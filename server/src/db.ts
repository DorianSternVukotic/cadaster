import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url));

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
) {
  return pool.query<T>(text, params as never);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for Postgres to accept connections (compose may start it after us). */
async function waitForDb(maxAttempts = 30): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[db] not ready (attempt ${attempt}/${maxAttempts}): ${msg}`);
      await sleep(2000);
    }
  }
  throw new Error("[db] gave up waiting for database");
}

/** Apply db/init.sql idempotently so a fresh DB works without the init mount. */
async function ensureSchema(): Promise<void> {
  // db/init.sql lives at <repo>/db/init.sql; this file is <repo>/server/src/db.ts
  const initSql = join(here, "..", "..", "db", "init.sql");
  const sql = await readFile(initSql, "utf8");
  await pool.query(sql);
  console.log("[db] schema ensured");
}

export async function initDb(): Promise<void> {
  await waitForDb();
  await ensureSchema();
}
