import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import pg from "pg";

const { Client } = pg;
const APP_ROLE = "autopilot_app";
const APP_DATABASE = "autopilot";
const MEMORY_ROLE = "memoryagent_app";
const MEMORY_DATABASE = "memoryagent";
const ROLLBACK_PARENT = "ci_rollback_parent";
const EXPECTED_TABLES = ["agent_memory", "ap_daily_quota", "ap_process_tickets", "ap_workitems"];

function required(name) {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const migrationUrl = required("MIGRATION_DATABASE_URL");
const runtimeUrl = required("DATABASE_URL");

// This test deliberately creates roles/databases and corrupts grants before it
// asks the production bootstrap to repair them. Make accidental execution
// against a durable or remote database impossible.
assert.equal(process.env.CI, "true", "adversarial bootstrap proof is CI-only");
assert.equal(
  process.env.AUTOPILOT_EPHEMERAL_DB_PROOF,
  "localhost-disposable-cluster",
  "explicit disposable-cluster acknowledgement is required"
);
const migrationTarget = new URL(migrationUrl);
const runtimeTarget = new URL(runtimeUrl);
assert.equal(migrationTarget.hostname, "localhost", "migration database must be localhost");
assert.equal(runtimeTarget.hostname, "localhost", "runtime database must be localhost");
assert.equal(decodeURIComponent(migrationTarget.pathname), "/postgres");
assert.equal(decodeURIComponent(runtimeTarget.pathname), `/${APP_DATABASE}`);

function databaseUrl(source, database) {
  const parsed = new URL(source);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function usingClient(connectionString, operation) {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
    statement_timeout: 25_000,
  });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

function runBootstrap(expectSuccess, label, applySchema) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const env = { ...process.env };
  if (applySchema === undefined) delete env.BOOTSTRAP_APPLY_SCHEMA;
  else env.BOOTSTRAP_APPLY_SCHEMA = applySchema ? "1" : "0";
  const result = spawnSync(command, ["run", "db:bootstrap"], {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
    timeout: 180_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `${label}: bootstrap was terminated by ${result.signal}`);
  if (expectSuccess) {
    assert.equal(result.status, 0, `${label}: bootstrap failed`);
  } else {
    assert.notEqual(result.status, 0, `${label}: unsafe prerequisite was unexpectedly accepted`);
  }
  console.log(`${label}: observed expected ${expectSuccess ? "success" : "failure"}.`);
}

async function neighbourSnapshot() {
  const cluster = await usingClient(migrationUrl, async (client) => {
    const databaseAcl = await client.query(`
      SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
             pg_get_userbyid(acl.grantor) AS grantor, acl.privilege_type, acl.is_grantable
        FROM pg_database d
        CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) acl
       WHERE d.datname = '${MEMORY_DATABASE}'
       ORDER BY grantee, grantor, acl.privilege_type, acl.is_grantable`);
    const role = await client.query(`
      SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
             rolreplication, rolbypassrls, rolconnlimit
        FROM pg_roles WHERE rolname = '${MEMORY_ROLE}'`);
    const memberships = await client.query(`
      SELECT parent.rolname AS parent_role
        FROM pg_auth_members m
        JOIN pg_roles parent ON parent.oid = m.roleid
        JOIN pg_roles member ON member.oid = m.member
       WHERE member.rolname = '${MEMORY_ROLE}'
       ORDER BY parent.rolname`);
    return { databaseAcl: databaseAcl.rows, role: role.rows, memberships: memberships.rows };
  });

  const grants = await usingClient(databaseUrl(migrationUrl, MEMORY_DATABASE), async (client) => {
    const schemaAcl = await client.query(`
      SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
             pg_get_userbyid(acl.grantor) AS grantor, acl.privilege_type, acl.is_grantable
        FROM pg_namespace n
        CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) acl
       WHERE n.nspname = 'public'
       ORDER BY grantee, grantor, acl.privilege_type, acl.is_grantable`);
    const sentinelAcl = await client.query(`
      SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
             pg_get_userbyid(acl.grantor) AS grantor, acl.privilege_type, acl.is_grantable
        FROM pg_class c
        CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
       WHERE c.oid = 'public.memory_acl_sentinel'::regclass
       ORDER BY grantee, grantor, acl.privilege_type, acl.is_grantable`);
    return { schemaAcl: schemaAcl.rows, sentinelAcl: sentinelAcl.rows };
  });
  return { ...cluster, ...grants };
}

async function createMemoryPrerequisite() {
  await usingClient(migrationUrl, async (admin) => {
    await admin.query(`CREATE ROLE ${MEMORY_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    await admin.query(`CREATE DATABASE ${MEMORY_DATABASE} OWNER postgres`);
    await admin.query(`REVOKE CONNECT ON DATABASE ${MEMORY_DATABASE} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${MEMORY_DATABASE} TO ${MEMORY_ROLE}`);
  });
  await usingClient(databaseUrl(migrationUrl, MEMORY_DATABASE), async (admin) => {
    await admin.query("CREATE TABLE public.memory_acl_sentinel (id bigint PRIMARY KEY)");
    await admin.query("REVOKE ALL ON TABLE public.memory_acl_sentinel FROM PUBLIC");
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${MEMORY_ROLE}`);
    await admin.query(`GRANT SELECT ON TABLE public.memory_acl_sentinel TO ${MEMORY_ROLE}`);
  });
}

async function assertNeighbourConnectivity() {
  await usingClient(migrationUrl, async (admin) => {
    const connect = await admin.query(`
      SELECT EXISTS (
               SELECT 1 FROM pg_database d,
                    LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) acl
                WHERE d.datname = '${MEMORY_DATABASE}' AND acl.grantee = 0
                  AND acl.privilege_type = 'CONNECT'
             ) AS public_connect,
             has_database_privilege('${MEMORY_ROLE}', '${MEMORY_DATABASE}', 'CONNECT') AS memory_connect,
             has_database_privilege('${APP_ROLE}', '${MEMORY_DATABASE}', 'CONNECT') AS autopilot_connect`);
    assert.deepEqual(connect.rows[0], {
      public_connect: false,
      memory_connect: true,
      autopilot_connect: false,
    });
  });

  const cross = new Client({
    connectionString: databaseUrl(runtimeUrl, MEMORY_DATABASE),
    connectionTimeoutMillis: 5_000,
  });
  let connectionError;
  try {
    await cross.connect();
  } catch (error) {
    connectionError = error;
  } finally {
    await cross.end().catch(() => {});
  }
  assert.equal(connectionError?.code, "42501", "runtime identity did not receive PostgreSQL CONNECT denial");
}

async function seedHostileObjects() {
  await usingClient(databaseUrl(migrationUrl, APP_DATABASE), async (admin) => {
    await admin.query("CREATE TABLE public.ci_unexpected_table (id bigint)");
    await admin.query("CREATE SEQUENCE public.ci_unexpected_sequence");
    await admin.query(`GRANT ALL PRIVILEGES ON TABLE public.ci_unexpected_table TO ${APP_ROLE}`);
    await admin.query(`GRANT ALL PRIVILEGES ON SEQUENCE public.ci_unexpected_sequence TO ${APP_ROLE}`);
  });
}

async function assertAutopilotContract() {
  await usingClient(runtimeUrl, async (runtime) => {
    const role = await runtime.query(`
      SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
             rolreplication, rolbypassrls, rolconnlimit
        FROM pg_roles WHERE rolname = current_user`);
    assert.deepEqual(role.rows[0], {
      rolcanlogin: true,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolreplication: false,
      rolbypassrls: false,
      rolconnlimit: 10,
    });

    const membership = await runtime.query(`
      SELECT count(*)::int AS membership_count
        FROM pg_auth_members
       WHERE member = (SELECT oid FROM pg_roles WHERE rolname = current_user)`);
    assert.deepEqual(membership.rows[0], { membership_count: 0 });

    const database = await runtime.query(`
      SELECT d.datdba = r.oid AS owned,
             has_database_privilege(current_user, current_database(), 'CONNECT') AS connect,
             has_database_privilege(current_user, current_database(), 'CREATE') AS create,
             has_database_privilege(current_user, current_database(), 'TEMP') AS temporary
        FROM pg_database d
        JOIN pg_roles r ON r.rolname = current_user
       WHERE d.datname = current_database()`);
    assert.deepEqual(database.rows[0], { owned: false, connect: true, create: false, temporary: false });

    const schema = await runtime.query(`
      SELECT n.nspowner = r.oid AS owned,
             has_schema_privilege(current_user, 'public', 'USAGE') AS usage,
             has_schema_privilege(current_user, 'public', 'CREATE') AS create
        FROM pg_namespace n
        JOIN pg_roles r ON r.rolname = current_user
       WHERE n.nspname = 'public'`);
    assert.deepEqual(schema.rows[0], { owned: false, usage: true, create: false });

    const tables = await runtime.query(`
      SELECT c.relname, c.relowner = r.oid AS owned,
             has_table_privilege(current_user, c.oid, 'SELECT') AS can_select,
             has_table_privilege(current_user, c.oid, 'INSERT') AS can_insert,
             has_table_privilege(current_user, c.oid, 'UPDATE') AS can_update,
             has_table_privilege(current_user, c.oid, 'DELETE') AS can_delete,
             has_table_privilege(current_user, c.oid, 'TRUNCATE') AS can_truncate,
             has_table_privilege(current_user, c.oid, 'REFERENCES') AS can_references,
             has_table_privilege(current_user, c.oid, 'TRIGGER') AS can_trigger
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_roles r ON r.rolname = current_user
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       ORDER BY c.relname`);
    const observedExpected = [];
    for (const row of tables.rows) {
      const { relname, ...privileges } = row;
      if (EXPECTED_TABLES.includes(relname)) {
        observedExpected.push(relname);
        assert.deepEqual(privileges, {
          owned: false,
          can_select: true,
          can_insert: true,
          can_update: true,
          can_delete: true,
          can_truncate: false,
          can_references: false,
          can_trigger: false,
        }, `${relname} does not have exact DML-only privileges`);
      } else {
        assert.deepEqual(privileges, {
          owned: false,
          can_select: false,
          can_insert: false,
          can_update: false,
          can_delete: false,
          can_truncate: false,
          can_references: false,
          can_trigger: false,
        }, `${relname} is an unexpected accessible table`);
      }
    }
    assert.deepEqual(observedExpected.sort(), EXPECTED_TABLES);

    const sequences = await runtime.query(`
      SELECT c.relname, c.relowner = r.oid AS owned,
             has_sequence_privilege(current_user, c.oid, 'USAGE') AS can_use,
             has_sequence_privilege(current_user, c.oid, 'SELECT') AS can_select,
             has_sequence_privilege(current_user, c.oid, 'UPDATE') AS can_update
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_roles r ON r.rolname = current_user
       WHERE n.nspname = 'public' AND c.relkind = 'S'
       ORDER BY c.relname`);
    assert.ok(sequences.rows.some((row) => row.relname === "ci_unexpected_sequence"));
    for (const { relname, ...privileges } of sequences.rows) {
      assert.deepEqual(privileges, {
        owned: false,
        can_use: false,
        can_select: false,
        can_update: false,
      }, `${relname} is an accessible sequence`);
    }
  });
}

async function rollbackState() {
  return usingClient(migrationUrl, async (admin) => {
    const state = await admin.query(`
      SELECT (SELECT rolconnlimit FROM pg_roles WHERE rolname = '${APP_ROLE}') AS connection_limit,
             pg_has_role('${APP_ROLE}', '${ROLLBACK_PARENT}', 'MEMBER') AS has_membership,
             has_database_privilege('${APP_ROLE}', '${APP_DATABASE}', 'TEMP') AS has_temp,
             EXISTS (
               SELECT 1 FROM pg_database d,
                    LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) acl
                WHERE d.datname = '${MEMORY_DATABASE}' AND acl.grantee = 0
                  AND acl.privilege_type = 'CONNECT'
             ) AS memory_public_connect`);
    const appDatabaseAcl = await admin.query(`
      SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
             pg_get_userbyid(acl.grantor) AS grantor, acl.privilege_type, acl.is_grantable
        FROM pg_database d
        CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) acl
       WHERE d.datname = '${APP_DATABASE}'
       ORDER BY grantee, grantor, acl.privilege_type, acl.is_grantable`);
    return { ...state.rows[0], app_database_acl: appDatabaseAcl.rows };
  });
}

async function armRollbackProof() {
  await usingClient(migrationUrl, async (admin) => {
    await admin.query(`CREATE ROLE ${ROLLBACK_PARENT} NOLOGIN`);
    await admin.query(`GRANT ${ROLLBACK_PARENT} TO ${APP_ROLE}`);
    await admin.query(`ALTER ROLE ${APP_ROLE} CONNECTION LIMIT 7`);
    await admin.query(`GRANT TEMPORARY ON DATABASE ${APP_DATABASE} TO ${APP_ROLE}`);
    // This check happens only after prepareCluster has attempted membership,
    // role/password, and database-ACL mutations inside its transaction.
    await admin.query(`GRANT CONNECT ON DATABASE ${MEMORY_DATABASE} TO PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${MEMORY_DATABASE} TO ${APP_ROLE}`);
  });
}

async function main() {
  await createMemoryPrerequisite();
  const pristineNeighbour = await neighbourSnapshot();
  assert.equal(pristineNeighbour.role.length, 1);
  assert.deepEqual(pristineNeighbour.memberships, []);

  runBootstrap(false, "missing schema-mode fail-closed", undefined);
  runBootstrap(true, "first-deploy schema bootstrap", true);
  assert.deepEqual(await neighbourSnapshot(), pristineNeighbour, "clean bootstrap changed Memory ACLs or grants");
  await assertNeighbourConnectivity();

  await seedHostileObjects();
  runBootstrap(true, "schema-preserving hostile-grant redeploy", false);
  await assertAutopilotContract();
  await assertNeighbourConnectivity();
  assert.deepEqual(await neighbourSnapshot(), pristineNeighbour, "idempotent bootstrap changed Memory ACLs or grants");

  await armRollbackProof();
  const beforeFailure = {
    state: await rollbackState(),
    neighbour: await neighbourSnapshot(),
  };
  const { app_database_acl: beforeAppDatabaseAcl, ...beforeFailureFlags } = beforeFailure.state;
  assert.ok(beforeAppDatabaseAcl.length > 0);
  assert.deepEqual(beforeFailureFlags, {
    connection_limit: 7,
    has_membership: true,
    has_temp: true,
    memory_public_connect: true,
  });

  runBootstrap(false, "late transactional failure", false);
  assert.deepEqual({
    state: await rollbackState(),
    neighbour: await neighbourSnapshot(),
  }, beforeFailure, "failed bootstrap did not roll back atomically");
  // A successful runtime query proves the failed cluster transaction did not
  // leave the canonical password/CONNECT path unusable.
  await usingClient(runtimeUrl, (runtime) => runtime.query("SELECT 1"));

  // Restore only the external prerequisite. The recovery bootstrap must itself
  // remove the hostile membership/TEMP grant and reset the connection limit.
  await usingClient(migrationUrl, (admin) =>
    admin.query(
      `REVOKE CONNECT ON DATABASE ${MEMORY_DATABASE} FROM PUBLIC; `
      + `REVOKE CONNECT ON DATABASE ${MEMORY_DATABASE} FROM ${APP_ROLE}`
    )
  );
  runBootstrap(true, "schema-preserving post-rollback recovery", false);
  await assertAutopilotContract();
  await assertNeighbourConnectivity();
  assert.deepEqual(await neighbourSnapshot(), pristineNeighbour, "recovery changed Memory ACLs or grants");

  await usingClient(migrationUrl, async (admin) => {
    await admin.query(`DROP ROLE ${ROLLBACK_PARENT}`);
  });
  console.log(
    "Database bootstrap adversarial proof passed: exact DML allowlist, zero unexpected-object access, " +
    "Memory non-interference, explicit first/ordinary schema modes, idempotence, atomic rollback, and recovery."
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
