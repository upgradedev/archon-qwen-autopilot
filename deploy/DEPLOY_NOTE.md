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
- `<autopilot-checkout>/.env` (gitignored, mode `0600`) containing only runtime
  settings: dedicated `DATABASE_URL`, DashScope key and reviewer token;
- `<autopilot-checkout>/.env.migration` (gitignored, mode `0600`) containing the
  bootstrap-only admin DSN and `AUTOPILOT_APP_DB_PASSWORD`; this file is passed only
  to the one-shot bootstrap container, never the application runtime;
- TLS reverse proxy routing the Autopilot hostname to `127.0.0.1:9100`.

Release:

```bash
cd <autopilot-checkout>
git pull --ff-only
bash deploy/redeploy.sh
```

The script creates/rotates the dedicated role, migrates as bootstrap admin, applies
least-privilege grants, proves cross-database denial, then builds/replaces the runtime.
It attaches both networks, mounts the durable ledger, runs `/health`, network-free
`/ready` and authenticated/metered `/ready/deep`, and
performs an authenticated intake→pending smoke with cleanup.

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
