// Unit — the custom Qwen skill catalog. Asserts the catalog is a FAITHFUL,
// non-drifting projection of the live function-calling defs (analysis-tools.ts +
// tools.ts): every declared skill appears exactly once, tier/gate/rule annotations
// are correct, and the parameters are the very object handed to qwen-plus.

import { test } from "node:test";
import assert from "node:assert/strict";
import { listSkills, skillCatalog, ALL_SKILL_NAMES } from "../../src/skills/catalog.js";
import { analysisToolDefs, ANALYSIS_TOOL_NAMES } from "../../src/ap/analysis-tools.js";
import { toolDefs, TERMINAL_TOOL_NAMES } from "../../src/ap/tools.js";

test("the catalog lists every declared skill exactly once (no drift, no leak)", () => {
  const names = listSkills().map((s) => s.name);
  assert.deepEqual([...names].sort(), [...ALL_SKILL_NAMES].sort());
  assert.equal(new Set(names).size, names.length, "no duplicate skill names");
  assert.equal(names.length, ANALYSIS_TOOL_NAMES.length + TERMINAL_TOOL_NAMES.length);
});

test("autonomous skills are ungated; terminal skills are human-gated", () => {
  const byName = new Map(listSkills().map((s) => [s.name, s]));
  for (const n of ANALYSIS_TOOL_NAMES) {
    assert.equal(byName.get(n)!.tier, "autonomous");
    assert.equal(byName.get(n)!.gate, "autonomous", `${n} must be ungated (side-effect-free)`);
  }
  for (const n of TERMINAL_TOOL_NAMES) {
    assert.equal(byName.get(n)!.tier, "terminal");
    assert.equal(byName.get(n)!.gate, "human-gated", `${n} must be human-gated`);
  }
});

test("R1–R6 rule ownership is annotated on the right skills", () => {
  const byName = new Map(listSkills().map((s) => [s.name, s]));
  assert.deepEqual(byName.get("validate_invoice")!.rules, ["R1", "R2", "R3", "R4"]);
  assert.deepEqual(byName.get("check_duplicate")!.rules, ["R5"]);
  assert.deepEqual(byName.get("compute_variance_vs_history")!.rules, ["R6"]);
  // Terminal actions own no validation rule.
  for (const n of TERMINAL_TOOL_NAMES) assert.deepEqual(byName.get(n)!.rules, []);
});

test("each skill's parameters ARE the live function-calling schema (a faithful contract)", () => {
  const live = new Map(
    [...analysisToolDefs(), ...toolDefs()].map((d) => [d.function.name, d.function.parameters])
  );
  for (const s of listSkills()) {
    assert.deepEqual(s.parameters, live.get(s.name), `${s.name} parameters must match the live def`);
    assert.equal(s.description, [...analysisToolDefs(), ...toolDefs()].find((d) => d.function.name === s.name)!.function.description);
  }
});

test("the catalog envelope frames the skill set as custom-skills and counts them", () => {
  const cat = skillCatalog();
  assert.equal(cat.kind, "custom-skills");
  assert.equal(cat.count, cat.skills.length);
  assert.equal(cat.count, ALL_SKILL_NAMES.length);
  assert.ok(cat.description.length > 0);
});
