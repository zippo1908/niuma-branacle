/**
 * Project RBAC (docs/architecture/07 §7, 09). Roles are ordered; a higher role
 * includes every lower role's permissions. Superadmin bypasses project roles.
 */
export const MEMBER_ROLES = ["viewer", "developer", "reviewer", "admin", "owner"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export function roleRank(role: MemberRole): number {
  return MEMBER_ROLES.indexOf(role);
}

export function roleAtLeast(role: MemberRole | null | undefined, min: MemberRole): boolean {
  if (!role) return false;
  return roleRank(role) >= roleRank(min);
}

/** Minimum role required per capability (the 07 §7 matrix). */
export const REQUIRED_ROLE = {
  read: "viewer",
  demandWrite: "developer", // create/edit demand, upload, run/stop/retry
  review: "reviewer", // approve/reject, commit/push/pr, deploy staging
  admin: "admin", // deploy production, force-release lock, project settings, manage members
} as const;
export type Capability = keyof typeof REQUIRED_ROLE;
