import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import type { Queue } from "bullmq";
import IORedis from "ioredis";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { schema, type Database } from "@agentplane/db";
import { channels, assertDemandTransition, type DemandStatus, type GitOpAction } from "@agentplane/shared";
import { sql } from "drizzle-orm";
import { DB, PUBLISHER, GIT_OPS_QUEUE, RUN_QUEUE } from "../infra/infra.module.js";
import { AuthGuard, type AuthedUser } from "../auth/auth.guard.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { config } from "../config.js";

function logRowToEvent(row: { seq: number; stream: string; content: string }) {
  if (row.stream === "event") {
    try {
      const parsed = JSON.parse(row.content) as { type: string };
      const { type, ...payload } = parsed;
      return { seq: row.seq, type, payload };
    } catch {
      /* fall through */
    }
  }
  return { seq: row.seq, type: "agent.output", payload: { stream: row.stream, content: row.content } };
}

@Controller("runs")
export class RunsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(PUBLISHER) private readonly pub: IORedis,
    @Inject(GIT_OPS_QUEUE) private readonly gitOps: Queue,
    @Inject(RUN_QUEUE) private readonly runQueue: Queue,
  ) {}

  @Get(":id")
  @UseGuards(AuthGuard)
  async detail(@Param("id") id: string) {
    const run = (await this.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)))[0];
    if (!run) throw new NotFoundException({ error: { code: "NOT_FOUND", message: "run not found" } });
    const [steps, workspace, diff] = await Promise.all([
      this.db.select().from(schema.runSteps).where(eq(schema.runSteps.runId, id)).orderBy(asc(schema.runSteps.seq)),
      this.db.select().from(schema.workspaces).where(eq(schema.workspaces.runId, id)),
      this.db.select().from(schema.diffs).where(eq(schema.diffs.runId, id)).orderBy(desc(schema.diffs.createdAt)).limit(1),
    ]);
    return { ...run, steps, workspace: workspace[0] ?? null, diff: diff[0] ?? null };
  }

  @Get(":id/logs")
  @UseGuards(AuthGuard)
  async logs(@Param("id") id: string, @Query("after_seq") afterSeq?: string) {
    const after = Number(afterSeq ?? "0");
    const rows = await this.db
      .select({ seq: schema.runLogs.seq, stream: schema.runLogs.stream, content: schema.runLogs.content, ts: schema.runLogs.ts })
      .from(schema.runLogs)
      .where(and(eq(schema.runLogs.runId, id), gt(schema.runLogs.seq, after)))
      .orderBy(asc(schema.runLogs.seq))
      .limit(2000);
    return rows;
  }

  @Get(":id/diff")
  @UseGuards(AuthGuard)
  async diff(@Param("id") id: string) {
    const d = (await this.db.select().from(schema.diffs).where(eq(schema.diffs.runId, id)).orderBy(desc(schema.diffs.createdAt)).limit(1))[0];
    if (!d) throw new NotFoundException({ error: { code: "NOT_FOUND", message: "no diff for run" } });
    return { summary: d.summary, files_changed: d.filesChanged, insertions: d.insertions, deletions: d.deletions, is_empty: d.isEmpty, patch: d.patch };
  }

  @Post(":id/stop")
  @UseGuards(AuthGuard)
  async stop(@Param("id") id: string) {
    await this.pub.publish(channels.control(id), JSON.stringify({ type: "stop" }));
    return { run_id: id, status: "stopping" };
  }

  @Post(":id/retry")
  @UseGuards(AuthGuard)
  async retry(@CurrentUser() user: AuthedUser, @Param("id") id: string) {
    const run = (await this.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)))[0];
    if (!run) throw new NotFoundException({ error: { code: "NOT_FOUND", message: "run not found" } });
    // demand must be re-runnable; move it back toward queued
    await this.moveDemandToQueued(run.demandId);
    const [{ maxAttempt }] = await this.db
      .select({ maxAttempt: sql<number>`coalesce(max(${schema.agentRuns.attempt}), 0)` })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.demandId, run.demandId));
    const [newRun] = await this.db
      .insert(schema.agentRuns)
      .values({
        demandId: run.demandId,
        projectId: run.projectId,
        agentProfileId: run.agentProfileId,
        runMode: run.runMode,
        status: "queued",
        attempt: Number(maxAttempt) + 1,
        triggeredBy: user.id,
        dangerousMode: run.dangerousMode,
      })
      .returning();
    await this.runQueue.add("run", { runId: newRun!.id }, { removeOnComplete: 100, attempts: 2 });
    return { new_run_id: newRun!.id, attempt: newRun!.attempt };
  }

  private async moveDemandToQueued(demandId: string) {
    const cur = (await this.db.select({ status: schema.demands.status }).from(schema.demands).where(eq(schema.demands.id, demandId)))[0];
    if (!cur) return;
    const from = cur.status as DemandStatus;
    const path: DemandStatus[] =
      from === "queued" ? []
      : from === "inbox" ? ["clarified", "queued"]
      : from === "clarified" || from === "failed" ? ["queued"]
      : from === "waiting_review" ? ["clarified", "queued"]
      : [];
    if (path.length === 0 && from !== "queued") {
      throw new BadRequestException({ error: { code: "NOT_RETRYABLE", message: `demand is ${from}` } });
    }
    let s = from;
    for (const next of path) {
      assertDemandTransition(s, next);
      await this.db.update(schema.demands).set({ status: next, updatedAt: new Date() }).where(eq(schema.demands.id, demandId));
      s = next;
    }
  }

  @Post(":id/approve")
  @UseGuards(AuthGuard)
  async approve(
    @CurrentUser() user: AuthedUser,
    @Param("id") id: string,
    @Body() body: { comment?: string },
    @Query("auto") auto?: string,
  ) {
    const run = (await this.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)))[0];
    if (!run) throw new NotFoundException({ error: { code: "NOT_FOUND", message: "run not found" } });
    const diff = (await this.db.select().from(schema.diffs).where(eq(schema.diffs.runId, id)).orderBy(desc(schema.diffs.createdAt)).limit(1))[0];
    await this.db.insert(schema.approvals).values({
      runId: id,
      demandId: run.demandId,
      kind: "diff_review",
      status: "accepted",
      reviewerId: user.id,
      comment: body.comment ?? null,
      diffId: diff?.id ?? null,
      decidedAt: new Date(),
    });
    await this.transitionDemand(run.demandId, "accepted");
    // convenience: one-tap ship = commit → push → PR (still discrete, interruptible jobs)
    if (auto === "ship") {
      await this.gitOps.add("ship", { runId: id, action: "ship" satisfies GitOpAction }, { removeOnComplete: 100, attempts: 1 });
    }
    return { run_id: id, decision: "accepted", shipping: auto === "ship" };
  }

  @Post(":id/reject")
  @UseGuards(AuthGuard)
  async reject(@CurrentUser() user: AuthedUser, @Param("id") id: string, @Body() body: { comment?: string }) {
    const run = (await this.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)))[0];
    if (!run) throw new NotFoundException({ error: { code: "NOT_FOUND", message: "run not found" } });
    await this.db.insert(schema.approvals).values({
      runId: id,
      demandId: run.demandId,
      kind: "diff_review",
      status: "changes_requested",
      reviewerId: user.id,
      comment: body.comment ?? null,
      decidedAt: new Date(),
    });
    // request-changes sends the demand back to clarified so it can be re-run with feedback
    await this.transitionDemand(run.demandId, "clarified");
    await this.db.insert(schema.demandComments).values({
      demandId: run.demandId,
      authorId: user.id,
      kind: "review_feedback",
      body: body.comment ?? "Changes requested.",
    });
    return { run_id: id, decision: "changes_requested" };
  }

  // ── Phase 2: commit / push / PR (gated on an accepted diff_review approval) ──
  private async requireAccepted(runId: string) {
    const run = (await this.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)))[0];
    if (!run) throw new NotFoundException({ error: { code: "NOT_FOUND", message: "run not found" } });
    const approved = (
      await this.db
        .select()
        .from(schema.approvals)
        .where(and(eq(schema.approvals.runId, runId), eq(schema.approvals.status, "accepted")))
        .limit(1)
    )[0];
    if (!approved) {
      throw new ForbiddenException({ error: { code: "NOT_APPROVED", message: "run has no accepted diff review" } });
    }
    if (!run.workspaceId) {
      throw new BadRequestException({ error: { code: "NO_WORKSPACE", message: "run has no workspace to commit" } });
    }
  }

  @Post(":id/commit")
  @UseGuards(AuthGuard)
  async commit(@Param("id") id: string, @Body() body: { message?: string }) {
    await this.requireAccepted(id);
    await this.gitOps.add("commit", { runId: id, action: "commit" satisfies GitOpAction, message: body.message }, { attempts: 1 });
    return { run_id: id, queued: "commit" };
  }

  @Post(":id/push")
  @UseGuards(AuthGuard)
  async push(@Param("id") id: string) {
    await this.requireAccepted(id);
    await this.gitOps.add("push", { runId: id, action: "push" satisfies GitOpAction }, { attempts: 1 });
    return { run_id: id, queued: "push" };
  }

  @Post(":id/create-pr")
  @UseGuards(AuthGuard)
  async createPr(@Param("id") id: string, @Body() body: { title?: string; body?: string }) {
    await this.requireAccepted(id);
    await this.gitOps.add(
      "create_pr",
      { runId: id, action: "create_pr" satisfies GitOpAction, title: body.title, body: body.body },
      { attempts: 1 },
    );
    return { run_id: id, queued: "create_pr" };
  }

  private async transitionDemand(demandId: string, to: DemandStatus) {
    const cur = (await this.db.select({ status: schema.demands.status }).from(schema.demands).where(eq(schema.demands.id, demandId)))[0];
    if (!cur) return;
    assertDemandTransition(cur.status as DemandStatus, to);
    await this.db.update(schema.demands).set({ status: to, updatedAt: new Date() }).where(eq(schema.demands.id, demandId));
  }

  /** SSE live stream with Last-Event-ID resume (docs/architecture/07 §4, §8). */
  @Get(":id/events")
  async events(@Param("id") id: string, @Req() req: Request, @Res() res: Response) {
    // auth via cookie (EventSource can't set headers; same-origin cookie is sent)
    const { readSession } = await import("../auth/session.js");
    if (!readSession(req.headers.cookie)) {
      res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "login required" } });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`retry: 3000\n\n`);

    const lastId = Number(req.headers["last-event-id"] ?? req.query.after_seq ?? "0");
    const backlog = await this.db
      .select({ seq: schema.runLogs.seq, stream: schema.runLogs.stream, content: schema.runLogs.content })
      .from(schema.runLogs)
      .where(and(eq(schema.runLogs.runId, id), gt(schema.runLogs.seq, lastId)))
      .orderBy(asc(schema.runLogs.seq))
      .limit(5000);
    for (const row of backlog) {
      const evt = logRowToEvent(row);
      res.write(`id: ${evt.seq}\nevent: ${evt.type}\ndata: ${JSON.stringify({ seq: evt.seq, ...evt.payload })}\n\n`);
    }

    const sub = new IORedis(config.redisUrl);
    await sub.subscribe(channels.events(id));
    sub.on("message", (_chan, raw) => {
      try {
        const evt = JSON.parse(raw) as { seq: number; type: string; payload: unknown };
        res.write(`id: ${evt.seq}\nevent: ${evt.type}\ndata: ${JSON.stringify({ seq: evt.seq, ...(evt.payload as object) })}\n\n`);
      } catch {
        /* ignore */
      }
    });
    const heartbeat = setInterval(() => res.write(`: ping\n\n`), 15000);
    const close = () => {
      clearInterval(heartbeat);
      void sub.quit();
      res.end();
    };
    req.on("close", close);
  }
}
