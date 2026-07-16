// Production-only least-privilege database bootstrap.
// MIGRATION_DATABASE_URL is a bootstrap/admin DSN to an existing maintenance DB.
// DATABASE_URL is the dedicated autopilot_app runtime DSN. The admin credential is
// never passed to the serving container.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import { safeOperationalSummary } from "../src/security/operational-error.js";

const APP_ROLE = "autopilot_app";
const APP_DATABASE = "autopilot";
const OTHER_ROLE = "memoryagent_app";
const APP_CONNECTION_LIMIT = 10;
const BOOTSTRAP_CONNECT_TIMEOUT_MS = 10_000;
const BOOTSTRAP_QUERY_TIMEOUT_MS = 60_000;
const BOOTSTRAP_STATEMENT_TIMEOUT_MS = 55_000;
// A fixed two-int key serializes bootstraps that use the same maintenance DB.
// We fail fast instead of letting two redeploys race CREATE/ALTER/migration work.
const BOOTSTRAP_LOCK_KEY_1 = 1_096_110_159;
const BOOTSTRAP_LOCK_KEY_2 = 1_347_043_412;

export interface BootstrapConfig {
  migrationUrl: string;
  runtimeUrl: string;
  appPassword: string;
  otherDatabase: string;
  applySchema: boolean;
}

export function bootstrapConfig(env: NodeJS.ProcessEnv = process.env): BootstrapConfig {
  const migrationUrl = env.MIGRATION_DATABASE_URL?.trim() ?? "";
  const runtimeUrl = env.DATABASE_URL?.trim() ?? "";
  const appPassword = env.AUTOPILOT_APP_DB_PASSWORD ?? "";
  const otherDatabase = env.MEMORY_DATABASE_NAME?.trim() ?? "";
  const applySchemaValue = env.BOOTSTRAP_APPLY_SCHEMA?.trim() ?? "";
  if (!migrationUrl || !runtimeUrl || appPassword.length < 32 || !/^[a-z][a-z0-9_]{0,62}$/.test(otherDatabase)) {
    throw new Error("MIGRATION_DATABASE_URL, DATABASE_URL, MEMORY_DATABASE_NAME and a 32+ character AUTOPILOT_APP_DB_PASSWORD are required");
  }
  if (applySchemaValue !== "0" && applySchemaValue !== "1") {
    throw new Error("BOOTSTRAP_APPLY_SCHEMA must be explicitly set to 0 (ordinary redeploy) or 1 (first/expand release)");
  }
  const migration = parsedPostgresUrl(migrationUrl, "MIGRATION_DATABASE_URL");
  const runtime = parsedPostgresUrl(runtimeUrl, "DATABASE_URL");
  if (migration.username === APP_ROLE) throw new Error("MIGRATION_DATABASE_URL must use a bootstrap/admin role, not autopilot_app");
  if (runtime.username !== APP_ROLE || decodeURIComponent(runtime.pathname.slice(1)) !== APP_DATABASE) {
    throw new Error("DATABASE_URL must use role autopilot_app and database autopilot");
  }
  if (decodeURIComponent(runtime.password) !== appPassword) {
    throw new Error("DATABASE_URL password must match AUTOPILOT_APP_DB_PASSWORD");
  }
  if (migration.hostname !== runtime.hostname || effectivePort(migration) !== effectivePort(runtime)) {
    throw new Error("migration and runtime DSNs must target the same PostgreSQL service");
  }
  if (otherDatabase === APP_DATABASE) throw new Error("MEMORY_DATABASE_NAME must identify the neighbouring database, not autopilot");
  return { migrationUrl, runtimeUrl, appPassword, otherDatabase, applySchema: applySchemaValue === "1" };
}

