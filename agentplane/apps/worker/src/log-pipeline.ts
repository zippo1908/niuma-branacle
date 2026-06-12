import { appendFileSync, closeSync, openSync } from "node:fs";
import { join } from "node:path";
import type Redis from "ioredis";
import { eq, sql } from "drizzle-orm";
import { redact, channels, type RunEventType, type LogStream } from "@agentplane/shared";
import { schema, type Database } from "@agentplane/db";
import { config } from "./config.js";

/**
 * The single log/event out-gate (docs/architecture/04 step 7): each line is
 *   raw → /logs/{run}.log (0600)   →   redact   →   run_logs (DB)   →   Redis publish.
 * `seq` is monotonic per run and is the SSE Last-Event-ID resume anchor.
 */
export class LogPipeline {
  private seq = 0;
  private readonly logFile: string;

  constructor(
    private readonly runId: string,
    private readonly db: Database,
    private readonly pub: Redis,
  ) {
    this.logFile = join(config.dirs.logs, `${runId}.log`);
    // create with 0600 if absent
    try {
      closeSync(openSync(this.logFile, "a", 0o600));
    } catch {
      /* ignore */
    }
  }

  async init(): Promise<void> {
    const row = await this.db
      .select({ max: sql<number>`coalesce(max(${schema.runLogs.seq}), 0)` })
      .from(schema.runLogs)
      .where(eq(schema.runLogs.runId, this.runId));
    this.seq = Number(row[0]?.max ?? 0);
  }

  private async persist(stream: LogStream, content: string): Promise<number> {
    const seq = ++this.seq;
    const safe = redact(content);
    await this.db.insert(schema.runLogs).values({ runId: this.runId, seq, stream, content: safe });
    return seq;
  }

  /** Append agent stdout/stderr. Raw goes to disk; redacted goes to DB + SSE. */
  async log(stream: "stdout" | "stderr", content: string): Promise<void> {
    appendFileSync(this.logFile, content.endsWith("\n") ? content : content + "\n");
    const trimmed = content.replace(/\n$/, "");
    if (!trimmed) return;
    const seq = await this.persist(stream, trimmed);
    await this.pub.publish(
      channels.events(this.runId),
      JSON.stringify({
        seq,
        runId: this.runId,
        type: "agent.output",
        ts: new Date().toISOString(),
        payload: { stream, content: redact(trimmed) },
      }),
    );
  }

  /** Emit a structured run event (workspace.created, diff.generated, run.succeeded, ...). */
  async event(type: RunEventType, payload: Record<string, unknown>): Promise<void> {
    const seq = await this.persist("event", JSON.stringify({ type, ...payload }));
    await this.pub.publish(
      channels.events(this.runId),
      JSON.stringify({ seq, runId: this.runId, type, ts: new Date().toISOString(), payload }),
    );
  }
}
