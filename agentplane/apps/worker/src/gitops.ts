import { eq } from "drizzle-orm";
import { schema } from "@agentplane/db";
import type { GitOpAction } from "@agentplane/shared";
import { getDb } from "./db.js";
import { publisher } from "./redis.js";
import { LogPipeline } from "./log-pipeline.js";
import { commitWorktree, pushWorktree } from "./git.js";
import { createPullRequest, parseGitHubRepo } from "./github.js";

interface RunCtx {
  runId: string;
  wsPath: string;
  workBranch: string;
  baseBranch: string;
  repoUrl: string;
  demandId: string;
  demandNumber: number;
  demandTitle: string;
}

async function loadCtx(runId: string): Promise<RunCtx> {
  const db = getDb();
  const run = (await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)))[0];
  if (!run) throw new Error(`run ${runId} not found`);
  const ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.runId, runId)))[0];
  if (!ws) throw new Error(`run ${runId} has no workspace`);
  const demand = (await db.select().from(schema.demands).where(eq(schema.demands.id, run.demandId)))[0]!;
  const project = (await db.select().from(schema.projects).where(eq(schema.projects.id, run.projectId)))[0]!;
  return {
    runId,
    wsPath: ws.path,
    workBranch: ws.workBranch,
    baseBranch: ws.baseBranch,
    repoUrl: project.repoUrl,
    demandId: demand.id,
    demandNumber: demand.number,
    demandTitle: demand.title,
  };
}

/** Run a git operation for an already-reviewed run. Commit → push → PR (docs/architecture/07 §5). */
export async function processGitOp(runId: string, action: GitOpAction, opts: { message?: string; title?: string; body?: string }): Promise<void> {
  const db = getDb();
  const ctx = await loadCtx(runId);
  const pipe = new LogPipeline(runId, db, publisher);
  await pipe.init();

  const doCommit = async () => {
    const message = opts.message ?? `feat: ${ctx.demandTitle}\n\nResolves demand #${ctx.demandNumber}.`;
    await pipe.log("stdout", `$ git commit -m "${message.split("\n")[0]}"`);
    const sha = await commitWorktree(ctx.wsPath, message);
    await db.update(schema.agentRuns).set({ commitSha: sha }).where(eq(schema.agentRuns.id, runId));
    await pipe.event("commit.created", { commit_sha: sha, branch: ctx.workBranch });
    return sha;
  };
  const doPush = async () => {
    await pipe.log("stdout", `$ git push origin ${ctx.workBranch}`);
    await pushWorktree(ctx.wsPath, ctx.workBranch);
    await pipe.event("push.completed", { branch: ctx.workBranch });
  };
  const doPr = async () => {
    const gh = parseGitHubRepo(ctx.repoUrl);
    if (!gh || !process.env.GITHUB_TOKEN) {
      await pipe.log("stdout", "[pr] skipped — set GITHUB_TOKEN and use a GitHub remote to open PRs automatically.");
      return;
    }
    const title = opts.title ?? `${ctx.demandTitle} (demand #${ctx.demandNumber})`;
    const body = opts.body ?? `Automated by AgentPlane for demand #${ctx.demandNumber}.`;
    const pr = await createPullRequest(gh, { title, body, head: ctx.workBranch, base: ctx.baseBranch });
    await db.update(schema.demands).set({ linkedPrUrl: pr.html_url, updatedAt: new Date() }).where(eq(schema.demands.id, ctx.demandId));
    await pipe.event("pr.created", { url: pr.html_url, number: pr.number });
    await pipe.log("stdout", `[pr] opened ${pr.html_url}`);
  };

  try {
    if (action === "commit") await doCommit();
    else if (action === "push") await doPush();
    else if (action === "create_pr") await doPr();
    else if (action === "ship") {
      await doCommit();
      await doPush();
      await doPr();
    }
  } catch (err) {
    await pipe.log("stderr", `[gitops:${action}] ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}
