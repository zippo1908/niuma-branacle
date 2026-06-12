/**
 * Minimal forward-only SQL migrator: applies every `migrations/*.sql` file in
 * lexical order inside a transaction, recording applied names in `_migrations`.
 * (expand-only discipline — see 11-mvp-roadmap.)
 */
import { config as loadEnv } from "dotenv";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
// load the monorepo-root .env (scripts run from the package dir)
loadEnv({ path: join(here, "..", "..", "..", ".env") });
loadEnv();
// migrations live next to src (repo) and dist (built); resolve relative to repo root of the package
const migrationsDir = join(here, "..", "migrations");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { max: 1 });

  await sql`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const already = await sql`SELECT 1 FROM _migrations WHERE name = ${file}`;
    if (already.length > 0) {
      console.log(`· skip ${file} (already applied)`);
      continue;
    }
    const ddl = readFileSync(join(migrationsDir, file), "utf8");
    console.log(`→ applying ${file}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(ddl);
      await tx`INSERT INTO _migrations (name) VALUES (${file})`;
    });
    console.log(`✓ applied ${file}`);
  }

  await sql.end();
  console.log("migrations up to date");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
