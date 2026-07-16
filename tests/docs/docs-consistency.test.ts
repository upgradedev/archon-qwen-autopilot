// Documentation-drift fitness functions — eight offline checks that keep the README
// honest against the code, run as their own `docs-consistency` CI job.
//
//   CHECK 1  README claims ↔ code  — model ids, HTTP endpoints, and the MCP-tool /
//            custom-skill catalog (incl. the security invariant that the model-facing
//            tool catalog EXCLUDES the human terminal actions approve/amend/reject).
//   CHECK 2  Mermaid diagram ↔ modules — every code-component node maps to a real file.
//   CHECK 3  A committed golden (claims.golden.json) pins the headline numbers (eval
//            22/22 + measured autonomy, MCP tools, skill split, the security
//            invariant) and asserts the README's stated versions match, so future
//            drift is caught.
//   CHECK 4  Every local README link resolves, and every Markdown fragment points to
//            a real GitHub-style heading anchor (no silently broken judge navigation).
//   CHECK 5  Judge-facing SMTP claims stop at awaited transport acceptance and never
//            imply recipient delivery or recipient-level exactly-once semantics.
//   CHECK 6  Obsolete pre-auth UI captures stay deleted so media tooling cannot
//            accidentally promote stale evidence.
//   CHECK 7  Workflow actions, Node, container services, k6, and the video renderer
//            use exact versions plus content digests/hashes where the platform allows.
//   CHECK 8  Promotion attempt 01 remains explicitly immutable and environment-invalid.
//
// Direction of every check is chosen so it passes CLEAN on current main: a
// README-claims-something-code-lacks direction is a HARD FAIL (no phantom); a
// code-has-something-README-omits direction is a console.warn (a sibling PR owns the
// README prose — this job must not race it). Fully offline: no key, no DB, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
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
import { runScenario, summarizeRows } from "../../eval/lib.js";

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

// Approximate GitHub's documented heading-id normalization for the headings used in
// this repository, including deterministic suffixes for duplicate headings.
function stripCompleteHtmlTags(value: string): string {
  let cursor = 0;
  let plain = "";
  while (cursor < value.length) {
    const open = value.indexOf("<", cursor);
    if (open < 0) return plain + value.slice(cursor);
    plain += value.slice(cursor, open);
    const close = value.indexOf(">", open + 1);
    if (close < 0) return plain + value.slice(open);
    cursor = close + 1;
  }
  return plain;
}

function markdownAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const occurrences = new Map<string, number>();
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;
    const plain = stripCompleteHtmlTags(heading[1]!)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[`*_~]/g, "")
      .trim()
      .toLowerCase();
    const base = plain
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = occurrences.get(base) ?? 0;
    occurrences.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  for (const match of markdown.matchAll(/<a\s+(?:name|id)=["']([^"']+)["']/gi)) {
    anchors.add(match[1]!);
  }
  return anchors;
}

test("anchor normalization removes nested tag text without exposing a new HTML opener", () => {
  assert.deepEqual([...markdownAnchors("# Safe <scr<script>ipt> heading")], ["safe-ipt-heading"]);
  assert.deepEqual([...markdownAnchors("# Preserve unmatched < text")], ["preserve-unmatched--text"]);
});

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
    AUTHZ: "src/server.ts", //            Reviewer credential split
    PREVIEW: "src/server.ts", //          Isolated non-durable public projection
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

test("CHECK 3 · golden: eval result + measured autonomy match the README, dataset and live offline pipeline", async () => {
  // Code anchor: the dataset really has `total` scenarios.
  assert.equal(EVAL_SET.length, GOLDEN.eval.total, "eval dataset size must match the golden total");

  // Behavioral anchor: drive the same deterministic offline pipeline used by the
  // canonical eval. This prevents a stale hand-copied average from agreeing only
  // with a stale README/golden pair.
  const rows = [];
  for (const scenario of EVAL_SET) rows.push(await runScenario(scenario, "offline"));
  const summary = summarizeRows(rows);
  assert.equal(summary.correct, GOLDEN.eval.pass, "offline policy result must match golden");
  assert.equal(summary.multiStep, GOLDEN.eval.total, "every eval case must remain multi-step");
  assert.equal(
    rows.reduce((total, row) => total + row.steps, 0),
    GOLDEN.eval.totalAutonomousSteps,
    "measured total autonomous steps must match golden"
  );
  assert.equal(
    Number(summary.avgSteps.toFixed(1)),
    GOLDEN.eval.avgAutonomousSteps,
    "measured one-decimal autonomous-step average must match golden"
  );

  // README anchor: it states the eval result as digits — parse and compare within tolerance.
  const m = README.match(/\*\*(\d+)\s*\/\s*(\d+)\s*\((\d+(?:\.\d+)?)%\)\*\*/);
  assert.ok(m, "README should state the eval result as '**22 / 22 (100.0%)**'");
  assert.equal(Number(m![1]), GOLDEN.eval.pass, "README eval pass count must match golden");
  assert.equal(Number(m![2]), GOLDEN.eval.total, "README eval total must match golden");
  assert.ok(Math.abs(Number(m![3]) - GOLDEN.eval.percent) < 0.1, "README eval % must match golden within 0.1");

  const avg = README.match(/avg\s+(\d+(?:\.\d+)?)/i);
  assert.ok(avg, "README should state the average autonomous-step count ('avg 2.4')");
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

// ════════════════════════════════════════════════════════════════════════════════
// CHECK 4 — README local links + heading anchors
// ════════════════════════════════════════════════════════════════════════════════

test("CHECK 4 · links: every local README target and Markdown heading fragment resolves", () => {
  const cache = new Map<string, Set<string>>();
  const anchorsFor = (path: string) => {
    let anchors = cache.get(path);
    if (!anchors) {
      anchors = markdownAnchors(readFileSync(path, "utf8"));
      cache.set(path, anchors);
    }
    return anchors;
  };

  for (const match of README.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g)) {
    const rawTarget = match[1]!.trim().replace(/^<|>$/g, "").split(/\s+["']/)[0]!;
    if (/^(?:https?:|mailto:|tel:)/i.test(rawTarget)) continue;
    const [rawPath = "", rawFragment] = rawTarget.split("#", 2);
    const relativePath = decodeURIComponent(rawPath);
    const targetPath = relativePath ? resolve(ROOT, relativePath) : join(ROOT, "README.md");
    assert.ok(
      targetPath === ROOT || targetPath.startsWith(ROOT + "\\") || targetPath.startsWith(ROOT + "/"),
      `README link escapes the repository: '${rawTarget}'`,
    );
    assert.ok(existsSync(targetPath), `README link target does not exist: '${rawTarget}'`);
    if (!rawFragment || !targetPath.toLowerCase().endsWith(".md")) continue;
    const fragment = decodeURIComponent(rawFragment).toLowerCase();
    assert.ok(
      anchorsFor(targetPath).has(fragment),
      `README link fragment '#${fragment}' does not match a heading in '${relativePath || "README.md"}'`,
    );
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// CHECK 5 — SMTP claim boundary (transport acceptance ≠ recipient delivery)
// ════════════════════════════════════════════════════════════════════════════════

function markdownFilesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...markdownFilesUnder(path));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(path);
  }
  return files;
}

test("CHECK 5 · claims: SMTP success means awaited transport acceptance, never recipient delivery", () => {
  const contract =
    "submits the approved message to the configured smtp transport and awaits transport acceptance; recipient delivery is not claimed";
  const contractFiles = [
    join(ROOT, "README.md"),
    join(ROOT, ".env.example"),
    join(ROOT, "demo", "PROJECT_STORY.md"),
    join(ROOT, "demo", "SUBMISSION.md"),
    join(ROOT, "demo", "JUDGE_REVIEW.md"),
    join(ROOT, "docs", "CLAIM_EVIDENCE_MATRIX.md"),
    join(ROOT, "scripts", "readiness.ts"),
  ];
  for (const path of contractFiles) {
    const normalized = readFileSync(path, "utf8")
      .replace(/[#`*_]/g, "")
      .replace(/\s+/g, " ")
      .toLowerCase();
    assert.ok(normalized.includes(contract), `${path} must state the bounded SMTP transport-acceptance contract`);
  }

  const judgeFacing = [
    join(ROOT, "README.md"),
    join(ROOT, "EVAL.md"),
    join(ROOT, ".env.example"),
    ...markdownFilesUnder(join(ROOT, "demo")),
    ...markdownFilesUnder(join(ROOT, "docs")),
  ];
  const forbidden = [
    /delivers? an actual (?:message|email) over smtp/i,
    /delivers? exactly the approved message/i,
    /delivers? the approved\/amended message/i,
    /\breal smtp send\b/i,
    /vendor-reply action to real delivery/i,
    /nodemailer sends after approval/i,
    /delivers via the transport seam/i,
  ];
  for (const path of judgeFacing) {
    const text = readFileSync(path, "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${path} contains an SMTP recipient-delivery overclaim (${pattern})`);
    }
  }
});

