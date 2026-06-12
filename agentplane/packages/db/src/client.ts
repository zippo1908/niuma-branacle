import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof createDb>["db"];

export function createDb(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const sql = postgres(databaseUrl, { max: 10 });
  const db = drizzle(sql, { schema });
  return { db, sql };
}
