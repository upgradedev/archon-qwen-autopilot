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
   ├── MemoryAgent data network ──► shared pgvector service
   │                                  └── separate database: autopilot
   └── host bind mount ───────────► /var/lib/archon-autopilot/ledger
```

- The shared PostgreSQL container avoids a duplicate database service; the separate
  `autopilot` database isolates memory, work items, and durable quota tables.
- Runtime needs both networks: `data` for `db:5432`, `edge` for Qwen egress.
- Host port 9100 is bound to `127.0.0.1` only. Do **not** add a public 9100
  security-group rule; the HTTPS reverse proxy is the sole public path.
- The durable JSONL ledger directory survives container replacement and is mounted
  into an otherwise read-only container.
- Production fails closed without real Qwen, PostgreSQL, and a 32+ character reviewer
  token. Reviewer decisions are Bearer-authenticated HTTP/UI operations only.
- MCP is a local stdio proposal/read surface with four tools and no decision or
  execution capability.

## Production runbook

Prerequisites already present on the ECS host:

- `/root/memoryagent` running its `db`, data network, and edge network;
- `/root/memoryagent/.env` containing the rotated PostgreSQL credentials;
- `/root/autopilot/.env` containing the real DashScope key and reviewer token;
- TLS reverse proxy routing the Autopilot hostname to `127.0.0.1:9100`.

Release:

```bash
cd /root/autopilot
git pull --ff-only
bash deploy/redeploy.sh
```

The script creates/migrates the isolated database, builds and replaces the container,
attaches both networks, mounts the durable ledger, runs `/health` + `/ready`, and
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
