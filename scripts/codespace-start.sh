#!/usr/bin/env bash
# Start OpenAccess inside a GitHub Codespace and leave it running in the
# background. postStartCommand runs this on every codespace start.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f dist/server/server/index.js ] || [ ! -f dist/client/index.html ] || [ ! -f dist/runtime/runtime.js ]; then
  npm run build
fi

# Replace a previous instance if the codespace restarted with one still running.
if [ -f /tmp/openaccess.pid ]; then
  kill "$(cat /tmp/openaccess.pid)" 2>/dev/null || true
  rm -f /tmp/openaccess.pid
fi
pkill -f 'node dist/server/server/index.js' 2>/dev/null || true

nohup node dist/server/server/index.js > /tmp/openaccess.log 2>&1 &
echo $! > /tmp/openaccess.pid

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT:-3000}/healthz" >/dev/null 2>&1; then
    echo "OpenAccess is listening on port ${PORT:-3000} (log: /tmp/openaccess.log)"
    exit 0
  fi
  sleep 1
done

cat /tmp/openaccess.log >&2
echo "OpenAccess failed to start" >&2
exit 1
