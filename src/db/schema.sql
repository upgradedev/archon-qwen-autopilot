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

-- ─────────────────────────────────────────────────────────────────────────────
-- AP WORK ITEMS  ← the human-in-the-loop approval queue
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ap_workitems (
    id          UUID PRIMARY KEY,
    status      TEXT NOT NULL,               -- pending | approved | rejected
    item        JSONB NOT NULL,              -- the full WorkItem (invoice, findings, proposal, execution)
    created_at  TIMESTAMPTZ DEFAULT now(),
    decided_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ap_workitems_status ON ap_workitems (status);
CREATE INDEX IF NOT EXISTS idx_ap_workitems_created ON ap_workitems (created_at);
