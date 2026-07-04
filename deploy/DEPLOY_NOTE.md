# Deploy note — Archon Autopilot → Alibaba Cloud

> This is a NOTE, not an executed deploy. It mirrors the Track-1 MemoryAgent
> deployment shape (ECS + docker-compose) so the same runbook applies. Nothing
> here has been run against a live account.

## Target shape

Same topology as the Track-1 Archon MemoryAgent:

- **Compute:** an Alibaba Cloud **ECS** instance running `docker compose up -d`
  (backend + pgvector), OR **Function Compute** custom-container (the backend
  image listens on CAPort 9000). The backend is a single Node/TS Fastify service.
- **Memory + queue store:** the `pgvector/pgvector:pg16` container for a self-
  contained box, or managed **ApsaraDB RDS for PostgreSQL** / **AnalyticDB for
  PostgreSQL** (pgvector extension) — same pg-wire, same SQL, so the app code is
  unchanged. Two tables: `agent_memory` (vector recall) + `ap_workitems` (the
  approval queue).
- **Model:** **Qwen** on Alibaba Cloud Model Studio (DashScope) via the OpenAI-
  compatible endpoint — `qwen-plus` for the function-calling decision,
  `text-embedding-v4` for memory. Set `DASHSCOPE_API_KEY` in a `.env` next to
  `docker-compose.yml`; without it the app runs the deterministic offline Fakes.

## Runbook (ECS + docker compose)

```bash
# On the box (Node not required — docker only):
git clone https://github.com/upgradedev/archon-qwen-autopilot && cd archon-qwen-autopilot

# Real Qwen: drop a .env with DASHSCOPE_API_KEY next to docker-compose.yml.
# (Omit it to run the offline Fakes.)
printf 'DASHSCOPE_API_KEY=sk-...\n' > .env

# Apply the schema first (creates agent_memory + ap_workitems), then serve.
docker compose run --rm backend npm run db:schema
docker compose up -d --build

# Smoke:
curl -s localhost:9000/health
curl -s -X POST localhost:9000/intake \
  -H 'content-type: application/json' \
  -d '{"invoice":{"vendor":"Globex","invoice_number":"GX-1","tax_id":"T","subtotal":500,"tax":100,"total":600}}'
curl -s localhost:9000/pending
```

## Function Compute (alternative)

```bash
docker build --platform linux/amd64 -t <registry>/archon-qwen-autopilot:latest .
docker push <registry>/archon-qwen-autopilot:latest
# Create an FC custom-container function, port 9000, env DATABASE_URL +
# DASHSCOPE_API_KEY, pointed at ApsaraDB RDS for PostgreSQL (pgvector).
```

## Not done here (deferred)

- Actual provisioning of ECS / RDS / Model Studio key.
- TLS / custom domain in front of the backend.
- A web approval UI over `/pending` + `/approve` + `/amend` + `/reject`.
