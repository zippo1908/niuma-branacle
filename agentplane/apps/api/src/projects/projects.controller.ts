import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Queue } from "bullmq";
import type IORedis from "ioredis";
import type { Request } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@agentplane/db";
import { isValidSlug, MEMBER_ROLES, type MemberRole } from "@agentplane/shared";
import { DB, CLONE_QUEUE, PUBLISHER } from "../infra/infra.module.js";
import { AuthGuard, type AuthedUser } from "../auth/auth.guard.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { assertProjectRole } from "../rbac.js";
import { writeAudit, clientIp } from "../audit.js";

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
  async releaseLock(@CurrentUser() user: AuthedUser, @Param("id") projectId: string, @Param("lockId") lockId: string, @Req() req: Request) {
    await assertProjectRole(this.db, user, projectId, "admin");
    const lock = (await this.db.select().from(schema.projectLocks).where(eq(schema.projectLocks.id, lockId)))[0];
    if (!lock) throw new NotFoundException({ error: { code: "NOT_FOUND", message: "lock not found" } });
    await this.redis.del(lock.lockKey);
    await this.db
      .update(schema.projectLocks)
      .set({ status: "force_released", releasedAt: new Date(), releasedBy: user.id })
      .where(eq(schema.projectLocks.id, lockId));
    await writeAudit(this.db, { actorId: user.id, ip: clientIp(req), action: "lock.force_release", resourceType: "lock", resourceId: lockId, payload: { project_id: projectId, branch: lock.branch } });
    return { lock_id: lockId, status: "force_released" };
  }

  @Get(":id/members")
  async members(@Param("id") projectId: string) {
    return this.db
      .select({ user_id: schema.projectMembers.userId, role: schema.projectMembers.role, email: schema.users.email, display_name: schema.users.displayName })
      .from(schema.projectMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.projectMembers.userId))
      .where(eq(schema.projectMembers.projectId, projectId));
  }

  /** Grant / change a member's role (admin or owner only). */
  @Post(":id/members")
  async addMember(
    @CurrentUser() user: AuthedUser,
    @Param("id") projectId: string,
    @Body() body: { user_id?: string; role?: MemberRole },
    @Req() req: Request,
  ) {
    await assertProjectRole(this.db, user, projectId, "admin");
    if (!body.user_id || !body.role || !MEMBER_ROLES.includes(body.role)) {
      throw new BadRequestException({ error: { code: "MISSING_FIELDS", message: "user_id and a valid role are required" } });
    }
    await this.db
      .insert(schema.projectMembers)
      .values({ projectId, userId: body.user_id, role: body.role })
      .onConflictDoUpdate({ target: [schema.projectMembers.projectId, schema.projectMembers.userId], set: { role: body.role } });
    await writeAudit(this.db, { actorId: user.id, ip: clientIp(req), action: "member.grant", resourceType: "project", resourceId: projectId, payload: { user_id: body.user_id, role: body.role } });
    return { project_id: projectId, user_id: body.user_id, role: body.role };
  }
}
