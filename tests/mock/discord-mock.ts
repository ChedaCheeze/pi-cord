/**
 * Minimal in-process Discord gateway + REST mock for picord v2 integration
 * tests. Emulates just enough of Discord for discord.js to:
 *
 *   1. GET /gateway/bot -> a ws:// URL on this same server,
 *   2. IDENTIFY -> READY (clientReady) with a fake bot user/application,
 *   3. receive one DM MESSAGE_CREATE the bot must stream an answer to,
 *   4. receive one /status INTERACTION_CREATE the bot must defer + editReply.
 *
 * The mock captures every REST call and gateway dispatch into plain arrays so
 * tests can assert against them directly (no stdout scraping, no control port).
 * It also exposes injectThreadDelete()/injectThreadUpdate() so the live
 * thread-memory hooks can be exercised on demand.
 *
 * Everything stays on localhost — no cloud, no real token.
 */
import * as http from 'http';
import { AddressInfo } from 'net';
import { WebSocketServer, WebSocket } from 'ws';

// --- fixed identity (token is base64(APP_ID), as Discord encodes it) --------
export const MOCK_TOKEN = 'MTAwMDAwMDAwMDAwMDAwMDAx.x.y';
export const APP_ID = '100000000000000001';
export const BOT_ID = '200000000000000002';
export const THREAD_ID = '300000000000000003';
export const GUILD_ID = '400000000000000004';
export const USER_ID = '500000000000000005';
// The DM channel id (a DM is its own channel; the bot answers it directly).
export const DM_CHANNEL_ID = '350000000000000009';

export interface RestCall {
  method: string;
  url: string;
  body: string;
}
export interface MessageCapture {
  channel_id: string;
  id: string;
  content: string;
}
export interface Snapshot {
  identified: boolean;
  /** command names from the most recent PUT /applications/:id/commands */
  commandNames: string[] | null;
  rest: RestCall[];
  /** POST /channels/:id/messages (the "Thinking..." create + any others) */
  creates: MessageCapture[];
  /** PATCH /channels/:id/messages/:mid (the streamed edits) */
  updates: MessageCapture[];
  /** interaction callback types (5 = deferred channel message acknowledgement) */
  callbackTypes: number[];
  /** callback contents (confirmation replies to component interactions) */
  callbackContents: string[];
  /** editReply bodies (PATCH /webhooks/.../messages/@original) */
  editReplyBodies: string[];
  /** select-menu customIds attached via editReply components */
  menuCustomIds: string[];
  /** option labels of menus attached via editReply components */
  menuLabels: string[];
  /** presence activities sent by the bot (op 3): names + types */
  presenceActivities: string[];
  presenceActivityTypes: number[];
  /** raw gateway packets the client sent (op-level) */
  gatewayOps: number[];
}

export class DiscordMock {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private botSockets = new Set<WebSocket>();
  private knownMessages = new Map<string, { channel_id: string; content: string }>();
  private nextId = 1;
  private identified = false;
  private scriptedSent = false;

  private restLog: RestCall[] = [];
  private creates: MessageCapture[] = [];
  private updates: MessageCapture[] = [];
  private commandNames: string[] | null = null;
  private callbackTypes: number[] = [];
  private callbackContents: string[] = [];
  private editReplyBodies: string[] = [];
  private menuCustomIds: string[] = [];
  private menuLabels: string[] = [];
  private presenceActivities: string[] = [];
  private presenceActivityTypes: number[] = [];
  private gatewayOps: number[] = [];

  private newId(): string {
    // BigInt: 9e17 exceeds Number.MAX_SAFE_INTEGER, so plain-number
    // arithmetic silently collapsed every id to the same string (colliding
    // DMs then re-emitted a cached bot message and were ignored).
    return (900000000000000000n + BigInt(this.nextId++)).toString();
  }

