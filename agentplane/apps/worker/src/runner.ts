import { eq } from "drizzle-orm";
import { schema } from "@agentplane/db";
import {
  buildPrompt,
  isWriteMode,
  assertRunTransition,
  assertDemandTransition,
  type AgentRunStatus,
  type DemandStatus,
  type RunMode,
} from "@agentplane/shared";
import { getDb } from "./db.js";
import { publisher } from "./redis.js";
import { config } from "./config.js";
import { LogPipeline } from "./log-pipeline.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { makeExecutor } from "./executors/index.js";
import { collectDiff } from "./git.js";

export class LockHeldError extends Error {
  constructor(public readonly branch: string) {
    super(`project lock already held for branch ${branch}`);
    this.name = "LockHeldError";
  }
}

async function setRunStatus(runId: string, from: AgentRunStatus, to: AgentRunStatus, patch: Record<string, unknown> = {}) {
  assertRunTransition(from, to);
  await getDb().update(schema.agentRuns).set({ status: to, ...patch }).where(eq(schema.agentRuns.id, runId));
}

async function setDemandStatus(demandId: string, to: DemandStatus) {
  const db = getDb();
  const cur = (await db.select({ status: schema.demands.status }).from(schema.demands).where(eq(schema.demands.id, demandId)))[0];
  if (!cur || cur.status === to) return;
  assertDemandTransition(cur.status as DemandStatus, to);
  await db.update(schema.demands).set({ status: to, updatedAt: new Date() }).where(eq(schema.demands.id, demandId));
}

