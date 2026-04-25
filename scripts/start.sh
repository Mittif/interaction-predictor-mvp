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
CAMERA_URL="${CAMERA_URL:-/tmp/interaction-predictor-demo/demo.mp4}"
API_HOST="${API_HOST:-0.0.0.0}"
API_PORT="${API_PORT:-8000}"
LLM_PROVIDER="${LLM_PROVIDER:-kimi}"
export OPENCV_AVFOUNDATION_SKIP_AUTH="${OPENCV_AVFOUNDATION_SKIP_AUTH:-0}"

if [[ "$LLM_PROVIDER" == "kimi" && -z "${MOONSHOT_API_KEY:-${KIMI_API_KEY:-}}" ]]; then
  echo "Missing MOONSHOT_API_KEY or KIMI_API_KEY. Put it in .env or export it before starting." >&2
  echo "Example: echo 'MOONSHOT_API_KEY=your_key' >> .env" >&2
  exit 1
fi

if [[ ! -d "$VENV_DIR" ]]; then
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

python -m pip install --upgrade pip
python -m pip install -e .

echo "Starting Interaction Predictor"
echo "UI: http://127.0.0.1:${API_PORT}/"
echo "API: http://127.0.0.1:${API_PORT}/docs"

exec python -m interaction_predictor \
  --camera-url "$CAMERA_URL" \
  --host "$API_HOST" \
  --port "$API_PORT" \
  --llm-provider "$LLM_PROVIDER"
