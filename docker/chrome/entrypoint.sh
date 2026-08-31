#!/bin/sh
set -eu

api_url=${FLOW_EXTENSION_API_URL:-http://backend:8787}
api_key=${FLOW_API_KEY:-}
worker_id=${FLOW_EXTENSION_WORKER_ID:-coolify-chrome}
enabled=${FLOW_EXTENSION_ENABLED:-true}
force=${FLOW_EXTENSION_FORCE_CONFIG:-true}
: "${NOVNC_PASSWORD:?Set NOVNC_PASSWORD in Coolify}"

jq -n \
  --arg apiUrl "$api_url" \
  --arg apiKey "$api_key" \
  --arg workerId "$worker_id" \
  --argjson enabled "$enabled" \
  --argjson force "$force" \
  '{apiUrl:$apiUrl,apiKey:$apiKey,workerId:$workerId,enabled:$enabled,force:$force}' \
  | sed '1s/^/export const runtimeDefaults = /; $s/$/;/' \
  > /opt/flow-extension/runtime-config.js

cleanup() {
  kill ${chrome_pid:-} ${novnc_pid:-} ${vnc_pid:-} ${wm_pid:-} ${xvfb_pid:-} 2>/dev/null || true
}
trap cleanup INT TERM EXIT

Xvfb :99 -screen 0 "${CHROME_SCREEN:-1920x1080x24}" -ac +extension GLX +render -noreset &
xvfb_pid=$!
sleep 1
openbox-session &
wm_pid=$!
x11vnc -storepasswd "$NOVNC_PASSWORD" /tmp/vnc.pass >/dev/null
x11vnc -display :99 -forever -shared -rfbauth /tmp/vnc.pass -rfbport 5900 -quiet &
vnc_pid=$!
websockify --web=/usr/share/novnc 6080 localhost:5900 &
novnc_pid=$!

chromium \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --no-first-run \
  --no-default-browser-check \
  --password-store=basic \
  --user-data-dir=/data/chromium \
  --load-extension=/opt/flow-extension \
  --disable-extensions-except=/opt/flow-extension \
  "${FLOW_START_URL:-https://gemini.google.com/app}" &
chrome_pid=$!

wait "$chrome_pid"
