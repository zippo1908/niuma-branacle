# AgentPlane — agent deployment prompt

Paste the block below to any capable coding agent (Claude Code / Codex / etc.) on the
**target Linux box**. It clones AgentPlane and brings up the Phase-1/2 MVP. The **only**
thing a human must supply is the **Postgres connection string** (you said you'll provision
Postgres on your intranet); everything else is automated. Redis can be Docker or your own.

---

You are deploying **AgentPlane** (a self-hosted control plane for AI coding agents) on this
Linux machine. Do it end-to-end and report the final URL + a smoke-test result.

## Inputs (ask the human only for these)
- `DATABASE_URL` — a reachable **PostgreSQL 16** database, e.g.
  `postgres://USER:PASSWORD@HOST:5432/agentplane`. The DB must exist and the user must own it.
- `REDIS_URL` — optional. If not provided, start Redis 7 via Docker (below) and use
  `redis://localhost:6379`.
- (optional) `GITHUB_TOKEN` — a repo-scoped PAT, only if you want automatic PR creation.

Do **not** invent or hard-code DB credentials — use exactly what the human gives you.

## Steps

1. **Prerequisites** — ensure these exist (install if missing, using the system package manager):
   `git`, **Node.js ≥ 20**, and `git` configured. `corepack` ships with Node (enables pnpm).
   For Redis-via-Docker you also need Docker + the compose plugin.

2. **Clone**:
   ```bash
   git clone https://github.com/zippo1908/niuma-branacle.git
   cd niuma-branacle/agentplane
   ```

3. **Redis** — if the human did NOT give a `REDIS_URL`, start one (Postgres is theirs):
   ```bash
   docker compose up -d redis        # exposes redis on localhost:6380 per docker-compose.yml
   # then use REDIS_URL=redis://localhost:6380
   ```

4. **Environment** — create `.env` from the template and fill in ONLY the connection values:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and set:
   - `DATABASE_URL=` … (the value from the human)
   - `REDIS_URL=` … (their value, or `redis://localhost:6380` if you started Docker Redis)
   - `SESSION_SECRET=` … generate a long random string: `openssl rand -base64 48`
   - `SEED_USER_EMAIL` / `SEED_USER_PASSWORD` … set a real admin login (this is what you'll sign in with)
   - leave `AGENTPLANE_DATA_DIR` as `./.data` for a single box (or point at `/srv/agentplane`)
   - (optional) add a line `GITHUB_TOKEN=...` if PR creation is wanted

5. **Install, build, migrate, seed** — one command does all of it:
   ```bash
   ./scripts/setup.sh
   ```
   (Re-run it after editing `.env`; it creates a `pnpm` shim if needed, runs `pnpm install`,
   `pnpm build`, `pnpm db:migrate`, `pnpm db:seed`.)

6. **Run the three services**. For a quick start:
   ```bash
   pnpm --filter @agentplane/api    start    # :4000
   pnpm --filter @agentplane/worker start
   pnpm --filter @agentplane/portal start    # :3000
   ```
   For a real server, install the unit files in `deploy/systemd/` (adjust the install path /
   `User`), `systemctl enable --now agentplane-{api,worker,portal}`, and put Caddy
   (`deploy/Caddyfile`) in front for TLS. The worker needs `git` on its PATH; to drive a real
   coding agent, install the Claude Code / Codex CLI and set the matching
   `agent_profiles.binary_path` (the `shell` profile works with no external agent).

7. **Verify**:
   ```bash
   curl -s http://localhost:4000/healthz          # → {"ok":true,...}
   ```
   Open the portal (`http://localhost:3000` or your Caddy domain), sign in with
   `SEED_USER_EMAIL`/`SEED_USER_PASSWORD`, **register a project** (a git URL or a local path),
   **file a demand**, hit **Run agent**, and confirm you see live logs and a diff.

8. **Smoke test the loop without an external agent** (proves worktree→diff→review works):
   after registering a project, set a shell command so an `edit` run changes a file, e.g. via SQL:
   `UPDATE projects SET settings='{"commands":{"edit":"echo hello >> NOTES.md"}}' WHERE slug='<your-slug>';`
   then file a demand, Run, and you should reach `waiting_review` with a 1-file diff; **Approve & ship**
   creates a commit + pushes the branch.

## Report back
- the portal URL, the admin email used, `/healthz` status,
- and the result of the smoke test (run reached `waiting_review`, diff produced, commit sha).

Notes: secrets in agent logs are auto-redacted; raw logs live at `<DATA_DIR>/logs/*.log` (0600).
Architecture + roadmap: `agentplane/docs/`. What's implemented vs deferred: `agentplane/IMPLEMENTATION.md`.
