import type { Request } from "express";
import { schema, type Database } from "@agentplane/db";

/** Append an audit row. Never throws into the request path (audit must not break actions). */
export async function writeAudit(
  db: Database,
  entry: { actorId?: string | null; ip?: string | null; action: string; resourceType?: string; resourceId?: string; payload?: Record<string, unknown> },
): Promise<void> {
  try {
    await db.insert(schema.auditLogs).values({
      actorId: entry.actorId ?? null,
      actorIp: entry.ip ?? null,
      action: entry.action,
      resourceType: entry.resourceType ?? null,
      resourceId: entry.resourceId ?? null,
      payload: (entry.payload ?? {}) as never,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[audit] failed to write", entry.action, err);
  }
}

export function clientIp(req: Request): string | null {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string") return xff.split(",")[0]!.trim();
  return req.socket?.remoteAddress ?? null;
}
