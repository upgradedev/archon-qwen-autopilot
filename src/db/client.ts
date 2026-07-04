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

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set (point it at your pgvector database).");
  }
  pool = new Pool({
    connectionString,
    max: Number(process.env.PGPOOL_MAX ?? 5),
    application_name: "archon-qwen-autopilot",
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
