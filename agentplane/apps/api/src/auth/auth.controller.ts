import { Body, Controller, Get, Inject, Post, Req, Res, UnauthorizedException, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { schema, type Database } from "@agentplane/db";
import { verifyPassword } from "@agentplane/shared";
import { DB } from "../infra/infra.module.js";
import { makeSessionCookie, clearSessionCookie } from "./session.js";
import { AuthGuard, type AuthedUser } from "./auth.guard.js";
import { CurrentUser } from "./current-user.decorator.js";

@Controller("auth")
export class AuthController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Post("login")
  async login(@Body() body: { email?: string; password?: string }, @Res({ passthrough: true }) res: Response) {
    const email = (body.email ?? "").trim().toLowerCase();
    const user = (await this.db.select().from(schema.users).where(eq(schema.users.email, email)))[0];
    if (!user || !user.passwordHash || !verifyPassword(body.password ?? "", user.passwordHash)) {
      throw new UnauthorizedException({ error: { code: "INVALID_CREDENTIALS", message: "wrong email or password" } });
    }
    await this.db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
    res.setHeader("Set-Cookie", makeSessionCookie(user.id));
    return { id: user.id, email: user.email, display_name: user.displayName, is_superadmin: user.isSuperadmin };
  }

  @Post("logout")
  logout(@Res({ passthrough: true }) res: Response) {
    res.setHeader("Set-Cookie", clearSessionCookie());
    res.status(204);
    return null;
  }

  @Get("me")
  @UseGuards(AuthGuard)
  async me(@CurrentUser() user: AuthedUser, @Req() _req: Request) {
    const memberships = await this.db
      .select({ project_id: schema.projectMembers.projectId, role: schema.projectMembers.role })
      .from(schema.projectMembers)
      .where(eq(schema.projectMembers.userId, user.id));
    return { id: user.id, email: user.email, display_name: user.displayName, is_superadmin: user.isSuperadmin, memberships };
  }
}
