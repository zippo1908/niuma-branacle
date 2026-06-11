# Contributing to AgentPlane

Thanks for your interest! The project is in **design phase** — the highest-value contributions today are not code.

## What helps most right now

1. **Design review.** Read `docs/architecture/` and open issues challenging specific decisions (lock granularity, worktree strategy, state machines). Reference the doc + section number.
2. **Spike reports.** Reproducible findings on headless behavior of agent CLIs (Claude Code, Codex CLI, others): exact flags, stream formats, exit-code reliability, SIGTERM behavior, version diffs. These directly shape `04-agent-runner.md`.
3. **Answers to open questions.** See `docs/architecture/12-open-questions.md`.
4. **Executor proposals** for additional agents (interface in `04-agent-runner.md` §3).

## Ground rules

- Architecture changes go through an ADR (`docs/adr/`, copy the 0001 template). PRs that contradict an accepted ADR without a superseding ADR will be declined.
- Security-relevant changes must address the threat model in `09-security.md`. **The "no unreviewed write path" invariant is non-negotiable.**
- Once code lands: TypeScript everywhere, business rules live in `packages/*` with unit tests, `pnpm build && pnpm test` must be green, conventional commits.
- Be kind. Assume good faith.

## Reporting security issues

Do **not** open public issues for vulnerabilities — see `SECURITY.md`.
