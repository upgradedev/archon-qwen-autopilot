#!/usr/bin/env node

// Fail-closed CodeQL SARIF severity gate. It deliberately emits only aggregate
// rule identifiers/counts: source snippets, messages, and locations remain in
// the access-controlled retained SARIF artifact rather than CI log output.

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;

export interface SarifDocument {
  name: string;
  sha256: string;
  document: unknown;
}

export interface CodeqlViolation {
  ruleId: string;
  securitySeverity: number;
  resultCount: number;
}

export interface CodeqlGateSummary {
  schemaVersion: 1;
  generatedAt: string;
  sourceCommit: string | null;
  status: "pass" | "fail";
  threshold: number;
  policy: {
    comparison: ">=";
    allowlistEntries: 0;
    input: "post-processed-sarif";
  };
  sarifFiles: Array<{ name: string; sha256: string }>;
  runs: number;
  results: number;
  securityScoredResults: number;
  unscoredResults: number;
  highOrCriticalResults: number;
  violations: CodeqlViolation[];
}

export class SarifGateError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SarifGateError";
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: JsonObject, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function requireObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) {
    throw new SarifGateError("INVALID_SARIF", `${label} must be an object`);
  }
  return value;
}

function optionalObject(value: unknown, label: string): JsonObject | undefined {
  if (value === undefined) return undefined;
  return requireObject(value, label);
}

function optionalArray(value: unknown, label: string): unknown[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new SarifGateError("INVALID_SARIF", `${label} must be an array`);
  }
  return value;
}

function requireOwnArray(value: JsonObject, property: string, label: string): unknown[] {
  if (!hasOwn(value, property) || !Array.isArray(value[property])) {
    throw new SarifGateError("INVALID_SARIF", `${label} must be an explicitly present array`);
  }
  return value[property];
}

const NOTIFICATION_PROPERTIES = [
  "toolExecutionNotifications",
  // SARIF 2.1.0's canonical configuration-notification property.
  "toolConfigurationNotifications",
  // Retain strict validation for producers using this compatibility spelling.
  "configurationNotifications",
] as const;

const SARIF_NOTIFICATION_LEVELS = new Set(["none", "note", "warning", "error"]);

function validateNotificationArray(
  invocation: JsonObject,
  property: (typeof NOTIFICATION_PROPERTIES)[number],
  invocationLabel: string,
): void {
  if (!hasOwn(invocation, property)) return;
  const label = `${invocationLabel}.${property}`;
  const notifications = invocation[property];
  if (!Array.isArray(notifications)) {
    throw new SarifGateError("INVALID_SARIF", `${label} must be an array`);
  }

  for (const [index, notificationValue] of notifications.entries()) {
    const notificationLabel = `${label}[${index}]`;
    const notification = requireObject(notificationValue, notificationLabel);
    // SARIF 2.1.0 defaults a missing notification level to "warning".
    if (!hasOwn(notification, "level")) continue;
    const level = notification.level;
    if (typeof level !== "string" || !SARIF_NOTIFICATION_LEVELS.has(level)) {
      throw new SarifGateError(
        "INVALID_SARIF",
        `${notificationLabel}.level must be one of none, note, warning, or error`,
      );
    }
    if (level === "error") {
      // Do not include notification messages, locations, descriptors, or other
      // producer-controlled content in this error: runGate persists and logs it.
      throw new SarifGateError(
        "ERROR_NOTIFICATION",
        `${notificationLabel}.level reported an analysis error`,
      );
    }
  }
}