test("CHECK 6 · media: obsolete pre-auth UI captures remain deleted", () => {
  for (const name of ["ui_card.png", "ui_overview.png"]) {
    assert.equal(
      existsSync(join(ROOT, "demo", "video", "assets", name)),
      false,
      `obsolete demo/video/assets/${name} must not return as submission evidence`,
    );
  }
});

test("CHECK 6 · media: proof narration separates deployed application SHA from submission HEAD", () => {
  const renderer = readFileSync(join(ROOT, "scripts", "make_frames.py"), "utf8").toLowerCase();
  assert.ok(
    renderer.includes("recorded deployed application") && renderer.includes("submission head"),
    "Alibaba proof narration must distinguish the deployed application release from a later docs/media submission HEAD",
  );
  assert.ok(
    !renderer.includes("comes from the exact final commit"),
    "proof narration must not collapse deployed application SHA and final submission HEAD",
  );
});

test("CHECK 7 · supply chain: immutable Actions + hash-locked demo-video Python graph", () => {
  const NODE_VERSION = "24.18.0";
  const NPM_VERSION = "11.16.0";
  const BUILD_NODE_IMAGE =
    "node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd";
  const RUNTIME_IMAGE =
    "cgr.dev/chainguard/wolfi-base@sha256:02dab76bd852a70556b5b2002195c8a5fdab77d323c433bf6642aab080489795";
  const PGVECTOR_IMAGE =
    "pgvector/pgvector:0.8.5-pg16-bookworm@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb";
  const K6_SHA256 = "295d961ebfca306f295f1133068dcd403a8171c87f387928f5f30b0fbcff858a";
  const workflows = readdirSync(join(ROOT, ".github", "workflows"))
    .filter((name) => /\.ya?ml$/i.test(name))
    .map((name) => join(ROOT, ".github", "workflows", name));
  let actionRefs = 0;
  for (const path of workflows) {
    const yaml = readFileSync(path, "utf8");
    for (const match of yaml.matchAll(/uses:\s+([\w.-]+\/[\w.-]+)@([^\s#]+)(?:\s+#\s+(v[^\s]+))?/g)) {
      actionRefs += 1;
      assert.match(match[2]!, /^[0-9a-f]{40}$/, `${path}: ${match[1]} must use an immutable full commit SHA`);
      assert.match(match[3] ?? "", /^v\d+\.\d+\.\d+$/, `${path}: pinned ${match[1]} needs a readable release comment`);
    }
  }
  assert.ok(actionRefs >= 20, `expected the full workflow action surface, found only ${actionRefs} references`);

  const workflowTexts = workflows.map((path) => readFileSync(path, "utf8"));
  const configuredRunners = workflowTexts.flatMap((yaml) =>
    [...yaml.matchAll(/^\s*runs-on:\s*([^\s#]+)/gm)].map((match) => match[1]!),
  );
  assert.equal(configuredRunners.length, 13, "every workflow job must declare an exact runner image");
  assert.deepEqual([...new Set(configuredRunners)], ["ubuntu-24.04"]);
  const configuredNodeVersions = workflowTexts.flatMap((yaml) =>
    [...yaml.matchAll(/node-version:\s*["']?([^\s"'#]+)/g)].map((match) => match[1]!),
  );
  assert.equal(configuredNodeVersions.length, 11, "every setup-node use must declare the exact Node patch");
  assert.deepEqual([...new Set(configuredNodeVersions)], [NODE_VERSION]);
  assert.equal(readFileSync(join(ROOT, ".nvmrc"), "utf8").trim(), `v${NODE_VERSION}`);

  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const packageLock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  assert.equal(manifest.engines.node, NODE_VERSION);
  assert.equal(manifest.engines.npm, NPM_VERSION);
  assert.equal(manifest.packageManager, `npm@${NPM_VERSION}`);
  assert.equal(manifest.devDependencies["@types/node"], "24.13.3");
  assert.equal(packageLock.packages[""].engines.node, NODE_VERSION);
  assert.equal(packageLock.packages[""].engines.npm, NPM_VERSION);
  assert.equal(packageLock.packages[""].devDependencies["@types/node"], "24.13.3");

  const popplerLock = JSON.parse(readFileSync(join(ROOT, "eval", "promotion-poppler.lock.json"), "utf8"));
  assert.deepEqual(popplerLock, {
    schemaVersion: 1,
    platform: "win32",
    architecture: "x64",
    basename: "pdftoppm.exe",
    version: "26.05.0",
    packageSpec: "poppler=26.05.0=h4b9d284_3",
    sha256: "742cbbd9a00931ad16c6618410bc40471375d639a45c61c1d86f3dcfc54b6388",
    bundleFiles: 178,
    bundleSha256: "26876d12591351aa880d98a4a84b7a3f9d242f043ee95716ac8198ed0f5b0e30",
  });
  const supplyChain = readFileSync(join(ROOT, "docs", "SUPPLY_CHAIN.md"), "utf8");
  for (const value of [
    popplerLock.version,
    popplerLock.packageSpec,
    popplerLock.sha256,
    String(popplerLock.bundleFiles),
    popplerLock.bundleSha256,
  ]) assert.ok(supplyChain.includes(value), `Poppler lock value ${value} must be documented`);
  const promotionEnvironment = readFileSync(join(ROOT, "eval", "promotion-environment.ts"), "utf8");
  assert.match(promotionEnvironment, /promotion-poppler\.lock\.json/);
  assert.match(promotionEnvironment, /archon-poppler-bundle-v1/);
  assert.match(promotionEnvironment, /popplerBundleIdentity/);

  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  const stageImages = [...dockerfile.matchAll(/^FROM\s+(\S+)\s+AS\s+/gm)].map((match) => match[1]!);
  assert.deepEqual(
    stageImages,
    [BUILD_NODE_IMAGE, RUNTIME_IMAGE, RUNTIME_IMAGE],
    "the build, APK-resolver, and final runtime stages must use reviewed digests",
  );

  const dockerIgnore = readFileSync(join(ROOT, ".dockerignore"), "utf8");
  assert.deepEqual(
    dockerIgnore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
    [
      "*",
      "!package.json",
      "!package-lock.json",
      "!tsconfig.json",
      "!runtime-packages.lock",
      "!runtime-apk-inventory.lock",
      "!runtime-apk-archives.sha256",
      "!src/",
      "!src/**",
      "!scripts/",
      "!scripts/apply-schema.ts",
      "!scripts/bootstrap-db.ts",
      "!demo/",
      "!demo/sample-invoice.png",
    ],
    "the Docker context must remain a default-deny allowlist of reviewed COPY sources",
  );
  const scriptCopy = dockerfile.match(/^COPY\s+(.+?)\s+\.\/scripts\/\s*$/m);
  assert.ok(scriptCopy, "Dockerfile must copy the production database scripts into the build stage");
  const copiedScripts = scriptCopy[1]!.trim().split(/\s+/);
  assert.deepEqual(copiedScripts, ["scripts/apply-schema.ts", "scripts/bootstrap-db.ts"]);
  for (const source of copiedScripts) {
    assert.match(
      dockerIgnore,
      new RegExp(`^!${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"),
      `${source} must be explicitly present in the production Docker build context`,
    );
  }

  const attributes = readFileSync(join(ROOT, ".gitattributes"), "utf8");
  for (const frozenText of ["eval/dataset.sha256", "eval/vision/manifest.json", "eval/vision/fixtures.sha256"]) {
    assert.match(
      attributes,
      new RegExp(`^${frozenText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+text\\s+eol=lf$`, "m"),
      `${frozenText} must remain byte-stable across Windows and Linux checkouts`,
    );
  }

  const ciWorkflow = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(
    ciWorkflow,
    /name:\s+Build \(tsc\)\s+run:\s+npm run --ignore-scripts build/,
    "hosted compilation must suppress prebuild/postbuild lifecycle hooks",
  );
  assert.match(
    ciWorkflow,
    /name:\s+Build the exact production Docker image\s+run:\s+DOCKER_BUILDKIT=1 docker build --tag archon-qwen-autopilot:ci \./,
    "hosted CI must build the same production Dockerfile used by deploy/redeploy.sh",
  );
  const pgvectorImages = [...ciWorkflow.matchAll(/^\s*image:\s+(pgvector\/pgvector:\S+)/gm)].map(
    (match) => match[1]!,
  );
  assert.equal(pgvectorImages.length, 3, "all three real-Postgres jobs must declare pgvector");
  for (const image of pgvectorImages) assert.equal(image, PGVECTOR_IMAGE);

  const loadWorkflow = readFileSync(join(ROOT, ".github", "workflows", "load-test.yml"), "utf8");
  assert.match(loadWorkflow, /K6_VERSION="2\.1\.0"/);
  assert.match(loadWorkflow, new RegExp(`K6_SHA256="${K6_SHA256}"`));
  assert.match(loadWorkflow, /grafana\/k6\/releases\/download\/v\$\{K6_VERSION\}/);
  assert.match(loadWorkflow, /K6_DIR="\$PWD\/\.artifacts\/k6"/);
  assert.match(loadWorkflow, /sha256sum --check --strict/);
  assert.doesNotMatch(loadWorkflow, /dl\.k6\.io|keyserver|sudo\s+gpg|apt-get\s+install[^\n]*\bk6\b/);
  assert.match(loadWorkflow, /K6_SUMMARY_PATH:\s*\.artifacts\/load-test\/load-summary\.json/);
  for (const finiteLoadCap of [
    'UPLOAD_DAILY_LIMIT: "1000000"',
    'UPLOAD_GLOBAL_DAILY_LIMIT: "1000000"',
    'REVIEWER_UPLOAD_DAILY_LIMIT: "1000000"',
    'REVIEWER_UPLOAD_GLOBAL_DAILY_LIMIT: "1000000"',
    'HTTP_REQUESTS_PER_MINUTE: "10000"',
    'REVIEWER_HTTP_REQUESTS_PER_MINUTE: "20000"',
    'HTTP_GLOBAL_REQUESTS_PER_MINUTE: "100000"',
  ]) {
    assert.ok(loadWorkflow.includes(finiteLoadCap), `offline load workflow must pin ${finiteLoadCap}`);
  }
  assert.match(loadWorkflow, /REQUIRE_INTAKE_ACCEPTED:.*'true'.*'false'/);

  const loadProfile = readFileSync(join(ROOT, "load", "workflow-load.js"), "utf8");
  assert.match(loadProfile, /REQUIRE_INTAKE_ACCEPTED/);
  assert.match(loadProfile, /thresholds\.intake_accepted\s*=\s*\["rate>0\.99"\]/);
  assert.match(loadProfile, /thresholds\.http_req_failed\s*=\s*\["rate<0\.01"\]/);
  const loadScript = readFileSync(join(ROOT, "load", "workflow-load.js"), "utf8");
  assert.doesNotMatch(
    loadScript,
    /from\s+["']https?:\/\//,
    "the load script must not execute mutable remote JavaScript imports",
  );
  assert.match(loadScript, /K6_REVIEWER_TOKEN is required/);
  assert.match(loadScript, /Authorization:\s*`Bearer \$\{REVIEWER_TOKEN\}`/);

  const videoWorkflow = readFileSync(join(ROOT, ".github", "workflows", "demo-video.yml"), "utf8");
  assert.match(videoWorkflow, /python-version:\s*["']3\.11\.15["']/);
  assert.match(videoWorkflow, /cache:\s*pip/);
  assert.match(videoWorkflow, /cache-dependency-path:\s*demo\/video\/requirements\.lock/);
  assert.match(videoWorkflow, /pip install[^\n]*--require-hashes[^\n]*--only-binary=:all:[^\n]*-r demo\/video\/requirements\.lock/);
  assert.match(videoWorkflow, /python -m pip check/);
  assert.doesNotMatch(videoWorkflow, /pip install --upgrade pip|(?:pillow|edge-tts)\s*>?=/i);

  const direct = readFileSync(join(ROOT, "demo", "video", "requirements.in"), "utf8");
  assert.match(direct, /^Pillow==12\.2\.0$/m);
  assert.match(direct, /^edge-tts==7\.2\.8$/m);
  const lock = readFileSync(join(ROOT, "demo", "video", "requirements.lock"), "utf8");
  assert.match(lock, /^pillow==12\.2\.0\s*\\$/m);
  assert.match(lock, /^edge-tts==7\.2\.8\s*\\$/m);
  const starts = [...lock.matchAll(/^([a-z0-9_.-]+)==([^\s\\]+)\s*\\$/gm)];
  assert.ok(starts.length >= 10, `expected a transitive Python lock, found ${starts.length} packages`);
  const allHashMarkers = [...lock.matchAll(/--hash=sha256:([^\s\\]+)/g)];
  assert.ok(allHashMarkers.length >= starts.length, "every locked package needs at least one SHA-256 distribution hash");
  for (const marker of allHashMarkers) assert.match(marker[1]!, /^[0-9a-f]{64}$/, "lock contains a malformed SHA-256 hash");
  for (let i = 0; i < starts.length; i += 1) {
    const begin = starts[i]!.index!;
    const end = i + 1 < starts.length ? starts[i + 1]!.index! : lock.length;
    assert.match(lock.slice(begin, end), /--hash=sha256:[0-9a-f]{64}/, `${starts[i]![1]} lacks a SHA-256 hash`);
  }
});

test("CHECK 8 · promotion evidence: attempt 01 remains immutable and environment-invalid", () => {
  const protocol = readFileSync(join(ROOT, "docs", "MODEL_PROMOTION.md"), "utf8");
  const results = readFileSync(join(ROOT, "eval", "results", "README.md"), "utf8");
  const evaluation = readFileSync(join(ROOT, "EVAL.md"), "utf8");
  const comparison = readFileSync(join(ROOT, "eval", "compare.ts"), "utf8");
  const promotionPreflight = readFileSync(join(ROOT, "eval", "promotion-preflight.ts"), "utf8");
  const promotionRecovery = readFileSync(join(ROOT, "eval", "promotion-recovery.ts"), "utf8");
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const ledger = JSON.parse(readFileSync(join(ROOT, "eval", "results", "evidence-ledger.json"), "utf8"));
  const attempt01 = readFileSync(join(ROOT, "eval", "results", "model-promotion-ab-attempt-01.json"));
  for (const text of [protocol, results]) {
    assert.match(text, /attempt(?: |-)?01/i);
    assert.match(text, /environment-invalid diagnostic/i);
    assert.match(text, /cdc2be2760e85feecb173083355c5b7f10f6f928852ddca4f052ac518b809588/);
    assert.match(text, /never (?:be )?overwritten|never overwrite/i);
    assert.match(text, /not (?:promotion|model-quality) evidence|not promotion evidence/i);
  }
  assert.match(protocol, /model-promotion-ab-attempt-02\.json/);
  assert.match(protocol, /AB \/ BA \/ BA \/ AB/);
  assert.match(protocol, /all four paired runs/);
  assert.match(protocol, /30,000 ms/);
  assert.match(protocol, /1\.5×/);
  assert.match(protocol, /--expected-release/);
  assert.match(protocol, /at least \*\*4 correct fields\*\*/);
  assert.match(protocol, /\*\*10% aggregate error-inclusive latency win\*\*/);
  assert.match(protocol, /tie[\s\S]{0,120}promotion-fail/i);
  assert.match(comparison, /const PROMOTION_RUN_ORDER = \["AB", "BA", "BA", "AB"\]/);
  assert.match(comparison, /maxMeanLatencyMsIncludingSeedSetup: 30_000/);
  assert.match(comparison, /maxMeanLatencyMs: 30_000/);
  assert.match(comparison, /maxMeanLatencyRatioVsBaseline: 1\.5/);
  assert.equal(
    packageJson.scripts["eval:compare:live"],
    "node --import tsx eval/compare.ts --online --runs 4"
  );
  assert.equal(
    packageJson.scripts["eval:compare:preflight"],
    "node --import tsx eval/promotion-preflight.ts"
  );
  assert.equal(
    packageJson.scripts["eval:compare:recover"],
    "node --import tsx eval/promotion-recovery.ts"
  );
  assert.match(protocol, /eval:compare:preflight/);
  assert.match(protocol, /zero-provider-call/i);
  assert.match(promotionPreflight, /providerCalls: 0/);
  assert.match(promotionPreflight, /artifactCreated: false/);
  assert.match(promotionPreflight, /committedProtocolState\(PROMOTION_PROTOCOL_FILES/);
  assert.match(promotionPreflight, /preflightPromotionEnvironment/);
  assert.ok((promotionPreflight.match(/requireHeadMatchesOriginMain: true/g) ?? []).length >= 3);
  assert.ok((comparison.match(/requireHeadMatchesOriginMain: true/g) ?? []).length >= 2);
  assert.doesNotMatch(promotionPreflight, /createExclusiveEvidenceArtifact|persistEvidenceArtifact|hasQwenCreds/);
  assert.match(comparison, /PROMOTION_PROGRESS_ROOT_STATUS = "incomplete"/);
  assert.match(comparison, /assertPromotionRootStatusForPersistence/);
  assert.match(protocol, /authoritative root JSON is `status: "incomplete"`/i);
  assert.match(protocol, /eval:compare:recover/);
  assert.match(protocol, /non-authoritative/);
  assert.match(protocol, /providerCalls: 0/);
  assert.match(promotionRecovery, /cleanupPromotionEvidenceStagingRemnants/);
  assert.match(promotionRecovery, /providerCalls: 0/);
  assert.doesNotMatch(promotionRecovery, /DASHSCOPE|QwenVision|runScenario|createQwenClient/);
  assert.deepEqual(ledger, {
    schemaVersion: 1,
    attempts: [{
      path: "eval/results/model-promotion-ab-attempt-01.json",
      sha256: "cdc2be2760e85feecb173083355c5b7f10f6f928852ddca4f052ac518b809588",
      sourceCommit: "69e926748bb5e97ff5bc7d7cb69b6c9f8cd88e42",
      status: "incomplete",
      classification: "environment-invalid-diagnostic",
    }],
  });
  assert.equal(
    createHash("sha256").update(attempt01).digest("hex"),
    "cdc2be2760e85feecb173083355c5b7f10f6f928852ddca4f052ac518b809588"
  );
  assert.equal(attempt01.includes(Buffer.from("\r\n")), false);
  assert.match(comparison, /"\.gitattributes", "tsconfig\.json"/);
  assert.match(comparison, /finalGuardedAgreement: 1/);
  assert.match(comparison, /aggregateCorrectFieldGain: 4/);
  assert.match(comparison, /aggregateLatencyWinRatio: 0\.9/);
  assert.match(evaluation, /model-promotion-ab-attempt-02\.json/);
  assert.doesNotMatch(evaluation, /model-promotion-ab-attempt-01\.json/);
  const commandSection = protocol.match(
    /## Counterbalanced same-attempt command[\s\S]*?```(?:powershell|bash)\r?\n[\s\S]*?\r?\n```/
  )?.[0] ?? "";
  assert.match(commandSection, /--write eval\/results\/model-promotion-ab-attempt-02\.json/);
  assert.doesNotMatch(
    commandSection,
    /model-promotion-ab-attempt-01\.json/,
    "the current command must never target the immutable diagnostic"
  );
});
