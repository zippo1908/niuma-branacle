import { eq, sql } from "drizzle-orm";
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
import { publisher, lockRedis } from "./redis.js";
import { LogPipeline } from "./log-pipeline.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { makeExecutor } from "./executors/index.js";
import { collectDiff, removeWorktree } from "./git.js";
import {
  ProjectLockManager,
  LockTimeoutError,
  isCrashedState,
  lockKey,
  lockTtlMs,
  lockWaitMs,
  type HeldLock,
} from "./lock.js";

const lockMgr = new ProjectLockManager(lockRedis);
const SILENT_TIMEOUT_MS = Math.max(60_000, Number(process.env.SILENT_TIMEOUT_SECONDS ?? "600") * 1000);

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

/**
 * Recover a run that a crashed worker left in flight: discard its half-built
 * workspace, free any stale lock, bump the attempt, and reset to `queued` so the
 * flow below re-runs it from a *fresh* workspace (docs/architecture/04 §6).
 */
async function recoverCrashedRun(runId: string): Promise<void> {
  const db = getDb();
  const ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.runId, runId)))[0];
  const project = (
    await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, (await db.select({ pid: schema.agentRuns.projectId }).from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)))[0]!.pid))
  )[0]!;
  if (ws) {
    const barePath = project.bareRepoPath ?? "";
    if (barePath) await removeWorktree(barePath, ws.path);
    await db.update(schema.workspaces).set({ status: "dirty" }).where(eq(schema.workspaces.id, ws.id));
  }
  // free any lock this run held
  const locks = await db.select().from(schema.projectLocks).where(eq(schema.projectLocks.holderRunId, runId));
  for (const l of locks) {
    if (l.status === "held") {
      await lockRedis.del(l.lockKey);
      await db.update(schema.projectLocks).set({ status: "expired", releasedAt: new Date() }).where(eq(schema.projectLocks.id, l.id));
    }
  }
  const run = (await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)))[0]!;
  await db
    .update(schema.agentRuns)
    .set({ status: "queued", attempt: run.attempt + 1, errorMessage: "recovered after worker crash", workspaceId: null, lockId: null })
    .where(eq(schema.agentRuns.id, runId));
}

