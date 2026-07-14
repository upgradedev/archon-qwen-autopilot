-- ═════════════════════════════════════════════════════════════════════════════
-- Archon Autopilot — pgvector schema
--
-- Two tables:
--   agent_memory  — the persistent, cross-session MEMORY the autopilot reasons
--                   over (the Track-1 MemoryAgent foundation). Every durable fact
--                   the agent learns — a vendor profile, a processed invoice, an
--                   executed action outcome — is a natural-language "memory" plus
--                   its Qwen embedding, recalled by MEANING (cosine) across
--                   sessions. vector(1024) matches text-embedding-v4's default.
--   ap_workitems  — the human-in-the-loop APPROVAL QUEUE. One JSONB row per
--                   proposed action, so a proposal survives across sessions until
--                   a human approves / amends / rejects it.
--
-- Runs identically on local pgvector docker, CI, and Alibaba Cloud AnalyticDB for
-- PostgreSQL / ApsaraDB RDS for PostgreSQL. Idempotent (IF NOT EXISTS throughout).
-- ═════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS vector;

-- ─────────────────────────────────────────────────────────────────────────────
-- AGENT MEMORY  ← the persistent, cross-session memory foundation (pgvector)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_memory (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Scope / retrieval filters (exact-match, via the btree indexes below).
    kind          TEXT NOT NULL,            -- vendor | invoice | action | insight
    vendor        TEXT NOT NULL DEFAULT '_global',
    source_ref    TEXT,
    -- The recallable content.
    content       TEXT NOT NULL,            -- natural-language statement of the fact
    metadata      JSONB,                    -- structured payload (amounts, refs, …)
    embedding     VECTOR(1024) NOT NULL,    -- Qwen text-embedding-v4 embedding of `content`
    embed_model   TEXT NOT NULL,
    importance    REAL NOT NULL DEFAULT 0.5,   -- 0..1 salience
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- HNSW cosine index — no training step, built incrementally as rows are inserted.
-- `ORDER BY embedding <=> $q LIMIT k` is index-accelerated for semantic recall.
CREATE INDEX IF NOT EXISTS idx_agent_memory_embedding
    ON agent_memory USING hnsw (embedding vector_cosine_ops);

-- Conventional secondary indexes for exact-match filtering / housekeeping.
CREATE INDEX IF NOT EXISTS idx_agent_memory_kind ON agent_memory (kind);
CREATE INDEX IF NOT EXISTS idx_agent_memory_vendor ON agent_memory (vendor);
CREATE INDEX IF NOT EXISTS idx_agent_memory_source_ref ON agent_memory (source_ref);
-- Deterministic duplicate lookup keys (new rows carry both in metadata). These
-- expression indexes keep R5 independent of semantic top-k recall.
CREATE INDEX IF NOT EXISTS idx_agent_memory_invoice_vendor_key
    ON agent_memory ((metadata->>'vendor_key')) WHERE kind = 'invoice';
CREATE INDEX IF NOT EXISTS idx_agent_memory_invoice_vendor_ref_key
    ON agent_memory ((metadata->>'vendor_ref_key')) WHERE kind = 'invoice';

-- ─────────────────────────────────────────────────────────────────────────────
-- AP WORK ITEMS  ← the human-in-the-loop approval queue
-- ─────────────────────────────────────────────────────────────────────────────
-- NOTE: the multi-step loop's decision `trace` + `stopReason` live INSIDE the `item`
-- JSONB (the entire WorkItem is serialized there) — no dedicated column is needed, so
-- adding the trace required NO migration and deploy/redeploy.sh is unaffected.
CREATE TABLE IF NOT EXISTS ap_workitems (
    id          UUID PRIMARY KEY,
    status      TEXT NOT NULL,               -- pending | executing | approved | rejected
    item        JSONB NOT NULL,              -- the full WorkItem (invoice, findings, recall, trace, proposal, execution)
    vendor_key  TEXT,                        -- TS canonicalVendorKey (NFKC + case/space)
    vendor_ref_key TEXT,                     -- TS canonicalReference (NFKC + case/space)
    invoice_total DOUBLE PRECISION,
    invoice_date DATE,
    currency    TEXT,
    created_at  TIMESTAMPTZ DEFAULT now(),
    decided_at  TIMESTAMPTZ
);

-- Additive upgrade for deployments created before canonical intake keys existed.
ALTER TABLE ap_workitems ADD COLUMN IF NOT EXISTS vendor_key TEXT;
ALTER TABLE ap_workitems ADD COLUMN IF NOT EXISTS vendor_ref_key TEXT;
ALTER TABLE ap_workitems ADD COLUMN IF NOT EXISTS invoice_total DOUBLE PRECISION;
ALTER TABLE ap_workitems ADD COLUMN IF NOT EXISTS invoice_date DATE;
ALTER TABLE ap_workitems ADD COLUMN IF NOT EXISTS currency TEXT;

-- Best-effort legacy backfill. New rows are always written with the stronger TS
-- NFKC canonicalization; PostgreSQL has no built-in NFKC transform, so this keeps
-- pre-upgrade ASCII/case/whitespace rows usable without pretending otherwise.
UPDATE ap_workitems
   SET vendor_key = COALESCE(vendor_key, lower(regexp_replace(trim(COALESCE(item->'invoice'->>'vendor', '')), '\s+', ' ', 'g'))),
       vendor_ref_key = COALESCE(vendor_ref_key, upper(regexp_replace(trim(COALESCE(item->'invoice'->>'vendor_ref', '')), '\s+', ' ', 'g'))),
       invoice_total = COALESCE(
         invoice_total,
         CASE WHEN COALESCE(item->'invoice'->>'total', '') ~ '^-?[0-9]+([.][0-9]+)?$'
              THEN (item->'invoice'->>'total')::double precision END
       ),
       invoice_date = COALESCE(
         invoice_date,
         CASE WHEN COALESCE(item->'invoice'->>'invoice_date', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
              THEN (item->'invoice'->>'invoice_date')::date END
       ),
       currency = COALESCE(currency, upper(COALESCE(item->'invoice'->>'currency', '')))
 WHERE vendor_key IS NULL
    OR vendor_ref_key IS NULL
    OR currency IS NULL;

CREATE INDEX IF NOT EXISTS idx_ap_workitems_status ON ap_workitems (status);
CREATE INDEX IF NOT EXISTS idx_ap_workitems_created ON ap_workitems (created_at);
CREATE INDEX IF NOT EXISTS idx_ap_workitems_live_vendor
    ON ap_workitems (vendor_key, status);
CREATE INDEX IF NOT EXISTS idx_ap_workitems_live_ref
    ON ap_workitems (vendor_key, vendor_ref_key, status);

-- Shared daily Qwen budget. PostgresDailyRateLimiter locks the per-client and
-- global rows together, so replicas/restarts cannot overspend either tier.
CREATE TABLE IF NOT EXISTS ap_daily_quota (
    day         DATE NOT NULL,
    client_key  TEXT NOT NULL,
    used        INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (day, client_key)
);
