#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$DIR/.." && pwd)"
HTTP_PORT="${HTTP_PORT:-8787}"
HTTPS_PORT="${HTTPS_PORT:-9443}"
PREDICTOR_PORT="${PREDICTOR_PORT:-8000}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
CAMERA_URL="${CAMERA_URL:-/tmp/interaction-predictor-demo/demo.mp4}"
LLM_PROVIDER="${LLM_PROVIDER:-kimi}"

mkdir -p "$DIR/certs" "$DIR/logs"

LAN_IP="${LAN_IP:-}"
if [ -z "$LAN_IP" ] && command -v ipconfig >/dev/null 2>&1; then
  LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
fi
if [ -z "$LAN_IP" ] && command -v ipconfig >/dev/null 2>&1; then
  LAN_IP="$(ipconfig getifaddr en1 2>/dev/null || true)"
fi
if [ -z "$LAN_IP" ] && command -v ip >/dev/null 2>&1; then
  LAN_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") {print $(i + 1); exit}}' || true)"
fi
if [ -z "$LAN_IP" ] && command -v hostname >/dev/null 2>&1; then
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
fi
if [ -z "$LAN_IP" ]; then
  LAN_IP="127.0.0.1"
fi

if [ ! -f "$DIR/certs/cert.pem" ] || [ ! -f "$DIR/certs/key.pem" ]; then
  echo "Generating local HTTPS certificate for localhost and $LAN_IP"
  if openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$DIR/certs/key.pem" \
    -out "$DIR/certs/cert.pem" \
    -days 365 \
    -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:$LAN_IP" >/dev/null 2>&1; then
    true
  else
    openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout "$DIR/certs/key.pem" \
      -out "$DIR/certs/cert.pem" \
      -days 365 \
      -subj "/CN=localhost" >/dev/null 2>&1
  fi
fi

if curl -fsS "http://localhost:$PREDICTOR_PORT/health" >/dev/null 2>&1; then
  echo "Interaction predictor already running on port $PREDICTOR_PORT"
else
  echo "Starting interaction predictor on port $PREDICTOR_PORT"
  (
    cd "$REPO_ROOT"
    nohup "$PYTHON_BIN" -m interaction_predictor \
      --camera-url "$CAMERA_URL" \
      --host 0.0.0.0 \
      --port "$PREDICTOR_PORT" \
      --llm-provider "$LLM_PROVIDER" \
      > "$DIR/logs/interaction-predictor.log" 2>&1 &
    echo $! > "$DIR/logs/interaction-predictor.pid"
  )
fi

echo "Starting Quest Portal Hub"
echo "Quest 3 HTTP URL:  http://$LAN_IP:$HTTP_PORT/"
echo "Quest 3 HTTPS URL: https://$LAN_IP:$HTTPS_PORT/"
echo "Local HTTP URL:    http://localhost:$HTTP_PORT/"
echo "Local HTTPS URL:   https://localhost:$HTTPS_PORT/"
echo "Use HTTP for fastest local asset loading. If Quest Browser hides Enter XR on HTTP, use HTTPS once."
cd "$DIR"
cleanup() {
  rm -f "$DIR/logs/portal.pid"
}
trap cleanup EXIT
HTTP_PORT="$HTTP_PORT" HTTPS_PORT="$HTTPS_PORT" node server.mjs &
PORTAL_PID="$!"
echo "$PORTAL_PID" > "$DIR/logs/portal.pid"
wait "$PORTAL_PID"
