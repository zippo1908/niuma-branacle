/**
 * Real-time event envelope shared by worker (producer), API (SSE relay) and
 * portal (consumer). See docs/architecture/07 §8.
 */

export type RunEventType =
  | "run.created"
  | "run.queued"
  | "workspace.created"
  | "lock.acquired"
  | "lock.released"
  | "agent.started"
  | "agent.output"
  | "command.started"
  | "command.finished"
  | "step.updated"
  | "diff.generated"
  | "approval.requested"
  | "commit.created"
  | "push.completed"
  | "pr.created"
  | "run.succeeded"
  | "run.failed"
  | "run.cancelled"
  | "run.timed_out";

export interface RunEvent<P = Record<string, unknown>> {
  /** monotonic per-run sequence — the SSE Last-Event-ID resume anchor */
  seq: number;
  runId: string;
  type: RunEventType;
  /** ISO-8601 */
  ts: string;
  payload: P;
}

export type LogStream = "stdout" | "stderr" | "event";

export interface LogLine {
  stream: LogStream;
  content: string;
}

/** Redis channel names (control vs events are deliberately separate). */
export const channels = {
  events: (runId: string) => `run:${runId}:events`,
  control: (runId: string) => `run:${runId}:control`,
};

/** BullMQ queue names shared by API (producer) and worker (consumer). */
export const QUEUES = {
  agentRuns: "agent-runs",
  projectClone: "project-clone",
  gitOps: "git-ops",
} as const;

export type GitOpAction = "commit" | "push" | "create_pr" | "ship";

export type ControlMessage =
  | { type: "stop"; reason?: string }
  | { type: "input"; text: string };

/** Coded error envelope used across API responses (07 §0). */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}
