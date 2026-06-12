import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import type { Queue } from "bullmq";
import type IORedis from "ioredis";
import { and, desc, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@agentplane/db";
import { isValidSlug } from "@agentplane/shared";
import { DB, CLONE_QUEUE, PUBLISHER } from "../infra/infra.module.js";
import { AuthGuard, type AuthedUser } from "../auth/auth.guard.js";
import { CurrentUser } from "../auth/current-user.decorator.js";

@Controller("projects")
@UseGuards(AuthGuard)
export class ProjectsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLONE_QUEUE) private readonly cloneQueue: Queue,
    @Inject(PUBLISHER) private readonly redis: IORedis,
  ) {}

  @Get()
  async list() {
    return this.db
      .select()
      .from(schema.projects)
      .where(isNull(schema.projects.deletedAt))
      .orderBy(desc(schema.projects.createdAt));
  }

  @Post()
  async create(
    @CurrentUser() user: AuthedUser,
    @Body() body: { slug?: string; name?: string; repo_url?: string; default_branch?: string },
  ) {
    const slug = (body.slug ?? "").trim();
    if (!isValidSlug(slug)) throw new BadRequestException({ error: { code: "INVALID_SLUG", message: "slug must match ^[a-z0-9-]{2,40}$" } });
    if (!body.name || !body.repo_url) throw new BadRequestException({ error: { code: "MISSING_FIELDS", message: "name and repo_url are required" } });

    const org = (await this.db.select().from(schema.organizations).where(eq(schema.organizations.slug, "default")))[0];
    if (!org) throw new BadRequestException({ error: { code: "NO_ORG", message: "default org missing — run db:seed" } });

    const [project] = await this.db
      .insert(schema.projects)
      .values({
        orgId: org.id,
        slug,
        name: body.name,
        repoUrl: body.repo_url,
        defaultBranch: body.default_branch ?? "main",
      })
      .returning();

    await this.db.insert(schema.projectMembers).values({ projectId: project!.id, userId: user.id, role: "owner" });
    await this.cloneQueue.add("clone", { projectId: project!.id }, { removeOnComplete: true, attempts: 2 });
    return project;
  }

  @Get(":id")
  async detail(@Param("id") id: string) {
    const project = (await this.db.select().from(schema.projects).where(eq(schema.projects.id, id)))[0];
    if (!project) throw new NotFoundException({ error: { code: "NOT_FOUND", message: "project not found" } });
    const activeRuns = await this.db
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.projectId, id)))
      .orderBy(desc(schema.agentRuns.createdAt))
      .limit(10);
    const locks = await this.db
      .select()
      .from(schema.projectLocks)
      .where(and(eq(schema.projectLocks.projectId, id), eq(schema.projectLocks.status, "held")));
    return { ...project, active_runs: activeRuns, locks };
  }

  @Get(":id/locks")
  async locks(@Param("id") id: string) {
    return this.db
      .select()
      .from(schema.projectLocks)
      .where(and(eq(schema.projectLocks.projectId, id), eq(schema.projectLocks.status, "held")));
  }

  /** Admin force-release of a stuck lock: drop the Redis key + mark the PG row. */
  @Post(":id/locks/:lockId/release")
  async releaseLock(@CurrentUser() user: AuthedUser, @Param("lockId") lockId: string) {
    const lock = (await this.db.select().from(schema.projectLocks).where(eq(schema.projectLocks.id, lockId)))[0];
    if (!lock) throw new NotFoundException({ error: { code: "NOT_FOUND", message: "lock not found" } });
    await this.redis.del(lock.lockKey);
    await this.db
      .update(schema.projectLocks)
      .set({ status: "force_released", releasedAt: new Date(), releasedBy: user.id })
      .where(eq(schema.projectLocks.id, lockId));
    return { lock_id: lockId, status: "force_released" };
  }
}
