# DEPLOY_STATE — Archon Autopilot → Alibaba Cloud

Crash-recoverable checkpoint / runbook. Secrets **MASKED** — never commit the real
`DASHSCOPE_API_KEY` or any AccessKey.

> This documents the deploy SHAPE + the one-command script. The live deploy is run
> by a human (SSH + the security-group edit below); nothing here has been executed
> from this checkout.

## Target

- **Region:** `ap-southeast-1` (Singapore / international)
- **Box:** the SAME Alibaba Cloud **ECS** instance that already runs the Track-1
  MemoryAgent — public IP **`43.106.13.19`** (see the MemoryAgent's
  `deploy/DEPLOY_STATE.md`). SSH user `root`, key `C:/tools/aliyun/archon-mem-kp.pem`
  (not committed).
- **Host port:** **9100** (container `9000` → host `9100`). Port `9000` is taken by
  the MemoryAgent, so the Autopilot lives on `9100`.
- **App:** Node/TS Fastify HTTP server. Endpoints: `/` + `/ui` (approval UI),
  `/health`, `/intake`, `/pending`, `/approve/:id`, `/amend/:id`, `/reject/:id`,
  `/docs`.
- **DASHSCOPE_API_KEY:** in a `.env` next to `docker-compose.yml` (masked). Without
  it the app runs the deterministic offline Fakes.

## Reuse-pgvector decision (why no second Postgres)

The MemoryAgent already runs `pgvector/pgvector:pg16` on the box. Starting a second
Postgres would waste the box and split the data. Instead the Autopilot **reuses the
MemoryAgent's running pgvector container**, with two guards against collision:

1. **Distinct host port** — the Autopilot backend is served on **9100**, not 9000.
2. **Separate database** — both apps define an `agent_memory` table, so they must
   NOT share one database. The Autopilot gets its **own `autopilot` database** on
   the same Postgres server (its own `agent_memory` + `ap_workitems` tables). The
   MemoryAgent keeps the default `postgres` database untouched.

**Wiring choice:** the backend is launched with **`docker run`** joined to the
MemoryAgent's docker network (`--network <memoryagent_net>`), NOT via
`docker compose`. Reasons: (a) the repo's `docker-compose.yml` stays a clean,
self-contained LOCAL-DEV stack (its own throwaway pgvector on 5432); (b) joining an
external network + suppressing the compose `db` service would make the compose file
conditional and fragile. `docker run` reuses the existing network + container
cleanly and is fully scripted in `deploy/redeploy.sh`. Inside the container the DB is
reached at `postgresql://postgres:****@db:5432/autopilot` (`db` is the MemoryAgent
pgvector service's network alias).

## ⚡ TURNKEY REDEPLOY (one command)

On the box, in the app dir (default `/root/autopilot`):

```bash
ssh -i C:/tools/aliyun/archon-mem-kp.pem root@43.106.13.19
cd /root/autopilot && git pull                 # or rsync latest code in
bash deploy/redeploy.sh                         # --no-smoke to skip the round-trip
```

`redeploy.sh` is idempotent and fail-closed. In order it:

1. **Preflight** — docker + curl present; auto-detects the MemoryAgent docker
   network (`*memoryagent*`) and its pgvector container.
2. **Ensure the `autopilot` database** exists (`CREATE DATABASE` if missing — guarded,
   since Postgres has no `CREATE DATABASE IF NOT EXISTS`).
3. **Build** the backend image.
4. **Apply the schema FIRST** to the `autopilot` DB (`agent_memory` + `ap_workitems`
   + `vector` extension) — aborts if this fails (would otherwise 500 on every
   `/intake`).
5. **Run** the backend: `docker run -d --restart unless-stopped --network
   <memoryagent_net> -p 9100:9000 -e DATABASE_URL=…/autopilot [--env-file .env]`.
6. **Health** poll on `http://localhost:9100/health`.
7. **Smoke** — `POST /intake` (a universal invoice) → `GET /pending`, then delete the
   smoke rows so the demo queue is untouched.

Env-overridable: `APP_DIR · IMAGE · CONTAINER · HOST_PORT · CONTAINER_PORT · NETWORK ·
DB_CONTAINER · DB_HOST · DB_PORT · DB_USER · DB_PASSWORD · DB_NAME · BASE_URL`.

## ⚠️ Security-group rule that MUST be opened (human step)

Port **9100** must be allowed inbound on the box's security group (the MemoryAgent
only opened 22 + 9000). Run once (human — this script does NOT touch the SG):

```bash
aliyun ecs AuthorizeSecurityGroup \
  --RegionId ap-southeast-1 \
  --SecurityGroupId sg-t4n2trq33br7znmgs2yf \
  --IpProtocol tcp --PortRange 9100/9100 --SourceCidrIp 0.0.0.0/0
```

(Security group `sg-t4n2trq33br7znmgs2yf` is the one the MemoryAgent box already uses.)

## Smoke commands (manual, after the SG rule is open)

```bash
# From anywhere once port 9100 is open:
curl -s http://43.106.13.19:9100/health

curl -s -X POST http://43.106.13.19:9100/intake \
  -H 'content-type: application/json' \
  -d '{"invoice":{"vendor":"Globex","invoice_number":"GX-1","tax_id":"T","subtotal":500,"tax":100,"total":600}}'

curl -s http://43.106.13.19:9100/pending
# then open http://43.106.13.19:9100/ in a browser to approve/amend/reject.
```

## Resource IDs (shared with the MemoryAgent box)

- ECS instance: `i-t4ngalzjr5nwtuowbv7y` (ap-southeast-1c, `ecs.e-c1m2.large`)
- Security group: `sg-t4n2trq33br7znmgs2yf` · Key pair: `archon-mem-kp`
  (pem `C:/tools/aliyun/archon-mem-kp.pem`, not committed)
- VPC/vSwitch: `vpc-t4n52ldyprw3c6s7c0x5o` / `vsw-t4nkxqnrrmnl8sxpijtno`
- MemoryAgent pgvector container + network: auto-detected by `redeploy.sh`
- Autopilot DATABASE_URL (masked): `postgresql://postgres:****@db:5432/autopilot`
- **Live URL (once deployed + SG open): http://43.106.13.19:9100/**

## Not done here (deferred to the human)

- Actual SSH deploy + running `redeploy.sh` on the box.
- The `aliyun ecs AuthorizeSecurityGroup` rule for port 9100 above.
- Setting the real `DASHSCOPE_API_KEY` in `/root/autopilot/.env`.
- Stopping/releasing the ECS box after the demo to cap cost.
