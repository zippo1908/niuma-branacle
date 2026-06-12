import { ForbiddenException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@agentplane/db";
import { roleAtLeast, REQUIRED_ROLE, type Capability, type MemberRole } from "@agentplane/shared";
import type { AuthedUser } from "./auth/auth.guard.js";

export async function getProjectRole(db: Database, userId: string, projectId: string): Promise<MemberRole | null> {
  const m = (
    await db
      .select({ role: schema.projectMembers.role })
      .from(schema.projectMembers)
      .where(and(eq(schema.projectMembers.projectId, projectId), eq(schema.projectMembers.userId, userId)))
  )[0];
  return (m?.role as MemberRole) ?? null;
}

/** Throw 403 unless the user (or a superadmin) has at least the role for `capability` on `projectId`. */
export async function assertProjectRole(db: Database, user: AuthedUser, projectId: string, capability: Capability): Promise<MemberRole | "superadmin"> {
  if (user.isSuperadmin) return "superadmin";
  const role = await getProjectRole(db, user.id, projectId);
  if (!roleAtLeast(role, REQUIRED_ROLE[capability])) {
    throw new ForbiddenException({
      error: { code: "FORBIDDEN", message: `requires ${REQUIRED_ROLE[capability]} on this project (you are ${role ?? "not a member"})` },
    });
  }
  return role!;
}
