import type { RunMode } from "./state-machine.js";

export interface PromptInput {
  demandNumber: number;
  title: string;
  description?: string | null;
  acceptanceCriteria?: string | null;
  contextFiles?: string[];
  attachments?: { safeFilename: string }[];
  /** review_feedback comments injected on a re-run (回炉) */
  reviewFeedback?: string[];
  runMode: RunMode;
}

/**
 * Build the full prompt handed to the agent (docs/architecture/04 §5 step 5).
 * Deterministic + auditable: the exact string is stored on agent_runs.prompt.
 */
export function buildPrompt(input: PromptInput): string {
  const lines: string[] = [];
  lines.push(`# Demand #${input.demandNumber}: ${input.title}`);
  lines.push("");
  if (input.description?.trim()) {
    lines.push("## Description");
    lines.push(input.description.trim());
    lines.push("");
  }
  if (input.acceptanceCriteria?.trim()) {
    lines.push("## Acceptance criteria (must all be satisfied)");
    lines.push(input.acceptanceCriteria.trim());
    lines.push("");
  }
  if (input.contextFiles?.length) {
    lines.push("## Relevant files");
    for (const f of input.contextFiles) lines.push(`- ${f}`);
    lines.push("");
  }
  if (input.attachments?.length) {
    lines.push("## Attachments");
    lines.push("The following files were attached and copied into ./attachments/ — read them:");
    for (const a of input.attachments) lines.push(`- ./attachments/${a.safeFilename}`);
    lines.push("");
  }
  if (input.reviewFeedback?.length) {
    lines.push("## Reviewer feedback from the previous attempt — address these");
    for (const r of input.reviewFeedback) lines.push(`- ${r}`);
    lines.push("");
  }
  lines.push("## Operating rules");
  if (input.runMode === "analysis") {
    lines.push("- This is an ANALYSIS run. Do NOT modify any files. Investigate and report only.");
  } else {
    lines.push("- Make the minimal changes needed to satisfy the acceptance criteria.");
    lines.push("- Match the surrounding code style.");
  }
  lines.push("- Do NOT run `git commit`, `git push`, or open a PR — stop when the edits are done.");
  lines.push("- Do NOT touch files outside this working directory.");
  return lines.join("\n");
}
