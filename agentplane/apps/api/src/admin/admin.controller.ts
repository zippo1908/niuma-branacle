import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Post, Query, UseGuards } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { schema, type Database } from "@agentplane/db";
import { hashPassword } from "@agentplane/shared";
import { DB } from "../infra/infra.module.js";
import { AuthGuard, type AuthedUser } from "../auth/auth.guard.js";
import { CurrentUser } from "../auth/current-user.decorator.js";

@Controller()
@UseGuards(AuthGuard)
export class AdminController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get("users")
  async listUsers() {
    return this.db
      .select({ id: schema.users.id, email: schema.users.email, display_name: schema.users.displayName, is_superadmin: schema.users.isSuperadmin })
      .from(schema.users)
      .where(eq(schema.users.isActive, true));
  }

  /** Create a user (superadmin only). Phase 5: open registration/invites would build on this. */
  @Post("users")
  async createUser(@CurrentUser() user: AuthedUser, @Body() body: { email?: string; password?: string; display_name?: string; is_superadmin?: boolean }) {
    if (!user.isSuperadmin) throw new ForbiddenException({ error: { code: "FORBIDDEN", message: "superadmin only" } });
    if (!body.email || !body.password) throw new BadRequestException({ error: { code: "MISSING_FIELDS", message: "email and password are required" } });
    const [u] = await this.db
      .insert(schema.users)
      .values({
        email: body.email.trim().toLowerCase(),
        passwordHash: hashPassword(body.password),
        displayName: body.display_name ?? body.email,
        isSuperadmin: body.is_superadmin ?? false,
      })
      .returning({ id: schema.users.id, email: schema.users.email });
    return u;
  }

  @Get("audit-logs")
  async audit(@CurrentUser() user: AuthedUser, @Query("action") action?: string, @Query("resource_id") resourceId?: string) {
    if (!user.isSuperadmin) throw new ForbiddenException({ error: { code: "FORBIDDEN", message: "superadmin only" } });
    const rows = await this.db.select().from(schema.auditLogs).orderBy(desc(schema.auditLogs.id)).limit(200);
    return rows.filter((r) => (!action || r.action === action) && (!resourceId || r.resourceId === resourceId));
  }
}
