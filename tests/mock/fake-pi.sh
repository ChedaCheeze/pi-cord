#!/bin/bash
# Fake `pi` for pi-cord integration testing.
#
# Modes:
#   --list-models   prints a parseable fake model table (for the /model picker)
#   stop-probe-slow anywhere in argv: a ~9-second job so /stop has a wide
#                   kill window
#   default (--print ...): streams a reply to stdout as line-separated chunks
#   with small delays, exercising the 75-char edit throttle (the real
#   SessionManager.makeStream yields complete lines). The default output and
#   timing must stay in sync with FAKE_PI_LINES in tests/gateway.test.ts.
#
# If FAKE_PI_ARGS_FILE is set, each invocation appends its argv (one arg per
# line, blank line between invocations) so tests can assert on the exact
# spawn args the gateway built.
set -euo pipefail

if [ -n "${FAKE_PI_ARGS_FILE:-}" ]; then
  {
    for a in "$@"; do printf '%s\n' "$a"; done
    printf '\n'
  } >> "$FAKE_PI_ARGS_FILE" 2>/dev/null || true
fi

if [ "$1" = "--list-models" ]; then
  cat <<'EOF'
provider   model                             context  max-out  thinking  images
llama.cpp  llama.cpp/fake/Model-A            131.0K   8.0K     yes       no
llama.cpp  llama.cpp/fake/Model-B            32.0K    4.0K     no        yes
EOF
  exit 0
fi

for a in "$@"; do
  if [ "$a" = "stop-probe-slow" ]; then
    sleep 3
    printf 'First line of the slow stop-probe run. \n'
    sleep 3
    printf 'Second line of the slow stop-probe run. \n'
    sleep 3
    printf 'This final line should never be reached because /stop kills the run. \n'
    exit 0
  fi
done

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
