import type { RiskLevel } from "./state-machine.js";

/**
 * Daily Demand Stack scoring (docs/architecture/06 §4). Higher score = plan
 * earlier. Deterministic + pure so the API endpoint and any scheduler agree.
 */
export interface PlannableDemand {
  id: string;
  priority: number; // 1 (highest) .. 5
  riskLevel: RiskLevel;
  retryCount: number;
  createdAt: Date | string;
  status: string;
}

const RISK_WEIGHT: Record<RiskLevel, number> = { low: 0, medium: 2, high: 5, critical: 8 };

/** Demands that may NOT be auto-run; still listed but flagged for a human. */
export const NEEDS_HUMAN_RETRIES = 3;

export function needsHuman(d: { retryCount: number; riskLevel: RiskLevel }): boolean {
  return d.retryCount >= NEEDS_HUMAN_RETRIES || d.riskLevel === "critical";
}

export function scoreDemand(d: PlannableDemand, now: Date = new Date(0)): number {
  const ageDays = Math.max(0, (now.getTime() - new Date(d.createdAt).getTime()) / 86_400_000);
  const priorityScore = (6 - clampPriority(d.priority)) * 10; // p1 → 50, p5 → 10
  const ageScore = Math.min(ageDays, 14); // older bubbles up, capped
  const riskScore = RISK_WEIGHT[d.riskLevel] ?? 2;
  const retryScore = d.retryCount * 3; // previously-failed demands rise next day
  return priorityScore + ageScore + riskScore + retryScore;
}

function clampPriority(p: number): number {
  return Math.min(5, Math.max(1, Math.round(p || 3)));
}

/** Order demands for a day's stack (desc score; stable by created_at then id). */
export function orderForStack<T extends PlannableDemand>(demands: T[], now?: Date): T[] {
  return [...demands].sort((a, b) => {
    const s = scoreDemand(b, now) - scoreDemand(a, now);
    if (s !== 0) return s;
    const t = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return t !== 0 ? t : a.id.localeCompare(b.id);
  });
}

/** Statuses eligible to be planned into a day's stack. */
export const PLANNABLE_STATUSES = ["inbox", "clarified", "failed"] as const;
