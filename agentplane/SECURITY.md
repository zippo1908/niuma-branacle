# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub **Security Advisories** ("Report a vulnerability" on the repo's Security tab). Do not open public issues for security problems.

You can expect an acknowledgment within 72 hours. Coordinated disclosure preferred; we'll credit reporters unless you ask otherwise.

## Scope notes for self-hosters

AgentPlane executes AI-generated code changes on your machine. Even with its isolation layers (unprivileged agent user, per-run workspaces, cgroup limits, credential domain separation, mandatory review), you should treat any host running it as a development environment, not a hardened production boundary. Read `docs/architecture/09-security.md` before exposing the portal beyond a private network, and prefer VPN/Tailscale access until 2FA lands (Phase 5).

## Known design-level caveats

- Prompt injection via repository content or attachments cannot be fully prevented; the mitigating control is that **all writes require human diff review**.
- The MVP runs agents as host processes (not containers). Container sandboxing arrives in Phase 4.
