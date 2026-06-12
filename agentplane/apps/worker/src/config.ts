import { config as loadEnv } from "dotenv";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", ".."); // apps/worker/src → agentplane root
loadEnv({ path: join(repoRoot, ".env") });
loadEnv();

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const dataDir = resolve(repoRoot, process.env.AGENTPLANE_DATA_DIR ?? "./.data");

export const config = {
  databaseUrl: req("DATABASE_URL"),
  redisUrl: req("REDIS_URL"),
  workerConcurrency: Number(process.env.WORKER_CONCURRENCY ?? "2"),
  dataDir,
  dirs: {
    projects: join(dataDir, "projects"),
    workspaces: join(dataDir, "workspaces"),
    uploads: join(dataDir, "uploads"),
    logs: join(dataDir, "logs"),
    artifacts: join(dataDir, "artifacts"),
  },
  workerId: `worker-${process.pid}`,
};

export function ensureDataDirs() {
  for (const d of Object.values(config.dirs)) mkdirSync(d, { recursive: true });
}
