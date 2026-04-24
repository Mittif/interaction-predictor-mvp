#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

PYTHON_BIN="${PYTHON_BIN:-python3}"
VENV_DIR="${VENV_DIR:-.venv}"
RUNTIME_DIR="${RUNTIME_DIR:-runtime}"
PID_FILE="${PID_FILE:-$RUNTIME_DIR/server.pid}"
LOG_FILE="${LOG_FILE:-$RUNTIME_DIR/server.log}"
RUNNER_FILE="${RUNNER_FILE:-$RUNTIME_DIR/run_server.sh}"
LAUNCHD_LABEL="${LAUNCHD_LABEL:-com.interaction-predictor.mvp}"
LAUNCHD_PLIST="${LAUNCHD_PLIST:-$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist}"
USE_LAUNCHD="${USE_LAUNCHD:-0}"
CAMERA_URL="${CAMERA_URL:-0}"
API_HOST="${API_HOST:-0.0.0.0}"
API_PORT="${API_PORT:-8000}"
LLM_PROVIDER="${LLM_PROVIDER:-kimi}"
export OPENCV_AVFOUNDATION_SKIP_AUTH="${OPENCV_AVFOUNDATION_SKIP_AUTH:-0}"

if [[ "$LLM_PROVIDER" == "kimi" && -z "${MOONSHOT_API_KEY:-${KIMI_API_KEY:-}}" ]]; then
  echo "Missing MOONSHOT_API_KEY or KIMI_API_KEY. Put it in .env or export it before deploying." >&2
  echo "Example: echo 'MOONSHOT_API_KEY=your_key' >> .env" >&2
  exit 1
fi

mkdir -p "$RUNTIME_DIR"

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE")"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "Stopping existing server: $old_pid"
    kill "$old_pid"
    for _ in {1..20}; do
      if ! kill -0 "$old_pid" 2>/dev/null; then
        break
      fi
      sleep 0.5
    done
    if kill -0 "$old_pid" 2>/dev/null; then
      echo "Existing server did not stop in time; killing: $old_pid"
      kill -9 "$old_pid" 2>/dev/null || true
    fi
  fi
fi

if [[ ! -d "$VENV_DIR" ]]; then
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

python -m pip install --upgrade pip
python -m pip install -e .

cat > "$RUNNER_FILE" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$ROOT_DIR"
if [[ -f ".env" ]]; then
  set -a
  source ".env"
  set +a
fi
export OPENCV_AVFOUNDATION_SKIP_AUTH="${OPENCV_AVFOUNDATION_SKIP_AUTH}"
exec "$ROOT_DIR/$VENV_DIR/bin/python" -m interaction_predictor \\
  --camera-url "$CAMERA_URL" \
  --host "$API_HOST" \
  --port "$API_PORT" \
  --llm-provider "$LLM_PROVIDER"
EOF
chmod +x "$RUNNER_FILE"

if [[ "$(uname -s)" == "Darwin" && "$USE_LAUNCHD" != "0" && "$USE_LAUNCHD" != "false" ]]; then
  mkdir -p "$(dirname "$LAUNCHD_PLIST")"
  launchctl bootout "gui/$UID" "$LAUNCHD_PLIST" >/dev/null 2>&1 || true
  cat > "$LAUNCHD_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LAUNCHD_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$ROOT_DIR/$RUNNER_FILE</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT_DIR</string>
  <key>StandardOutPath</key>
  <string>$ROOT_DIR/$LOG_FILE</string>
  <key>StandardErrorPath</key>
  <string>$ROOT_DIR/$LOG_FILE</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
EOF
  launchctl bootstrap "gui/$UID" "$LAUNCHD_PLIST"
  launchctl kickstart -k "gui/$UID/$LAUNCHD_LABEL"
  sleep 1
  new_pid="$(pgrep -f "$ROOT_DIR/$VENV_DIR/bin/python -m interaction_predictor" | tail -n 1 || true)"
  if [[ -n "$new_pid" ]]; then
    echo "$new_pid" > "$PID_FILE"
  fi
  echo "Interaction Predictor deployed with launchd"
  echo "LaunchAgent: $LAUNCHD_PLIST"
else
  nohup "$RUNNER_FILE" >"$LOG_FILE" 2>&1 &
  new_pid="$!"
  echo "$new_pid" > "$PID_FILE"
  echo "Interaction Predictor deployed"
  echo "PID: $new_pid"
fi

echo "UI: http://127.0.0.1:${API_PORT}/"
echo "API: http://127.0.0.1:${API_PORT}/docs"
echo "Log: $LOG_FILE"
