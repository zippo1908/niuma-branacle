#!/usr/bin/env bash
# AgentPlane one-shot setup: deps → build → migrate → seed.
# Prerequisites: Node 20+, a reachable Postgres 16 (DATABASE_URL) and Redis 7 (REDIS_URL).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

command -v node >/dev/null || { echo "ERROR: Node.js 20+ is required"; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "ERROR: Node 20+ required (have $(node -v))"; exit 1; }

# Ensure a real `pnpm` on PATH (turborepo spawns it by name).
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable pnpm >/dev/null 2>&1 || true
fi
if ! command -v pnpm >/dev/null 2>&1; then
  mkdir -p "$HOME/.local/bin"
  printf '#!/bin/sh\nexec corepack pnpm "$@"\n' > "$HOME/.local/bin/pnpm"
  chmod +x "$HOME/.local/bin/pnpm"
  export PATH="$HOME/.local/bin:$PATH"
  echo "note: created pnpm shim at ~/.local/bin/pnpm — add it to PATH in future shells"
fi
corepack prepare pnpm@9.12.0 --activate >/dev/null 2>&1 || true

if [ ! -f .env ]; then
  cp .env.example .env
  echo ">>> created .env from .env.example."
  echo ">>> EDIT .env now: set DATABASE_URL, REDIS_URL, SESSION_SECRET (and SEED_USER_*), then re-run this script."
  exit 0
fi

echo "→ installing dependencies"; pnpm install
echo "→ building";              pnpm build
echo "→ migrating database";    pnpm db:migrate
echo "→ seeding";               pnpm db:seed

cat <<'EOF'

✓ AgentPlane setup complete.

Start the three services (separate terminals, or use the systemd units in deploy/):
  pnpm --filter @agentplane/api    start    # http://localhost:4000  (GET /healthz)
  pnpm --filter @agentplane/worker start
  pnpm --filter @agentplane/portal start    # http://localhost:3000

Or all in dev/watch mode at once:  pnpm dev
Sign in with the SEED_USER_EMAIL / SEED_USER_PASSWORD from your .env.
EOF
