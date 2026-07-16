import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  SarifGateError,
  evaluateSarifDocuments,
  runGate,
  type SarifDocument,
} from "../../scripts/codeql-sarif-gate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST_ARTIFACTS = join(ROOT, ".artifacts", "codeql-gate-tests");
const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) {
    const target = cleanup.pop()!;
    assert.ok(target.startsWith(`${TEST_ARTIFACTS}`), "test cleanup escaped the project artifact root");
    rmSync(target, { recursive: true, force: true });
  }
});

function tempDirectory(): string {
  mkdirSync(TEST_ARTIFACTS, { recursive: true });
  const directory = mkdtempSync(join(TEST_ARTIFACTS, "case-"));
  cleanup.push(directory);
  return directory;
}

function input(document: unknown, name = "upload.sarif"): SarifDocument {
  return { name, sha256: "a".repeat(64), document };
}

function sarif(
  rules: unknown[],
  results: unknown[],
  extensions: unknown[] = [],
): unknown {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "CodeQL", rules }, extensions },
        results,
      },
    ],
  };
}

function sarifRun(properties: Record<string, unknown>): unknown {
  return {
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "CodeQL", rules: [] } }, ...properties }],
  };
}

const rule = (id: string, severity?: string): unknown => ({
  id,
  properties: severity === undefined ? { "problem.severity": "warning" } : { "security-severity": severity },
});

test("CodeQL gate maps ruleIndex to security-severity and blocks >= 7.0", () => {
  const summary = evaluateSarifDocuments(
    [input(sarif([rule("js/high", "7.0")], [{ ruleId: "js/high", ruleIndex: 0 }]))],
    7,
    new Date("2026-07-16T00:00:00.000Z"),
  );

  assert.equal(summary.status, "fail");
  assert.equal(summary.highOrCriticalResults, 1);
  assert.deepEqual(summary.violations, [
    { ruleId: "js/high", securitySeverity: 7, resultCount: 1 },
  ]);
  assert.equal(summary.policy.allowlistEntries, 0);
});

test("CodeQL gate maps ruleId without ruleIndex and leaves quality results unscored", () => {
  const summary = evaluateSarifDocuments([
    input(
      sarif(
        [rule("js/medium", "6.9"), rule("js/quality")],
        [{ ruleId: "js/medium" }, { ruleId: "js/quality" }],
      ),
    ),
  ]);

  assert.equal(summary.status, "pass");
  assert.equal(summary.securityScoredResults, 1);
  assert.equal(summary.unscoredResults, 1);
  assert.equal(summary.highOrCriticalResults, 0);
});

test("CodeQL gate fails closed when a security-tagged result has no numeric severity", () => {
  for (const tags of [["security"], [" Security "], ["reliability", "security"]]) {
    assert.throws(
      () =>
        evaluateSarifDocuments([
          input(
            sarif(
              [{ id: "js/security-unscored", properties: { tags } }],
              [{ ruleId: "js/security-unscored", ruleIndex: 0 }],
            ),
          ),
        ]),
      (error: unknown) =>
        error instanceof SarifGateError && error.code === "MISSING_SECURITY_SEVERITY",
    );
  }

  const quality = evaluateSarifDocuments([
    input(
      sarif(
        [{ id: "js/quality", properties: { tags: ["maintainability", "reliability"] } }],
        [{ ruleId: "js/quality", ruleIndex: 0 }],
      ),
    ),
  ]);
  assert.equal(quality.status, "pass");
  assert.equal(quality.unscoredResults, 1);

  for (const tags of ["security", null, [null], [""], ["   "]]) {
    assert.throws(
      () =>
        evaluateSarifDocuments([
          input(
            sarif(
              [{ id: "js/malformed-tags", properties: { tags } }],
              [{ ruleId: "js/malformed-tags", ruleIndex: 0 }],
            ),
          ),
        ]),
      (error: unknown) => error instanceof SarifGateError && error.code === "INVALID_SARIF",
    );
  }
});

test("CodeQL gate takes the maximum result/rule severity and never downscopes a conflict", () => {
  const summary = evaluateSarifDocuments([
    input(
      sarif(
        [rule("js/conflict", "4.0")],
        [{
          ruleId: "js/conflict",
          ruleIndex: 0,
          properties: { "security-severity": "9.1" },
        }],
      ),
    ),
  ]);

  assert.equal(summary.status, "fail");
  assert.equal(summary.violations[0]?.securitySeverity, 9.1);
});

