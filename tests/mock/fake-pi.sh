#!/bin/bash
# Fake `pi` for picord v2 integration testing. Ignores its args
# (--print --session-id <id> <input>) and streams a reply to stdout as
# LINE-SEPARATED chunks with small delays, exercising the 75-char edit
# throttle (the real SessionManager.makeStream yields complete lines).
set -euo pipefail
# Chunk 1 (~95 chars, its own line)
printf 'Hello from the fake pi process. This is the first streamed line of the reply, long enough to cross the threshold. \n'
sleep 0.5
# Chunk 2 (~100 chars, its own line)
printf 'Here comes the second line of streamed output. It keeps going so that the gateway edits the message before the very end. \n'
sleep 0.5
# Chunk 3 (~80 chars, its own line)
printf 'And a final line to finish the streamed reply nicely for the test. Thanks for reading all of it. \n'
sleep 0.5
# Short final line (<75 chars by itself, forces the close-flush path)
printf 'Done. \n'
exit 0
