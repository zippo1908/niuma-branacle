import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { schema } from "@agentplane/db";
import { getDb } from "./db.js";
import { config } from "./config.js";
import { addDetachedWorktree, removeWorktree } from "./git.js";

const exec = promisify(execFile);

/** Pull a deploy URL out of the command output (convention: a `KEY=url` line). */
function parseUrl(output: string): string | null {
  const m = output.match(/(?:PREVIEW_URL|DEPLOY_URL|AGENTPLANE_URL)\s*=\s*(\S+)/);
  return m ? m[1]! : null;
}

/**
 * Run a deployment (docs/architecture/10-cicd): check out the approved commit in
 * a detached worktree, run the project's pre-registered `deploy_<env>` command,
 * capture the URL, and record the result. Rollbacks mark their target rolled_back.
 */
export async function processDeploy(deploymentId: string): Promise<void> {
  const db = getDb();
  const dep = (await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId)))[0];
  if (!dep) throw new Error(`deployment ${deploymentId} not found`);
  const project = (await db.select().from(schema.projects).where(eq(schema.projects.id, dep.projectId)))[0]!;

  // claim it (partial unique index guarantees one 'deploying' per project+env)
  try {
    await db.update(schema.deployments).set({ status: "deploying", startedAt: new Date() }).where(eq(schema.deployments.id, deploymentId));
  } catch (err: unknown) {
    if (typeof err === "object" && err && (err as { code?: string }).code === "23505") {
      await db.update(schema.deployments).set({ status: "failed", finishedAt: new Date() }).where(eq(schema.deployments.id, deploymentId));
      throw new Error(`another deploy to ${dep.environment} is already in flight`);
    }
    throw err;
  }

  const settings = (project.settings ?? {}) as { commands?: Record<string, string>; deploy_env_allowlist?: string[] };
  const command = settings.commands?.[`deploy_${dep.environment}`] ?? settings.commands?.deploy;
  const barePath = project.bareRepoPath ?? join(config.dirs.projects, `${project.slug}.git`);
  const checkout = join(config.dirs.workspaces, project.slug, `deploy-${deploymentId}`);

  const allow = settings.deploy_env_allowlist ?? ["PATH", "HOME"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of allow) if (process.env[k] !== undefined) env[k] = process.env[k];

  let ok = false;
  let url: string | null = null;
  try {
    if (!command) throw new Error(`no deploy command for environment "${dep.environment}" (project.settings.commands.deploy_${dep.environment})`);
    await addDetachedWorktree(barePath, checkout, dep.commitSha);
    const { stdout, stderr } = await exec("/bin/bash", ["-lc", command], { cwd: checkout, env, maxBuffer: 32 * 1024 * 1024 });
    url = parseUrl(stdout + "\n" + stderr);
    ok = true;
    console.log(`[deploy] ${project.slug} → ${dep.environment} @ ${dep.commitSha.slice(0, 8)} ok${url ? ` (${url})` : ""}`);
  } catch (err) {
    console.error(`[deploy] ${project.slug} → ${dep.environment} failed:`, err instanceof Error ? err.message : err);
  } finally {
    await removeWorktree(barePath, checkout);
  }

  await db
    .update(schema.deployments)
    .set({ status: ok ? "succeeded" : "failed", url: url ?? undefined, finishedAt: new Date() })
    .where(eq(schema.deployments.id, deploymentId));

  if (ok && dep.rollbackOf) {
    await db.update(schema.deployments).set({ status: "rolled_back" }).where(eq(schema.deployments.id, dep.rollbackOf));
  }
}
