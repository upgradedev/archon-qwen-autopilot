// PostgreSQL / pgvector connection — the agent's memory + work-item store.
//
// The store speaks the PostgreSQL wire protocol, so the standard `pg` driver
// connects unchanged against all three targets this project uses:
//   local  : a pgvector/pgvector docker container
//   CI      : the same image, as a GitHub Actions service
//   prod    : Alibaba Cloud AnalyticDB for PostgreSQL / ApsaraDB RDS for
//             PostgreSQL (pgvector extension)
// Same driver, same SQL, same vector operators everywhere.
//
// One pool per process, lazily created. `DATABASE_URL` selects the target. When
// DATABASE_URL is unset the app can still run fully in-memory (offline mode),
// so getPool() is only reached on the DB-backed code paths.

import { Pool, type PoolClient, type QueryResultRow } from "pg";

let pool: Pool | null = null;

export interface DatabasePoolConfig {
  max: number;
  connectionTimeoutMillis: number;
  query_timeout: number;
  statement_timeout: number;
}

function exactBoundedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error(`${name} must be a canonical integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function resolveDatabasePoolConfig(env: NodeJS.ProcessEnv = process.env): DatabasePoolConfig {
  const config = {
    max: exactBoundedInteger(env, "PGPOOL_MAX", 5, 1, 50),
    connectionTimeoutMillis: exactBoundedInteger(env, "PG_CONNECT_TIMEOUT_MS", 10_000, 100, 120_000),
    query_timeout: exactBoundedInteger(env, "PG_QUERY_TIMEOUT_MS", 30_000, 100, 300_000),
    statement_timeout: exactBoundedInteger(env, "PG_STATEMENT_TIMEOUT_MS", 30_000, 100, 300_000),
  };
  if (config.statement_timeout > config.query_timeout) {
    throw new Error("PG_STATEMENT_TIMEOUT_MS must not exceed PG_QUERY_TIMEOUT_MS");
  }
  return config;
}

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set (point it at your pgvector database).");
  }
  const bounded = resolveDatabasePoolConfig();
  pool = new Pool({
    connectionString,
    max: bounded.max,
    application_name: "archon-qwen-autopilot",
    // Bound both connection establishment and server/client query execution so
    // readiness and live requests cannot hold a deployment gate indefinitely.
    connectionTimeoutMillis: bounded.connectionTimeoutMillis,
    query_timeout: bounded.query_timeout,
    statement_timeout: bounded.statement_timeout,
  });
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await getPool().query<T>(text, params);
  return res.rows;
}

export async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// pgvector's `vector` type is sent/received as the text form `[0.1,0.2,0.3]`.
// The `pg` driver has no vector type parser, so we bind the literal as text and
// cast it in SQL (`$n::vector`). This helper renders a JS number[] to that form.
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
