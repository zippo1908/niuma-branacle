/**
 * State machines for demands and agent runs (see docs/architecture/03-data-model §1).
 *
 * The application layer is the source of truth for legal transitions; the DB has
 * trigger-level guards as a backstop. Keeping the transition tables here (shared)
 * means API and worker validate identically.
 */

export type DemandStatus =
  | "inbox"
  | "clarified"
  | "queued"
  | "running"
  | "waiting_review"
  | "accepted"
  | "rejected"
  | "building"
  | "preview"
  | "deployed"
  | "done"
  | "failed"
  | "cancelled";

export type AgentRunStatus =
  | "queued"
  | "preparing_workspace"
  | "running"
  | "waiting_user_input"
  | "waiting_review"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export type RunMode = "analysis" | "edit" | "test" | "build" | "deploy";

export type RiskLevel = "low" | "medium" | "high" | "critical";

const DEMAND_TRANSITIONS: Record<DemandStatus, readonly DemandStatus[]> = {
  inbox: ["clarified", "cancelled"],
  clarified: ["queued", "cancelled"],
  queued: ["running", "cancelled"],
  running: ["waiting_review", "failed", "cancelled"],
  waiting_review: ["accepted", "rejected", "clarified"],
  accepted: ["building"],
  building: ["preview", "failed"],
  preview: ["deployed", "failed"],
  deployed: ["done"],
  done: [],
  failed: ["queued"], // manual retry
  rejected: [],
  cancelled: [],
};

const RUN_TRANSITIONS: Record<AgentRunStatus, readonly AgentRunStatus[]> = {
  queued: ["preparing_workspace", "cancelled", "failed"],
  preparing_workspace: ["running", "failed", "cancelled"],
  running: ["waiting_user_input", "waiting_review", "succeeded", "failed", "cancelled", "timed_out"],
  waiting_user_input: ["running", "timed_out", "cancelled"],
  // terminal
  waiting_review: [],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export const TERMINAL_RUN_STATUSES: readonly AgentRunStatus[] = [
  "waiting_review",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
];

export function isTerminalRunStatus(status: AgentRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export function canTransitionDemand(from: DemandStatus, to: DemandStatus): boolean {
  return DEMAND_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canTransitionRun(from: AgentRunStatus, to: AgentRunStatus): boolean {
  return RUN_TRANSITIONS[from]?.includes(to) ?? false;
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly entity: "demand" | "run",
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Illegal ${entity} transition: ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function assertDemandTransition(from: DemandStatus, to: DemandStatus): void {
  if (!canTransitionDemand(from, to)) throw new IllegalTransitionError("demand", from, to);
}

export function assertRunTransition(from: AgentRunStatus, to: AgentRunStatus): void {
  if (!canTransitionRun(from, to)) throw new IllegalTransitionError("run", from, to);
}

/** Write modes need a project lock + produce a diff; analysis is read-only. */
export function isWriteMode(mode: RunMode): boolean {
  return mode === "edit" || mode === "build" || mode === "deploy";
}
