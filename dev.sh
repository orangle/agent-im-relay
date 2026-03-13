#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [[ ! -f ".env" ]]; then
  echo "Missing .env. Copy from .env.example and fill Feishu settings." >&2
  exit 1
fi

INSPECT_FLAG=""
if [[ "${1:-}" == "--inspect" ]]; then
  INSPECT_FLAG="--inspect"
elif [[ "${1:-}" == "--inspect-brk" ]]; then
  INSPECT_FLAG="--inspect-brk"
elif [[ "${1:-}" =~ ^--inspect=([0-9]+)$ ]]; then
  INSPECT_FLAG="--inspect=127.0.0.1:${BASH_REMATCH[1]}"
elif [[ "${1:-}" =~ ^--inspect-brk=([0-9]+)$ ]]; then
  INSPECT_FLAG="--inspect-brk=127.0.0.1:${BASH_REMATCH[1]}"
elif [[ -n "${1:-}" ]]; then
  echo "Usage: ./dev.sh [--inspect|--inspect-brk|--inspect=PORT|--inspect-brk=PORT]" >&2
  exit 1
fi

CORE_DIST="$ROOT_DIR/packages/core/dist/index.mjs"
if [[ ! -f "$CORE_DIST" ]]; then
  echo "Core dist missing. Building @agent-im-relay/core..." >&2
  pnpm --filter @agent-im-relay/core build
fi

if [[ -n "$INSPECT_FLAG" ]]; then
  NODE_OPTIONS="$INSPECT_FLAG" pnpm dev:feishu
else
  pnpm dev:feishu
fi
