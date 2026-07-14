// Documentation-drift fitness functions — three offline checks that keep the README
// honest against the code, run as their own `docs-consistency` CI job.
//
//   CHECK 1  README claims ↔ code  — model ids, HTTP endpoints, and the MCP-tool /
//            custom-skill catalog (incl. the security invariant that the model-facing
//            tool catalog EXCLUDES the human terminal actions approve/amend/reject).
//   CHECK 2  Mermaid diagram ↔ modules — every code-component node maps to a real file.
//   CHECK 3  A committed golden (claims.golden.json) pins the headline numbers (eval
//            22/22, MCP tools, skill split, the security invariant) and asserts the
//            README's stated versions match, so future drift is caught.
//
// Direction of every check is chosen so it passes CLEAN on current main: a
// README-claims-something-code-lacks direction is a HARD FAIL (no phantom); a
// code-has-something-README-omits direction is a console.warn (a sibling PR owns the
// README prose — this job must not race it). Fully offline: no key, no DB, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer } from "../../src/server.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { FakeEmbedder, DEFAULT_EMBED_MODEL } from "../../src/memory/embeddings.js";
import { InMemoryStore } from "../../src/memory/store.js";
import { InMemoryWorkItemStore } from "../../src/ap/workitem-store.js";
import { defaultLoop, DEFAULT_DECIDER_MODEL } from "../../src/ap/loop.js";
import { fakeSinks } from "../../src/ap/sinks.js";
import { FakeExtractionClient, DEFAULT_VISION_MODEL } from "../../src/qwen/vision.js";
import { analysisToolDefs, ANALYSIS_TOOL_NAMES } from "../../src/ap/analysis-tools.js";
import { toolDefs, TERMINAL_TOOL_NAMES } from "../../src/ap/tools.js";
import { listSkills } from "../../src/skills/catalog.js";
import { EVAL_SET } from "../../eval/dataset.js";

// Offline: no key means the decider + embedder + extractor auto-select the Fakes.
delete process.env.DASHSCOPE_API_KEY;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const GOLDEN = JSON.parse(readFileSync(join(HERE, "claims.golden.json"), "utf8"));

// ── shared helpers ────────────────────────────────────────────────────────────

function serverDeps() {
  return {
    embedder: new FakeEmbedder(),
    memory: new InMemoryStore(),
    workitems: new InMemoryWorkItemStore(),
    loop: defaultLoop(),
    sinks: fakeSinks(),
    extractor: new FakeExtractionClient(),
  };
}

// Flatten Fastify's `printRoutes` tree into a de-duplicated { method, path } list.
// Validated empirically against the live server (see the CHECK-1 endpoints test,
// which floor-asserts the count so a Fastify format change cannot pass vacuously).
function flattenRoutes(tree: string): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  const stack: string[] = [];
  for (const line of tree.split("\n")) {
    if (!line.trim()) continue;
    const idx = line.search(/[^\s│├└─]/);
    if (idx < 0) continue;
    const level = Math.floor(idx / 4);
    const rest = line.slice(idx);
    const m = rest.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    const seg = (m ? m[1]! : rest).trim();
    stack.length = level;
    stack[level] = seg;
    if (!m) continue;
    const joined = stack.slice(0, level + 1).join("");
    const path = joined.startsWith("/") ? joined : "/" + joined;
    for (const method of m[2]!.split(",").map((s) => s.trim())) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      out.push({ method, path });
    }
  }
  return out;
}

async function realRoutes(): Promise<Set<string>> {
  const app = await buildServer(serverDeps());
  await app.ready();
  try {
    const flat = flattenRoutes(app.printRoutes({ commonPrefix: false } as never));
    return new Set(flat.map((r) => `${r.method} ${r.path}`));
  } finally {
    await app.close();
  }
}

async function mcpToolNames(): Promise<string[]> {
  const { server } = buildMcpServer(serverDeps());
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "docs-consistency", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name).sort();
  } finally {
    await client.close();
    await server.close();
  }
}

// The single "## Endpoints" section of the README, so we parse the endpoints TABLE
// (and its immediate prose) — not the curl examples elsewhere that use `<id>`.
function endpointsSection(): string {
  const start = README.indexOf("## Endpoints");
  assert.ok(start >= 0, "README must have an '## Endpoints' section");
  const after = README.indexOf("\n## ", start + 5);
  return README.slice(start, after < 0 ? undefined : after);
}

