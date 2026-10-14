#!/usr/bin/env bash
# Development mode: the room server (auto-restarts on change) on :8787 and the Vite
# viewer with hot reload on :5173. The viewer is also built once so that invite links
# (which point at :8787) open a working page.
set -euo pipefail
cd "$(dirname "$0")/.."

need_major=20
have=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$have" -lt "$need_major" ]; then
  echo "Node.js $need_major+ is required (found: $(node -v 2>/dev/null || echo none)). Try: nvm use" >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing pinned dependencies (npm ci)…"
  npm ci
fi

echo "Building the web viewer once (served by the room server at :8787)…"
npm run build -w web >/dev/null

pids=()
kill_tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$child"; done
  kill "$1" 2>/dev/null || true
}
cleanup() {
  trap - INT TERM EXIT
  for p in ${pids[@]+"${pids[@]}"}; do kill_tree "$p"; done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

npm run dev -w server &
pids+=($!)
npm run dev -w web -- --clearScreen false &
pids+=($!)

echo
echo "Room server: http://<this-mac-ip>:8787  (the server prints the exact address)"
echo "Viewer with hot reload: http://localhost:5173  (proxies /api and /ws to :8787)"
echo "Press Ctrl-C to stop both."
# macOS ships bash 3.2 (no `wait -n`): stop everything as soon as either process exits.
while kill -0 "${pids[0]}" 2>/dev/null && kill -0 "${pids[1]}" 2>/dev/null; do sleep 1; done
