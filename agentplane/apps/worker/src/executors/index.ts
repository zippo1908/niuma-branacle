import { CliExecutor } from "./cli.js";
import { ShellExecutor } from "./shell.js";
import type { Executor } from "./types.js";

export * from "./types.js";

/** Map an agent_profile.executor to its implementation (design principle #15). */
export function makeExecutor(executor: string): Executor {
  switch (executor) {
    case "claude":
      return new CliExecutor("claude");
    case "codex":
      return new CliExecutor("codex");
    case "shell":
      return new ShellExecutor();
    default:
      throw new Error(`unknown executor "${executor}"`);
  }
}
