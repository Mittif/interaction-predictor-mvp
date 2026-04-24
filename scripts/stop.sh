#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RUNTIME_DIR="${RUNTIME_DIR:-runtime}"
PID_FILE="${PID_FILE:-$RUNTIME_DIR/server.pid}"
LAUNCHD_LABEL="${LAUNCHD_LABEL:-com.interaction-predictor.mvp}"
LAUNCHD_PLIST="${LAUNCHD_PLIST:-$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist}"

if [[ "$(uname -s)" == "Darwin" && -f "$LAUNCHD_PLIST" ]]; then
  launchctl bootout "gui/$UID" "$LAUNCHD_PLIST" >/dev/null 2>&1 || true
fi

if [[ ! -f "$PID_FILE" ]]; then
  echo "No PID file found: $PID_FILE"
  exit 0
fi

pid="$(cat "$PID_FILE")"
if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
  echo "Server is not running"
  rm -f "$PID_FILE"
  exit 0
fi

echo "Stopping server: $pid"
kill "$pid"
for _ in {1..20}; do
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "Stopped"
    exit 0
  fi
  sleep 0.5
done

echo "Server did not stop in time; killing: $pid"
kill -9 "$pid" 2>/dev/null || true
rm -f "$PID_FILE"
echo "Stopped"
