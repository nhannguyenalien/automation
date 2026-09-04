#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repo_dir=${script_dir:h}
node_bin=$(command -v node)
launch_agents_dir="$HOME/Library/LaunchAgents"
logs_dir="$HOME/Library/Logs/FlowWorkerUpdater"
plist="$launch_agents_dir/com.schoolsai.flow-worker-updater.plist"
extension_dirs=$("$node_bin" "$script_dir/discover-extensions.mjs" | paste -sd ';' -)

mkdir -p "$launch_agents_dir" "$logs_dir"
sed \
  -e "s|__NODE_BIN__|$node_bin|g" \
  -e "s|__SERVICE_SCRIPT__|$script_dir/update-service.mjs|g" \
  -e "s|__REPO_DIR__|$repo_dir|g" \
  -e "s@__EXTENSION_DIRS__@$extension_dirs@g" \
  -e "s|__LOG_DIR__|$logs_dir|g" \
  "$script_dir/com.schoolsai.flow-worker-updater.plist.template" > "$plist"

launchctl bootout "gui/$(id -u)/com.schoolsai.flow-worker-updater" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
launchctl kickstart -k "gui/$(id -u)/com.schoolsai.flow-worker-updater"

for attempt in {1..20}; do
  if curl --silent --fail --max-time 1 http://127.0.0.1:8765/status >/dev/null; then
    break
  fi
  sleep 0.25
done
curl --silent --fail --max-time 2 http://127.0.0.1:8765/status >/dev/null
echo "Updater installed: http://127.0.0.1:8765/status"