  /** Start the mock on an ephemeral port; resolves with the base URL. */
  async start(): Promise<string> {
    this.server = http.createServer((req, res) => this.onRest(req, res));
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => this.onConnection(ws));

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    for (const ws of this.botSockets) {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    this.botSockets.clear();
    await new Promise<void>((resolve) => {
      if (this.wss) this.wss.close(() => resolve());
      else resolve();
    });
    await new Promise<void>((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  /** Send a THREAD_DELETE dispatch to every connected bot socket. */
  injectThreadDelete(threadId: string = THREAD_ID, guildId: string = GUILD_ID): void {
    this.dispatch({ id: threadId, guild_id: guildId }, 'THREAD_DELETE');
  }

  /** Send a THREAD_UPDATE dispatch (e.g. archive) to every connected socket. */
  injectThreadUpdate(patch: Record<string, unknown>, threadId: string = THREAD_ID): void {
    this.dispatch({ id: threadId, ...patch }, 'THREAD_UPDATE');
  }

  /**
   * Send an INTERACTION_CREATE of the given type. `channel` is an object in
   * the current API shape — discord.js 14.27 reads channelId from
   * data.channel?.id, so omitting it makes interaction.channelId null and
   * per-channel overrides would key against the wrong id.
   */
  injectInteraction(
    type: number,
    data: Record<string, unknown>,
    topLevel: Record<string, unknown> = {},
  ): string {
    const id = `int-${(this.nextId++).toString().padStart(2, '0')}`;
    this.dispatch(
      {
        id,
        application_id: APP_ID,
        type,
        data,
        channel: { id: DM_CHANNEL_ID },
        channel_id: DM_CHANNEL_ID,
        guild_id: null,
        member: { user: { id: USER_ID, username: 'tester', bot: false, discriminator: '0007' } },
        entitlements: [], // BaseInteraction constructor calls .reduce on this
        authorizing_integration_owners: {}, // indexed by integration type
        token: `int-token-${id}`,
        version: 1,
        ...topLevel,
      },
      'INTERACTION_CREATE',
    );
    return id;
  }

  /**
   * Inject a select-menu click (component_type 3) on a picker customId.
   * Note: InteractionType.MessageComponent === 3 in the current
   * discord-api-types enum, and the interaction's `message` field is a
   * top-level payload member (sibling of `data`), not part of `data.data`.
   */
  injectSelectMenu(customId: string, value: string): string {
    return this.injectInteraction(
      3, // InteractionType.MessageComponent
      { custom_id: customId, component_type: 3, values: [value] },
      {
        message: {
          id: '999000000000000001',
          channel_id: DM_CHANNEL_ID,
          author: this.botAuthor(),
          content: '',
          timestamp: new Date().toISOString(),
          mentions: [],
        },
      },
    );
  }

  /** Inject a DM MESSAGE_CREATE (any content; the bot answers every DM). */
  injectDM(content: string, channelId: string = DM_CHANNEL_ID): string {
    const id = this.newId();
    this.dispatch(
      {
        id,
        guild_id: null, // DM: no guild
        channel_type: 1, // 1 = DM
        channel_id: channelId,
        author: { id: USER_ID, username: 'tester', bot: false, discriminator: '0007' },
        member: null,
        content,
        timestamp: new Date().toISOString(),
        mentions: [],
        mention_everyone: false,
      },
      'MESSAGE_CREATE',
    );
    return id;
  }

  snapshot(): Snapshot {
    return {
      identified: this.identified,
      commandNames: this.commandNames,
      rest: this.restLog,
      creates: this.creates,
      updates: this.updates,
      callbackTypes: this.callbackTypes,
      callbackContents: this.callbackContents,
      editReplyBodies: this.editReplyBodies,
      menuCustomIds: this.menuCustomIds,
      menuLabels: this.menuLabels,
      presenceActivities: this.presenceActivities,
      presenceActivityTypes: this.presenceActivityTypes,
      gatewayOps: this.gatewayOps,
    };
  }

  // --- internals -------------------------------------------------------------

  private dispatch(d: Record<string, unknown>, t: string): void {
    const packet = JSON.stringify({ op: 0, s: 90, t, d });
    for (const ws of this.botSockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(packet);
    }
  }

  private botAuthor() {
    return { id: BOT_ID, username: 'picord-mock', bot: true, discriminator: '0001' };
  }

  private messageShape(id: string, channel_id: string, content: string, guild_id: string | null) {
    return {
      id,
      channel_id,
      author: this.botAuthor(),
      content,
      timestamp: new Date().toISOString(),
      mentions: [],
      mention_everyone: false,
      guild_id,
      member: null,
    };
  }

  private onRest(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const method = req.method ?? '';
      const url = req.url ?? '';
      this.restLog.push({ method, url, body });
      res.setHeader('content-type', 'application/json');

      if (req.method === 'GET' && /\/gateway\/bot/.test(url)) {
        res.end(
          JSON.stringify({
            url: `ws://127.0.0.1:${(this.server!.address() as AddressInfo).port}`,
            shards: 1,
            session_start_limit: { total: 1, remaining: 1, max_concurrency: 1, reset_after: 1000 },
          }),
        );
        return;
      }
      if (req.method === 'PUT' && /\/applications\/[^/]+\/commands$/.test(url)) {
        const cmds = JSON.parse(body || '[]');
        this.commandNames = cmds.map((c: { name: string }) => c.name);
        res.end(JSON.stringify(cmds));
        return;
      }
      if (req.method === 'POST' && /\/channels\/[^/]+\/messages$/.test(url)) {
        const channelId = url.match(/\/channels\/([^/]+)\/messages/)![1];
        const parsed = JSON.parse(body || '{}');
        const id = this.newId();
        const msg = this.messageShape(id, channelId, parsed.content ?? '', GUILD_ID);
        this.knownMessages.set(id, { channel_id: channelId, content: msg.content });
        this.creates.push({ channel_id: channelId, id, content: msg.content });
        for (const ws of this.botSockets) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ op: 0, s: 99, t: 'MESSAGE_CREATE', d: msg }));
          }
        }
        res.end(JSON.stringify(msg));
        return;
      }
      if (req.method === 'PATCH' && /\/channels\/[^/]+\/messages\/[^/]+$/.test(url)) {
        const m = url.match(/\/channels\/([^/]+)\/messages\/([^/]+)/)!;
        const [channelId, messageId] = [m[1], m[2]];
        const parsed = JSON.parse(body || '{}');
        const content = parsed.content ?? '';
        this.knownMessages.set(messageId, { channel_id: channelId, content });
        this.updates.push({ channel_id: channelId, id: messageId, content });
        res.end(JSON.stringify(this.messageShape(messageId, channelId, content, GUILD_ID)));
        return;
      }
      if (req.method === 'POST' && /\/interactions\/[^/]+\/[^/]+\/callback/.test(url)) {
        const parsed = JSON.parse(body || '{}');
        this.callbackTypes.push(parsed.type);
        if (parsed.data && typeof parsed.data.content === 'string') {
          this.callbackContents.push(parsed.data.content);
        }
        // A real Discord 204 has no JSON content-type (prevents a
        // "Unexpected end of JSON input" in @discordjs/rest).
        res.statusCode = 204;
        res.removeHeader('content-type');
        res.end();
        return;
      }
      if (req.method === 'PATCH' && /\/webhooks\/[^/]+\/[^/]+\/messages\//.test(url)) {
        const parsed = JSON.parse(body || '{}');
        this.editReplyBodies.push(parsed.content ?? '');
        // Capture select menus attached to the reply (pickers).
        for (const row of parsed.components ?? []) {
          for (const comp of row.components ?? []) {
            if (typeof comp.custom_id === 'string') this.menuCustomIds.push(comp.custom_id);
            for (const opt of comp.options ?? []) {
              if (typeof opt.label === 'string') this.menuLabels.push(opt.label);
            }
          }
        }
        res.end(JSON.stringify(this.messageShape('reply-id', THREAD_ID, parsed.content ?? '', null)));
        return;
      }
      res.end(JSON.stringify({ id: 'mock-id', ok: true }));
    });
  }

  private onConnection(ws: WebSocket): void {
    this.botSockets.add(ws);
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }));
    ws.on('close', () => this.botSockets.delete(ws));
    ws.on('message', (raw) => {
      let d;
      try {
        d = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.gatewayOps.push(d.op);

      if (d.op === 2) {
        this.identified = true;
        ws.send(
          JSON.stringify({
            op: 0,
            s: 1,
            t: 'READY',
            d: {
              user: { id: BOT_ID, username: 'picord-mock', discriminator: '0001', bot: true },
              application: { id: APP_ID, name: 'picord' },
              session_id: 'sess-mock-0001',
              resume_gateway_url: `ws://127.0.0.1:${(this.server!.address() as AddressInfo).port}`,
              guilds: [],
            },
          }),
        );
        if (!this.scriptedSent) {
          this.scriptedSent = true;
          this.sendScriptedSequence(ws);
        }
        return;
      }
      if (d.op === 3) {
        const act = d.d && d.d.activities && d.d.activities[0];
        if (act && act.name) {
          this.presenceActivities.push(act.name);
          this.presenceActivityTypes.push(act.type ?? -1);
        }
        return;
      }
      if (d.op === 1) {
        ws.send(JSON.stringify({ op: 11, d: d.d ?? null }));
        return;
      }
      if (d.op === 6) {
        return; // RESUME
      }
    });
  }

  /**
   * After READY: cache a real guild + thread (so threadDelete/threadUpdate
   * fire), then a DM MESSAGE_CREATE the bot must answer, then a /status
   * INTERACTION_CREATE for the command router.
   */
  private sendScriptedSequence(ws: WebSocket): void {
    const ts = new Date().toISOString();
    const send = (delay: number, t: string, d: unknown): void => {
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 0, s: 91, t, d }));
      }, delay);
    };

    // A minimal but valid GUILD_CREATE so the thread can be cached.
    const guild = {
      id: GUILD_ID,
      name: 'mock-guild',
      icon: null,
      owner_id: USER_ID,
      region: 'us-west',
      premium_tier: 0,
      premium_count: 0,
      preferred_locale: 'en-US',
      verification_level: 0,
      default_message_notifications: 0,
      explicit_content_filter: 0,
      mfa_level: 0,
      features: [],
      // GUILD_CREATE sends emojis/stickers as arrays (the Guild
      // constructor iterates them; an object crashes with "not iterable").
      emojis: [],
      stickers: [],
      system_channel_id: null,
      system_channel_flags: 0,
      rules_channel_id: null,
      public_updates_channel_id: null,
      premium_subscription_count: 0,
      max_members: 500,
      max_presences: null,
      max_webhooks: null,
      afk_channel_id: null,
      afk_timeout: 0,
      vanity_url_code: null,
      description: null,
      banner: null,
      splash: null,
      discovery_splash: null,
      nsfw_level: 0,
      stage_instances: [],
      threads: [],
      members: [],
      presences: [],
      voice_states: [],
      joined_at: ts,
      large: false,
      unowned: false,
    };

    const thread = {
      id: THREAD_ID,
      type: 11, // 11 = PublicThread
      guild_id: GUILD_ID,
      name: 'test-thread',
      parent_id: '600000000000000006',
      owner_id: USER_ID,
      last_message_id: null,
      message_count: 0,
      member_count: 1,
      rate_limit_per_user: 0,
      thread_metadata: {
        archived: false,
        auto_archive_duration: 1440,
        archive_timestamp: ts,
        create_timestamp: ts,
      },
    };

    send(100, 'GUILD_CREATE', guild);
    send(300, 'THREAD_CREATE', thread);
    send(700, 'MESSAGE_CREATE', {
      id: this.newId(),
      guild_id: null, // DM: no guild
      channel_type: 1, // 1 = DM
      channel_id: DM_CHANNEL_ID,
      author: { id: USER_ID, username: 'tester', bot: false, discriminator: '0007' },
      member: null,
      content: 'hello from the test dm',
      timestamp: ts,
      mentions: [],
      mention_everyone: false,
    });
    send(1300, 'INTERACTION_CREATE', {
      id: 'int-0001',
      application_id: APP_ID,
      type: 2, // ChatInputCommand
      data: { id: 'cmd-status', name: 'status', type: 1, options: [], target_id: null, resolved: {} },
      guild_id: null,
      channel_id: DM_CHANNEL_ID,
      member: { user: { id: USER_ID, username: 'tester', bot: false, discriminator: '0007' } },
      entitlements: [], // BaseInteraction constructor calls .reduce on this
      authorizing_integration_owners: {}, // indexed by integration type
      token: 'int-token-abc123',
      version: 1,
    });
  }
}