test("CodeQL gate resolves reporting descriptors in a referenced tool extension", () => {
  const summary = evaluateSarifDocuments([
    input(
      sarif(
        [],
        [{ rule: { id: "js/extension-high", index: 0, toolComponent: { index: 0 } } }],
        [{ name: "CodeQL extension", rules: [rule("js/extension-high", "8.2")] }],
      ),
    ),
  ]);

  assert.equal(summary.status, "fail");
  assert.equal(summary.violations[0]?.ruleId, "js/extension-high");
});

test("CodeQL gate fails closed on invalid severities and unresolved rule mappings", () => {
  assert.throws(
    () =>
      evaluateSarifDocuments([
        input(sarif([rule("js/bad", "not-a-number")], [{ ruleId: "js/bad", ruleIndex: 0 }])),
      ]),
    (error: unknown) => error instanceof SarifGateError && error.code === "INVALID_SECURITY_SEVERITY",
  );
  assert.throws(
    () =>
      evaluateSarifDocuments([
        input(sarif([rule("js/blank", "   ")], [{ ruleId: "js/blank", ruleIndex: 0 }])),
      ]),
    (error: unknown) => error instanceof SarifGateError && error.code === "INVALID_SECURITY_SEVERITY",
  );
  assert.throws(
    () => evaluateSarifDocuments([input(sarif([], [{ ruleId: "js/missing", ruleIndex: 0 }]))]),
    (error: unknown) => error instanceof SarifGateError && error.code === "UNRESOLVED_RULE",
  );
  assert.throws(
    () => evaluateSarifDocuments([input({ version: "2.1.0", runs: [] })]),
    (error: unknown) => error instanceof SarifGateError && error.code === "NO_RUNS",
  );
});

test("CodeQL gate requires every run to own an explicitly present results array", () => {
  const valid = evaluateSarifDocuments([input(sarifRun({ results: [] }))]);
  assert.equal(valid.status, "pass");
  assert.equal(valid.results, 0);

  for (const properties of [
    {},
    { results: undefined },
    { results: null },
    { results: {} },
    { results: "[]" },
  ]) {
    assert.throws(
      () => evaluateSarifDocuments([input(sarifRun(properties))]),
      (error: unknown) => error instanceof SarifGateError && error.code === "INVALID_SARIF",
    );
  }

  const inheritedResultsRun = Object.create({ results: [] }) as Record<string, unknown>;
  inheritedResultsRun.tool = { driver: { name: "CodeQL", rules: [] } };
  assert.throws(
    () =>
      evaluateSarifDocuments([
        input({ version: "2.1.0", runs: [inheritedResultsRun] }),
      ]),
    (error: unknown) => error instanceof SarifGateError && error.code === "INVALID_SARIF",
  );
});

test("CodeQL gate accepts absent or successful invocations and rejects malformed or failed invocations", () => {
  for (const document of [
    sarifRun({ results: [] }),
    sarifRun({ results: [], invocations: [] }),
    sarifRun({ results: [], invocations: [{ executionSuccessful: true }] }),
  ]) {
    assert.equal(evaluateSarifDocuments([input(document)]).status, "pass");
  }

  for (const invocations of [
    undefined,
    null,
    {},
    [null],
    ["invocation"],
    [{}],
    [{ executionSuccessful: null }],
    [{ executionSuccessful: "true" }],
    [{ executionSuccessful: 1 }],
  ]) {
    assert.throws(
      () => evaluateSarifDocuments([input(sarifRun({ results: [], invocations }))]),
      (error: unknown) => error instanceof SarifGateError && error.code === "INVALID_SARIF",
    );
  }

  const inheritedSuccess = Object.create({ executionSuccessful: true }) as Record<string, unknown>;
  assert.throws(
    () =>
      evaluateSarifDocuments([
        input(sarifRun({ results: [], invocations: [inheritedSuccess] })),
      ]),
    (error: unknown) => error instanceof SarifGateError && error.code === "INVALID_SARIF",
  );

  assert.throws(
    () =>
      evaluateSarifDocuments([
        input(sarifRun({ results: [], invocations: [{ executionSuccessful: false }] })),
      ]),
    (error: unknown) => error instanceof SarifGateError && error.code === "FAILED_INVOCATION",
  );
});

