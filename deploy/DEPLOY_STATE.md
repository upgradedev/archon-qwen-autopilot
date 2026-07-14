# DEPLOY_STATE — Archon Autopilot on Alibaba Cloud

Authoritative production checkpoint and crash-recovery runbook. Secrets are never
printed or committed.

> **Status: LIVE over HTTPS.**
> https://autopilot.43.106.13.19.sslip.io
>
> The public reverse proxy is the only **application** network entry point. The
> Autopilot container is bound to **`127.0.0.1:9100`**, not a public security-group
> port.

## Current production topology

| Layer | Current state |
|---|---|
| Alibaba resource | ECS `i-t4ngalzjr5nwtuowbv7y`, region `ap-southeast-1`, public IP `43.106.13.19` |
| Public edge | HTTPS reverse proxy on the ECS host → `http://127.0.0.1:9100` |
| Autopilot runtime | Container `archon-autopilot`, internal port `9000`, restart `unless-stopped`, read-only root filesystem |
| Internet egress | Existing MemoryAgent Compose **edge** network, used for DashScope/Qwen |
| Database traffic | Existing MemoryAgent Compose internal **data** network, where DNS name `db` resolves |
| PostgreSQL | The MemoryAgent's existing pgvector/PostgreSQL container and credentials are reused |
| Data isolation | Separate logical database `autopilot` on that shared PostgreSQL service; it owns `agent_memory`, `ap_workitems`, and `ap_daily_quota` |
| Durable ledger | Host `/var/lib/archon-autopilot/ledger` bind-mounted at `/var/lib/archon-ledger`; `LEDGER_JSONL_PATH=/var/lib/archon-ledger/ledger.jsonl` |
| Secrets | `/root/autopilot/.env`: real `DASHSCOPE_API_KEY`, 32+ character `REVIEWER_TOKEN`, readiness settings; `/root/memoryagent/.env`: shared PostgreSQL credentials |
| Human decisions | Bearer-authenticated HTTP/UI only; MCP is local stdio with four proposal/read tools and no decision capability |

The dual-network attachment is required. The `data` network is internal and can reach
PostgreSQL but not DashScope; the `edge` network provides egress but intentionally
cannot resolve `db`. Migration joins only `data`; the running backend joins **both**,
with Docker gateway priority `1` on `edge` so outbound Qwen traffic has a deterministic
default route instead of depending on network-name/order selection.

## Why the database is shared this way

Starting a second PostgreSQL container would waste the small ECS host. Sharing the same
physical pgvector service keeps operations simple, while a separate `autopilot`
database prevents collisions with MemoryAgent's tables and memories. The runtime URL
is constructed in memory as:

```text
postgresql://<shared-user>:<masked-password>@db:5432/autopilot
```

Credentials are read from `/root/memoryagent/.env` and never echoed. Schema migration
runs before replacement of the serving container and fails closed.

## Authoritative redeploy

Run on the ECS host from the final repository checkout:

```bash
cd /root/autopilot
git pull --ff-only
bash deploy/redeploy.sh
```

Optional `--no-smoke` skips only the intake/pending round-trip; it still runs health
and readiness probes. A normal release should not skip the smoke.

`deploy/redeploy.sh` performs, in order:

1. Verify Docker/curl, repository path, both MemoryAgent networks, pgvector container,
   production Qwen credential, reviewer token, and shared DB password.
2. Provision `/var/lib/archon-autopilot/ledger` as a private persistent directory for
   the image's uid/gid 1000.
3. Create the isolated `autopilot` database if absent.
4. Build the final backend image.
5. Run the compiled migration on the **data** network before serving new code.
6. Replace `archon-autopilot` with:
   - `--network <memoryagent>_data`, then connect `<memoryagent>_edge`;
   - `-p 127.0.0.1:9100:9000`;
   - read-only root, `/tmp` tmpfs, all Linux capabilities dropped, and
     `no-new-privileges`;
   - durable ledger host bind mount;
   - explicit `DATABASE_URL`, `PORT`, and `LEDGER_JSONL_PATH` overrides after `.env`.
7. Poll local `/health` and dependency-aware `/ready`.
8. Submit a dedicated smoke invoice, read `/pending` with the private Bearer token,
   then delete only the smoke vendor's work-item/memory rows.

Useful overrides are documented in the script header: `APP_DIR`, `IMAGE`, `CONTAINER`,
`HOST_PORT`, `DATA_NETWORK`, `EDGE_NETWORK`, `DB_CONTAINER`, `DB_HOST`, `DB_PORT`,
`DB_USER`, `DB_PASSWORD`, `DB_NAME`, `MEMORY_ENV_FILE`, `BASE_URL`,
`LEDGER_HOST_DIR`, and `LEDGER_CONTAINER_PATH`.

## Verification after every release

On the ECS host:

```bash
curl -fsS http://127.0.0.1:9100/health
curl -fsS http://127.0.0.1:9100/ready
docker inspect archon-autopilot --format '{{json .NetworkSettings.Networks}}'
docker inspect archon-autopilot --format '{{json .HostConfig.PortBindings}}'
test -d /var/lib/archon-autopilot/ledger
```

From outside the host:

```bash
curl -fsS https://autopilot.43.106.13.19.sslip.io/health
curl -fsS https://autopilot.43.106.13.19.sslip.io/ready
```

For an authenticated queue smoke, load the token without printing it and call the
public HTTPS `/pending` endpoint. Never paste the token into shell history, logs,
screenshots, or public documentation.

## Network/security invariant

**Do not open TCP 9100 in the Alibaba security group.** The backend publishes only to
host loopback. Public traffic terminates on HTTPS and reaches the backend through the
reverse proxy. This removes direct clear-text access and prevents bypassing edge/TLS
policy.

The MCP process is not a network listener. Its four local stdio tools are
`intake_invoice`, `list_pending`, `recall_vendor`, and `list_skills`; no MCP client can
approve, amend, reject, recover, or execute.

## Local development is intentionally different

`docker-compose.yml` is a self-contained local stack with its own throwaway pgvector,
loopback ports, deterministic-provider opt-in, and local credentials. It is **not** the
production deployment mechanism. Production uses `deploy/redeploy.sh` to join the
already-running MemoryAgent data + edge networks and shared PostgreSQL service.

## Historical note — obsolete topology

Earlier drafts described choosing one arbitrary MemoryAgent network and publishing
`0.0.0.0:9100`, including a security-group rule for direct access. That design is
obsolete and unsafe: one network cannot provide both internal DB DNS and egress, and a
public 9100 binding bypasses HTTPS. The authoritative topology is the dual-network,
localhost-only design above.

## Cost hygiene

After the judging/demo window, stop or release the ECS resources according to the
team's retention plan. Preserve any required ledger/audit artifact before teardown.
