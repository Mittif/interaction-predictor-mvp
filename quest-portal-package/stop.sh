#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -f "$DIR/logs/portal.pid" ]; then
  PID="$(cat "$DIR/logs/portal.pid")"
  if kill -0 "$PID" >/dev/null 2>&1; then
    kill "$PID"
    echo "Stopped Quest Portal Hub PID $PID"
  fi
  rm -f "$DIR/logs/portal.pid"
fi

if [ -f "$DIR/logs/interaction-predictor.pid" ]; then
  PID="$(cat "$DIR/logs/interaction-predictor.pid")"
  if kill -0 "$PID" >/dev/null 2>&1; then
    kill "$PID"
    echo "Stopped interaction predictor PID $PID"
  fi
  rm -f "$DIR/logs/interaction-predictor.pid"
fi

echo "Stopped packaged services when matching PID files were present."
