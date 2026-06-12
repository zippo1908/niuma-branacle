import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import type { Queue } from "bullmq";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { schema, type Database } from "@agentplane/db";
import {
  assertDemandTransition,
  sanitizeFilename,
  orderForStack,
  needsHuman,
  PLANNABLE_STATUSES,
  type DemandStatus,
  type RunMode,
  type RiskLevel,
} from "@agentplane/shared";
import type { Request } from "express";
import { Req } from "@nestjs/common";
import { DB, RUN_QUEUE } from "../infra/infra.module.js";
import { AuthGuard, type AuthedUser } from "../auth/auth.guard.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { assertProjectRole } from "../rbac.js";
import { writeAudit, clientIp } from "../audit.js";
import { config } from "../config.js";

const MIME_ALLOWLIST = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "text/plain", "application/pdf"]);

@Controller("demands")
@UseGuards(AuthGuard)
export class DemandsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(RUN_QUEUE) private readonly runQueue: Queue,
  ) {}

  @Get()
  async list(@Query("project_id") projectId?: string, @Query("status") status?: string) {
    const conds = [];
    if (projectId) conds.push(eq(schema.demands.projectId, projectId));
    if (status) conds.push(eq(schema.demands.status, status as DemandStatus));
    const where = conds.length ? and(...conds) : undefined;
    return this.db.select().from(schema.demands).where(where).orderBy(desc(schema.demands.createdAt)).limit(100);
  }

  @Post()
  async create(
    @CurrentUser() user: AuthedUser,
    @Body()
    body: {
      project_id?: string;
      title?: string;
      description?: string;
      acceptance_criteria?: string;
      target_branch?: string;
      run_mode?: RunMode;
      priority?: number;
    },
  ) {
    if (!body.project_id || !body.title) {
      throw new BadRequestException({ error: { code: "MISSING_FIELDS", message: "project_id and title are required" } });
    }
    const project = (await this.db.select().from(schema.projects).where(eq(schema.projects.id, body.project_id)))[0];
    if (!project) throw new NotFoundException({ error: { code: "NOT_FOUND", message: "project not found" } });
    await assertProjectRole(this.db, user, project.id, "demandWrite");

    const [{ max }] = await this.db
      .select({ max: sql<number>`coalesce(max(${schema.demands.number}), 0)` })
      .from(schema.demands)
      .where(eq(schema.demands.projectId, project.id));

    const [demand] = await this.db
      .insert(schema.demands)
      .values({
        projectId: project.id,
        number: Number(max) + 1,
        title: body.title,
        description: body.description ?? null,
        acceptanceCriteria: body.acceptance_criteria ?? null,
        targetBranch: body.target_branch ?? project.defaultBranch,
        runMode: body.run_mode ?? "edit",
        priority: body.priority ?? 3,
        ownerId: user.id,
        status: "inbox",
      })
      .returning();
    return demand;
  }

  // ── Daily Demand Stack (Phase 6) — declared before :id so "stack" isn't an id ──

  @Get("stack")
  async stack(@Query("date") date?: string) {
    const day = date ?? new Date().toISOString().slice(0, 10);
    return this.db
      .select()
      .from(schema.demands)
      .where(eq(schema.demands.scheduledDate, day))
      .orderBy(asc(schema.demands.stackOrder));
  }

  /**
   * Plan a day's stack: score eligible demands, assign scheduled_date +
   * stack_order, flag needs-human, and (if automation.auto_run_low_risk is on)
   * auto-trigger low-risk demands — which still stop at waiting_review. The iron
   * rule: automation never bypasses review (docs/architecture/06, 11 Phase 6).
   */
  @Post("stack/plan")
  async plan(@CurrentUser() user: AuthedUser, @Query("date") date?: string, @Query("project_id") projectId?: string) {
    const day = date ?? new Date().toISOString().slice(0, 10);
    const conds = [inArray(schema.demands.status, [...PLANNABLE_STATUSES])];
    if (projectId) conds.push(eq(schema.demands.projectId, projectId));
    const candidates = await this.db.select().from(schema.demands).where(and(...conds));

    const ordered = orderForStack(
      candidates.map((d) => ({ id: d.id, priority: d.priority, riskLevel: d.riskLevel as RiskLevel, retryCount: d.retryCount, createdAt: d.createdAt, status: d.status })),
    );

    const autoRunSetting = (await this.db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, "automation.auto_run_low_risk")))[0];
    const autoRun = autoRunSetting?.value === true;

    const plan: { id: string; number: number; title: string; needs_human: boolean; auto_ran: boolean }[] = [];
    let order = 0;
    for (const o of ordered) {
      const d = candidates.find((c) => c.id === o.id)!;
      order += 1;
      // a previously-failed demand re-boards the next day → counts as a retry
      const retryCount = d.status === "failed" ? d.retryCount + 1 : d.retryCount;
      const nh = needsHuman({ retryCount, riskLevel: d.riskLevel as RiskLevel });
      const labels = nh && !d.labels.includes("needs-human") ? [...d.labels, "needs-human"] : d.labels;
      await this.db.update(schema.demands).set({ scheduledDate: day, stackOrder: order, labels, retryCount, updatedAt: new Date() }).where(eq(schema.demands.id, d.id));

      let autoRan = false;
      if (autoRun && !nh && (d.riskLevel === "low") && (d.status === "inbox" || d.status === "clarified")) {
        await this.autoEnqueueRun(d, user.id);
        autoRan = true;
      }
      plan.push({ id: d.id, number: d.number, title: d.title, needs_human: nh, auto_ran: autoRan });
    }
    return { date: day, count: plan.length, auto_run_enabled: autoRun, stack: plan };
  }

  /** Create + enqueue a run for a planned demand (terminus is waiting_review). */
  private async autoEnqueueRun(demand: typeof schema.demands.$inferSelect, userId: string) {
    const shell = (await this.db.select().from(schema.agentProfiles).where(eq(schema.agentProfiles.slug, "shell")))[0];
    const profileId = demand.targetAgentProfileId ?? shell?.id;
    if (!profileId) return;
    await this.moveDemandToQueued(demand.id, demand.status as DemandStatus);
    const [run] = await this.db
      .insert(schema.agentRuns)
      .values({ demandId: demand.id, projectId: demand.projectId, agentProfileId: profileId, runMode: demand.runMode, status: "queued", triggeredBy: userId })
      .returning();
    await this.runQueue.add("run", { runId: run!.id }, { removeOnComplete: 100, attempts: 2 });
  }

  @Get(":id")
  async detail(@Param("id") id: string) {
    const demand = (await this.db.select().from(schema.demands).where(eq(schema.demands.id, id)))[0];
    if (!demand) throw new NotFoundException({ error: { code: "NOT_FOUND", message: "demand not found" } });
    const [comments, attachments, runs] = await Promise.all([
      this.db.select().from(schema.demandComments).where(eq(schema.demandComments.demandId, id)).orderBy(schema.demandComments.createdAt),
      this.db.select().from(schema.demandAttachments).where(eq(schema.demandAttachments.demandId, id)),
      this.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.demandId, id)).orderBy(desc(schema.agentRuns.createdAt)),
    ]);
    return { ...demand, comments, attachments, runs };
  }

  @Post(":id/run")
  async run(
    @CurrentUser() user: AuthedUser,
    @Param("id") id: string,
    @Body() body: { agent_profile_id?: string; run_mode?: RunMode; dangerous_mode?: boolean },
    @Req() req: Request,
  ) {
    const demand = (await this.db.select().from(schema.demands).where(eq(schema.demands.id, id)))[0];
    if (!demand) throw new NotFoundException({ error: { code: "NOT_FOUND", message: "demand not found" } });
    await assertProjectRole(this.db, user, demand.projectId, "demandWrite");

    // resolve agent profile: explicit → demand default → 'shell' (loop runs without an external agent binary)
    let profileId = body.agent_profile_id ?? demand.targetAgentProfileId ?? null;
    if (!profileId) {
      const shell = (await this.db.select().from(schema.agentProfiles).where(eq(schema.agentProfiles.slug, "shell")))[0];
      profileId = shell?.id ?? null;
    }
    if (!profileId) throw new BadRequestException({ error: { code: "NO_AGENT", message: "no agent profile available" } });

    const runMode = body.run_mode ?? (demand.runMode as RunMode);

    // auto-clarify so a single tap can run an inbox demand (MVP single-user)
    await this.moveDemandToQueued(demand.id, demand.status as DemandStatus);

    const [run] = await this.db
      .insert(schema.agentRuns)
      .values({
        demandId: demand.id,
        projectId: demand.projectId,
        agentProfileId: profileId,
        runMode,
        status: "queued",
        triggeredBy: user.id,
        dangerousMode: body.dangerous_mode ?? false,
      })
      .returning();

    await this.runQueue.add("run", { runId: run!.id }, { removeOnComplete: 100, attempts: 2 });
    await writeAudit(this.db, { actorId: user.id, ip: clientIp(req), action: "run.trigger", resourceType: "run", resourceId: run!.id, payload: { demand_id: demand.id, run_mode: runMode } });
    return { run_id: run!.id, status: "queued" };
  }

  private async moveDemandToQueued(demandId: string, from: DemandStatus) {
    const path: DemandStatus[] =
      from === "inbox" ? ["clarified", "queued"] : from === "clarified" || from === "failed" ? ["queued"] : [];
    let cur = from;
    for (const next of path) {
      assertDemandTransition(cur, next);
      await this.db.update(schema.demands).set({ status: next, updatedAt: new Date() }).where(eq(schema.demands.id, demandId));
      cur = next;
    }
  }

  @Post(":id/comments")
  async comment(@CurrentUser() user: AuthedUser, @Param("id") id: string, @Body() body: { body?: string }) {
    if (!body.body) throw new BadRequestException({ error: { code: "MISSING_FIELDS", message: "body is required" } });
    const [c] = await this.db
      .insert(schema.demandComments)
      .values({ demandId: id, authorId: user.id, kind: "user", body: body.body })
      .returning();
    return c;
  }

  @Post(":id/attachments")
  @UseInterceptors(FilesInterceptor("files", 10, { limits: { fileSize: config.maxUploadBytes } }))
  async attachments(
    @CurrentUser() user: AuthedUser,
    @Param("id") id: string,
    @UploadedFiles() files: Array<{ originalname: string; mimetype: string; size: number; buffer: Buffer }>,
  ) {
    if (!files?.length) throw new BadRequestException({ error: { code: "NO_FILES", message: "no files uploaded" } });
    const saved = [];
    for (const f of files) {
      if (!MIME_ALLOWLIST.has(f.mimetype)) {
        throw new BadRequestException({ error: { code: "BAD_MIME", message: `disallowed mime ${f.mimetype}` } });
      }
      const sha256 = createHash("sha256").update(f.buffer).digest("hex");
      const now = new Date();
      const dir = join(config.uploadsDir, String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, "0"));
      mkdirSync(dir, { recursive: true });
      const ext = extname(f.originalname).slice(0, 10);
      const storagePath = join(dir, `${sha256}${ext}`);
      writeFileSync(storagePath, f.buffer);
      const [row] = await this.db
        .insert(schema.demandAttachments)
        .values({
          demandId: id,
          uploaderId: user.id,
          originalFilename: f.originalname,
          safeFilename: sanitizeFilename(f.originalname),
          mimeType: f.mimetype,
          sizeBytes: f.size,
          sha256,
          storagePath,
        })
        .returning();
      saved.push({ id: row!.id, safe_filename: row!.safeFilename, size: row!.sizeBytes });
    }
    return saved;
  }
}
