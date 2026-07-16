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
> **Exact application release verified 2026-07-15:**
> `321b6c5440a365fe346d2c446e141e9c5d33854c`. The release controller checked out that
> SHA, built the production image, bootstrapped the dedicated database role and
> schema, proved cross-database denial, replaced the hardened container, and passed
> `/health`, `/ready`, authenticated `/ready/deep`, and a real-Qwen
> intake→PENDING→targeted-cleanup smoke. Public UI, health and readiness also
> returned `200` over valid TLS. The deployment record is redacted and retained only
> in this project's ignored `.artifacts/` evidence directory.
>
> The exercised release proves all three baseline model paths: a
> `text-embedding-v4` deep probe, `qwen-vl-max` extraction of the bundled synthetic
> invoice, and a multi-step `qwen-plus` decision that stopped at `PENDING`. The
> canary was rejected through the authenticated human gate and exactly its work item
> and vendor-memory row were removed. Final screenshots/video must capture this
> evidence; configuration alone is never substituted for an exercised model claim.
> A later docs/media-only submission HEAD may differ from the deployed application
> SHA and must be labelled separately. See
> [`../demo/BUILD_RECORDING.md`](../demo/BUILD_RECORDING.md).

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
git fetch origin main
git switch main
git merge --ff-only origin/main
EXPECTED_RELEASE=<trusted-40-character-final-main-sha> bash deploy/redeploy.sh
```

`EXPECTED_RELEASE` is mandatory, lowercase, and exactly 40 hexadecimal characters.
Copy it from the final merged-main release/CI record; do not derive it from whatever
revision happens to be checked out on the host. The script independently requires
both `HEAD` and the fetched `refs/remotes/origin/main` to match it, rejects
assume-unchanged/skip-worktree index flags, and requires
the non-ignored working tree (including untracked Docker build inputs) to be clean.

Optional `--no-smoke` skips only the intake/pending round-trip; it still runs health
and readiness probes. A normal release should not skip the smoke.

`deploy/redeploy.sh` performs, in order:

1. Verify Docker/curl/git, exact expected release, clean non-ignored checkout, both
   networks, production Qwen/reviewer settings, dedicated runtime DSN, and regular
   non-symlink runtime/migration env files with exact mode `0600`.
2. Provision `/var/lib/archon-autopilot/ledger` as a private persistent directory for
   the image's uid/gid 1000.
3. Build the final backend image.
4. In a one-shot container, create/rotate `autopilot_app`, create `autopilot` if
   absent, migrate as admin, grant least privilege, and prove the runtime role cannot
   connect to `memoryagent`.
5. Refuse any stale rollback container, stop and preserve the current runtime under
   a rollback name, then start the candidate `archon-autopilot` with:
   - `--network <memoryagent>_data`, then connect `<memoryagent>_edge`;
   - `-p 127.0.0.1:9100:9000`;
   - read-only root, `/tmp` tmpfs, all Linux capabilities dropped, and
     `no-new-privileges`;
   - durable ledger host bind mount;
   - explicit `DATABASE_URL`, `PORT`, and `LEDGER_JSONL_PATH` overrides after `.env`.
6. Read the running candidate's OCI revision label back from Docker, require it to
   equal `EXPECTED_RELEASE`, then poll `/health`, network-free `/ready`, and
   authenticated/metered `/ready/deep`.
7. Submit a dedicated authenticated smoke invoice, read `/pending` with the private Bearer token,
   then delete only the smoke vendor's work-item/memory rows.
8. Only after every gate passes, disarm rollback and remove the stopped backup. Any
   earlier normal error, `HUP`, `INT`, or `TERM` removes the candidate, restores the previous
   container/name, restarts it, and polls its network-free `/health` endpoint.

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
docker inspect archon-autopilot --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
test -d /var/lib/archon-autopilot/ledger
```

The revision label must equal the same trusted `EXPECTED_RELEASE` supplied to the
deploy command. Never publish raw `docker inspect` output containing infrastructure
identifiers; retain it only as private release evidence and expose a redacted proof.

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