function parsedPostgresUrl(value: string, name: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${name} must be a valid PostgreSQL URL`); }
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol) || !parsed.username || !parsed.hostname || !parsed.pathname.slice(1)) {
    throw new Error(`${name} must include PostgreSQL scheme, user, host and database`);
  }
  return parsed;
}

function effectivePort(url: URL): string {
  return url.port || "5432";
}

function databaseUrl(source: string, database: string): string {
  const url = new URL(source);
  url.pathname = `/${database}`;
  return url.toString();
}

function bootstrapClient(connectionString: string, application_name: string, connectMs = BOOTSTRAP_CONNECT_TIMEOUT_MS): Client {
  return new Client({
    connectionString,
    application_name,
    connectionTimeoutMillis: connectMs,
    query_timeout: BOOTSTRAP_QUERY_TIMEOUT_MS,
    statement_timeout: BOOTSTRAP_STATEMENT_TIMEOUT_MS,
  });
}

async function roleExists(client: Client, role: string): Promise<boolean> {
  const result = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  return (result.rowCount ?? 0) === 1;
}

async function databaseExists(client: Client, database: string): Promise<boolean> {
  const result = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
  return (result.rowCount ?? 0) === 1;
}

async function withBootstrapLock<T>(config: BootstrapConfig, operation: () => Promise<T>): Promise<T> {
  const lockClient = bootstrapClient(config.migrationUrl, "autopilot-db-bootstrap-lock");
  await lockClient.connect();
  let acquired = false;
  try {
    const result = await lockClient.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::int, $2::int) AS acquired",
      [BOOTSTRAP_LOCK_KEY_1, BOOTSTRAP_LOCK_KEY_2]
    );
    acquired = result.rows[0]?.acquired === true;
    if (!acquired) throw new Error("another database bootstrap is already in progress");
    return await operation();
  } finally {
    if (acquired) {
      await lockClient.query("SELECT pg_advisory_unlock($1::int, $2::int)", [BOOTSTRAP_LOCK_KEY_1, BOOTSTRAP_LOCK_KEY_2]).catch(() => {});
    }
    await lockClient.end().catch(() => {});
  }
}

async function prepareCluster(config: BootstrapConfig): Promise<void> {
  const admin = bootstrapClient(config.migrationUrl, "autopilot-db-bootstrap");
  await admin.connect();
  try {
    const capability = await admin.query<{ rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>(
      "SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user"
    );
    const current = capability.rows[0];
    if (!current || (!current.rolsuper && (!current.rolcreatedb || !current.rolcreaterole))) {
      throw new Error("migration role must be superuser or have both CREATEDB and CREATEROLE");
    }
    if (!await databaseExists(admin, config.otherDatabase)) {
      throw new Error("configured MEMORY_DATABASE_NAME does not exist; cross-database isolation cannot be verified");
    }
    if (!await roleExists(admin, OTHER_ROLE)) {
      throw new Error("memoryagent_app role does not exist; neighbouring isolation cannot be attested");
    }

    // CREATE DATABASE is the sole cluster operation PostgreSQL forbids inside a
    // transaction. Create an absent, still-unused database first; every password,
    // membership, ownership and ACL mutation below then commits atomically.
    if (!await databaseExists(admin, APP_DATABASE)) await admin.query(`CREATE DATABASE ${APP_DATABASE}`);

    await admin.query("BEGIN");
    try {
      if (!await roleExists(admin, APP_ROLE)) await admin.query(`CREATE ROLE ${APP_ROLE} LOGIN`);
      const memberships = await admin.query<{ parent_role: string }>(
        `SELECT quote_ident(parent.rolname) AS parent_role
           FROM pg_auth_members membership
           JOIN pg_roles parent ON parent.oid = membership.roleid
           JOIN pg_roles member ON member.oid = membership.member
          WHERE member.rolname = $1`,
        [APP_ROLE]
      );
      for (const membership of memberships.rows) {
        await admin.query(`REVOKE ${membership.parent_role} FROM ${APP_ROLE}`);
      }
      const quoted = await admin.query<{ literal: string }>("SELECT quote_literal($1) AS literal", [config.appPassword]);
      await admin.query(
        `ALTER ROLE ${APP_ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${APP_CONNECTION_LIMIT} PASSWORD ${quoted.rows[0]!.literal}`
      );
      const adminIdentifier = await admin.query<{ identifier: string }>("SELECT quote_ident(current_user) AS identifier");
      await admin.query(`ALTER DATABASE ${APP_DATABASE} OWNER TO ${adminIdentifier.rows[0]!.identifier}`);
      await admin.query(`REVOKE ALL PRIVILEGES ON DATABASE ${APP_DATABASE} FROM PUBLIC`);
      await admin.query(`REVOKE ALL PRIVILEGES ON DATABASE ${APP_DATABASE} FROM ${APP_ROLE}`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${APP_DATABASE} FROM ${OTHER_ROLE}`);
      await admin.query(`GRANT CONNECT ON DATABASE ${APP_DATABASE} TO ${APP_ROLE}`);
      // Autopilot owns only its own role/database. Never mutate any ACL on the
      // neighbouring Memory database from this release path—not even an explicit
      // grant to autopilot_app. Prove effective denial and require the Memory
      // deployment/operator to repair its own boundary if it is not already closed.
      const crossPrivilege = await admin.query<{ can_connect: boolean }>(
        "SELECT has_database_privilege($1, $2, 'CONNECT') AS can_connect",
        [APP_ROLE, config.otherDatabase]
      );
      if (crossPrivilege.rows[0]?.can_connect !== false) {
        throw new Error("neighbouring Memory database must revoke PUBLIC CONNECT before Autopilot bootstrap");
      }
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK").catch(() => {});
      throw error;
    }
  } finally {
    await admin.end();
  }
}

