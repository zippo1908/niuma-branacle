import { config as loadEnv } from "dotenv";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", ".."); // apps/api/src → agentplane root
loadEnv({ path: join(repoRoot, ".env") });
loadEnv();

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const dataDir = resolve(repoRoot, process.env.AGENTPLANE_DATA_DIR ?? "./.data");

export const config = {
  port: Number(process.env.API_PORT ?? "4000"),
  databaseUrl: req("DATABASE_URL"),
  redisUrl: req("REDIS_URL"),
  sessionSecret: process.env.SESSION_SECRET ?? "dev-insecure-secret-change-me",
  cookieSecure: (process.env.COOKIE_SECURE ?? "false") === "true",
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
  dataDir,
  uploadsDir: join(dataDir, "uploads"),
  logsDir: join(dataDir, "logs"),
  maxUploadBytes: 50 * 1024 * 1024,
};
