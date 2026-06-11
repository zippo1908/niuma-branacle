# AgentPlane

> **Status: design phase.** This repository currently contains the full architecture specification. Implementation follows the roadmap in [`docs/architecture/11-mvp-roadmap.md`](docs/architecture/11-mvp-roadmap.md).

**AgentPlane is a self-hosted, demand-driven control plane for AI coding agents** — not another agent session UI.

You file a **Demand** (a structured, agent-ready requirement with acceptance criteria and attachments). AgentPlane schedules it, runs **Claude Code / Codex CLI / any pluggable agent** in an **isolated git worktree**, streams logs to your phone, captures the **diff**, and gates everything behind **human review** before it touches your branches — then drives the rest of the pipeline: commit → push → PR → CI → preview → staging → production, with **RBAC, audit logs, and one-click rollback**.

## Why another orchestrator?

Plenty of great open-source tools let you run coding agents in parallel worktrees or control sessions from a browser. AgentPlane targets the layer **above** that:

| Capability | Typical session UIs / worktree runners | AgentPlane |
|---|---|---|
| Run agents in isolated worktrees | ✅ | ✅ |
| Mobile-friendly remote control | some | ✅ (mobile-first PWA) |
| Survives disconnects (queue + workers, no tty babysitting) | varies | ✅ by architecture |
| **Structured backlog (Demand Stack) with daily planning** | ❌ | ✅ |
| **Mandatory diff review / approval gates — no unreviewed writes, ever** | rare | ✅ non-negotiable |
| **Write locks per project+branch (safe multi-user concurrency)** | ❌ | ✅ |
| **Demand-driven CI/CD: PR → CI → preview → staged deploys → rollback** | ❌ | ✅ |
| **RBAC, multi-user, append-only audit trail** | ❌ | ✅ |

Core stance: **the CLI agent is a replaceable executor**. The durable assets are Demands, Runs, Workspaces, Diffs, Approvals, and Deployments — all in PostgreSQL, all auditable.

## Architecture at a glance

```
Phone / Desktop → Web Portal → API → Queue (Redis/BullMQ) → Worker pool
   → isolated git worktree (+ your attachments) → Claude Code / Codex / pluggable executor
   → diff → human review → commit/push/PR → GitHub Actions → preview → deploy → audit
```

Full specification lives in [`docs/architecture/`](docs/architecture/) (00–12), decisions in [`docs/adr/`](docs/adr/), operations in [`docs/runbooks/`](docs/runbooks/).

**Stack (MVP):** Next.js · NestJS · PostgreSQL 16 + Drizzle · Redis 7 + BullMQ · Node worker with node-pty · git worktrees · GitHub Actions · Docker Compose previews · systemd + Caddy.

## Security model (short version)

- Agents run as an unprivileged user, confined to their run's workspace, under cgroup limits.
- Three isolated credential domains: model keys (agent) / deploy keys (git jobs only) / production secrets (deploy jobs only — **agents never see them**).
- Every command, log line, diff, approval, and deployment is recorded; audit log is append-only.
- Automation's hard ceiling is `waiting_review`. There is no unreviewed write path.

See [`docs/architecture/09-security.md`](docs/architecture/09-security.md) and [`SECURITY.md`](SECURITY.md).

## Self-hosting

Designed for a single Linux box first (reference: Rocky Linux 9; any systemd distro should work). Data root defaults to `/srv/agentplane` and is configurable via `AGENTPLANE_DATA_DIR`. Setup guide: [`docs/runbooks/local-dev-server-setup.md`](docs/runbooks/local-dev-server-setup.md).

## Roadmap

Phase 0 (server + headless-CLI spikes) → Phase 1 (single-user MVP: demand → run → live logs → diff) → Phase 2 (review + commit) → Phase 3 (locks + crash-safe workers) → Phase 4 (CI/CD + previews) → Phase 5 (multi-user RBAC) → Phase 6 (daily demand planning). Details: [`docs/architecture/11-mvp-roadmap.md`](docs/architecture/11-mvp-roadmap.md).

## Contributing

The most valuable contributions right now are design review and Phase 0 spike reports (headless behavior of agent CLIs across versions). See [`CONTRIBUTING.md`](CONTRIBUTING.md). Open questions that need community input: [`docs/architecture/12-open-questions.md`](docs/architecture/12-open-questions.md).

## License

TBD before first release — see the discussion in [`docs/oss/open-source-readiness.md`](docs/oss/open-source-readiness.md). Leading candidate: Apache-2.0.

---

*Docs are currently written in Chinese (the design language of the original author); English translations are planned per the readiness checklist. The README is English-first.*
