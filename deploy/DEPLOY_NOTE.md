# Deploy note — Archon Autopilot on Alibaba Cloud

> **Current production:** Alibaba ECS, real Qwen Model Studio, shared MemoryAgent
> pgvector service, dual data/edge Docker networks, and a localhost-only backend behind
> HTTPS at https://autopilot.43.106.13.19.sslip.io.

The one-command production release is [`redeploy.sh`](redeploy.sh). Exact resource,
recovery, and verification details are in [`DEPLOY_STATE.md`](DEPLOY_STATE.md).

## Current deployment shape

```text
Internet
   │ HTTPS :443
   ▼
ECS reverse proxy
   │ http://127.0.0.1:9100
   ▼
archon-autopilot (container :9000, read-only root)
   ├── MemoryAgent edge network ──► DashScope / Qwen
   ├── private data network ──────► shared pgvector service
   │                                  └── database `autopilot`, role `autopilot_app`
   └── host bind mount ───────────► /var/lib/archon-autopilot/ledger
```

- The shared PostgreSQL service avoids duplicate infrastructure. Database
  `autopilot` revokes `PUBLIC` connect/create, and the dedicated `autopilot_app`
  runtime role receives only schema usage plus table DML/sequence usage. It cannot
  connect to the Memory database; the deployment verifies SQLSTATE `42501`.
- Runtime needs both networks: `data` for `db:5432`, `edge` for Qwen egress.
- Host port 9100 is bound to `127.0.0.1` only. Do **not** add a public 9100
  security-group rule; the HTTPS reverse proxy is the sole public path.
- The durable JSONL ledger directory survives container replacement and is mounted
  into an otherwise read-only container.
- Production fails closed without real Qwen, PostgreSQL, and a 32+ character reviewer
  token. Reviewer decisions are Bearer-authenticated HTTP/UI operations only.
- This ECS shape runs one bounded app container. Public/reviewer provider pools are
  isolated, and one shared document-render cap bounds their aggregate PDF memory. A
  future Function Compute deployment must additionally set a maximum instance count
  to preserve a fleet-wide workflow-admission bound; per-workflow tokens/provider
  retries are bounded and measured separately.
- MCP is a local stdio proposal/read surface with four tools and no decision or
  execution capability.

## Production runbook

Prerequisites on the ECS host:

- the shared pgvector service plus private data and egress networks;
- Docker plus the exact project-contained Docker Buildx `v0.35.0` plugin. Install
  or attest it with `sudo bash deploy/bootstrap-buildx.sh`; the script downloads
  only Docker's official Linux-amd64 release, verifies SHA-256
  `d41ece72044243b4f58b343441ae37446d9c29a7d6b5e11c61847bbcf8f7dfda`,
  and keeps the plugin under this checkout's ignored `.artifacts/docker-config`.
  That Docker config is deliberately closed: no `config.json`, extra plugin
  directories, or sibling CLI plugins are permitted;
- `<autopilot-checkout>/.env` (gitignored, regular/non-symlink, exact mode `0600`) containing only runtime
  settings: dedicated `DATABASE_URL`, DashScope key and reviewer token;
- `<autopilot-checkout>/.env.migration` (gitignored, regular/non-symlink, exact mode `0600`) containing the
  bootstrap-only admin DSN and `AUTOPILOT_APP_DB_PASSWORD`; this file is passed only
  to the one-shot bootstrap container, never the application runtime;
- the trusted 40-character commit SHA of the final merged `main`, obtained from the
  release/CI record rather than recomputed from an arbitrary host checkout;
- TLS reverse proxy routing the Autopilot hostname to `127.0.0.1:9100`.

Release:

```bash
cd <autopilot-checkout>
git fetch origin main
git switch main
git merge --ff-only origin/main
sudo bash deploy/bootstrap-buildx.sh
sudo DOCKER_CONFIG="$PWD/.artifacts/docker-config" \
  EXPECTED_RELEASE=<trusted-40-character-final-main-sha> bash deploy/redeploy.sh
```