test("CodeQL gate validates execution and configuration notification structure and levels", () => {
  const notificationProperties = [
    "toolExecutionNotifications",
    "toolConfigurationNotifications",
    "configurationNotifications",
  ] as const;

  assert.equal(
    evaluateSarifDocuments([
      input(
        sarifRun({
          results: [],
          invocations: [{
            executionSuccessful: true,
            toolExecutionNotifications: [{}, { level: "none" }],
            toolConfigurationNotifications: [{ level: "note" }],
            configurationNotifications: [{ level: "warning" }],
          }],
        }),
      ),
    ]).status,
    "pass",
  );

  for (const property of notificationProperties) {
    for (const notifications of [
      undefined,
      null,
      {},
      [null],
      ["notification"],
      [{ level: null }],
      [{ level: 1 }],
      [{ level: "fatal" }],
      [{ level: "Warning" }],
    ]) {
      assert.throws(
        () =>
          evaluateSarifDocuments([
            input(
              sarifRun({
                results: [],
                invocations: [{ executionSuccessful: true, [property]: notifications }],
              }),
            ),
          ]),
        (error: unknown) => error instanceof SarifGateError && error.code === "INVALID_SARIF",
      );
    }

    assert.throws(
      () =>
        evaluateSarifDocuments([
          input(
            sarifRun({
              results: [],
              invocations: [{
                executionSuccessful: true,
                [property]: [{ level: "error" }],
              }],
            }),
          ),
        ]),
      (error: unknown) => error instanceof SarifGateError && error.code === "ERROR_NOTIFICATION",
    );
  }
});

test("CLI gate retains a sanitized summary before returning a blocking exit code", () => {
  const directory = tempDirectory();
  const inputDirectory = join(directory, "post-processed");
  const summaryPath = join(directory, "summary.json");
  mkdirSync(inputDirectory, { recursive: true });
  writeFileSync(
    join(inputDirectory, "upload.sarif"),
    JSON.stringify(
      sarif(
        [rule("js/retained-high", "8.0")],
        [{
          ruleId: "js/retained-high",
          ruleIndex: 0,
          message: { text: "sensitive source detail" },
          locations: [{ physicalLocation: { artifactLocation: { uri: "src/private.ts" } } }],
        }],
      ),
    ),
  );
  const originalError = console.error;
  console.error = () => undefined;
  try {
    assert.equal(runGate({ input: inputDirectory, summary: summaryPath, threshold: 7 }), 1);
  } finally {
    console.error = originalError;
  }

  const rawSummary = readFileSync(summaryPath, "utf8");
  const summary = JSON.parse(rawSummary) as Record<string, unknown>;
  assert.equal(summary.status, "fail");
  assert.doesNotMatch(rawSummary, /sensitive source detail|src\/private\.ts|locations|message/);
  assert.match(rawSummary, /"sha256": "[0-9a-f]{64}"/);
});

test("CLI gate never echoes rejected notification content or locations", () => {
  const directory = tempDirectory();
  const inputDirectory = join(directory, "post-processed");
  const summaryPath = join(directory, "summary.json");
  const notificationPayload = "notification-redaction-fixture-9f23f34e";
  const privateLocation = "src/private-notification.ts";
  mkdirSync(inputDirectory, { recursive: true });
  writeFileSync(
    join(inputDirectory, "upload.sarif"),
    JSON.stringify(
      sarifRun({
        results: [],
        invocations: [{
          executionSuccessful: true,
          toolExecutionNotifications: [{
            level: "error",
            message: { text: `sensitive ${notificationPayload}` },
            locations: [{ physicalLocation: { artifactLocation: { uri: privateLocation } } }],
          }],
        }],
      }),
    ),
  );

  let emitted = "";
  const originalError = console.error;
  console.error = (...values: unknown[]) => {
    emitted += values.map(String).join(" ");
  };
  try {
    assert.equal(runGate({ input: inputDirectory, summary: summaryPath, threshold: 7 }), 2);
  } finally {
    console.error = originalError;
  }

  const rawSummary = readFileSync(summaryPath, "utf8");
  const summary = JSON.parse(rawSummary) as {
    status: string;
    error: { code: string };
  };
  assert.equal(summary.status, "error");
  assert.equal(summary.error.code, "ERROR_NOTIFICATION");
  for (const sensitive of [notificationPayload, privateLocation, "sensitive notification-redaction"]) {
    assert.doesNotMatch(rawSummary, new RegExp(sensitive));
    assert.doesNotMatch(emitted, new RegExp(sensitive));
  }
});

test("CLI gate writes an error summary and fails closed when no SARIF exists", () => {
  const directory = tempDirectory();
  const inputDirectory = join(directory, "empty");
  const summaryPath = join(directory, "summary.json");
  mkdirSync(inputDirectory, { recursive: true });
  const originalError = console.error;
  console.error = () => undefined;
  try {
    assert.equal(runGate({ input: inputDirectory, summary: summaryPath, threshold: 7 }), 2);
  } finally {
    console.error = originalError;
  }
  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
    status: string;
    error: { code: string };
  };
  assert.equal(summary.status, "error");
  assert.equal(summary.error.code, "NO_SARIF");
});
