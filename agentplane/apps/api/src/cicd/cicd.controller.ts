import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import type { Queue } from "bullmq";
import { and, desc, eq } from "drizzle-orm";
import { schema, type Database } from "@agentplane/db";
import { mapGithubCiStatus, type DeployEnvironment } from "@agentplane/shared";
import { Req } from "@nestjs/common";
import type { Request } from "express";
import { DB, DEPLOY_QUEUE } from "../infra/infra.module.js";
import { AuthGuard, type AuthedUser } from "../auth/auth.guard.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { assertProjectRole } from "../rbac.js";
import { writeAudit, clientIp } from "../audit.js";
import { parseGitHubRepo, latestWorkflowRunForBranch } from "../github.js";

const ENVS: DeployEnvironment[] = ["preview", "staging", "production"];

@Controller()
@UseGuards(AuthGuard)
export class CicdController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(DEPLOY_QUEUE) private readonly deployQueue: Queue,
  ) {}

  /** Deploy the demand's committed work to an environment (gated on the right approval). */
  @Post("demands/:id/deploy")
  async deploy(
    @CurrentUser() user: AuthedUser,
    @Param("id") demandId: string,
    @Body() body: { environment?: DeployEnvironment },
    @Req() req: Request,
  ) {
    const env = body.environment;
    if (!env || !ENVS.includes(env)) throw new BadRequestException({ error: { code: "BAD_ENV", message: "environment must be preview|staging|production" } });
    const demand = (await this.db.select().from(schema.demands).where(eq(schema.demands.id, demandId)))[0];
    if (!demand) throw new NotFoundException({ error: { code: "NOT_FOUND", message: "demand not found" } });
    // staging/preview need reviewer; production needs admin (07 §7)
    await assertProjectRole(this.db, user, demand.projectId, env === "production" ? "admin" : "review");

    // the commit to deploy = the most recent run with a commit_sha
    const run = (
      await this.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.demandId, demandId)).orderBy(desc(schema.agentRuns.createdAt))
    ).find((r) => r.commitSha);
    if (!run?.commitSha) throw new BadRequestException({ error: { code: "NOTHING_TO_DEPLOY", message: "no committed run for this demand (commit it first)" } });

    // record the deploy approval (in single-user MVP the deployer is the approver)
    const [approval] = await this.db
      .insert(schema.approvals)
      .values({ runId: run.id, demandId, kind: `${env}_deploy`, status: "accepted", reviewerId: user.id, decidedAt: new Date() })
      .returning();

    const [dep] = await this.db
      .insert(schema.deployments)
      .values({ demandId, projectId: demand.projectId, environment: env, commitSha: run.commitSha, approvalId: approval!.id, deployedBy: user.id, status: "pending" })
      .returning();
    await this.deployQueue.add("deploy", { deploymentId: dep!.id }, { attempts: 1 });
    await writeAudit(this.db, { actorId: user.id, ip: clientIp(req), action: `deploy.${env}`, resourceType: "deployment", resourceId: dep!.id, payload: { demand_id: demandId, commit_sha: run.commitSha, approval_id: approval!.id } });
    return { deployment_id: dep!.id, environment: env, commit_sha: run.commitSha };
  }

  @Get("deployments")
  async list(@Query("project_id") projectId?: string, @Query("environment") environment?: string) {
    const conds = [];
    if (projectId) conds.push(eq(schema.deployments.projectId, projectId));
    if (environment) conds.push(eq(schema.deployments.environment, environment));
    return this.db
      .select()
      .from(schema.deployments)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(schema.deployments.createdAt))
      .limit(50);
  }

  /** Roll back: re-deploy the previous succeeded commit for the same project+environment. */
  @Post("deployments/:id/rollback")
  async rollback(@CurrentUser() user: AuthedUser, @Param("id") id: string, @Req() req: Request) {
    const dep = (await this.db.select().from(schema.deployments).where(eq(schema.deployments.id, id)))[0];
    if (!dep) throw new NotFoundException({ error: { code: "NOT_FOUND", message: "deployment not found" } });
    await assertProjectRole(this.db, user, dep.projectId, dep.environment === "production" ? "admin" : "review");
    void writeAudit(this.db, { actorId: user.id, ip: clientIp(req), action: `deploy.rollback.${dep.environment}`, resourceType: "deployment", resourceId: id });
    const prev = (
      await this.db
        .select()
        .from(schema.deployments)
        .where(and(eq(schema.deployments.projectId, dep.projectId), eq(schema.deployments.environment, dep.environment), eq(schema.deployments.status, "succeeded")))
        .orderBy(desc(schema.deployments.createdAt))
    ).find((d) => d.id !== dep.id && d.commitSha !== dep.commitSha);
    if (!prev) throw new BadRequestException({ error: { code: "NO_PREVIOUS", message: "no previous succeeded deployment to roll back to" } });
    const [rb] = await this.db
      .insert(schema.deployments)
      .values({ demandId: dep.demandId, projectId: dep.projectId, environment: dep.environment, commitSha: prev.commitSha, deployedBy: user.id, rollbackOf: dep.id, status: "pending" })
      .returning();
    await this.deployQueue.add("deploy", { deploymentId: rb!.id }, { attempts: 1 });
    return { deployment_id: rb!.id, rolling_back_to: prev.commitSha };
  }

  @Get("ci-jobs")
  async ciJobs(@Query("demand_id") demandId?: string) {
    if (!demandId) return [];
    return this.db.select().from(schema.ciJobs).where(eq(schema.ciJobs.demandId, demandId)).orderBy(desc(schema.ciJobs.createdAt));
  }

  /** Pull CI status from GitHub Actions for the demand's work branch (poll fallback). */
  @Post("demands/:id/ci/refresh")
  async refreshCi(@Param("id") demandId: string) {
    const demand = (await this.db.select().from(schema.demands).where(eq(schema.demands.id, demandId)))[0];
    if (!demand) throw new NotFoundException({ error: { code: "NOT_FOUND", message: "demand not found" } });
    const project = (await this.db.select().from(schema.projects).where(eq(schema.projects.id, demand.projectId)))[0]!;
    const gh = parseGitHubRepo(project.repoUrl);
    if (!gh || !process.env.GITHUB_TOKEN) {
      throw new BadRequestException({ error: { code: "NO_GITHUB", message: "needs a GitHub remote + GITHUB_TOKEN" } });
    }
    // the run/work branch produced by the latest committed run
    const run = (
      await this.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.demandId, demandId)).orderBy(desc(schema.agentRuns.createdAt))
    ).find((r) => r.commitSha);
    const ws = run ? (await this.db.select().from(schema.workspaces).where(eq(schema.workspaces.runId, run.id)))[0] : null;
    const branch = ws?.workBranch;
    if (!branch) throw new BadRequestException({ error: { code: "NO_BRANCH", message: "no work branch yet" } });
    const wr = await latestWorkflowRunForBranch(gh, branch);
    if (!wr) return { ci: null };
    const status = mapGithubCiStatus(wr.status, wr.conclusion) as never;
    await this.db
      .insert(schema.ciJobs)
      .values({ demandId, runId: run?.id, provider: "github_actions", externalId: String(wr.id), externalUrl: wr.html_url, ref: branch, status })
      .onConflictDoUpdate({ target: [schema.ciJobs.provider, schema.ciJobs.externalId], set: { status, externalUrl: wr.html_url } });
    return { ci: { status, url: wr.html_url, branch } };
  }
}