The script first rechecks the canonical path, closed directory set, root ownership,
mode, link count, exact SHA-256, and reported version of the selected Buildx artifact,
then acquires a host-global exclusive lock (shared by every checkout). It proves
`HEAD == origin/main == EXPECTED_RELEASE`, rejects tracked or non-ignored untracked
changes, ignored untracked files admitted by Docker's reviewed source allowlist,
and hidden assume-unchanged/skip-worktree index flags, then validates both env-file
types and exact permissions. Before build or database mutation it requires a reliable
Docker inventory, refuses stale rollback state, captures the serving container and
image by immutable ID, requires the runtime `DATABASE_URL` to be unchanged, and proves
the old release is DB-ready. The same Buildx artifact is rechecked immediately before
invoking `docker buildx build`. Database credential rotation is deliberately a separate
two-phase operation, not an ordinary redeploy.

The controller creates the build context from `git archive EXPECTED_RELEASE`, records
Docker's immutable `sha256` image ID, and embeds that revision at image level. With a
serving release, ordinary redeploy requires the committed `schema.sql` to be byte-for-
byte identical to the schema inside that release; schema evolution uses a separately
reviewed expand/contract release. Runtime values are copied into short-lived mode-
`0600` env files under `.git` and passed with `--env-file`, not credential-bearing
Docker `-e` arguments. The bootstrap runs as a named, bounded, restart-disabled job:
its Docker timeout is reconciled by immutable ID, a PostgreSQL advisory lock refuses
concurrent DB bootstrap, and its role/ACL and schema/grant phases fail closed inside
transactions (apart from PostgreSQL's necessarily out-of-transaction first database
creation). Cross-database denial and the old release's post-bootstrap `/ready` must pass.

Before cutover, the exact image/config runs in a non-published staging container. It
performs only `/health`, network-free `/ready`, and authenticated/metered `/ready/deep`
probes—no production-DB intake—while the old release keeps serving. The controller
then arms a transaction-specific closed application gate before stopping anything,
preserves the old container by immutable ID, and starts the loopback-bound candidate
with restart disabled. Health endpoints remain probeable, but ordinary business
traffic receives `503` unless it carries the controller's per-transaction bypass.

The host creates a high-entropy vendor marker before gated intake and requires the
returned ID/vendor/status through the exact protected `GET /pending/:id` route. An
independent named DB cleanup job deletes within a transaction and proves zero matching
work-item and vendor-memory rows. Commit requires that cleanup proof, the final exact
container still running, `/ready` passing, restart updated to `unless-stopped`, the
release gate opened, and an ordinary Bearer-protected `/pending?limit=1` read succeeding
without the bypass. Only after that commit does the controller remove the old object.

An ordinary error, hangup, interrupt, or termination first re-closes the application
gate, quiets the candidate, independently cleans any smoke residue, and only then
restarts/reconciles the old immutable object when `/ready` can be proved. An uncatchable
`SIGKILL`, host loss, or Docker-daemon outage can interrupt that sequence—including
after the gate-open point—so automatic traffic closure or rollback is not promised;
inspect and explicitly reconcile any candidate, backup, cleanup job, and release-gate
directory before retrying.

Post-release external checks:

```bash
curl -fsS https://autopilot.43.106.13.19.sslip.io/health
curl -fsS https://autopilot.43.106.13.19.sslip.io/ready
```

## Local development — not production

For a self-contained local clone, `docker-compose.yml` starts its own loopback-only
pgvector, migration job, and backend:

```bash
docker compose up -d --build
curl -fsS http://127.0.0.1:9000/health
curl -fsS http://127.0.0.1:9000/ready
```

Local compose may opt into deterministic providers. Do not use its default local
credentials or topology as a production runbook.

## Alternatives — not the current deployment

The container can target Function Compute plus managed ApsaraDB/RDS in a future
topology because it speaks standard HTTP and PostgreSQL/pgvector. Those are documented
design options only. The hackathon deployment currently runs on ECS as described
above.

## Historical correction

Previous notes mentioned a single MemoryAgent network, direct public port 9100, and a
security-group opening. Those instructions are superseded. Production now uses both
the isolated data network and egress edge network, binds 9100 to localhost, and exposes
the service only through HTTPS.
