import { Controller, Get, Inject, UseGuards } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { schema, type Database } from "@agentplane/db";
import { DB } from "../infra/infra.module.js";
import { AuthGuard } from "../auth/auth.guard.js";

@Controller("agent-profiles")
@UseGuards(AuthGuard)
export class ProfilesController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get()
  async list() {
    return this.db.select().from(schema.agentProfiles).where(eq(schema.agentProfiles.isEnabled, true));
  }
}