/** Process one agent_run job (docs/architecture/04 §5). */
export async function processRun(runId: string, signal: AbortSignal): Promise<void> {
  const db = getDb();
  const run = (await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)))[0];
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.status !== "queued") {
    // idempotent: a re-delivered job for an already-processed run is a no-op
    return;
  }
  const demand = (await db.select().from(schema.demands).where(eq(schema.demands.id, run.demandId)))[0]!;
  const project = (await db.select().from(schema.projects).where(eq(schema.projects.id, run.projectId)))[0]!;
  const profile = run.agentProfileId
    ? (await db.select().from(schema.agentProfiles).where(eq(schema.agentProfiles.id, run.agentProfileId)))[0]!
    : null;
  if (!profile) throw new Error(`run ${runId} has no agent profile`);

  const pipe = new LogPipeline(runId, db, publisher);
  await pipe.init();

  let stepSeq = 0;
  async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const seq = ++stepSeq;
    const [row] = await db
      .insert(schema.runSteps)
      .values({ runId, seq, name, status: "running", startedAt: new Date() })
      .returning();
    await pipe.event("step.updated", { step_seq: seq, name, status: "running" });
    try {
      const result = await fn();
      await db.update(schema.runSteps).set({ status: "succeeded", finishedAt: new Date() }).where(eq(schema.runSteps.id, row!.id));
      await pipe.event("step.updated", { step_seq: seq, name, status: "succeeded" });
      return result;
    } catch (err) {
      await db.update(schema.runSteps).set({ status: "failed", finishedAt: new Date(), meta: { error: String(err) } }).where(eq(schema.runSteps.id, row!.id));
      await pipe.event("step.updated", { step_seq: seq, name, status: "failed" });
      throw err;
    }
  }

  let lockId: string | null = null;
  const writeMode = isWriteMode(run.runMode as RunMode);
  const baseBranch = demand.targetBranch;

  try {
    await setRunStatus(runId, "queued", "preparing_workspace");
    await setDemandStatus(demand.id, "running");

    // 1. lock (write modes only)
    if (writeMode) {
      lockId = await step("acquire_lock", async () => {
        try {
          const [lock] = await db
            .insert(schema.projectLocks)
            .values({
              projectId: project.id,
              branch: baseBranch,
              lockKey: `lock:${project.id}:${baseBranch}`,
              holderRunId: runId,
              holderWorkerId: config.workerId,
              reason: `run ${runId}`,
              status: "held",
              expiresAt: new Date(Date.now() + run.timeoutSeconds * 1000),
              lastHeartbeatAt: new Date(),
            })
            .returning();
          return lock!.id;
        } catch (err: unknown) {
          if (typeof err === "object" && err && (err as { code?: string }).code === "23505") {
            throw new LockHeldError(baseBranch);
          }
          throw err;
        }
      });
      await db.update(schema.agentRuns).set({ lockId }).where(eq(schema.agentRuns.id, runId));
      await pipe.event("lock.acquired", { lock_key: `lock:${project.id}:${baseBranch}`, holder_run_id: runId });
    }

    // 2. workspace (+ attachments)
    const attachments = await db.select().from(schema.demandAttachments).where(eq(schema.demandAttachments.demandId, demand.id));
    const ws = await step("prepare_workspace", () =>
      WorkspaceManager.create({
        projectSlug: project.slug,
        repoUrl: project.repoUrl,
        bareRepoPath: project.bareRepoPath,
        runId,
        demandNumber: demand.number,
        attempt: run.attempt,
        baseBranch,
        attachments: attachments.map((a) => ({ storagePath: a.storagePath, safeFilename: a.safeFilename, sha256: a.sha256 })),
      }),
    );
    const [wsRow] = await db
      .insert(schema.workspaces)
      .values({
        runId,
        projectId: project.id,
        path: ws.path,
        baseBranch,
        workBranch: ws.workBranch,
        baseCommit: ws.baseCommit,
        status: "ready",
      })
      .returning();
    await db.update(schema.agentRuns).set({ workspaceId: wsRow!.id }).where(eq(schema.agentRuns.id, runId));
    await pipe.event("workspace.created", { path: ws.path, base_commit: ws.baseCommit, work_branch: ws.workBranch });

    // 3. prompt
    const prompt = buildPrompt({
      demandNumber: demand.number,
      title: demand.title,
      description: demand.description,
      acceptanceCriteria: demand.acceptanceCriteria,
      contextFiles: demand.contextFiles,
      attachments: attachments.map((a) => ({ safeFilename: a.safeFilename })),
      runMode: run.runMode as RunMode,
    });
    await db.update(schema.agentRuns).set({ prompt }).where(eq(schema.agentRuns.id, runId));

    // 4. run agent
    await setRunStatus(runId, "preparing_workspace", "running", { startedAt: new Date() });
    await pipe.event("agent.started", { profile_slug: profile.slug, dangerous_mode: run.dangerousMode });
    const executor = makeExecutor(profile.executor);
    const result = await step("agent_exec", () =>
      executor.run({
        workspacePath: ws.path,
        prompt,
        runMode: run.runMode as RunMode,
        profile: {
          executor: profile.executor,
          binaryPath: profile.binaryPath,
          defaultArgs: profile.defaultArgs,
          envAllowlist: profile.envAllowlist,
        },
        projectSettings: (project.settings ?? {}) as Record<string, unknown>,
        emit: (stream, content) => pipe.log(stream, content),
        signal,
      }),
    );

    // 5. diff
    const diff = await step("collect_diff", () => collectDiff(ws.path));
    await db.insert(schema.diffs).values({
      runId,
      baseCommit: ws.baseCommit,
      patch: diff.patch.length <= 1_000_000 ? diff.patch : null,
      filesChanged: diff.filesChanged,
      insertions: diff.insertions,
      deletions: diff.deletions,
      summary: diff.summary,
      isEmpty: diff.isEmpty,
    });
    await pipe.event("diff.generated", {
      files_changed: diff.filesChanged,
      insertions: diff.insertions,
      deletions: diff.deletions,
      is_empty: diff.isEmpty,
    });

    // 6. release lock
    if (lockId) {
      await db.update(schema.projectLocks).set({ status: "released", releasedAt: new Date() }).where(eq(schema.projectLocks.id, lockId));
      await pipe.event("lock.released", { lock_key: `lock:${project.id}:${baseBranch}` });
    }

    // 7. terminal status
    const ok = result.exitCode === 0;
    const finishedAt = new Date();
    if (ok) {
      const to: AgentRunStatus = diff.isEmpty ? "succeeded" : "waiting_review";
      await setRunStatus(runId, "running", to, { finishedAt, exitCode: 0 });
      await setDemandStatus(demand.id, "waiting_review");
      if (to === "waiting_review") await pipe.event("approval.requested", { kind: "diff_review" });
      await pipe.event("run.succeeded", { exit_code: 0, files_changed: diff.filesChanged });
    } else {
      await setRunStatus(runId, "running", "failed", { finishedAt, exitCode: result.exitCode, errorMessage: `exit ${result.exitCode}` });
      await setDemandStatus(demand.id, "failed");
      await pipe.event("run.failed", { exit_code: result.exitCode });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await pipe.log("stderr", `[runner] ${message}`);
    if (lockId) {
      await db.update(schema.projectLocks).set({ status: "released", releasedAt: new Date() }).where(eq(schema.projectLocks.id, lockId)).catch(() => {});
    }
    // best-effort failure transition from whatever non-terminal state we're in
    const fresh = (await db.select({ status: schema.agentRuns.status }).from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)))[0];
    if (fresh && !["succeeded", "failed", "cancelled", "timed_out", "waiting_review"].includes(fresh.status)) {
      await db.update(schema.agentRuns).set({ status: "failed", finishedAt: new Date(), errorMessage: message }).where(eq(schema.agentRuns.id, runId));
    }
    await setDemandStatus(demand.id, "failed").catch(() => {});
    await pipe.event("run.failed", { error_message: message });
    throw err;
  }
}
