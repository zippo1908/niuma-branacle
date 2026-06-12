import { mkdirSync, copyFileSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { safeJoin, assertValidSlug } from "@agentplane/shared";
import { ensureBareRepo, addWorktree } from "./git.js";
import { config } from "./config.js";

export interface AttachmentRef {
  storagePath: string;
  safeFilename: string;
  sha256: string;
}

export interface PreparedWorkspace {
  path: string;
  barePath: string;
  baseCommit: string;
  workBranch: string;
}

async function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (d) => hash.update(d))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

export class WorkspaceManager {
  /**
   * Create an isolated git worktree for a run and copy in attachments.
   * (docs/architecture/05-workspace-isolation, 04 steps 3–4.)
   */
  static async create(opts: {
    projectSlug: string;
    repoUrl: string;
    bareRepoPath: string | null;
    runId: string;
    demandNumber: number;
    attempt: number;
    baseBranch: string;
    attachments: AttachmentRef[];
  }): Promise<PreparedWorkspace> {
    assertValidSlug(opts.projectSlug);
    const barePath = opts.bareRepoPath ?? join(config.dirs.projects, `${opts.projectSlug}.git`);
    await ensureBareRepo(opts.repoUrl, barePath);

    const wsPath = safeJoin(config.dirs.workspaces, opts.projectSlug, `${opts.runId}-a${opts.attempt}`);
    const workBranch = `agentplane/d${opts.demandNumber}-r${opts.attempt}-${opts.runId.slice(0, 8)}`;
    const baseCommit = await addWorktree(barePath, wsPath, workBranch, opts.baseBranch);

    if (opts.attachments.length > 0) {
      const attDir = safeJoin(wsPath, "attachments");
      mkdirSync(attDir, { recursive: true });
      for (const a of opts.attachments) {
        const dest = safeJoin(attDir, a.safeFilename);
        copyFileSync(a.storagePath, dest);
        const actual = await sha256OfFile(dest);
        if (actual !== a.sha256) {
          throw new Error(`attachment sha256 mismatch for ${a.safeFilename} (expected ${a.sha256}, got ${actual})`);
        }
      }
    }

    return { path: wsPath, barePath, baseCommit, workBranch };
  }
}
