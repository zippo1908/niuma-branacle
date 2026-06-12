import { Worker, type ConnectionOptions } from "bullmq";
import IORedis from "ioredis";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { QUEUES, channels, type ControlMessage, type GitOpAction } from "@agentplane/shared";
import { schema } from "@agentplane/db";
import { config, ensureDataDirs } from "./config.js";
import { bullConnection } from "./redis.js";
import { getDb } from "./db.js";
import { processRun } from "./runner.js";
import { processGitOp } from "./gitops.js";
import { ensureBareRepo } from "./git.js";

ensureDataDirs();
console.log(`[worker] ${config.workerId} starting (concurrency=${config.workerConcurrency})`);
console.log(`[worker] data dir: ${config.dataDir}`);

// ── agent-run consumer ────────────────────────────────────────────────────────
const runWorker = new Worker(
  QUEUES.agentRuns,
  async (job) => {
    const runId = job.data.runId as string;
    const ac = new AbortController();
    // listen for stop on the control channel (docs/architecture/04 §7)
    const control = new IORedis(config.redisUrl);
    await control.subscribe(channels.control(runId));
    control.on("message", (_chan, raw) => {
      try {
        const msg = JSON.parse(raw) as ControlMessage;
        if (msg.type === "stop") ac.abort();
      } catch {
        /* ignore malformed control message */
      }
    });
    try {
      await processRun(runId, ac.signal);
    } finally {
      await control.quit().catch(() => {});
    }
  },
  { connection: bullConnection as unknown as ConnectionOptions, concurrency: config.workerConcurrency },
);

runWorker.on("failed", (job, err) => {
  console.error(`[worker] run ${job?.data?.runId} failed:`, err.message);
});
runWorker.on("completed", (job) => {
  console.log(`[worker] run ${job.data.runId} processed`);
});

// ── project-clone consumer ────────────────────────────────────────────────────
const cloneWorker = new Worker(
  QUEUES.projectClone,
  async (job) => {
    const projectId = job.data.projectId as string;
    const db = getDb();
    const project = (await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)))[0];
    if (!project) return;
    const barePath = project.bareRepoPath ?? join(config.dirs.projects, `${project.slug}.git`);
    await db.update(schema.projects).set({ cloneStatus: "cloning", bareRepoPath: barePath }).where(eq(schema.projects.id, projectId));
    try {
      await ensureBareRepo(project.repoUrl, barePath);
      await db.update(schema.projects).set({ cloneStatus: "ready" }).where(eq(schema.projects.id, projectId));
      console.log(`[worker] cloned ${project.slug} → ${barePath}`);
    } catch (err) {
      await db.update(schema.projects).set({ cloneStatus: "failed" }).where(eq(schema.projects.id, projectId));
      console.error(`[worker] clone failed for ${project.slug}:`, err);
      throw err;
    }
  },
  { connection: bullConnection as unknown as ConnectionOptions, concurrency: 2 },
);

// ── git-ops consumer (commit / push / create_pr / ship) ───────────────────────
const gitOpsWorker = new Worker(
  QUEUES.gitOps,
  async (job) => {
    const { runId, action, message, title, body } = job.data as {
      runId: string;
      action: GitOpAction;
      message?: string;
      title?: string;
      body?: string;
    };
    await processGitOp(runId, action, { message, title, body });
  },
  { connection: bullConnection as unknown as ConnectionOptions, concurrency: 2 },
);
gitOpsWorker.on("failed", (job, err) => {
  console.error(`[worker] git-op ${job?.data?.action} for run ${job?.data?.runId} failed:`, err.message);
});

async function shutdown() {
  console.log("[worker] shutting down…");
  await Promise.allSettled([runWorker.close(), cloneWorker.close(), gitOpsWorker.close()]);
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
