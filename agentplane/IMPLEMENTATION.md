# Implementation status

This monorepo implements **Phase 0 + 1 + 2 + 3** of [`docs/architecture/11-mvp-roadmap.md`](docs/architecture/11-mvp-roadmap.md): the single-user loop **Demand → Run → live logs → diff → review → commit → push → PR**, plus **concurrency safety + crash recovery** ("safe to run multiple workers"), verified end-to-end.

## Done

- **Monorepo** — pnpm workspaces + turborepo, shared `tsconfig.base`, `docker-compose` (Postgres 16 + Redis 7).
- **`packages/shared`** — demand/run **state machines**, `safeJoin` path guard + slug/filename sanitisers, **secret redactor**, agent **prompt builder**, scrypt **password hashing**. 19 unit tests (vitest).
- **`packages/db`** — Drizzle schema for the Phase-1 tables (organizations, users, projects, project_members, agent_profiles, demands, demand_comments, demand_attachments, agent_runs, run_steps, run_logs, run_artifacts, workspaces, project_locks, diffs, system_settings), forward-only SQL migrator, idempotent seed (org + superadmin + claude/codex/shell profiles + settings). Partial-unique index enforces *one held lock per project+branch* at the DB layer.
- **`apps/worker`** — BullMQ consumers for `agent-runs` + `project-clone`; `WorkspaceManager` (bare mirror → `git worktree` → attachment copy with sha256 verify); executors (`ShellExecutor` working e2e; `CliExecutor` for Claude/Codex headless); **log pipeline** (raw→`/logs/{run}.log` 0600 → redact → `run_logs` → Redis publish, monotonic `seq`); diff collection (`git add -A && git diff --staged` + numstat); `run_steps` timeline; project-lock acquire/release for write modes; stop via Redis control channel (SIGTERM→SIGKILL on the process group).
- **`apps/api`** — NestJS REST under `/api/v1` + cookie session auth; projects (register → enqueue clone), demands (CRUD, attachments with MIME/size checks, comments, `:id/run`), runs (`:id`, `:id/logs`, `:id/diff`, `:id/approve|reject|stop`), **SSE `/runs/:id/events`** with `Last-Event-ID` backlog replay; agent-profiles; `/healthz`.
- **`apps/portal`** — Next.js (App Router, mobile-first): login, projects + register, demands + file/run, **run detail with live SSE logs**, step timeline, coloured diff, approve / request-changes. Same-origin via Next rewrites so cookies + SSE work without CORS.

- **Phase 2 — review → ship.** `approvals` table (migration `0001`); `POST /runs/:id/approve` records an accepted `diff_review` approval (and `?auto=ship` enqueues the chain); `reject` records `changes_requested` and sends the demand back to `clarified`; `commit` / `push` / `create-pr` endpoints are **gated on an accepted approval** (403 otherwise). A `git-ops` worker queue commits the worktree (templated message → `agent_runs.commit_sha`), pushes the work branch to the project's remote, and opens a GitHub PR when `GITHUB_TOKEN` + a GitHub remote are present (skips gracefully otherwise). Commit/push/PR progress streams over the same run SSE.
- **Deploy packaging** — `scripts/setup.sh` (deps → build → migrate → seed), `deploy/systemd/*.service`, `deploy/Caddyfile` (SSE-safe), and a clone-and-deploy agent prompt at the repo root (`AGENT_DEPLOY_PROMPT.md`).

`pnpm build` and `pnpm test` are green; the loop was verified against live Postgres/Redis: worktree created → shell edit produced a real 1-file diff → run reached `waiting_review` → **Approve & ship** wrote commit `edb129e3…` and pushed branch `agentplane/d2-r1-…` to the repo.

- **Phase 3 — concurrency safety + crash recovery.** A **Redis-Lua project lock** (`SET NX PX`) is the runtime source of truth, persisted to `project_locks` and renewed by a **heartbeat**; the partial-unique index is the DB backstop (one `held` row per project+branch). Write runs **block-wait** for a busy lock (up to `LOCK_WAIT_SECONDS`) instead of failing. A **reconciliation loop** expires `held` rows whose Redis key has vanished. **Crash recovery**: BullMQ stalled-detection re-delivers a dead worker's job; the runner discards the half-built workspace, frees the stale lock, bumps `attempt`, and **re-runs on a fresh workspace** (step sequence continues, so the crashed attempt stays in the timeline). **Timeout policy**: total (`run.timeout_seconds`) + **silent-output watchdog** (`SILENT_TIMEOUT_SECONDS`) → `timed_out`; user **stop** → `cancelled` (diff still collected). New endpoints: `POST /runs/:id/retry`, `GET /projects/:id/locks`, `POST /projects/:id/locks/:lockId/release` (force-release). Portal shows active locks + force-release + run retry.

  Verified by chaos test against live infra: two writes on the same project+branch **serialised** (the 2nd waited for the lock); `kill -9` of a busy worker → job recovered onto a fresh workspace (`attempt 2`, "recovered after worker crash"); the DB guarantee — no `(project, branch)` ever has >1 held lock — held throughout; force-release, reconcile, and retry all confirmed.

## Deliberately deferred (later phases)

- **Phase 3 (remaining)** `systemd-run` cgroup resource limits + Docker sandboxing of the agent; control-channel `input` (answering `waiting_user_input`).
- **Phase 4** CI/CD (GitHub Actions webhooks, compose previews, deployments/rollback) — tables for these are not yet migrated.
- **Phase 5** multi-user RBAC guards + `audit_logs` write-path + Audit UI.
- **Phase 6** daily Demand Stack scheduler.
- **Security hardening**: argon2id (currently scrypt), `node-pty` (currently piped spawn), unprivileged `agentplane-agent` user + cgroup confinement.

See per-area specs in [`docs/architecture/`](docs/architecture/).
