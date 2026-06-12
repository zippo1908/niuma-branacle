import { createDb, type Database } from "@agentplane/db";
import { config } from "./config.js";

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) _db = createDb(config.databaseUrl).db;
  return _db;
}
