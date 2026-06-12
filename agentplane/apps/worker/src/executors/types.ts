import type { RunMode } from "@agentplane/shared";

export interface ExecutorProfile {
  executor: string; // claude | codex | shell
  binaryPath: string | null;
  defaultArgs: string[];
  envAllowlist: string[];
}

export interface ExecContext {
  workspacePath: string;
  prompt: string;
  runMode: RunMode;
  profile: ExecutorProfile;
  projectSettings: Record<string, unknown>;
  emit: (stream: "stdout" | "stderr", content: string) => Promise<void>;
  signal: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
}

export interface Executor {
  readonly kind: string;
  run(ctx: ExecContext): Promise<ExecResult>;
}

/** Filter the process env down to the profile allowlist (docs/architecture/04 §4.1). */
export function filteredEnv(allowlist: string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of allowlist) {
    if (process.env[key] !== undefined) out[key] = process.env[key];
  }
  return out;
}
