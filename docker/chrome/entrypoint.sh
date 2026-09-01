#!/bin/sh
set -eu

# Docker initializes a new named volume as root. Fix its ownership once, then
# run every desktop process as the unprivileged Chrome user.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data/chromium
  rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
  chown -R chrome:chrome /data/chromium /opt/flow-extension

  api_url=${FLOW_EXTENSION_API_URL:-http://backend:8787}
  api_key=${FLOW_API_KEY:-}
  worker_id=${FLOW_EXTENSION_WORKER_ID:-coolify-chrome}
  enabled=${FLOW_EXTENSION_ENABLED:-true}
  force=${FLOW_EXTENSION_FORCE_CONFIG:-true}
  jq -n \
    --arg apiUrl "$api_url" \
    --arg apiKey "$api_key" \
    --arg workerId "$worker_id" \
    --argjson enabled "$enabled" \
    --argjson force "$force" \
    '{apiUrl:$apiUrl,apiKey:$apiKey,workerId:$workerId,enabled:$enabled,force:$force}' \
    | sed '1s/^/export const runtimeDefaults = /; $s/$/;/' \
    > /opt/flow-extension/runtime-config.js

  # Chrome Stable no longer accepts --load-extension. Package the extension
  # as a CRX and force-install it with a managed Chrome policy. Keep the signing
  # key in the persistent profile so its ID remains unchanged across rebuilds.
  extension_key=/data/chromium/.flow-extension.pem
  rm -f /opt/flow-extension.crx /opt/flow-extension.pem
  if [ -f "$extension_key" ]; then
    google-chrome-stable --no-sandbox \
      --pack-extension=/opt/flow-extension \
      --pack-extension-key="$extension_key"
  else
    google-chrome-stable --no-sandbox --pack-extension=/opt/flow-extension
    mv /opt/flow-extension.pem "$extension_key"
  fi
  extension_id="$(openssl rsa -in "$extension_key" -pubout -outform DER 2>/dev/null \
    | sha256sum | cut -c1-32 | tr '0-9a-f' 'a-p')"
  extension_version="$(jq -r .version /opt/flow-extension/manifest.json)"
  mkdir -p /opt/extension-updates /etc/opt/chrome/policies/managed
  mv /opt/flow-extension.crx /opt/extension-updates/flow-extension.crx
  printf '%s\n' \
    '<?xml version="1.0" encoding="UTF-8"?>' \
    '<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">' \
    "  <app appid=\"${extension_id}\">" \
    "    <updatecheck codebase=\"http://127.0.0.1:8090/flow-extension.crx\" version=\"${extension_version}\"/>" \
    '  </app>' \
    '</gupdate>' > /opt/extension-updates/updates.xml
  jq -n --arg install "${extension_id};http://127.0.0.1:8090/updates.xml" \
    '{ExtensionInstallForcelist:[$install]}' \
    > /etc/opt/chrome/policies/managed/flow-extension.json
  chmod 0600 "$extension_key"
  chmod 0644 /opt/extension-updates/flow-extension.crx \
    /opt/extension-updates/updates.xml \
    /etc/opt/chrome/policies/managed/flow-extension.json
  chown root:root "$extension_key"
  exec gosu chrome "$0" "$@"
fi

: "${NOVNC_PASSWORD:?Set NOVNC_PASSWORD in Coolify}"

# Container hostnames change on every Coolify deployment. Chrome leaves these
# process locks in the persistent profile after a container is replaced, which
# makes the next Chrome process incorrectly conclude the profile is in use.
rm -f /data/chromium/SingletonLock \
  /data/chromium/SingletonSocket \
  /data/chromium/SingletonCookie

cleanup() {
  kill ${chrome_pid:-} ${httpd_pid:-} ${novnc_pid:-} ${vnc_pid:-} ${wm_pid:-} ${xvfb_pid:-} 2>/dev/null || true
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
busybox httpd -f -p 127.0.0.1:8090 -h /opt/extension-updates &
httpd_pid=$!

google-chrome-stable \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --no-first-run \
  --no-default-browser-check \
  --password-store=basic \
  --user-data-dir=/data/chromium \
  "${FLOW_START_URL:-https://gemini.google.com/app}" &
chrome_pid=$!

wait "$chrome_pid"