/** Process one agent_run job (docs/architecture/04 §5). `signal` aborts on user stop. */
export async function processRun(runId: string, signal: AbortSignal): Promise<void> {
  const db = getDb();
  let run = (await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)))[0];
  if (!run) throw new Error(`run ${runId} not found`);
  if (["succeeded", "failed", "cancelled", "timed_out", "waiting_review"].includes(run.status)) return; // already terminal
  if (isCrashedState(run.status)) {
    await recoverCrashedRun(runId);
    run = (await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)))[0]!;
  }
  if (run.status !== "queued") return;

  const demand = (await db.select().from(schema.demands).where(eq(schema.demands.id, run.demandId)))[0]!;
  const project = (await db.select().from(schema.projects).where(eq(schema.projects.id, run.projectId)))[0]!;
  const profile = run.agentProfileId
    ? (await db.select().from(schema.agentProfiles).where(eq(schema.agentProfiles.id, run.agentProfileId)))[0]!
    : null;
  if (!profile) throw new Error(`run ${runId} has no agent profile`);

  const pipe = new LogPipeline(runId, db, publisher);
  await pipe.init();

  // continue the step sequence past any crashed attempt's steps (recovery-safe)
  const maxStepRow = (
    await db
      .select({ maxStep: sql<number>`coalesce(max(${schema.runSteps.seq}), 0)` })
      .from(schema.runSteps)
      .where(eq(schema.runSteps.runId, runId))
  )[0];
  let stepSeq = Number(maxStepRow?.maxStep ?? 0);
  async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const seq = ++stepSeq;
    const [row] = await db.insert(schema.runSteps).values({ runId, seq, name, status: "running", startedAt: new Date() }).returning();
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

  let held: HeldLock | null = null;
  const writeMode = isWriteMode(run.runMode as RunMode);
  const baseBranch = demand.targetBranch;

  try {
    await setRunStatus(runId, "queued", "preparing_workspace");
    await setDemandStatus(demand.id, "running");

    // 1. project lock (write modes) — block until acquired or timeout
    if (writeMode) {
      held = await step("acquire_lock", () =>
        lockMgr.acquire({
          projectId: project.id,
          branch: baseBranch,
          runId,
          ttlMs: lockTtlMs(),
          timeoutMs: lockWaitMs(),
          onWait: () => pipe.log("stdout", `[lock] waiting for project lock on ${baseBranch} (held by another run)…`),
        }),
      );
      await db.update(schema.agentRuns).set({ lockId: held.lockId }).where(eq(schema.agentRuns.id, runId));
      await pipe.event("lock.acquired", { lock_key: lockKey(project.id, baseBranch), holder_run_id: runId });
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
      .values({ runId, projectId: project.id, path: ws.path, baseBranch, workBranch: ws.workBranch, baseCommit: ws.baseCommit, status: "ready" })
      .onConflictDoUpdate({
        target: schema.workspaces.runId,
        set: { path: ws.path, workBranch: ws.workBranch, baseCommit: ws.baseCommit, status: "ready", cleanedAt: null },
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

    // 4. run agent — under a combined abort: user-stop, total timeout, silent-output watchdog
    await setRunStatus(runId, "preparing_workspace", "running", { startedAt: new Date() });
    await pipe.event("agent.started", { profile_slug: profile.slug, dangerous_mode: run.dangerousMode });

    const runAc = new AbortController();
    let stopReason: "stop" | "timeout" | null = null;
    const onExternalStop = () => {
      stopReason = "stop";
      runAc.abort();
    };
    if (signal.aborted) onExternalStop();
    else signal.addEventListener("abort", onExternalStop, { once: true });

    let lastOutput = Date.now();
    const totalTimer = setTimeout(() => {
      stopReason = "timeout";
      runAc.abort();
    }, run.timeoutSeconds * 1000);
    const silentTimer = setInterval(() => {
      if (Date.now() - lastOutput > SILENT_TIMEOUT_MS) {
        stopReason = "timeout";
        runAc.abort();
      }
    }, 15_000);

    const executor = makeExecutor(profile.executor);
    let exitCode = 0;
    try {
      const result = await step("agent_exec", () =>
        executor.run({
          workspacePath: ws.path,
          prompt,
          runMode: run.runMode as RunMode,
          profile: { executor: profile.executor, binaryPath: profile.binaryPath, defaultArgs: profile.defaultArgs, envAllowlist: profile.envAllowlist },
          projectSettings: (project.settings ?? {}) as Record<string, unknown>,
          emit: (stream, content) => {
            lastOutput = Date.now();
            return pipe.log(stream, content);
          },
          signal: runAc.signal,
        }),
      );
      exitCode = result.exitCode;
    } finally {
      clearTimeout(totalTimer);
      clearInterval(silentTimer);
      signal.removeEventListener("abort", onExternalStop);
    }

    // 5. diff (collected even on stop/timeout, for inspection)
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
    await pipe.event("diff.generated", { files_changed: diff.filesChanged, insertions: diff.insertions, deletions: diff.deletions, is_empty: diff.isEmpty });

    // 6. release lock
    if (held) {
      await held.stop();
      held = null;
      await pipe.event("lock.released", { lock_key: lockKey(project.id, baseBranch) });
    }

    // 7. terminal status
    const finishedAt = new Date();
    if (stopReason === "timeout") {
      await setRunStatus(runId, "running", "timed_out", { finishedAt, errorMessage: "timed out" });
      await setDemandStatus(demand.id, "failed");
      await pipe.event("run.timed_out", { files_changed: diff.filesChanged });
    } else if (stopReason === "stop") {
      await setRunStatus(runId, "running", "cancelled", { finishedAt });
      await setDemandStatus(demand.id, "cancelled");
      await pipe.event("run.cancelled", { files_changed: diff.filesChanged });
    } else if (exitCode === 0) {
      const to: AgentRunStatus = diff.isEmpty ? "succeeded" : "waiting_review";
      await setRunStatus(runId, "running", to, { finishedAt, exitCode: 0 });
      await setDemandStatus(demand.id, "waiting_review");
      if (to === "waiting_review") await pipe.event("approval.requested", { kind: "diff_review" });
      await pipe.event("run.succeeded", { exit_code: 0, files_changed: diff.filesChanged });
    } else {
      await setRunStatus(runId, "running", "failed", { finishedAt, exitCode, errorMessage: `exit ${exitCode}` });
      await setDemandStatus(demand.id, "failed");
      await pipe.event("run.failed", { exit_code: exitCode });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await pipe.log("stderr", `[runner] ${message}`);
    if (held) await held.stop().catch(() => {});
    const fresh = (await db.select({ status: schema.agentRuns.status }).from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)))[0];
    if (fresh && !["succeeded", "failed", "cancelled", "timed_out", "waiting_review"].includes(fresh.status)) {
      const to: AgentRunStatus = err instanceof LockTimeoutError ? "failed" : "failed";
      await db.update(schema.agentRuns).set({ status: to, finishedAt: new Date(), errorMessage: message }).where(eq(schema.agentRuns.id, runId));
    }
    await setDemandStatus(demand.id, "failed").catch(() => {});
    await pipe.event("run.failed", { error_message: message });
    throw err;
  }
}
