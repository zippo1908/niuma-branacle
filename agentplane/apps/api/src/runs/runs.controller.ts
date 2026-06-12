import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import IORedis from "ioredis";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { schema, type Database } from "@agentplane/db";
import { channels, assertDemandTransition, type DemandStatus } from "@agentplane/shared";
import { DB, PUBLISHER } from "../infra/infra.module.js";
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

  @Post(":id/approve")
  @UseGuards(AuthGuard)
  async approve(@CurrentUser() user: AuthedUser, @Param("id") id: string, @Body() body: { comment?: string }) {
    const run = (await this.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)))[0];
    if (!run) throw new NotFoundException({ error: { code: "NOT_FOUND", message: "run not found" } });
    await this.transitionDemand(run.demandId, "accepted");
    await this.db.insert(schema.demandComments).values({
      demandId: run.demandId,
      authorId: user.id,
      kind: "system",
      body: `Diff approved${body.comment ? `: ${body.comment}` : ""}. (commit/push is Phase 2.)`,
    });
    return { run_id: id, decision: "accepted" };
  }

  @Post(":id/reject")
  @UseGuards(AuthGuard)
  async reject(@CurrentUser() user: AuthedUser, @Param("id") id: string, @Body() body: { comment?: string }) {
    const run = (await this.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)))[0];
    if (!run) throw new NotFoundException({ error: { code: "NOT_FOUND", message: "run not found" } });
    await this.transitionDemand(run.demandId, "rejected");
    await this.db.insert(schema.demandComments).values({
      demandId: run.demandId,
      authorId: user.id,
      kind: "review_feedback",
      body: body.comment ?? "Rejected.",
    });
    return { run_id: id, decision: "rejected" };
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
