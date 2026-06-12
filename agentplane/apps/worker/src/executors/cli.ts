import { existsSync } from "node:fs";
import { spawnStreaming } from "./spawn.js";
import { filteredEnv, type ExecContext, type ExecResult, type Executor } from "./types.js";

/**
 * Drives a headless agent CLI (Claude Code / Codex). The exact flags live on the
 * agent_profile (default_args) — Phase 0 spikes confirm them per CLI version, so
 * nothing is hard-coded here. The prompt is appended as the final argument.
 */
export class CliExecutor implements Executor {
  readonly kind: string;
  constructor(kind: "claude" | "codex") {
    this.kind = kind;
  }

  async run(ctx: ExecContext): Promise<ExecResult> {
    const bin = ctx.profile.binaryPath;
    if (!bin || !existsSync(bin)) {
      throw new Error(
        `agent binary not found at "${bin ?? "(unset)"}" for executor "${this.kind}". ` +
          `Install the CLI or point agent_profiles.binary_path at it.`,
      );
    }
    const args = [...ctx.profile.defaultArgs, ctx.prompt];
    await ctx.emit("stdout", `$ ${this.kind} ${ctx.profile.defaultArgs.join(" ")} <prompt>`);
    const exitCode = await spawnStreaming({
      command: bin,
      args,
      cwd: ctx.workspacePath,
      env: filteredEnv(ctx.profile.envAllowlist),
      emit: ctx.emit,
      signal: ctx.signal,
    });
    return { exitCode };
  }
}
