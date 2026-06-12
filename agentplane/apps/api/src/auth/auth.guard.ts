import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { eq } from "drizzle-orm";
import { schema, type Database } from "@agentplane/db";
import { DB } from "../infra/infra.module.js";
import { readSession } from "./session.js";

export interface AuthedUser {
  id: string;
  email: string;
  displayName: string;
  isSuperadmin: boolean;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Database) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser }>();
    const userId = readSession(req.headers.cookie);
    if (!userId) throw new UnauthorizedException({ error: { code: "UNAUTHENTICATED", message: "login required" } });
    const user = (await this.db.select().from(schema.users).where(eq(schema.users.id, userId)))[0];
    if (!user || !user.isActive || user.deletedAt) {
      throw new UnauthorizedException({ error: { code: "UNAUTHENTICATED", message: "invalid session" } });
    }
    req.user = { id: user.id, email: user.email, displayName: user.displayName, isSuperadmin: user.isSuperadmin };
    return true;
  }
}