function validateInvocations(run: JsonObject, runLabel: string): void {
  if (!hasOwn(run, "invocations")) return;
  const invocations = run.invocations;
  if (!Array.isArray(invocations)) {
    throw new SarifGateError("INVALID_SARIF", `${runLabel}.invocations must be an array`);
  }

  for (const [index, invocationValue] of invocations.entries()) {
    const invocationLabel = `${runLabel}.invocations[${index}]`;
    const invocation = requireObject(invocationValue, invocationLabel);
    if (
      !hasOwn(invocation, "executionSuccessful") ||
      typeof invocation.executionSuccessful !== "boolean"
    ) {
      throw new SarifGateError(
        "INVALID_SARIF",
        `${invocationLabel}.executionSuccessful must be an explicitly present boolean`,
      );
    }
    if (invocation.executionSuccessful === false) {
      throw new SarifGateError(
        "FAILED_INVOCATION",
        `${invocationLabel}.executionSuccessful reported a failed analysis`,
      );
    }
    for (const property of NOTIFICATION_PROPERTIES) {
      validateNotificationArray(invocation, property, invocationLabel);
    }
  }
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new SarifGateError("INVALID_SARIF", `${label} must be a non-empty string`);
  }
  return value;
}

function optionalIndex(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < -1) {
    throw new SarifGateError("INVALID_SARIF", `${label} must be an integer >= -1`);
  }
  return value as number;
}

function securitySeverity(properties: unknown, label: string): number | undefined {
  if (properties === undefined) return undefined;
  const bag = requireObject(properties, label);
  const raw = bag["security-severity"];
  if (raw === undefined) return undefined;
  const decimal = typeof raw === "string" ? raw.trim() : undefined;
  const value =
    typeof raw === "number"
      ? raw
      : decimal && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(decimal)
        ? Number(decimal)
        : Number.NaN;
  if (!Number.isFinite(value) || value < 0 || value > 10) {
    throw new SarifGateError(
      "INVALID_SECURITY_SEVERITY",
      `${label}.security-severity must be numeric and between 0.0 and 10.0`,
    );
  }
  return value;
}

function propertyTags(properties: unknown, label: string): string[] {
  if (properties === undefined) return [];
  const bag = requireObject(properties, label);
  if (!hasOwn(bag, "tags")) return [];
  if (!Array.isArray(bag.tags)) {
    throw new SarifGateError("INVALID_SARIF", `${label}.tags must be an array`);
  }
  return bag.tags.map((tag, index) => {
    if (typeof tag !== "string" || tag.trim().length === 0) {
      throw new SarifGateError(
        "INVALID_SARIF",
        `${label}.tags[${index}] must be a non-empty string`,
      );
    }
    return tag.trim().toLowerCase();
  });
}

interface ToolComponent {
  index: number;
  value: JsonObject;
}

function toolComponents(run: JsonObject, label: string): ToolComponent[] {
  const tool = requireObject(run.tool, `${label}.tool`);
  const driver = requireObject(tool.driver, `${label}.tool.driver`);
  const extensions = optionalArray(tool.extensions, `${label}.tool.extensions`) ?? [];
  return [
    { index: -1, value: driver },
    ...extensions.map((extension, index) => ({
      index,
      value: requireObject(extension, `${label}.tool.extensions[${index}]`),
    })),
  ];
}

function resolveComponent(
  components: ToolComponent[],
  reference: JsonObject | undefined,
  label: string,
): ToolComponent {
  if (!reference) return components[0]!;
  const index = optionalIndex(reference.index, `${label}.index`);
  const name = optionalString(reference.name, `${label}.name`);
  const guid = optionalString(reference.guid, `${label}.guid`);
  let candidates = components;
  if (index !== undefined) candidates = candidates.filter((component) => component.index === index);
  if (name !== undefined) candidates = candidates.filter((component) => component.value.name === name);
  if (guid !== undefined) candidates = candidates.filter((component) => component.value.guid === guid);
  if (candidates.length !== 1) {
    throw new SarifGateError(
      "UNRESOLVED_RULE_COMPONENT",
      `${label} did not resolve to exactly one SARIF tool component`,
    );
  }
  return candidates[0]!;
}

