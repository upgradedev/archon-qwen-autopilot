# DEPLOY_STATE — Archon Autopilot on Alibaba Cloud

Authoritative production checkpoint and crash-recovery runbook. Secrets are never
printed or committed.

> **Status: LIVE over HTTPS.**
> https://autopilot.43.106.13.19.sslip.io
>
> The public reverse proxy is the only **application** network entry point. The
> Autopilot container is bound to **`127.0.0.1:9100`**, not a public security-group
> port.
>
> Release-truth boundary: the hostname being live does not prove which source
> revision it serves. The audited application release candidate is
> `321b6c5440a365fe346d2c446e141e9c5d33854c`; it is represented as the final runtime
> only after the exact checkout, immutable CI, redeploy, readiness, decision and
> vision canaries pass. See [`../demo/BUILD_RECORDING.md`](../demo/BUILD_RECORDING.md).
> A later docs/media-only submission HEAD may differ and must be labelled separately.
>
> Historical infrastructure checkpoint (not final-release evidence): real
> `text-embedding-v4` / `qwen-plus`, PostgreSQL mode, real-Qwen intake→pending,
> unauthenticated `/pending` 401 and authenticated `/pending` 200 were verified on
> 2026-07-15. Runtime hardening was loopback-only, read-only, `cap-drop ALL`,
> `512 MiB / 1 CPU / 128 PIDs`, zero restarts, dual `data` + `edge` networks, and a
> uid-1000 writable durable-ledger mount; direct public 9100/5432 were blocked. These
> facts must be re-proven for the selected application SHA rather than copied forward.

## Current production topology

| Layer | Current state |
|---|---|
| Alibaba resource | ECS in `ap-southeast-1`; instance ID and administrative principal intentionally omitted from the public runbook |
| Public edge | Ports `80` (redirect/ACME) and `443` (HTTPS) → loopback backend; administrative access restricted out of band |
| Autopilot runtime | Container `archon-autopilot`, internal port `9000`, restart `unless-stopped`, read-only root filesystem |
| Internet egress | Existing MemoryAgent Compose **edge** network, used for DashScope/Qwen |
| Database traffic | Existing MemoryAgent Compose internal **data** network, where DNS name `db` resolves |
| PostgreSQL | Existing pgvector/PostgreSQL service; bootstrap/admin and runtime credentials are separate |
| Data isolation | Database `autopilot`; fixed runtime role `autopilot_app` has a 10-connection ceiling, only connect/schema usage/table DML/sequence usage, and is denied connection to the Memory database |
| Durable ledger | Host `/var/lib/archon-autopilot/ledger` bind-mounted at `/var/lib/archon-ledger`; `LEDGER_JSONL_PATH=/var/lib/archon-ledger/ledger.jsonl` |
| Secrets | Project-local gitignored `.env` contains runtime-only secrets; mode-0600 `.env.migration` contains bootstrap-only admin DSN + app-role password and is never passed to runtime |
| Human decisions | Bearer-authenticated HTTP/UI only; MCP is local stdio with four proposal/read tools and no decision capability |

The dual-network attachment is required. The `data` network is internal and can reach
PostgreSQL but not DashScope; the `edge` network provides egress but intentionally
cannot resolve `db`. Migration joins only `data`; the running backend joins **both**,
with Docker gateway priority `1` on `edge` so outbound Qwen traffic has a deterministic
default route instead of depending on network-name/order selection.

## Why the database is shared this way

Starting a second PostgreSQL container would waste the small ECS host. Sharing the same
physical pgvector service keeps operations simple. Isolation is both database- and
principal-level: `PUBLIC` access is revoked, cross-app roles are revoked, and the
deployment proves the runtime role is denied on the other database. The runtime DSN is:

```text
postgresql://autopilot_app:<masked-password>@db:5432/autopilot
```

The admin DSN stays in `.env.migration`, is supplied only to a one-shot bootstrap
container and is never echoed. Schema migration and grants run before replacement of
the serving container and fail closed.

## Authoritative redeploy

Run on the ECS host from the final repository checkout:

```bash
cd <autopilot-checkout>
git pull --ff-only
bash deploy/redeploy.sh
```

Optional `--no-smoke` skips only the intake/pending round-trip; it still runs health
and readiness probes. A normal release should not skip the smoke.

`deploy/redeploy.sh` performs, in order:

1. Verify Docker/curl, repository path, both networks, production Qwen/reviewer
   settings, dedicated runtime DSN, and mode-0600 migration env separation.
2. Provision `/var/lib/archon-autopilot/ledger` as a private persistent directory for
   the image's uid/gid 1000.
3. Build the final backend image.
4. In a one-shot container, create/rotate `autopilot_app`, create `autopilot` if
   absent, migrate as admin, grant least privilege, and prove the runtime role cannot
   connect to `memoryagent`.
5. Replace `archon-autopilot` with:
   - `--network <memoryagent>_data`, then connect `<memoryagent>_edge`;
   - `-p 127.0.0.1:9100:9000`;
   - read-only root, `/tmp` tmpfs, all Linux capabilities dropped, and
     `no-new-privileges`;
   - durable ledger host bind mount;
   - explicit `DATABASE_URL`, `PORT`, and `LEDGER_JSONL_PATH` overrides after `.env`.
6. Poll `/health`, network-free `/ready`, and authenticated/metered `/ready/deep`.
7. Submit a dedicated authenticated smoke invoice, read `/pending` with the private Bearer token,
   then delete only the smoke vendor's work-item/memory rows.

Useful overrides are documented in the script header: `APP_DIR`, `IMAGE`, `CONTAINER`,
`HOST_PORT`, `DATA_NETWORK`, `EDGE_NETWORK`, `MIGRATION_ENV_FILE`, `BASE_URL`, `PUBLIC_BASE_URL`,
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
