#!/usr/bin/env bash
# Linux launcher for Folder2Page / image-post.
# Installs deps if missing, builds the frontend if missing, then starts the
# Node server in the foreground (so systemd / pm2 can supervise it).

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

echo "[start.sh] Running from $ROOT"

# ── Node check ───────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "[start.sh] ERROR: node is not installed. Install Node 18+ first." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "[start.sh] WARNING: Node $NODE_MAJOR detected. Node 18+ is recommended." >&2
fi

# ── Backend deps ─────────────────────────────────────────
if [ ! -d node_modules ]; then
  echo "[start.sh] Installing backend deps…"
  npm install --no-audit --no-fund
fi

# ── Frontend deps + build ────────────────────────────────
if [ ! -d frontend/node_modules ]; then
  echo "[start.sh] Installing frontend deps…"
  (cd frontend && npm install --no-audit --no-fund)
fi

if [ ! -d frontend/dist ]; then
  echo "[start.sh] Building frontend…"
  (cd frontend && npm run build)
fi

# ── Data dir ─────────────────────────────────────────────
mkdir -p data

# ── Run ──────────────────────────────────────────────────
PORT="${PORT:-5016}"
export PORT
echo "[start.sh] Starting server on port $PORT…"
exec node server.js