function resolveRule(
  result: JsonObject,
  components: ToolComponent[],
  label: string,
): { id: string; properties: unknown } | undefined {
  const ruleReference = optionalObject(result.rule, `${label}.rule`);
  const componentReference = ruleReference
    ? optionalObject(ruleReference.toolComponent, `${label}.rule.toolComponent`)
    : undefined;
  const component = resolveComponent(components, componentReference, `${label}.rule.toolComponent`);
  const rules = optionalArray(component.value.rules, `${label}.resolvedComponent.rules`) ?? [];

  const resultRuleId = optionalString(result.ruleId, `${label}.ruleId`);
  const referenceRuleId = ruleReference
    ? optionalString(ruleReference.id, `${label}.rule.id`)
    : undefined;
  if (resultRuleId && referenceRuleId && resultRuleId !== referenceRuleId) {
    throw new SarifGateError("CONFLICTING_RULE_REFERENCE", `${label} has conflicting rule identifiers`);
  }
  const ruleId = referenceRuleId ?? resultRuleId;

  const resultRuleIndex = optionalIndex(result.ruleIndex, `${label}.ruleIndex`);
  const referenceRuleIndex = ruleReference
    ? optionalIndex(ruleReference.index, `${label}.rule.index`)
    : undefined;
  if (
    resultRuleIndex !== undefined &&
    referenceRuleIndex !== undefined &&
    resultRuleIndex !== referenceRuleIndex
  ) {
    throw new SarifGateError("CONFLICTING_RULE_REFERENCE", `${label} has conflicting rule indexes`);
  }
  const ruleIndex = referenceRuleIndex ?? resultRuleIndex;
  const ruleGuid = ruleReference
    ? optionalString(ruleReference.guid, `${label}.rule.guid`)
    : undefined;

  let candidates = rules.map((rule, index) => ({
    index,
    value: requireObject(rule, `${label}.resolvedComponent.rules[${index}]`),
  }));
  if (ruleIndex !== undefined && ruleIndex >= 0) {
    candidates = candidates.filter((candidate) => candidate.index === ruleIndex);
  }
  if (ruleId !== undefined) candidates = candidates.filter((candidate) => candidate.value.id === ruleId);
  if (ruleGuid !== undefined) candidates = candidates.filter((candidate) => candidate.value.guid === ruleGuid);

  if (ruleIndex === undefined && ruleId === undefined && ruleGuid === undefined) return undefined;
  if (candidates.length !== 1) {
    throw new SarifGateError(
      "UNRESOLVED_RULE",
      `${label} did not resolve to exactly one SARIF reporting descriptor`,
    );
  }
  const resolved = candidates[0]!.value;
  const resolvedId = optionalString(resolved.id, `${label}.resolvedRule.id`) ?? ruleId;
  if (!resolvedId) {
    throw new SarifGateError("UNRESOLVED_RULE", `${label} resolved rule has no identifier`);
  }
  return { id: resolvedId, properties: resolved.properties };
}

function evaluateResult(
  resultValue: unknown,
  components: ToolComponent[],
  label: string,
): { ruleId: string; severity: number | undefined } {
  const result = requireObject(resultValue, label);
  const ruleReference = optionalObject(result.rule, `${label}.rule`);
  const resolvedRule = resolveRule(result, components, label);
  const severities = [
    securitySeverity(result.properties, `${label}.properties`),
    securitySeverity(ruleReference?.properties, `${label}.rule.properties`),
    securitySeverity(resolvedRule?.properties, `${label}.resolvedRule.properties`),
  ].filter((value): value is number => value !== undefined);
  const tags = [
    ...propertyTags(result.properties, `${label}.properties`),
    ...propertyTags(ruleReference?.properties, `${label}.rule.properties`),
    ...propertyTags(resolvedRule?.properties, `${label}.resolvedRule.properties`),
  ];

  if (!resolvedRule && severities.length === 0) {
    throw new SarifGateError(
      "UNSCORABLE_RESULT",
      `${label} has neither a resolvable rule nor a result security severity`,
    );
  }
  if (severities.length === 0 && tags.includes("security")) {
    throw new SarifGateError(
      "MISSING_SECURITY_SEVERITY",
      `${label} is security-tagged but has no numeric security severity`,
    );
  }
  const fallbackId = optionalString(result.ruleId, `${label}.ruleId`) ?? ruleReference?.id;
  return {
    ruleId: resolvedRule?.id ?? (typeof fallbackId === "string" ? fallbackId : "<inline-result>"),
    // Taking the maximum is fail-closed if a producer supplies both result- and
    // rule-level values that disagree.
    severity: severities.length > 0 ? Math.max(...severities) : undefined,
  };
}

