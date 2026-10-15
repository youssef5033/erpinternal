import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Schema = typeof schema;
export type DB = NodePgDatabase<Schema>;
/** A transaction or the root db — domain services accept either. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0] | DB;

const globalForDb = globalThis as unknown as { __pgPool?: Pool; __db?: DB };

function createPool() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. See .env.example.");
  return new Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 10) });
}

export const pool = globalForDb.__pgPool ?? createPool();
export const db: DB = globalForDb.__db ?? drizzle(pool, { schema });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__pgPool = pool;
  globalForDb.__db = db;
}
