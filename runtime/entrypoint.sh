#!/usr/bin/env bash
set -euo pipefail
export HOME=/home/coder
export DSH_HOME=/home/coder/.dsh
export DSH_TELEMETRY_MODE=DISABLED
export DSH_TELEMETRY_DISABLED=1
mkdir -p "$HOME/project" "$HOME/.local/share" "$DSH_HOME"
node /opt/gateway/seed.mjs
cd "$HOME/project"
# User code and agent share only this project's sandbox; neither receives platform credentials.
code-server --bind-addr 127.0.0.1:8080 --auth none --disable-telemetry --disable-update-check "$HOME/project" &
ide_pid=$!
# dsh web prints a per-process browser token ("dsh web: http://...?token=..."). The gateway
# hands it to the authorized browser on agent launch; it must never reach the pod logs.
token_dir=/tmp/harness
mkdir -p "$token_dir" && chmod 700 "$token_dir"
rm -f "$token_dir/dsh-web-token"
capture_dsh_token() {
  local line tok
  while IFS= read -r line; do
    case "$line" in
      "dsh web: "*"token="*)
        tok="${line##*token=}"
        tok="${tok%%[&# ]*}"
        (umask 077 && printf '%s' "$tok" >"$token_dir/dsh-web-token.tmp")
        mv -f "$token_dir/dsh-web-token.tmp" "$token_dir/dsh-web-token"
        echo "dsh web: listening on 127.0.0.1:3080 (browser token handed to the gateway)"
        ;;
      *) printf '%s\n' "$line" ;;
    esac
  done
}
dsh web --patch /opt/gateway/privacy.yml --host 127.0.0.1 --port 3080 --trusted-host "$AI_HOST" --no-open \
  > >(capture_dsh_token) 2>&1 &
agent_pid=$!
node /opt/gateway/gateway.mjs &
gateway_pid=$!
cleanup() { kill -TERM "$ide_pid" "$agent_pid" "$gateway_pid" 2>/dev/null || true; wait || true; }
trap cleanup EXIT
trap 'exit 0' TERM INT
# If any service fails, restart the pod rather than advertising a partially working environment.
wait -n "$ide_pid" "$agent_pid" "$gateway_pid"
exit 1
