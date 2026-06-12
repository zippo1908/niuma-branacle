import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import type Redis from "ioredis";
import { schema } from "@agentplane/db";
import { getDb } from "./db.js";
import { config } from "./config.js";

/**
 * Project lock (docs/architecture/02, 03 §2.13, 09 lock design).
 *
 * Redis is the runtime source of truth (atomic Lua SET NX PX); the project_locks
 * table is the durable audit + crash-recovery record. A partial unique index
 * (one `held` row per project+branch) is the DB-layer backstop. While a run holds
 * the lock a heartbeat renews both the Redis TTL and last_heartbeat_at.
 */

const ACQUIRE = `return redis.call('set', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2])`;
const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export function lockKey(projectId: string, branch: string): string {
  return `lock:${projectId}:${branch}`;
}

export class LockTimeoutError extends Error {
  constructor(public readonly branch: string) {
    super(`timed out waiting for project lock on branch ${branch}`);
    this.name = "LockTimeoutError";
  }
}

export interface HeldLock {
  lockId: string;
  token: string;
  key: string;
  stop: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ProjectLockManager {
  constructor(private readonly redis: Redis) {}

  /** Block until the lock is acquired or `timeoutMs` elapses. Calls onWait once if it has to queue. */
  async acquire(opts: {
    projectId: string;
    branch: string;
    runId: string;
    ttlMs: number;
    timeoutMs: number;
    onWait?: () => void | Promise<void>;
  }): Promise<HeldLock> {
    const db = getDb();
    const key = lockKey(opts.projectId, opts.branch);
    const token = randomUUID();
    const deadline = Date.now() + opts.timeoutMs;
    let waited = false;

    for (;;) {
      const ok = await this.redis.eval(ACQUIRE, 1, key, token, String(opts.ttlMs));
      if (ok) break;
      if (!waited) {
        waited = true;
        if (opts.onWait) await opts.onWait();
      }
      if (Date.now() >= deadline) throw new LockTimeoutError(opts.branch);
      await sleep(500);
    }

    // we now own the Redis lock → any 'held' PG row for this project+branch is stale
    await db
      .update(schema.projectLocks)
      .set({ status: "expired" })
      .where(and(eq(schema.projectLocks.projectId, opts.projectId), eq(schema.projectLocks.branch, opts.branch), eq(schema.projectLocks.status, "held")));

    const [row] = await db
      .insert(schema.projectLocks)
      .values({
        projectId: opts.projectId,
        branch: opts.branch,
        lockKey: key,
        holderRunId: opts.runId,
        holderWorkerId: config.workerId,
        status: "held",
        expiresAt: new Date(Date.now() + opts.ttlMs),
        lastHeartbeatAt: new Date(),
      })
      .returning();

    const lockId = row!.id;
    const heartbeat = setInterval(() => {
      void this.renew(key, token, opts.ttlMs, lockId);
    }, Math.max(2000, Math.floor(opts.ttlMs / 3)));

    const stop = async () => {
      clearInterval(heartbeat);
      await this.redis.eval(RELEASE, 1, key, token);
      await getDb().update(schema.projectLocks).set({ status: "released", releasedAt: new Date() }).where(eq(schema.projectLocks.id, lockId));
    };

    return { lockId, token, key, stop };
  }

  private async renew(key: string, token: string, ttlMs: number, lockId: string): Promise<void> {
    const ok = await this.redis.eval(RENEW, 1, key, token, String(ttlMs));
    if (ok) {
      await getDb()
        .update(schema.projectLocks)
        .set({ lastHeartbeatAt: new Date(), expiresAt: new Date(Date.now() + ttlMs) })
        .where(eq(schema.projectLocks.id, lockId));
    }
  }

  /** Force-release a specific lock id (admin). Removes the Redis key + marks PG row. */
  async forceRelease(lockId: string, releasedByUserId?: string): Promise<void> {
    const db = getDb();
    const lock = (await db.select().from(schema.projectLocks).where(eq(schema.projectLocks.id, lockId)))[0];
    if (!lock) return;
    await this.redis.del(lock.lockKey);
    await db
      .update(schema.projectLocks)
      .set({ status: "force_released", releasedAt: new Date(), releasedBy: releasedByUserId ?? null })
      .where(eq(schema.projectLocks.id, lockId));
  }

  /** Reconciliation: expire any 'held' PG row whose Redis key has vanished (dead holder). */
  async reconcile(): Promise<number> {
    const db = getDb();
    const held = await db.select().from(schema.projectLocks).where(eq(schema.projectLocks.status, "held"));
    let expired = 0;
    for (const lock of held) {
      const exists = await this.redis.exists(lock.lockKey);
      if (!exists) {
        await db.update(schema.projectLocks).set({ status: "expired", releasedAt: new Date() }).where(eq(schema.projectLocks.id, lock.id));
        expired++;
      }
    }
    return expired;
  }
}

/** True if a run is in a non-terminal, non-queued state — i.e. a crashed attempt to recover. */
export function isCrashedState(status: string): boolean {
  return ["preparing_workspace", "running", "waiting_user_input"].includes(status);
}

export const lockTtlMs = () => Math.max(30_000, Number(process.env.LOCK_TTL_SECONDS ?? "60") * 1000);
export const lockWaitMs = () => Math.max(10_000, Number(process.env.LOCK_WAIT_SECONDS ?? "1800") * 1000);