export function evaluateSarifDocuments(
  documents: SarifDocument[],
  threshold = 7.0,
  now = new Date(),
): CodeqlGateSummary {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 10) {
    throw new SarifGateError("INVALID_THRESHOLD", "threshold must be between 0.0 and 10.0");
  }
  if (documents.length === 0) {
    throw new SarifGateError("NO_SARIF", "no CodeQL SARIF files were found");
  }

  let runCount = 0;
  let resultCount = 0;
  let scoredCount = 0;
  let unscoredCount = 0;
  const violationMap = new Map<string, CodeqlViolation>();

  for (const input of documents) {
    const document = requireObject(input.document, `${input.name}`);
    if (document.version !== "2.1.0") {
      throw new SarifGateError("INVALID_SARIF", `${input.name} must use SARIF 2.1.0`);
    }
    if (!Array.isArray(document.runs)) {
      throw new SarifGateError("INVALID_SARIF", `${input.name}.runs must be an array`);
    }
    for (const [runIndex, runValue] of document.runs.entries()) {
      const runLabel = `${input.name}.runs[${runIndex}]`;
      const run = requireObject(runValue, runLabel);
      const results = requireOwnArray(run, "results", `${runLabel}.results`);
      validateInvocations(run, runLabel);
      const components = toolComponents(run, runLabel);
      runCount += 1;
      for (const [resultIndex, result] of results.entries()) {
        const evaluated = evaluateResult(result, components, `${runLabel}.results[${resultIndex}]`);
        resultCount += 1;
        if (evaluated.severity === undefined) {
          unscoredCount += 1;
          continue;
        }
        scoredCount += 1;
        if (evaluated.severity < threshold) continue;
        const existing = violationMap.get(evaluated.ruleId);
        if (existing) {
          existing.resultCount += 1;
          existing.securitySeverity = Math.max(existing.securitySeverity, evaluated.severity);
        } else {
          violationMap.set(evaluated.ruleId, {
            ruleId: evaluated.ruleId,
            securitySeverity: evaluated.severity,
            resultCount: 1,
          });
        }
      }
    }
  }

  if (runCount === 0) {
    throw new SarifGateError("NO_RUNS", "CodeQL SARIF contained no analysis runs");
  }

  const violations = [...violationMap.values()].sort((left, right) =>
    left.ruleId.localeCompare(right.ruleId),
  );
  const highOrCriticalResults = violations.reduce((total, violation) => total + violation.resultCount, 0);
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    sourceCommit: process.env.GITHUB_SHA || null,
    status: highOrCriticalResults === 0 ? "pass" : "fail",
    threshold,
    policy: {
      comparison: ">=",
      allowlistEntries: 0,
      input: "post-processed-sarif",
    },
    sarifFiles: documents.map(({ name, sha256 }) => ({ name, sha256 })),
    runs: runCount,
    results: resultCount,
    securityScoredResults: scoredCount,
    unscoredResults: unscoredCount,
    highOrCriticalResults,
    violations,
  };
}

function collectPaths(inputPath: string): Array<{ absolute: string; name: string }> {
  const absoluteInput = resolve(inputPath);
  const rootStats = lstatSync(absoluteInput);
  if (rootStats.isSymbolicLink()) {
    throw new SarifGateError("SYMLINK_INPUT", "the SARIF input cannot be a symbolic link");
  }
  if (rootStats.isFile()) {
    if (!absoluteInput.endsWith(".sarif")) {
      throw new SarifGateError("NO_SARIF", "the SARIF input file must end in .sarif");
    }
    return [{ absolute: absoluteInput, name: basename(absoluteInput) }];
  }
  if (!rootStats.isDirectory()) {
    throw new SarifGateError("NO_SARIF", "the SARIF input must be a file or directory");
  }

  const paths: Array<{ absolute: string; name: string }> = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new SarifGateError("SYMLINK_INPUT", "the SARIF input tree cannot contain symbolic links");
      }
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".sarif")) {
        paths.push({ absolute, name: relative(absoluteInput, absolute).replaceAll("\\", "/") });
      }
    }
  };
  walk(absoluteInput);
  return paths;
}

