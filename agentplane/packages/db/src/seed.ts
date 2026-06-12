/**
 * Idempotent seed for the single-user MVP: one org, one superadmin user, the
 * three reference agent profiles (claude/codex/shell), and base system settings.
 */
import { config as loadEnv } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "@agentplane/shared";
import { createDb } from "./client.js";
import * as schema from "./schema.js";
import { eq } from "drizzle-orm";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(here, "..", "..", "..", ".env") });
loadEnv();

async function main() {
  const { db, sql } = createDb();

  // org
  let org = (await db.select().from(schema.organizations).where(eq(schema.organizations.slug, "default")))[0];
  if (!org) {
    org = (await db.insert(schema.organizations).values({ slug: "default", name: "Default Org" }).returning())[0]!;
    console.log("✓ org created");
  }

  // user
  const email = process.env.SEED_USER_EMAIL ?? "admin@agentplane.local";
  const password = process.env.SEED_USER_PASSWORD ?? "changeme";
  let user = (await db.select().from(schema.users).where(eq(schema.users.email, email)))[0];
  if (!user) {
    user = (
      await db
        .insert(schema.users)
        .values({ email, passwordHash: hashPassword(password), displayName: "Admin", isSuperadmin: true })
        .returning()
    )[0]!;
    console.log(`✓ user ${email} created (password from SEED_USER_PASSWORD)`);
  }

  // agent profiles
  const profiles = [
    {
      slug: "claude-code",
      name: "Claude Code",
      executor: "claude",
      binaryPath: "/usr/local/bin/claude",
      defaultArgs: ["-p", "--output-format", "stream-json", "--verbose"],
      envAllowlist: ["HOME", "PATH", "ANTHROPIC_API_KEY"],
      supportsVision: true,
      allowedRunModes: ["analysis", "edit", "test"] as const,
    },
    {
      slug: "codex",
      name: "Codex CLI",
      executor: "codex",
      binaryPath: "/usr/local/bin/codex",
      defaultArgs: ["exec", "--json"],
      envAllowlist: ["HOME", "PATH", "OPENAI_API_KEY"],
      supportsVision: true,
      allowedRunModes: ["analysis", "edit", "test"] as const,
    },
    {
      slug: "shell",
      name: "Shell (templated commands)",
      executor: "shell",
      binaryPath: "/bin/bash",
      defaultArgs: [],
      envAllowlist: ["HOME", "PATH"],
      supportsVision: false,
      allowedRunModes: ["analysis", "edit", "test", "build", "deploy"] as const,
    },
  ];
  for (const p of profiles) {
    const exists = (await db.select().from(schema.agentProfiles).where(eq(schema.agentProfiles.slug, p.slug)))[0];
    if (!exists) {
      await db.insert(schema.agentProfiles).values({ ...p, allowedRunModes: [...p.allowedRunModes] });
      console.log(`✓ agent profile ${p.slug} created`);
    }
  }

  // system settings
  const settings = [
    { key: "worker.concurrency", value: 2, description: "global max concurrent runs" },
    { key: "workspace.retention_days", value: 7, description: "days to keep cleaned workspaces" },
    {
      key: "uploads.mime_allowlist",
      value: ["image/png", "image/jpeg", "image/webp", "image/gif", "text/plain", "application/pdf"],
      description: "accepted attachment MIME types",
    },
    {
      key: "automation.auto_run_low_risk",
      value: false,
      description: "Phase 6: when planning, auto-trigger low-risk demands (still stops at waiting_review)",
    },
  ];
  for (const s of settings) {
    await db
      .insert(schema.systemSettings)
      .values({ key: s.key, value: s.value as never, description: s.description })
      .onConflictDoNothing();
  }
  console.log("✓ system settings ensured");

  await sql.end();
  console.log("seed complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
