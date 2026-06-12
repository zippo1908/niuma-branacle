import { Controller, Headers, HttpCode, Inject, Post, Req, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@agentplane/db";
import { verifyGithubSignature, mapGithubCiStatus } from "@agentplane/shared";
import { DB } from "../infra/infra.module.js";
import { config } from "../config.js";

@Controller("webhooks")
export class WebhooksController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Post("github")
  @HttpCode(200)
  async github(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers("x-hub-signature-256") signature?: string,
    @Headers("x-github-event") event?: string,
  ) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    if (!verifyGithubSignature(config.githubWebhookSecret, raw, signature)) {
      throw new UnauthorizedException({ error: { code: "BAD_SIGNATURE", message: "invalid webhook signature" } });
    }
    if (event !== "workflow_run") return { ok: true, ignored: event };

    const body = req.body as { workflow_run?: { id: number; status: string | null; conclusion: string | null; html_url: string; head_branch: string | null; head_sha: string } };
    const wr = body.workflow_run;
    if (!wr) return { ok: true };

    const status = mapGithubCiStatus(wr.status, wr.conclusion) as never;
    // link to a demand via the work branch → workspace → run
    let demandId: string | null = null;
    let runId: string | null = null;
    if (wr.head_branch) {
      const ws = (await this.db.select().from(schema.workspaces).where(eq(schema.workspaces.workBranch, wr.head_branch)))[0];
      if (ws) {
        runId = ws.runId;
        const run = (await this.db.select({ demandId: schema.agentRuns.demandId }).from(schema.agentRuns).where(eq(schema.agentRuns.id, ws.runId)))[0];
        demandId = run?.demandId ?? null;
      }
    }
    if (!demandId) return { ok: true, unlinked: true };

    await this.db
      .insert(schema.ciJobs)
      .values({ demandId, runId, provider: "github_actions", externalId: String(wr.id), externalUrl: wr.html_url, ref: wr.head_branch, status })
      .onConflictDoUpdate({ target: [schema.ciJobs.provider, schema.ciJobs.externalId], set: { status, externalUrl: wr.html_url } });
    return { ok: true, demand_id: demandId, status };
  }
}
