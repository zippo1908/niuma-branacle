import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

export interface SpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  emit: (stream: "stdout" | "stderr", content: string) => Promise<void>;
  signal: AbortSignal;
}

/**
 * Spawn a child in its own process group, stream stdout/stderr line-by-line to
 * `emit`, and on abort do SIGTERM → 5s → SIGKILL on the whole group
 * (docs/architecture/04 §3 stop, §4.3 timeout).
 */
export function spawnStreaming(opts: SpawnOptions): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: true, // new process group so we can signal the whole tree
      stdio: ["ignore", "pipe", "pipe"],
    });

    const pending: Promise<void>[] = [];
    const attach = (name: "stdout" | "stderr", src: Readable) => {
      let buf = "";
      src.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          pending.push(opts.emit(name, line));
        }
      });
      src.on("end", () => {
        if (buf.length > 0) pending.push(opts.emit(name, buf));
      });
    };
    attach("stdout", child.stdout);
    attach("stderr", child.stderr);

    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        /* already gone */
      }
    };
    const onAbort = () => {
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 5000);
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      opts.signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", async (code) => {
      opts.signal.removeEventListener("abort", onAbort);
      await Promise.allSettled(pending);
      resolve(code ?? 0);
    });
  });
}
