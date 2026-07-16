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
> **Exact application release verified 2026-07-16:**
> [`203f159df25f825a0b994a2f8a4d2c0892b45390`](https://github.com/upgradedev/archon-qwen-autopilot/commit/203f159df25f825a0b994a2f8a4d2c0892b45390).
> Project-contained exact-deploy attempt 23 completed with Alibaba Cloud Assistant
> terminal status `Success`, exit code `0`, the SHA-bound application marker, and
> the aggregate `EXACT_DEPLOY_SUCCESS` marker. The release controller checked out
> that immutable GitHub SHA, built the production image, attested a byte-stable raw
> `.env`, filtered every override-owned runtime key from the base env file, and
> proved each authoritative runtime value appeared exactly once in both the
> non-published staging and final containers. It then bootstrapped the dedicated
> database role and schema, proved cross-database denial, replaced the hardened
> container, and passed `/health`, `/ready`, authenticated `/ready/deep`, and a
> real-Qwen intake→PENDING→targeted-cleanup smoke. Public UI, health and readiness
> also returned `200` over valid TLS. The redacted deployment record is retained only
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
assume-unchanged/skip-worktree index flags, and requires every reviewed Docker build
input to be clean, including ignored untracked files within the admitted source tree.

`--no-smoke` is an emergency diagnostic weakening: it omits the mutating intake,
exact-item assertion, and independent zero-residual cleanup canary. Non-mutating
staging/final readiness and the gate-open protected read still run, but a deployment
using this flag is not valid evidence for the end-to-end release-smoke claim.

`deploy/redeploy.sh` performs, in order:

1. Verify Docker/Git/`flock`/GNU `timeout`, acquire the host-global exclusive release
   lock shared by all checkouts, and prove the exact expected release and complete
   clean Docker build inputs,
   both networks, production Qwen/reviewer settings, dedicated runtime DSN, and
   regular non-symlink runtime/migration env files with exact mode `0600`.
2. Obtain a reliable Docker inventory and refuse stale rollback state before build or
   database mutation. If a release is serving, capture its container and image by
   immutable ID, require it to be running with the exact unchanged `DATABASE_URL`,
   and prove its network-free `/ready`. Ordinary redeploy never rotates that credential.
3. Provision `/var/lib/archon-autopilot/ledger`, materialize a private build context
   with `git archive EXPECTED_RELEASE`, and—when an old release exists—require its
   embedded `schema.sql` to be byte-identical. Build under a hard timeout, capture the
   resulting `sha256` image ID, and require the image-level OCI revision to equal the
   expected release. Schema evolution is a separate expand/contract release.
4. Verify the compiled Alibaba Model Studio endpoint contract. Put validated runtime
   and DB values in short-lived mode-`0600` env files and pass them via `--env-file`;
   no credential-bearing `-e DATABASE_URL=...` value enters Docker's argv.
5. Run bootstrap as a named, restart-disabled job with a bounded Docker wait. Reconcile
   timeout/error outcomes by immutable ID so it cannot continue mutating after failure.
   A PostgreSQL advisory lock refuses concurrent bootstrap; role/password/membership/
   ownership/ACL and schema/grant phases each fail closed transactionally, while only
   initial `CREATE DATABASE` necessarily occurs outside a transaction. Prove exact
   least privilege, cross-database denial, and the old release's post-bootstrap `/ready`.
6. Start the exact image in a non-published, restart-disabled staging container while
   the old release serves. Verify immutable image/revision, security/env/mount/network
   contract, `/health`, `/ready`, and `/ready/deep`, make no intake/DB writes, then
   remove and prove the staging object absent.
7. Create and close a transaction-specific, root-owned application gate before any
   serving-state mutation. Revalidate the old identity, stop/preserve it under the
   rollback name, then start the final candidate with restart policy `no` behind the
   closed gate:
   - `--network <memoryagent>_data`, then connect `<memoryagent>_edge`;
   - `-p 127.0.0.1:9100:9000`;
   - read-only root, `/tmp` tmpfs, all Linux capabilities dropped, and
     `no-new-privileges`;
   - durable ledger host bind mount;
   - short-lived env-file overrides after `.env`, plus a read-only gate mount.
   The gate leaves only `/health`, `/ready`, and `/ready/deep` ordinarily probeable;
   a missing, unreadable, malformed, closed, or unexpectedly populated gate directory
   makes every other route return `503` except for the controller's secret bypass.
8. Re-verify the final immutable contract and run bounded in-container health/readiness
   probes. Unless explicitly skipped, generate the vendor marker on the host before
   intake, submit through the closed-gate bypass, and require its exact ID/vendor/
   pending status from Bearer-protected `GET /pending/:id`.
9. In a separate named DB job, transactionally delete the exact smoke work item and
   at most its vendor-memory row, then query and require zero matching residual rows.
10. Set `unless-stopped`, re-verify the exact running contract and `/ready`, require
    cleanup complete, atomically open the release gate, and prove an ordinary
    Bearer-protected `/pending?limit=1` read without the bypass. Re-verify the final
    running contract, mark the candidate authoritative, then remove the stopped backup
    by immutable ID.

For an ordinary error, `HUP`, `INT`, or `TERM`, rollback re-closes the gate, quiets the
candidate, independently cleans and proves zero smoke residue, then starts the old
container by immutable ID, proves `/ready`, and reconciles its production name. The
handler ignores a second handled termination while recovery is in progress. An
uncatchable `SIGKILL`, host loss, or Docker-daemon outage can interrupt recovery or
occur just after gate-open, so neither automatic traffic closure nor rollback is
promised across that boundary. Inspect and explicitly reconcile every candidate,
backup, bootstrap/cleanup job, and release-gate directory before retrying. Database
credential rotation and schema evolution remain separate, explicitly reviewed
operations rather than exceptions to ordinary-redeploy invariants.

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

For an authenticated queue check, load the token without printing it. `GET /pending`
lists the queue; `GET /pending/:id` reads one exact still-pending item without a queue-
order assumption. Never paste the token into shell history, logs, screenshots, or
public documentation.

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