function stripComments(fragment: string): string {
  return fragment.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
}

async function migrateAndGrant(config: BootstrapConfig): Promise<void> {
  const targetAdmin = bootstrapClient(databaseUrl(config.migrationUrl, APP_DATABASE), "autopilot-db-migration");
  await targetAdmin.connect();
  try {
    let statements: string[] = [];
    if (config.applySchema) {
      const here = dirname(fileURLToPath(import.meta.url));
      const schema = await readFile(join(here, "..", "src", "db", "schema.sql"), "utf8");
      statements = stripComments(schema).split(";").map((statement) => statement.trim()).filter(Boolean);
    }
    await targetAdmin.query("BEGIN");
    try {
      for (const statement of statements) await targetAdmin.query(statement);
      const adminIdentifier = await targetAdmin.query<{ identifier: string }>("SELECT quote_ident(current_user) AS identifier");
      await targetAdmin.query(`ALTER SCHEMA public OWNER TO ${adminIdentifier.rows[0]!.identifier}`);
      for (const table of ["agent_memory", "ap_workitems", "ap_daily_quota", "ap_process_tickets"]) {
        await targetAdmin.query(`ALTER TABLE public.${table} OWNER TO ${adminIdentifier.rows[0]!.identifier}`);
      }
      await targetAdmin.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
      await targetAdmin.query(`REVOKE ALL ON SCHEMA public FROM ${APP_ROLE}`);
      await targetAdmin.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
      await targetAdmin.query("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC");
      await targetAdmin.query("REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC");
      await targetAdmin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${APP_ROLE}`);
      await targetAdmin.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${APP_ROLE}`);
      if (await roleExists(targetAdmin, OTHER_ROLE)) {
        await targetAdmin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${OTHER_ROLE}`);
        await targetAdmin.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${OTHER_ROLE}`);
      }
      await targetAdmin.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
           public.agent_memory,
           public.ap_workitems,
           public.ap_daily_quota,
           public.ap_process_tickets
         TO ${APP_ROLE}`
      );
      await targetAdmin.query("ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC");
      await targetAdmin.query("ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC");
      await targetAdmin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${APP_ROLE}`);
      await targetAdmin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${APP_ROLE}`);
      await targetAdmin.query("COMMIT");
    } catch (err) {
      await targetAdmin.query("ROLLBACK").catch(() => {});
      throw err;
    }
  } finally {
    await targetAdmin.end();
  }
}

async function verifyIsolation(config: BootstrapConfig): Promise<void> {
  const runtime = bootstrapClient(config.runtimeUrl, "autopilot-db-verification");
  await runtime.connect();
  try {
    const identity = await runtime.query<{ current_user: string; current_database: string }>(
      "SELECT current_user, current_database() AS current_database"
    );
    if (identity.rows[0]?.current_user !== APP_ROLE || identity.rows[0]?.current_database !== APP_DATABASE) {
      throw new Error("runtime DSN did not resolve to the dedicated autopilot role/database");
    }
    const role = await runtime.query<{
      rolcanlogin: boolean; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolinherit: boolean;
      rolreplication: boolean; rolbypassrls: boolean; rolconnlimit: number;
    }>("SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls, rolconnlimit FROM pg_roles WHERE rolname = current_user");
    const flags = role.rows[0];
    if (!flags || !flags.rolcanlogin || flags.rolsuper || flags.rolcreatedb || flags.rolcreaterole || flags.rolinherit
      || flags.rolreplication || flags.rolbypassrls || flags.rolconnlimit !== APP_CONNECTION_LIMIT) {
      throw new Error("autopilot_app retained a forbidden PostgreSQL role capability");
    }
    const membership = await runtime.query<{ membership_count: string }>(
      `SELECT count(*)::text AS membership_count
         FROM pg_auth_members
        WHERE member = (SELECT oid FROM pg_roles WHERE rolname = current_user)`
    );
    if (membership.rows[0]?.membership_count !== "0") {
      throw new Error("autopilot_app retained a PostgreSQL role membership");
    }
    const database = await runtime.query<{ owned: boolean; can_create: boolean; can_temp: boolean }>(
      `SELECT d.datdba = r.oid AS owned,
              has_database_privilege(current_user, current_database(), 'CREATE') AS can_create,
              has_database_privilege(current_user, current_database(), 'TEMP') AS can_temp
         FROM pg_database d JOIN pg_roles r ON r.rolname = current_user
        WHERE d.datname = current_database()`
    );
    if (database.rows[0]?.owned || database.rows[0]?.can_create || database.rows[0]?.can_temp) {
      throw new Error("autopilot_app retained database ownership, CREATE, or TEMP");
    }
    const schema = await runtime.query<{ owned: boolean; can_create: boolean; can_use: boolean }>(
      `SELECT n.nspowner = r.oid AS owned,
              has_schema_privilege(current_user, 'public', 'CREATE') AS can_create,
              has_schema_privilege(current_user, 'public', 'USAGE') AS can_use
         FROM pg_namespace n JOIN pg_roles r ON r.rolname = current_user
        WHERE n.nspname = 'public'`
    );
    if (schema.rows[0]?.owned || schema.rows[0]?.can_create || !schema.rows[0]?.can_use) {
      throw new Error("autopilot_app schema privilege set is not exact USAGE-only");
    }
    const tablePrivileges = await runtime.query<{
      relname: string; owned: boolean; can_select: boolean; can_insert: boolean; can_update: boolean;
      can_delete: boolean; truncate: boolean; references: boolean; trigger: boolean;
    }>(
      `SELECT c.relname, c.relowner = r.oid AS owned,
              has_table_privilege(current_user, c.oid, 'SELECT') AS can_select,
              has_table_privilege(current_user, c.oid, 'INSERT') AS can_insert,
              has_table_privilege(current_user, c.oid, 'UPDATE') AS can_update,
              has_table_privilege(current_user, c.oid, 'DELETE') AS can_delete,
              has_table_privilege(current_user, c.oid, 'TRUNCATE') AS truncate,
              has_table_privilege(current_user, c.oid, 'REFERENCES') AS references,
              has_table_privilege(current_user, c.oid, 'TRIGGER') AS trigger
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_roles r ON r.rolname = current_user
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')`
    );
    const expectedTables = new Set(["agent_memory", "ap_workitems", "ap_daily_quota", "ap_process_tickets"]);
    const observedExpected = new Set<string>();
    for (const row of tablePrivileges.rows) {
      if (expectedTables.has(row.relname)) {
        observedExpected.add(row.relname);
        if (row.owned || !row.can_select || !row.can_insert || !row.can_update || !row.can_delete
          || row.truncate || row.references || row.trigger) {
          throw new Error("autopilot_app expected-table privileges are not exact DML");
        }
      } else if (row.owned || row.can_select || row.can_insert || row.can_update || row.can_delete
        || row.truncate || row.references || row.trigger) {
        throw new Error("autopilot_app retained access to an unexpected public table");
      }
    }
    if (observedExpected.size !== expectedTables.size) {
      throw new Error("autopilot_app expected-table privilege set is incomplete");
    }
    const sequencePrivileges = await runtime.query<{
      owned: boolean; can_use: boolean; can_select: boolean; can_update: boolean;
    }>(
      `SELECT c.relowner = r.oid AS owned,
              has_sequence_privilege(current_user, c.oid, 'USAGE') AS can_use,
              has_sequence_privilege(current_user, c.oid, 'SELECT') AS can_select,
              has_sequence_privilege(current_user, c.oid, 'UPDATE') AS can_update
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_roles r ON r.rolname = current_user
        WHERE n.nspname = 'public' AND c.relkind = 'S'`
    );
    if (sequencePrivileges.rows.some((row) => row.owned || row.can_use || row.can_select || row.can_update)) {
      throw new Error("autopilot_app retained access to a public sequence");
    }
    await runtime.query("SELECT 1 FROM agent_memory LIMIT 1");
    await runtime.query("SELECT 1 FROM ap_workitems LIMIT 1");
    await runtime.query("SELECT 1 FROM ap_daily_quota LIMIT 1");
    await runtime.query("SELECT 1 FROM ap_process_tickets LIMIT 1");
  } finally {
    await runtime.end();
  }

  const cross = bootstrapClient(databaseUrl(config.runtimeUrl, config.otherDatabase), "autopilot-cross-db-verification", 5_000);
  try {
    await cross.connect();
    throw new Error("autopilot_app unexpectedly retained CONNECT on the Memory database");
  } catch (err) {
    if ((err as NodeJS.ErrnoException & { code?: string }).code !== "42501") throw err;
  } finally {
    await cross.end().catch(() => {});
  }
}

async function main(): Promise<void> {
  const config = bootstrapConfig();
  await withBootstrapLock(config, async () => {
    await prepareCluster(config);
    await migrateAndGrant(config);
    await verifyIsolation(config);
  });
  console.log(
    `Dedicated autopilot_app role, ${config.applySchema ? "bounded schema application" : "schema-preserving ordinary redeploy"}, `
    + "exact grants and cross-database isolation verified."
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`Database bootstrap failed: ${safeOperationalSummary(err, "database-bootstrap")}`);
    process.exit(1);
  });
}