// Extract backtick-fenced `METHOD /path` tokens from a chunk of README.
function documentedEndpoints(chunk: string): Set<string> {
  const set = new Set<string>();
  for (const m of chunk.matchAll(/`(GET|POST|PUT|PATCH|DELETE)\s+(\/[^`\s]*)`/g)) {
    set.add(`${m[1]!} ${m[2]!}`);
  }
  return set;
}

// Backtick-fenced model-id tokens anywhere in the README (qwen-* / text-embedding-*).
function readmeModelIds(): Set<string> {
  const set = new Set<string>();
  for (const m of README.matchAll(/`(qwen-[a-z0-9.\-]+|text-embedding-[a-z0-9.\-]+)`/gi)) {
    set.add(m[1]!.toLowerCase());
  }
  return set;
}

// Parse the node ids declared in the ```mermaid ...``` block. A node is declared by
// an id immediately followed by a shape opener ([, (, {, [[, {{, [( ) or by `subgraph`.
// Validated empirically to yield exactly the 15 nodes of the architecture diagram.
function mermaidNodeIds(): Set<string> {
  const block = README.match(/```mermaid\s*([\s\S]*?)```/);
  assert.ok(block, "README must contain a ```mermaid``` architecture diagram");
  const src = block![1] ?? "";
  const ids = new Set<string>();
  for (const m of src.matchAll(/\bsubgraph\s+([A-Za-z][A-Za-z0-9_]*)/g)) ids.add(m[1]!);
  for (const m of src.matchAll(/(?:^|[\s>|-])([A-Za-z][A-Za-z0-9_]*)\s*(?:\[\(|\[\[|\{\{|\[|\(|\{)/gm)) {
    ids.add(m[1]!);
  }
  // Drop mermaid keywords that can precede a brace (none expected, but be safe).
  for (const kw of ["subgraph", "end", "direction", "classDef", "style", "flowchart"]) ids.delete(kw);
  return ids;
}

// ════════════════════════════════════════════════════════════════════════════════
// CHECK 1 — README claims ↔ code (documentation drift)
// ════════════════════════════════════════════════════════════════════════════════

test("CHECK 1 · models: every model id the README states is one the code actually uses (no phantom)", () => {
  const codeModels = new Set([DEFAULT_DECIDER_MODEL, DEFAULT_EMBED_MODEL, DEFAULT_VISION_MODEL].map((s) => s.toLowerCase()));
  // Anchor: the three live model ids we expect the code to reference.
  assert.deepEqual([...codeModels].sort(), ["qwen-plus", "qwen-vl-max", "text-embedding-v4"]);

  const docModels = readmeModelIds();
  // Floor: a doc reformat that stops matching model ids must FAIL here, not pass vacuously.
  assert.ok(docModels.size >= 3, `expected ≥3 model ids in README, found ${docModels.size}`);

  // HARD FAIL — no phantom: every model id the README claims is one the code uses.
  for (const m of docModels) {
    assert.ok(codeModels.has(m), `README references model '${m}' that no code path uses (phantom model)`);
  }

  // Documented-primary direction → warn only (never fail the sibling README PR's race).
  for (const m of codeModels) {
    if (!docModels.has(m)) console.warn(`[docs-consistency][warn] code uses model '${m}' but the README does not document it`);
  }
});

test("CHECK 1 · endpoints: every README-documented endpoint is a real Fastify route (no phantom); real-but-undocumented → warn", async () => {
  const real = await realRoutes();
  // Floor: real route enumeration must actually have found the surface.
  assert.ok(real.size >= 10, `expected ≥10 real routes, found ${real.size}`);

  const documented = documentedEndpoints(endpointsSection());
  // Floor: the Endpoints table must have parsed to a meaningful set.
  assert.ok(documented.size >= 10, `expected ≥10 documented endpoints, parsed ${documented.size}`);

  // HARD FAIL — no phantom: every documented endpoint resolves to a real route.
  for (const ep of documented) {
    assert.ok(real.has(ep), `README documents endpoint '${ep}' that is not a real route (phantom endpoint)`);
  }

  // Real-but-undocumented routes → console.warn ONLY (a sibling PR documents these;
  // the audit flagged POST /extract/document specifically). /docs* + /openapi.json are
  // swagger-plugin surfaces the README already covers under `GET /docs`.
  const documentedPaths = new Set([...documented]);
  for (const key of real) {
    const path = key.split(" ")[1]!;
    if (path === "/" || path.startsWith("/docs") || path === "/openapi.json") continue;
    if (!documentedPaths.has(key)) {
      console.warn(`[docs-consistency][warn] real route '${key}' is not in the README Endpoints table (undocumented route)`);
    }
  }
});

test("CHECK 1 · MCP tools: the code exposes 4 agent-safe MCP tools and every name is documented in the README", async () => {
  const names = await mcpToolNames();
  // Numeric equality is asserted code↔golden (README states 'four' as a word).
  assert.equal(names.length, GOLDEN.mcpToolCount, `code exposes ${names.length} MCP tools; golden pins ${GOLDEN.mcpToolCount}`);
  assert.deepEqual(names, ["intake_invoice", "list_pending", "list_skills", "recall_vendor"]);

  // README name-presence (README states the count as a word for readable prose).
  assert.match(README, /\bfour\b[^.\n]{0,40}\bMCP\b/i, "README should state 'four MCP tools'");
  for (const n of names) {
    assert.ok(README.includes("`" + n + "`"), `MCP tool '${n}' is not documented in the README`);
  }
});

test("CHECK 1 · skills: the custom-skill catalog is 9 (5 autonomous / 4 gated) and every skill is documented", () => {
  const skills = listSkills();
  const autonomous = skills.filter((s) => s.gate === "autonomous");
  const gated = skills.filter((s) => s.gate === "human-gated");

  // Numeric equality code↔golden (README lists a 9-row table, no literal 9/5/4).
  assert.equal(skills.length, GOLDEN.skills.total, "skill count must match golden");
  assert.equal(autonomous.length, GOLDEN.skills.autonomous, "autonomous skill count must match golden");
  assert.equal(gated.length, GOLDEN.skills.gated, "gated skill count must match golden");
  assert.equal(autonomous.length, ANALYSIS_TOOL_NAMES.length);
  assert.equal(gated.length, TERMINAL_TOOL_NAMES.length);

  // README name-presence: every skill appears in the README skills table.
  for (const s of skills) {
    assert.ok(README.includes("`" + s.name + "`"), `skill '${s.name}' is not documented in the README`);
  }
});

test("CHECK 1 · SECURITY INVARIANT: the model-facing tool catalog EXCLUDES the human terminal actions (approve/amend/reject/pay)", async () => {
  // The catalog handed to qwen-plus is literally `[...analysisToolDefs(), ...toolDefs()]`
  // (src/ap/loop.ts) — the same source listSkills() derives from. Assert against BOTH.
  const modelCatalog = [...analysisToolDefs(), ...toolDefs()].map((d) => d.function.name);
  const catalogFromSkills = listSkills().map((s) => s.name);
  assert.deepEqual([...modelCatalog].sort(), [...catalogFromSkills].sort(), "the derived skill catalog must equal the model's live tool catalog");

  const FORBIDDEN = GOLDEN.security.terminalActionNames as string[]; // approve/amend/reject/pay
  // HARD FAIL if any money-moving / gate-bypassing human action is exposed to the model.
  for (const name of FORBIDDEN) {
    assert.ok(!modelCatalog.includes(name), `SECURITY: model tool catalog must NOT expose the human terminal action '${name}'`);
  }

  // Make the invariant bite across both agent-facing catalogs: terminal decisions
  // are absent from qwen-plus ToolDefs AND from MCP. They exist only on the
  // authenticated HTTP/UI surface owned by a human reviewer.
  const mcp = await mcpToolNames();
  for (const human of ["approve", "amend", "reject"]) {
    assert.ok(!mcp.includes(human), `'${human}' must not exist on the agent-facing MCP surface`);
  }
  const toolsSrc = readFileSync(join(ROOT, "src", "ap", "tools.ts"), "utf8");
  for (const name of FORBIDDEN) {
    assert.doesNotMatch(toolsSrc, new RegExp(`name:\\s*["']${name}["']`), `no ToolDef in tools.ts may be named '${name}'`);
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// CHECK 2 — Mermaid diagram ↔ modules (architecture conformance)
// ════════════════════════════════════════════════════════════════════════════════

test("CHECK 2 · architecture: every code-component node in the Mermaid diagram maps to a real module", () => {
  // Explicit, readable diagram-node → source-file mapping (the conformance contract).
  const MAPPING: Record<string, string> = {
    HTTP: "src/server.ts", //             HTTP + Approval UI surface
    MCP: "src/mcp/server.ts", //          MCP server (stdio)
    NORM: "src/ap/normalize.ts", //       Normalize / fence as UNTRUSTED DATA
    DEC: "src/ap/loop.ts", //             Qwen picks the next tool (ReAct loop)
    READ: "src/ap/analysis-tools.ts", //  Autonomous read/analyze tier
    TERM: "src/ap/tools.ts", //           Terminal action tier
    PEND: "src/ap/workitem-store.ts", //  PENDING proposal + trace store
    GATE: "src/agents/autopilot-agent.ts", // Human-in-the-loop gate (requirePending)
    NOTE: "src/skills/catalog.ts", //     Model catalog excludes approve/pay (the guard)
    EXE: "src/ap/sinks.ts", //            Execute for real — simulated sink adapters
    MEM: "src/memory/store.ts", //        pgvector memory
    QWEN: "src/qwen/client.ts", //        Qwen Cloud / DashScope
  };
  // Non-module nodes (untrusted input + the two subgraph containers) need no file.
  const NON_MODULE = new Set(["IN", "SURF", "LOOP"]);

  const nodes = mermaidNodeIds();
  // Floor: the parser must have found the whole diagram (≥12 code nodes) — a parse
  // that silently matches nothing would otherwise rubber-stamp this check.
  const codeNodes = [...nodes].filter((n) => !NON_MODULE.has(n));
  assert.ok(codeNodes.length >= 12, `expected ≥12 code-component nodes in the diagram, parsed ${codeNodes.length}`);

  // Each mapped node must be present in the diagram (catches a renamed/removed node)…
  for (const node of Object.keys(MAPPING)) {
    assert.ok(nodes.has(node), `mapping references diagram node '${node}' that is not in the Mermaid diagram`);
  }
  // …and its module must exist on disk (HARD FAIL on an orphan node → missing code).
  for (const [node, file] of Object.entries(MAPPING)) {
    assert.ok(existsSync(join(ROOT, file)), `diagram node '${node}' maps to '${file}', which does not exist (orphan node)`);
  }

  // A diagram node that is neither a known non-module nor mapped → warn (likely new
  // decoration; a sibling PR owns the diagram prose, so we do not fail on it).
  for (const node of codeNodes) {
    if (!(node in MAPPING)) console.warn(`[docs-consistency][warn] diagram node '${node}' is not mapped to a module (new node?)`);
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// CHECK 3 — Snapshot the key claims (golden)
// ════════════════════════════════════════════════════════════════════════════════

test("CHECK 3 · golden: the eval numbers pinned in claims.golden.json match the README and the dataset", () => {
  // Code anchor: the dataset really has `total` scenarios.
  assert.equal(EVAL_SET.length, GOLDEN.eval.total, "eval dataset size must match the golden total");

  // README anchor: it states the eval result as digits — parse and compare within tolerance.
  const m = README.match(/\*\*(\d+)\s*\/\s*(\d+)\s*\((\d+(?:\.\d+)?)%\)\*\*/);
  assert.ok(m, "README should state the eval result as '**22 / 22 (100.0%)**'");
  assert.equal(Number(m![1]), GOLDEN.eval.pass, "README eval pass count must match golden");
  assert.equal(Number(m![2]), GOLDEN.eval.total, "README eval total must match golden");
  assert.ok(Math.abs(Number(m![3]) - GOLDEN.eval.percent) < 0.1, "README eval % must match golden within 0.1");

  const avg = README.match(/avg\s+(\d+(?:\.\d+)?)/i);
  assert.ok(avg, "README should state the average autonomous-step count ('avg 2.5')");
  assert.ok(Math.abs(Number(avg![1]) - GOLDEN.eval.avgAutonomousSteps) < 0.05, "README avg-steps must match golden within 0.05");
});

test("CHECK 3 · golden: the MCP-tool + skill counts pinned in the golden match the live code", async () => {
  assert.equal((await mcpToolNames()).length, GOLDEN.mcpToolCount);
  const skills = listSkills();
  assert.equal(skills.length, GOLDEN.skills.total);
  assert.equal(skills.filter((s) => s.gate === "autonomous").length, GOLDEN.skills.autonomous);
  assert.equal(skills.filter((s) => s.gate === "human-gated").length, GOLDEN.skills.gated);
});

test("CHECK 3 · golden: the security invariant pinned in the golden holds in code (terminal actions excluded)", () => {
  assert.equal(GOLDEN.security.terminalActionsExcludedFromModelCatalog, true, "the golden must pin the security invariant as true");
  const modelCatalog = [...analysisToolDefs(), ...toolDefs()].map((d) => d.function.name);
  for (const name of GOLDEN.security.terminalActionNames as string[]) {
    assert.ok(!modelCatalog.includes(name), `golden invariant broken: '${name}' leaked into the model tool catalog`);
  }
});
