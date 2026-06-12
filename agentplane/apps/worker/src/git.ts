import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** Clone (or update) a bare mirror of the project repo at `barePath`. */
export async function ensureBareRepo(repoUrl: string, barePath: string): Promise<void> {
  if (existsSync(barePath)) {
    // refresh refs; ignore failures (offline / detached dev)
    try {
      await git(["--git-dir", barePath, "fetch", "--all", "--prune"]);
    } catch {
      /* best effort */
    }
    return;
  }
  await git(["clone", "--bare", repoUrl, barePath]);
}

export async function resolveCommit(barePath: string, ref: string): Promise<string> {
  const out = await git(["--git-dir", barePath, "rev-parse", ref]);
  return out.trim();
}

/** Create a worktree at `wsPath` on a fresh branch off `baseBranch`. Returns base commit sha. */
export async function addWorktree(
  barePath: string,
  wsPath: string,
  workBranch: string,
  baseBranch: string,
): Promise<string> {
  await git(["--git-dir", barePath, "worktree", "add", "-b", workBranch, wsPath, baseBranch]);
  return resolveCommit(barePath, baseBranch);
}

/** Worktree checked out at a specific commit (detached) — used for deploys. */
export async function addDetachedWorktree(barePath: string, wsPath: string, commitSha: string): Promise<void> {
  await git(["--git-dir", barePath, "worktree", "add", "--detach", wsPath, commitSha]);
}

export async function removeWorktree(barePath: string, wsPath: string): Promise<void> {
  try {
    await git(["--git-dir", barePath, "worktree", "remove", "--force", wsPath]);
  } catch {
    /* best effort cleanup */
  }
}

/** Commit everything currently in the worktree; returns the new commit sha. */
export async function commitWorktree(wsPath: string, message: string): Promise<string> {
  await git(["add", "-A"], wsPath);
  await git(
    ["-c", "user.name=AgentPlane", "-c", "user.email=agentplane@localhost", "commit", "-m", message],
    wsPath,
  );
  return (await git(["rev-parse", "HEAD"], wsPath)).trim();
}

/** Push the worktree's branch to its origin (the project's real remote). */
export async function pushWorktree(wsPath: string, branch: string): Promise<string> {
  return git(["push", "origin", `HEAD:refs/heads/${branch}`], wsPath);
}

export interface DiffResult {
  patch: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  summary: { path: string; insertions: number; deletions: number }[];
  isEmpty: boolean;
}

/** Stage everything and capture the staged diff + numstat (docs/architecture/04 step 10). */
export async function collectDiff(wsPath: string): Promise<DiffResult> {
  await git(["add", "-A"], wsPath);
  const patch = await git(["diff", "--staged"], wsPath);
  const numstat = await git(["diff", "--staged", "--numstat"], wsPath);
  const summary: DiffResult["summary"] = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [ins, del, ...rest] = trimmed.split("\t");
    const path = rest.join("\t");
    const i = ins === "-" ? 0 : Number(ins);
    const d = del === "-" ? 0 : Number(del);
    insertions += i;
    deletions += d;
    summary.push({ path, insertions: i, deletions: d });
  }
  return {
    patch,
    filesChanged: summary.length,
    insertions,
    deletions,
    summary,
    isEmpty: summary.length === 0,
  };
}
