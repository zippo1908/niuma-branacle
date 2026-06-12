import { spawnStreaming } from "./spawn.js";
import { filteredEnv, type ExecContext, type ExecResult, type Executor } from "./types.js";

/**
 * Runs ONLY pre-registered command templates from project.settings.commands,
 * keyed by run mode (test/build/deploy/edit). Never accepts a free command
 * string from a run (docs/architecture/04 §3, §4.2). Useful as the test/build
 * step and as a no-LLM way to exercise the full loop end-to-end.
 */
export class ShellExecutor implements Executor {
  readonly kind = "shell";

  async run(ctx: ExecContext): Promise<ExecResult> {
    const commands = (ctx.projectSettings.commands ?? {}) as Record<string, string>;
    const command = commands[ctx.runMode];
    if (!command) {
      await ctx.emit(
        "stdout",
        `[shell] no command template for run_mode "${ctx.runMode}" in project.settings.commands — nothing to do.`,
      );
      return { exitCode: 0 };
    }
    await ctx.emit("stdout", `$ ${command}`);
    const exitCode = await spawnStreaming({
      command: "/bin/bash",
      args: ["-lc", command],
      cwd: ctx.workspacePath,
      env: filteredEnv(ctx.profile.envAllowlist),
      emit: ctx.emit,
      signal: ctx.signal,
    });
    return { exitCode };
  }
}