export function loadSarifDocuments(inputPath: string): SarifDocument[] {
  const paths = collectPaths(inputPath);
  if (paths.length === 0) {
    throw new SarifGateError("NO_SARIF", "no CodeQL SARIF files were found");
  }
  return paths.map(({ absolute, name }) => {
    const content = readFileSync(absolute);
    let document: unknown;
    try {
      document = JSON.parse(content.toString("utf8"));
    } catch {
      throw new SarifGateError("INVALID_JSON", `${name} is not valid JSON`);
    }
    return {
      name,
      sha256: createHash("sha256").update(content).digest("hex"),
      document,
    };
  });
}

interface GateOptions {
  input: string;
  summary: string;
  threshold: number;
}

function writeSummary(path: string, summary: unknown): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function runGate(options: GateOptions, now = new Date()): number {
  try {
    const summary = evaluateSarifDocuments(loadSarifDocuments(options.input), options.threshold, now);
    writeSummary(options.summary, summary);
    if (summary.status === "fail") {
      console.error(
        `CodeQL SARIF gate failed: ${summary.highOrCriticalResults} result(s) met security-severity >= ${summary.threshold}.`,
      );
      for (const violation of summary.violations) {
        console.error(
          `- ${violation.ruleId}: severity ${violation.securitySeverity.toFixed(1)}, ${violation.resultCount} result(s)`,
        );
      }
      return 1;
    }
    console.log(
      `CodeQL SARIF gate passed: ${summary.securityScoredResults} security-scored result(s), ` +
        `${summary.unscoredResults} non-security/unscored result(s), threshold ${summary.threshold}.`,
    );
    return 0;
  } catch (error) {
    const controlled = error instanceof SarifGateError;
    const code = controlled ? error.code : "UNEXPECTED_ERROR";
    const message = controlled ? error.message : "unexpected failure while evaluating SARIF";
    writeSummary(options.summary, {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      sourceCommit: process.env.GITHUB_SHA || null,
      status: "error",
      threshold: options.threshold,
      policy: { comparison: ">=", allowlistEntries: 0, input: "post-processed-sarif" },
      error: { code, message },
    });
    console.error(`CodeQL SARIF gate error [${code}]: ${message}`);
    return 2;
  }
}

function parseArguments(args: string[]): GateOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new SarifGateError(
        "INVALID_ARGUMENTS",
        "usage: codeql-sarif-gate --input <path> --summary <path> --threshold <0..10>",
      );
    }
    if (values.has(key)) {
      throw new SarifGateError("INVALID_ARGUMENTS", `duplicate argument: ${key}`);
    }
    values.set(key, value);
  }
  for (const key of values.keys()) {
    if (!["--input", "--summary", "--threshold"].includes(key)) {
      throw new SarifGateError("INVALID_ARGUMENTS", `unknown argument: ${key}`);
    }
  }
  const input = values.get("--input");
  const summary = values.get("--summary");
  const rawThreshold = values.get("--threshold");
  if (!input || !summary || !rawThreshold) {
    throw new SarifGateError(
      "INVALID_ARGUMENTS",
      "usage: codeql-sarif-gate --input <path> --summary <path> --threshold <0..10>",
    );
  }
  const threshold = Number(rawThreshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 10) {
    throw new SarifGateError("INVALID_ARGUMENTS", "threshold must be between 0.0 and 10.0");
  }
  return { input, summary, threshold };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  let exitCode: number;
  try {
    exitCode = runGate(parseArguments(process.argv.slice(2)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid arguments";
    console.error(`CodeQL SARIF gate error: ${message}`);
    exitCode = 2;
  }
  process.exitCode = exitCode;
}
