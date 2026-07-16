// Fail-closed fitness functions for the production-image security gates. These
// tests are intentionally offline: they catch mutable Action/tool pins, a weaker
// severity threshold, a hidden ignore rule, or evidence-format drift before the
// hosted workflow is allowed to run.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Node,
} from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readText = (relativePath: string) => readFileSync(join(ROOT, relativePath), "utf8");

const ACTION_PINS = new Map([
  ["actions/checkout", { sha: "34e114876b0b11c390a56381ad16ebd13914f8d5", release: "v4.3.1" }],
  ["actions/setup-node", { sha: "49933ea5288caeca8642d1e84afbd3f7d6820020", release: "v4.4.0" }],
  ["actions/setup-python", { sha: "a26af69be951a213d495a4c3e4e4022e16d87065", release: "v5.6.0" }],
  ["actions/upload-artifact", { sha: "ea165f8d65b6e75b540449e92b4886f43607fa02", release: "v4.6.2" }],
  ["github/codeql-action", { sha: "02c5e83432fe5497fd85b873b6c9f16a8578e1d9", release: "v3.37.0" }],
]);

const EXPECTED_ACTION_INVENTORY = new Map([
  ["actions/checkout", 13],
  ["actions/setup-node", 11],
  ["actions/setup-python", 1],
  ["actions/upload-artifact", 8],
  ["github/codeql-action/analyze", 1],
  ["github/codeql-action/init", 1],
  ["github/codeql-action/upload-sarif", 1],
]);

type JsonObject = Record<string, unknown>;

interface ActionUse {
  path: string;
  reference: string;
  releaseComment: string;
}

interface ParsedWorkflow {
  label: string;
  value: JsonObject;
  actionUses: ActionUse[];
}

interface DockerInstruction {
  keyword: string;
  value: string;
  lines: string[];
  stage: string;
}

const CODEQL_INIT =
  "github/codeql-action/init@02c5e83432fe5497fd85b873b6c9f16a8578e1d9";
const CODEQL_ANALYZE =
  "github/codeql-action/analyze@02c5e83432fe5497fd85b873b6c9f16a8578e1d9";
const CODEQL_UPLOAD =
  "github/codeql-action/upload-sarif@02c5e83432fe5497fd85b873b6c9f16a8578e1d9";
const CHECKOUT =
  "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5";
const SETUP_NODE =
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
const UPLOAD_ARTIFACT =
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";
const SYFT_POLICY_PATH = "$EVIDENCE_DIR/input-locks/syft-policy.yaml";
const GRYPE_POLICY_PATH = "$EVIDENCE_DIR/input-locks/grype-policy.yaml";
const SYFT_COMMAND = '"$TOOLS_DIR/syft/syft"';
const GRYPE_COMMAND = '"$TOOLS_DIR/grype/grype"';

function objectValue(value: unknown, label: string): JsonObject {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as JsonObject;
}

function arrayValue(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value;
}

function exactKeys(value: JsonObject, expected: string[], label: string): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has unexpected or missing keys`);
}

function walkWorkflowNode(
  node: Node | null,
  label: string,
  path: string[],
  actionUses: ActionUse[],
): void {
  if (node === null) return;
  assert.ok(!isAlias(node), `${label}:${path.join(".")} must not use YAML aliases`);
  if (isMap(node)) {
    for (const pair of node.items) {
      assert.ok(
        isScalar(pair.key) && typeof pair.key.value === "string",
        `${label}:${path.join(".")} must use simple string mapping keys`,
      );
      const key = pair.key.value;
      const pairPath = [...path, key];
      assert.notEqual(key, "continue-on-error", `${label}:${pairPath.join(".")} is forbidden`);
      if (key === "uses") {
        assert.ok(
          isScalar(pair.value) && typeof pair.value.value === "string",
          `${label}:${pairPath.join(".")} must be a scalar Action reference`,
        );
        actionUses.push({
          path: pairPath.join("."),
          reference: pair.value.value,
          releaseComment: pair.value.comment?.trim() ?? "",
        });
      }
      walkWorkflowNode(pair.value as Node | null, label, pairPath, actionUses);
    }
    return;
  }
  if (isSeq(node)) {
    node.items.forEach((item, index) =>
      walkWorkflowNode(item as Node | null, label, [...path, String(index)], actionUses),
    );
  }
}

function parseWorkflowSource(source: string, label: string): ParsedWorkflow {
  const document = parseDocument(source, {
    strict: true,
    uniqueKeys: true,
    merge: false,
  });
  assert.deepEqual(
    document.errors.map((error) => error.message),
    [],
    `${label} must be unambiguous YAML`,
  );
  const actionUses: ActionUse[] = [];
  walkWorkflowNode(document.contents, label, [], actionUses);
  return {
    label,
    value: objectValue(document.toJS({ maxAliasCount: 0 }), label),
    actionUses,
  };
}

function parseWorkflow(name: string): ParsedWorkflow {
  return parseWorkflowSource(readText(`.github/workflows/${name}`), name);
}

function validateActionUse(use: ActionUse): string {
  const match = use.reference.match(/^([^@\s]+)@([0-9a-f]{40})$/);
  assert.ok(match, `${use.path} needs a full 40-hex Action SHA`);
  const action = match[1]!;
  const approved = [...ACTION_PINS.keys()].find(
    (candidate) => action === candidate || action.startsWith(`${candidate}/`),
  );
  assert.ok(approved, `${use.path} uses an unreviewed Action: ${action}`);
  assert.deepEqual(
    { sha: match[2], release: use.releaseComment },
    ACTION_PINS.get(approved!),
    `${use.path} drifted from its reviewed release`,
  );
  return action;
}

function workflowJob(workflow: ParsedWorkflow, jobId: string): JsonObject {
  const jobs = objectValue(workflow.value.jobs, `${workflow.label}.jobs`);
  return objectValue(jobs[jobId], `${workflow.label}.jobs.${jobId}`);
}

function jobSteps(job: JsonObject, label: string): JsonObject[] {
  return arrayValue(job.steps, `${label}.steps`).map((step, index) =>
    objectValue(step, `${label}.steps[${index}]`),
  );
}

function stepById(job: JsonObject, id: string, label: string): JsonObject {
  const matches = jobSteps(job, label).filter((step) => step.id === id);
  assert.equal(matches.length, 1, `${label} must contain exactly one step id=${id}`);
  return matches[0]!;
}

function stepByUses(job: JsonObject, uses: string, label: string): JsonObject {
  const matches = jobSteps(job, label).filter((step) => step.uses === uses);
  assert.equal(matches.length, 1, `${label} must contain exactly one ${uses} step`);
  return matches[0]!;
}

function stepByName(job: JsonObject, name: string, label: string): JsonObject {
  const matches = jobSteps(job, label).filter((step) => step.name === name);
  assert.equal(matches.length, 1, `${label} must contain exactly one step named ${name}`);
  return matches[0]!;
}

function stepIdentity(step: JsonObject, label: string): string {
  if (typeof step.id === "string") return `id:${step.id}`;
  if (typeof step.name === "string") return `name:${step.name}`;
  if (typeof step.uses === "string") return `uses:${step.uses}`;
  assert.fail(`${label} needs a stable id, name, or Action reference`);
}

function executableLines(value: unknown, label: string): string[] {
  assert.equal(typeof value, "string", `${label} must be a shell program`);
  return (value as string)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function jobProgram(job: JsonObject, label: string): string[] {
  return jobSteps(job, label).flatMap((step, index) =>
    step.run === undefined ? [] : executableLines(step.run, `${label}.steps[${index}].run`),
  );
}

function assertExplicitSyftInvocations(program: string[], label: string): void {
  assert.deepEqual(
    program.filter((line) => /^(?:syft|"\$TOOLS_DIR\/syft\/syft")\s/.test(line)),
    [
      `${SYFT_COMMAND} --config "${SYFT_POLICY_PATH}" config --load \\`,
      `${SYFT_COMMAND} --config "${SYFT_POLICY_PATH}" version \\`,
      `${SYFT_COMMAND} --config "${SYFT_POLICY_PATH}" scan "docker:$IMAGE" --scope squashed \\`,
    ],
    `${label} must execute the hash-anchored Syft path with the retained reviewed policy`,
  );
}

const CODEQL_GATE_LINES = [
  'test "$CODEQL_ACTION_DIFF_INFORMED_QUERIES" = "false"',
  'test -n "$CODEQL_RAW_SARIF"',
  "node dist/scripts/codeql-sarif-gate.js \\",
  "--input .artifacts/codeql/post-processed \\",
  "--summary .artifacts/codeql/codeql-gate-summary.json \\",
  "--threshold 7.0",
];

const GRYPE_GATE_LINES = [
  "set -euo pipefail",
  'test "$(sha256sum "$TOOLS_DIR/grype/grype" | cut -d \' \' -f 1)" = "$EXPECTED_GRYPE_BINARY_SHA256"',
  `test "$(sha256sum "${GRYPE_POLICY_PATH}" | cut -d ' ' -f 1)" = "$EXPECTED_GRYPE_POLICY_SHA256"`,
  'test -n "$EXPECTED_SYFT_SHA256"',
  'test "$(sha256sum "$EVIDENCE_DIR/autopilot.syft.json" | cut -d \' \' -f 1)" = "$EXPECTED_SYFT_SHA256"',
  '(cd "$EVIDENCE_DIR" && sha256sum --check --strict SCANNED-SBOM.sha256)',
  `${GRYPE_COMMAND} --config "${GRYPE_POLICY_PATH}" "sbom:$EVIDENCE_DIR/autopilot.syft.json" \\`,
  "--by-cve --fail-on high --output table",
];

const SCANNER_INSTALL_LINES = [
  "set -euo pipefail",
  'mkdir -p "$TOOLS_DIR/syft" "$TOOLS_DIR/grype" "$EVIDENCE_DIR"',
  'SYFT_ARCHIVE="$TOOLS_DIR/syft/syft_${SYFT_VERSION}_linux_amd64.tar.gz"',
  'GRYPE_ARCHIVE="$TOOLS_DIR/grype/grype_${GRYPE_VERSION}_linux_amd64.tar.gz"',
  "curl --fail --silent --show-error --location \\",
  '--output "$SYFT_ARCHIVE" \\',
  '"https://github.com/anchore/syft/releases/download/v${SYFT_VERSION}/syft_${SYFT_VERSION}_linux_amd64.tar.gz"',
  "curl --fail --silent --show-error --location \\",
  '--output "$GRYPE_ARCHIVE" \\',
  '"https://github.com/anchore/grype/releases/download/v${GRYPE_VERSION}/grype_${GRYPE_VERSION}_linux_amd64.tar.gz"',
  'echo "$SYFT_SHA256  $SYFT_ARCHIVE" | sha256sum --check --strict',
  'echo "$GRYPE_SHA256  $GRYPE_ARCHIVE" | sha256sum --check --strict',
  'tar -xzf "$SYFT_ARCHIVE" -C "$TOOLS_DIR/syft" syft',
  'tar -xzf "$GRYPE_ARCHIVE" -C "$TOOLS_DIR/grype" grype',
  'chmod 0755 "$TOOLS_DIR/syft/syft" "$TOOLS_DIR/grype/grype"',
  'SYFT_BINARY_SHA256="$(sha256sum "$TOOLS_DIR/syft/syft" | cut -d \' \' -f 1)"',
  'GRYPE_BINARY_SHA256="$(sha256sum "$TOOLS_DIR/grype/grype" | cut -d \' \' -f 1)"',
  'test "$SYFT_BINARY_SHA256" = "$EXPECTED_SYFT_BINARY_SHA256"',
  'test "$GRYPE_BINARY_SHA256" = "$EXPECTED_GRYPE_BINARY_SHA256"',
] as const;

const SBOM_GENERATION_EXECUTABLE_LINES = 47;
const SBOM_GENERATION_PROGRAM_SHA256 = "24db52331d7d3bacf9c5310655ea61cb07b116922b0670f2b6797729d1cd3155";

const RUNTIME_CANARY_OPEN_LINE = `"$IMAGE" -euc '`;
const RUNTIME_CANARY_CLOSE_LINE = `' | tee "$EVIDENCE_DIR/runtime-apk-inventory.actual"`;
const RUNTIME_CANARY_INNER_LINES = [
  'test "$(node --version)" = "v24.18.0"',
  'test "$(id -u)" = "1000"',
  'test "$(id -g)" = "1000"',
  "! command -v npm >/dev/null",
  'test -f "/usr/share/fonts/ubuntu/Ubuntu[wdth,wght].ttf"',
  'test -f "/usr/share/fonts/ubuntu/Ubuntu-Italic[wdth,wght].ttf"',
  'test "$(find /usr/share/fonts/ubuntu -mindepth 1 -maxdepth 1 -type f -name "*.ttf" | wc -l)" -eq 4',
  "mkdir -p /tmp/render",
  "timeout 20s pdftoppm -f 1 -l 1 -singlefile -png -scale-to 512 \\",
  "/fixture.pdf /tmp/render/page \\",
  "> /tmp/pdftoppm.stdout 2> /tmp/pdftoppm.stderr",
  "test ! -s /tmp/pdftoppm.stdout",
  "test ! -s /tmp/pdftoppm.stderr",
  "test -s /tmp/render/page.png",
  'test "$(wc -c < /tmp/render/page.png)" -le 4194304',
  'echo "pdf-render-font-substitution-clean" >&2',
  'grep -Ev "^(#|$)" /expected-apk-inventory.lock \\',
  '| sed "s/=/-/" | LC_ALL=C sort > /tmp/expected-apk-inventory',
  ": > /tmp/empty-apk-repositories",
  "apk --no-network --repositories-file /tmp/empty-apk-repositories info -v \\",
  "| LC_ALL=C sort > /tmp/actual-apk-inventory",
  "diff -u /tmp/expected-apk-inventory /tmp/actual-apk-inventory",
  'grep -Eq "^[^ ]+ /proc proc " /proc/mounts',
  'grep -Eq "^[^ ]+ /sys sysfs " /proc/mounts',
  'grep -Eq "^[^ ]+ /tmp tmpfs " /proc/mounts',
  "AUDIT_STATUS=0",
  "apk --no-network --repositories-file /tmp/empty-apk-repositories \\",
  "audit --system --check-permissions \\",
  "> /tmp/apk-audit.system 2> /tmp/apk-audit.stderr || AUDIT_STATUS=$?",
  'test "$AUDIT_STATUS" -eq 0 -o "$AUDIT_STATUS" -eq 1',
  "test ! -s /tmp/apk-audit.stderr",
  'printf "%s\\n" "m proc/" "m sys/" "m tmp/" > /tmp/apk-audit.expected-runtime-mounts',
  "LC_ALL=C sort /tmp/apk-audit.system > /tmp/apk-audit.actual-runtime-mounts",
  "diff -u /tmp/apk-audit.expected-runtime-mounts /tmp/apk-audit.actual-runtime-mounts",
  'echo "apk-audit-system-clean-except-exact-runtime-mount-metadata" >&2',
  "cat /tmp/actual-apk-inventory",
] as const;

const RUNTIME_CANARY_STEP_PREFIX_LINES = [
  "set -euo pipefail",
  'test -n "$EXPECTED_IMAGE_ID"',
  'test "$(docker image inspect --format \'{{.Id}}\' "$IMAGE")" = "$EXPECTED_IMAGE_ID"',
  'mkdir -p "$EVIDENCE_DIR"',
  "docker image inspect --format '{{json .Config}}' \"$IMAGE\" \\",
  '> "$EVIDENCE_DIR/runtime-image-config.actual.json"',
  "node --input-type=module <<'NODE'",
  'import assert from "node:assert/strict";',
  'import { readFileSync } from "node:fs";',
  "const config = JSON.parse(",
  'readFileSync(`${process.env.EVIDENCE_DIR}/runtime-image-config.actual.json`, "utf8"),',
  ");",
  'assert.equal(config.WorkingDir, "/app");',
  'assert.equal(config.User, "1000:1000");',
  'assert.deepEqual(config.Cmd, ["node", "dist/src/server.js"]);',
  "assert.equal(config.Entrypoint, null);",
  'assert.deepEqual(config.ExposedPorts, { "9000/tcp": {} });',
  'for (const expected of ["NODE_ENV=production", "PORT=9000", "HOME=/tmp"]) {',
  "assert.equal(config.Env.filter((entry) => entry === expected).length, 1);",
  "assert.equal(",
  'config.Env.filter((entry) => entry.startsWith(`${expected.split("=", 1)[0]}=`)).length,',
  "1,",
  ");",
  "}",
  "assert.deepEqual(config.Healthcheck?.Test, [",
  '"CMD-SHELL",',
  '"node -e \\"fetch(\'http://127.0.0.1:9000/health\').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\\"",',
  "]);",
  "assert.equal(config.Healthcheck?.Interval, 30_000_000_000);",
  "assert.equal(config.Healthcheck?.Timeout, 5_000_000_000);",
  "assert.equal(config.Healthcheck?.StartPeriod, 20_000_000_000);",
  "assert.equal(config.Healthcheck?.Retries, 3);",
  "NODE",
  'FIXTURE="$GITHUB_WORKSPACE/eval/vision/assets/v03-table-gbp.pdf"',
  'echo "8a4c0b511d63ccb085c8c9044e8a4f4918d5a0af1e2287aed8b87c0cb42e5bef  $FIXTURE" \\',
  "| sha256sum --check --strict",
  "docker run --rm \\",
  "--network none \\",
  "--read-only \\",
  "--cap-drop ALL \\",
  "--security-opt no-new-privileges \\",
  "--pids-limit 64 \\",
  "--memory 256m \\",
  "--cpus 1 \\",
  "--tmpfs /tmp:rw,noexec,nosuid,size=16m \\",
  '--mount "type=bind,src=$FIXTURE,dst=/fixture.pdf,readonly" \\',
  '--mount "type=bind,src=$GITHUB_WORKSPACE/runtime-apk-inventory.lock,dst=/expected-apk-inventory.lock,readonly" \\',
  "--entrypoint /bin/sh \\",
] as const;

const RUNTIME_CANARY_STEP_SUFFIX_LINES = [
  'APP_CANARY_ID="$(docker run --detach --rm \\',
  "--network none \\",
  "--read-only \\",
  "--cap-drop ALL \\",
  "--security-opt no-new-privileges \\",
  "--pids-limit 64 \\",
  "--memory 256m \\",
  "--cpus 1 \\",
  "--tmpfs /tmp:rw,noexec,nosuid,size=16m \\",
  "--env REVIEWER_TOKEN=local-ci-canary-not-a-secret-local-ci-canary \\",
  "--env ALLOW_FAKE_QWEN=true \\",
  "--env ALLOW_IN_MEMORY_STORE=true \\",
  '"$IMAGE")"',
  'test -n "$APP_CANARY_ID"',
  'trap \'docker rm -f "$APP_CANARY_ID" >/dev/null 2>&1\' EXIT',
  'test "$(docker inspect --format \'{{.Image}}\' "$APP_CANARY_ID")" = "$EXPECTED_IMAGE_ID"',
  "APP_HEALTHY=0",
  "for attempt in $(seq 1 30); do",
  'if docker exec "$APP_CANARY_ID" node -e \\',
  '"fetch(\'http://127.0.0.1:9000/health\').then(async r=>{const b=await r.json();if(r.status!==200||b.status!==\'ok\')process.exit(1)}).catch(()=>process.exit(1))"; then',
  "APP_HEALTHY=1",
  "break",
  "fi",
  'if test "$(docker inspect --format \'{{.State.Running}}\' "$APP_CANARY_ID")" != "true"; then',
  "break",
  "fi",
  "sleep 1",
  "done",
  'if test "$APP_HEALTHY" -ne 1; then',
  'docker logs --tail 100 "$APP_CANARY_ID" >&2',
  "exit 1",
  "fi",
  'test "$(docker exec "$APP_CANARY_ID" id -u)" = "1000"',
  'test "$(docker exec "$APP_CANARY_ID" id -g)" = "1000"',
  'docker rm -f "$APP_CANARY_ID" >/dev/null',
  "trap - EXIT",
  'echo "default-cmd-health-canary-passed" >&2',
] as const;

const RUNTIME_CANARY_STEP_LINES = [
  ...RUNTIME_CANARY_STEP_PREFIX_LINES,
  RUNTIME_CANARY_OPEN_LINE,
  ...RUNTIME_CANARY_INNER_LINES,
  RUNTIME_CANARY_CLOSE_LINE,
  ...RUNTIME_CANARY_STEP_SUFFIX_LINES,
] as const;

function assertRuntimeCanaryInnerContract(
  value: unknown,
  label = "constrained runtime canary",
): void {
  const lines = executableLines(value, label);
  const openIndexes = lines.flatMap((line, index) =>
    line === RUNTIME_CANARY_OPEN_LINE ? [index] : [],
  );
  const closeIndexes = lines.flatMap((line, index) =>
    line === RUNTIME_CANARY_CLOSE_LINE ? [index] : [],
  );
  assert.equal(openIndexes.length, 1, `${label} must have exactly one inner-shell opening boundary`);
  assert.equal(closeIndexes.length, 1, `${label} must have exactly one inner-shell closing boundary`);
  const openIndex = openIndexes[0]!;
  const closeIndex = closeIndexes[0]!;
  assert.equal(
    closeIndex,
    openIndex + RUNTIME_CANARY_INNER_LINES.length + 1,
    `${label} must not add executable lines inside the reviewed inner shell`,
  );
  assert.deepEqual(
    lines.slice(openIndex + 1, closeIndex),
    RUNTIME_CANARY_INNER_LINES,
    `${label} must preserve the complete PDF/APK-audit inner-shell program`,
  );
}

function assertRuntimeCanaryStepContract(
  value: unknown,
  label = "constrained runtime canary step",
): void {
  assert.deepEqual(
    executableLines(value, label),
    RUNTIME_CANARY_STEP_LINES,
    `${label} must preserve the complete ordered executable program`,
  );
  assertRuntimeCanaryInnerContract(value, `${label} inner shell`);
}

function assertCodeqlGateStep(step: JsonObject, label = "CodeQL gate"): void {
  exactKeys(step, ["name", "id", "env", "run"], label);
  assert.equal(step.name, "Gate CodeQL high and critical SARIF results");
  assert.equal(step.id, "codeql_severity_gate");
  assert.deepEqual(objectValue(step.env, `${label}.env`), {
    CODEQL_RAW_SARIF: "${{ steps.analyze.outputs.sarif-output }}",
  });
  assert.deepEqual(executableLines(step.run, `${label}.run`), CODEQL_GATE_LINES);
}

function assertCodeqlFullSourceEnvironment(value: unknown, label: string): void {
  const environment = objectValue(value, label);
  exactKeys(environment, ["CODEQL_ACTION_DIFF_INFORMED_QUERIES"], label);
  assert.equal(
    environment.CODEQL_ACTION_DIFF_INFORMED_QUERIES,
    "false",
    "CodeQL PR analysis must disable diff-informed query restriction",
  );
}

function assertGrypeGateStep(step: JsonObject, label = "Grype gate"): void {
  exactKeys(step, ["name", "id", "env", "shell", "run"], label);
  assert.equal(step.name, "Gate every high or critical finding (no current allowlist)");
  assert.equal(step.id, "grype_high_critical_gate");
  assert.deepEqual(objectValue(step.env, `${label}.env`), {
    EXPECTED_SYFT_SHA256: "${{ steps.seal_sbom.outputs.syft_sha256 }}",
    EXPECTED_GRYPE_BINARY_SHA256: "${{ env.EXPECTED_GRYPE_BINARY_SHA256 }}",
  });
  assert.equal(step.shell, "bash");
  assert.deepEqual(executableLines(step.run, `${label}.run`), GRYPE_GATE_LINES);
}

function assertScannerInstallStep(step: JsonObject, label = "scanner install step"): void {
  exactKeys(step, ["name", "id", "shell", "run"], label);
  assert.equal(step.name, "Install pinned Syft and Grype archives");
  assert.equal(step.id, "install_scanners");
  assert.equal(step.shell, "bash");
  assert.deepEqual(
    executableLines(step.run, `${label}.run`),
    [...SCANNER_INSTALL_LINES],
    `${label} must keep the exact reviewed download, extraction, and binary-verification program`,
  );
}

function assertSyftPolicy(value: unknown, label = ".syft.yaml"): void {
  const policy = objectValue(value, label);
  exactKeys(
    policy,
    ["check-for-app-update", "scope", "default-catalogers", "select-catalogers", "exclude"],
    label,
  );
  assert.equal(policy["check-for-app-update"], false);
  assert.equal(policy.scope, "squashed");
  assert.deepEqual(arrayValue(policy["default-catalogers"], `${label}.default-catalogers`), []);
  assert.deepEqual(arrayValue(policy["select-catalogers"], `${label}.select-catalogers`), []);
  assert.deepEqual(arrayValue(policy.exclude, `${label}.exclude`), [], "Syft exclusions must remain empty");
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function dockerInstructions(source: string): DockerInstruction[] {
  const instructions: DockerInstruction[] = [];
  let logicalLines: string[] = [];
  let stage = "";

  const finish = (): void => {
    if (logicalLines.length === 0) return;
    const first = logicalLines[0]!;
    const match = first.match(/^([A-Z]+)(?:\s+)(.*)$/s);
    assert.ok(match, `invalid Dockerfile instruction: ${logicalLines.join(" ")}`);
    const keyword = match![1]!;
    const valueLines = [match![2]!, ...logicalLines.slice(1)];
    const value = valueLines.join("\n");
    if (keyword === "FROM") {
      const alias = value.match(/\s+AS\s+([a-zA-Z0-9._-]+)$/i);
      stage = alias?.[1] ?? value;
    }
    instructions.push({ keyword, value, lines: valueLines, stage });
    logicalLines = [];
  };

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    assert.ok(
      !/^#\s*[a-z][a-z0-9_-]*\s*=/i.test(line),
      "Docker parser directives are forbidden; the reviewed default BuildKit frontend is required",
    );
    if (logicalLines.length === 0 && (line === "" || line.startsWith("#"))) continue;
    assert.ok(!line.startsWith("#"), "comments cannot interrupt a logical Dockerfile instruction");
    const continued = line.endsWith("\\");
    logicalLines.push(continued ? line.slice(0, -1).trimEnd() : line);
    if (!continued) finish();
  }
  assert.equal(logicalLines.length, 0, "Dockerfile ended during a continued instruction");
  return instructions;
}

function dockerStage(
  instructions: DockerInstruction[],
  stage: string,
): DockerInstruction[] {
  const selected = instructions.filter((instruction) => instruction.stage === stage);
  assert.ok(selected.length > 0, `Dockerfile stage ${stage} is required`);
  return selected;
}

function oneDockerInstruction(
  instructions: DockerInstruction[],
  keyword: string,
  label: string,
): DockerInstruction {
  const matches = instructions.filter((instruction) => instruction.keyword === keyword);
  assert.equal(matches.length, 1, `${label} must contain exactly one ${keyword}`);
  return matches[0]!;
}

const RUNTIME_RUN_LINES = [
  "--network=none",
  "--mount=type=bind,from=runtime-apk-archives,source=/tmp/runtime-apks,target=/tmp/runtime-apks,ro",
  "set -eu;",
  "grep -Ev '^(#|$)' /tmp/runtime-apk-lock/runtime-packages.lock > /tmp/runtime-apk-lock/packages;",
  'test "$(wc -l < /tmp/runtime-apk-lock/packages)" -eq 45;',
  "sed 's/=/-/; s/$/.apk/' /tmp/runtime-apk-lock/packages",
  "| LC_ALL=C sort > /tmp/runtime-apk-lock/expected-archives;",
  'test "$(LC_ALL=C sort -u /tmp/runtime-apk-lock/expected-archives | wc -l)" -eq 45;',
  'test "$(wc -l < /tmp/runtime-apk-lock/runtime-apk-archives.sha256)" -eq 45;',
  "test \"$(grep -Ec '^[0-9a-f]{64}  [a-z0-9][a-z0-9+._-]*-[0-9][a-zA-Z0-9+._:-]*-r[0-9]+\\.apk$' /tmp/runtime-apk-lock/runtime-apk-archives.sha256)\" -eq 45;",
  "awk '{ print $2 }' /tmp/runtime-apk-lock/runtime-apk-archives.sha256",
  "| LC_ALL=C sort > /tmp/runtime-apk-lock/manifest-archives;",
  'test "$(LC_ALL=C sort -u /tmp/runtime-apk-lock/manifest-archives | wc -l)" -eq 45;',
  "diff -u /tmp/runtime-apk-lock/expected-archives /tmp/runtime-apk-lock/manifest-archives;",
  'test "$(find /tmp/runtime-apks -mindepth 1 -maxdepth 1 | wc -l)" -eq 45;',
  'test "$(find /tmp/runtime-apks -mindepth 1 -maxdepth 1 -type f | wc -l)" -eq 45;',
  ": > /tmp/runtime-apk-lock/actual-archives.unsorted;",
  "for archive in /tmp/runtime-apks/*; do",
  'test -f "$archive";',
  'basename "$archive" >> /tmp/runtime-apk-lock/actual-archives.unsorted;',
  "done;",
  "LC_ALL=C sort /tmp/runtime-apk-lock/actual-archives.unsorted",
  "> /tmp/runtime-apk-lock/actual-archives;",
  'test "$(wc -l < /tmp/runtime-apk-lock/actual-archives)" -eq 45;',
  'test "$(LC_ALL=C sort -u /tmp/runtime-apk-lock/actual-archives | wc -l)" -eq 45;',
  "diff -u /tmp/runtime-apk-lock/expected-archives /tmp/runtime-apk-lock/actual-archives;",
  "(cd /tmp/runtime-apks && sha256sum -c /tmp/runtime-apk-lock/runtime-apk-archives.sha256);",
  ": > /tmp/runtime-apk-lock/empty-repositories;",
  "apk --no-cache --no-network --repositories-file /tmp/runtime-apk-lock/empty-repositories",
  "add --allow-untrusted /tmp/runtime-apks/*.apk;",
  "grep -Ev '^(#|$)' /tmp/runtime-apk-lock/runtime-apk-inventory.lock",
  "| sed 's/=/-/' | LC_ALL=C sort > /tmp/runtime-apk-lock/expected-inventory;",
  "apk --no-network --repositories-file /tmp/runtime-apk-lock/empty-repositories info -v",
  "| LC_ALL=C sort > /tmp/runtime-apk-lock/actual-inventory;",
  "diff -u /tmp/runtime-apk-lock/expected-inventory /tmp/runtime-apk-lock/actual-inventory;",
  'test "$(node --version)" = "v24.18.0";',
  "command -v pdftoppm >/dev/null;",
  "! command -v npm >/dev/null;",
  "rm -rf /tmp/runtime-apk-lock",
] as const;

const ARCHIVE_RUN_LINES = [
  "set -eu;",
  "grep -Ev '^(#|$)' runtime-packages.lock > packages;",
  'test "$(wc -l < packages)" -eq 45;',
  "test \"$(grep -Ec '^[a-z0-9][a-z0-9+._-]*=[0-9][a-zA-Z0-9+._:-]*-r[0-9]+$' packages)\" -eq 45;",
  "cut -d= -f1 packages > package-names;",
  'test "$(wc -l < package-names)" -eq 45;',
  'test "$(LC_ALL=C sort -u package-names | wc -l)" -eq 45;',
  "sed 's/=/-/; s/$/.apk/' packages | LC_ALL=C sort > expected-archives;",
  'test "$(LC_ALL=C sort -u expected-archives | wc -l)" -eq 45;',
  'test "$(wc -l < runtime-apk-archives.sha256)" -eq 45;',
  "test \"$(grep -Ec '^[0-9a-f]{64}  [a-z0-9][a-z0-9+._-]*-[0-9][a-zA-Z0-9+._:-]*-r[0-9]+\\.apk$' runtime-apk-archives.sha256)\" -eq 45;",
  "awk '{ print $2 }' runtime-apk-archives.sha256 | LC_ALL=C sort > manifest-archives;",
  'test "$(LC_ALL=C sort -u manifest-archives | wc -l)" -eq 45;',
  "diff -u expected-archives manifest-archives;",
  "mkdir -p /tmp/runtime-apks;",
  "apk fetch --no-cache --output /tmp/runtime-apks $(cat package-names);",
  'test "$(find /tmp/runtime-apks -mindepth 1 -maxdepth 1 | wc -l)" -eq 45;',
  'test "$(find /tmp/runtime-apks -mindepth 1 -maxdepth 1 -type f | wc -l)" -eq 45;',
  ": > actual-archives.unsorted;",
  "for archive in /tmp/runtime-apks/*; do",
  'test -f "$archive";',
  'basename "$archive" >> actual-archives.unsorted;',
  "done;",
  "LC_ALL=C sort actual-archives.unsorted > actual-archives;",
  'test "$(wc -l < actual-archives)" -eq 45;',
  'test "$(LC_ALL=C sort -u actual-archives | wc -l)" -eq 45;',
  "diff -u expected-archives actual-archives;",
  "(cd /tmp/runtime-apks && sha256sum -c /tmp/runtime-apk-lock/runtime-apk-archives.sha256)",
] as const;

function assertPackageBuildContract(value: unknown): void {
  const manifest = objectValue(value, "package.json");
  const scripts = objectValue(manifest.scripts, "package.json.scripts");
  assert.equal(scripts.build, "tsc", "the production build script must invoke only TypeScript");
  for (const lifecycle of ["prebuild", "postbuild"]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(scripts, lifecycle),
      false,
      `${lifecycle} must not create a compiled-output side channel`,
    );
  }
}

function assertBuildStageContract(buildStage: DockerInstruction[]): void {
  assert.deepEqual(
    buildStage.map((instruction) => instruction.keyword),
    ["FROM", "WORKDIR", "COPY", "RUN", "COPY", "COPY", "COPY", "RUN"],
    "the complete source-to-JavaScript builder instruction inventory must remain exact",
  );
  const values = (keyword: string): string[] =>
    buildStage
      .filter((instruction) => instruction.keyword === keyword)
      .map((instruction) => instruction.value);
  assert.deepEqual(values("WORKDIR"), ["/app"]);
  assert.deepEqual(values("COPY"), [
    "package.json package-lock.json ./",
    "tsconfig.json ./",
    "src ./src",
    "scripts/apply-schema.ts scripts/bootstrap-db.ts ./scripts/",
  ]);
  assert.deepEqual(
    buildStage.filter((instruction) => instruction.keyword === "RUN").map((instruction) => instruction.lines),
    [
      ["npm ci --ignore-scripts"],
      [
        "npm run --ignore-scripts build",
        "&& npm prune --omit=dev --ignore-scripts",
        "&& npm cache clean --force",
      ],
    ],
    "no command may mutate compiled output after the reviewed build/prune program",
  );
}

function assertArchiveStageContract(archiveStage: DockerInstruction[]): void {
  assert.deepEqual(
    archiveStage.map((instruction) => instruction.keyword),
    ["FROM", "WORKDIR", "COPY", "RUN"],
    "the complete networked APK-resolver instruction inventory must remain exact",
  );
  assert.deepEqual(
    archiveStage.filter((instruction) => instruction.keyword === "WORKDIR").map((instruction) => instruction.value),
    ["/tmp/runtime-apk-lock"],
  );
  assert.deepEqual(
    archiveStage.filter((instruction) => instruction.keyword === "COPY").map((instruction) => instruction.value),
    ["runtime-packages.lock runtime-apk-archives.sha256 ./"],
  );
  assert.deepEqual(
    oneDockerInstruction(archiveStage, "RUN", "runtime-apk-archives stage").lines,
    ARCHIVE_RUN_LINES,
    "the complete signed-index resolver/fetch/hash program must remain exact",
  );
}

function assertRuntimeStageContract(runtimeStage: DockerInstruction[]): void {
  const values = (keyword: string): string[] =>
    runtimeStage
      .filter((instruction) => instruction.keyword === keyword)
      .map((instruction) => instruction.value);
  assert.deepEqual(values("ENV"), ["NODE_ENV=production", "PORT=9000", "HOME=/tmp"]);
  assert.deepEqual(values("WORKDIR"), ["/app"]);
  assert.deepEqual(values("EXPOSE"), ["9000"]);
  assert.deepEqual(values("USER"), ["1000:1000"]);
  assert.deepEqual(values("HEALTHCHECK"), [
    "--interval=30s --timeout=5s --start-period=20s --retries=3\n" +
      "CMD node -e \"fetch('http://127.0.0.1:9000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\"",
  ]);
  assert.deepEqual(values("ENTRYPOINT"), ["[]"]);
  assert.deepEqual(values("CMD"), ['["node", "dist/src/server.js"]']);
  const runtimeRun = oneDockerInstruction(runtimeStage, "RUN", "runtime stage");
  assert.deepEqual(
    runtimeRun.lines,
    RUNTIME_RUN_LINES,
    "the complete network-disabled runtime install/validation program must remain exact",
  );
}

const workflowNames = readdirSync(join(ROOT, ".github", "workflows"))
  .filter((name) => /\.ya?ml$/i.test(name))
  .sort();

test("SUPPLY 1 — every workflow Action is an approved full-SHA release pin", () => {
  const inventory = new Map<string, number>();
  for (const name of workflowNames) {
    for (const use of parseWorkflow(name).actionUses) {
      const action = validateActionUse(use);
      inventory.set(action, (inventory.get(action) ?? 0) + 1);
    }
  }
  assert.deepEqual(inventory, EXPECTED_ACTION_INVENTORY, "the complete Action inventory drifted");
  assert.equal(
    [...inventory.values()].reduce((total, count) => total + count, 0),
    36,
    "the exact workflow Action count drifted",
  );
});

test("SUPPLY 2 — CodeQL runs the pinned security-and-quality suite with narrow permissions", () => {
  const workflow = parseWorkflow("codeql.yml");
  exactKeys(workflow.value, ["name", "on", "concurrency", "permissions", "jobs"], "codeql.yml");
  assert.equal(workflow.value.name, "CodeQL");
  assert.deepEqual(objectValue(workflow.value.on, "codeql.yml.on"), {
    push: { branches: ["main"] },
    pull_request: null,
    schedule: [{ cron: "19 4 * * 1" }],
    workflow_dispatch: null,
  });
  assert.deepEqual(objectValue(workflow.value.concurrency, "codeql.yml.concurrency"), {
    group: "codeql-${{ github.workflow }}-${{ github.ref }}",
    "cancel-in-progress": true,
  });
  assert.deepEqual(objectValue(workflow.value.permissions, "codeql.yml.permissions"), {
    contents: "read",
    actions: "read",
    "security-events": "write",
  });

  const job = workflowJob(workflow, "analyze");
  exactKeys(job, ["name", "runs-on", "timeout-minutes", "env", "steps"], "codeql.yml.jobs.analyze");
  assert.equal(job.name, "Analyze (javascript-typescript)");
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(job["timeout-minutes"], 20);
  assertCodeqlFullSourceEnvironment(job.env, "codeql.yml.jobs.analyze.env");
  assert.deepEqual(
    jobSteps(job, "codeql.yml.jobs.analyze").map((step, index) =>
      stepIdentity(step, `codeql.yml.jobs.analyze.steps[${index}]`),
    ),
    [
      `uses:${CHECKOUT}`,
      `uses:${SETUP_NODE}`,
      "name:Initialize CodeQL (security-and-quality)",
      "name:Install the lockfile-exact dependency graph",
      "name:Compile the analyzed TypeScript revision",
      "id:analyze",
      "id:codeql_severity_gate",
      "name:Retain raw and post-processed CodeQL SARIF evidence",
    ],
    "CodeQL must keep the exact fail-closed step sequence",
  );

  const nodeStep = stepByUses(job, SETUP_NODE, "codeql.yml.jobs.analyze");
  exactKeys(nodeStep, ["uses", "with"], "CodeQL setup-node step");
  assert.deepEqual(objectValue(nodeStep.with, "CodeQL setup-node with"), {
    "node-version": "24.18.0",
    cache: "npm",
  });

  const initStep = stepByUses(job, CODEQL_INIT, "codeql.yml.jobs.analyze");
  exactKeys(initStep, ["name", "uses", "with"], "CodeQL init step");
  assert.equal(initStep.name, "Initialize CodeQL (security-and-quality)");
  assert.deepEqual(objectValue(initStep.with, "CodeQL init with"), {
    languages: "javascript-typescript",
    queries: "security-and-quality",
  });

  const installStep = stepByName(
    job,
    "Install the lockfile-exact dependency graph",
    "codeql.yml.jobs.analyze",
  );
  exactKeys(installStep, ["name", "run"], "CodeQL install step");
  assert.equal(installStep.run, "npm ci --ignore-scripts");
  const compileStep = stepByName(
    job,
    "Compile the analyzed TypeScript revision",
    "codeql.yml.jobs.analyze",
  );
  exactKeys(compileStep, ["name", "run"], "CodeQL compile step");
  assert.equal(compileStep.run, "npm run --ignore-scripts build");

  const analyzeStep = stepById(job, "analyze", "codeql.yml.jobs.analyze");
  exactKeys(analyzeStep, ["name", "id", "uses", "with"], "CodeQL analyze step");
  assert.equal(analyzeStep.name, "Perform CodeQL analysis");
  assert.equal(analyzeStep.uses, CODEQL_ANALYZE);
  assert.deepEqual(objectValue(analyzeStep.with, "CodeQL analyze with"), {
    category: "/language:javascript-typescript",
    output: ".artifacts/codeql/raw",
    "post-processed-sarif-path": ".artifacts/codeql/post-processed",
    upload: "always",
  });

  assertCodeqlGateStep(stepById(job, "codeql_severity_gate", "codeql.yml.jobs.analyze"));

  const artifactStep = stepByUses(job, UPLOAD_ARTIFACT, "codeql.yml.jobs.analyze");
  exactKeys(artifactStep, ["name", "if", "uses", "with"], "CodeQL artifact step");
  assert.equal(artifactStep.name, "Retain raw and post-processed CodeQL SARIF evidence");
  assert.equal(artifactStep.if, "always()");
  const artifactWith = objectValue(artifactStep.with, "CodeQL artifact with");
  exactKeys(
    artifactWith,
    ["name", "path", "if-no-files-found", "retention-days"],
    "CodeQL artifact with",
  );
  assert.equal(artifactWith.name, "codeql-sarif-${{ github.sha }}");
  assert.deepEqual(executableLines(artifactWith.path, "CodeQL artifact paths"), [
    ".artifacts/codeql/raw",
    ".artifacts/codeql/post-processed",
    ".artifacts/codeql/codeql-gate-summary.json",
  ]);
  assert.equal(artifactWith["if-no-files-found"], "error");
  assert.equal(artifactWith["retention-days"], 30);
});

test("SUPPLY 3 — the image inventory and scanner/database inputs are byte-pinned", () => {
  const workflow = parseWorkflow("supply-chain.yml");
  exactKeys(workflow.value, ["name", "on", "concurrency", "permissions", "jobs"], "supply-chain.yml");
  assert.equal(workflow.value.name, "Production Image Supply Chain");
  assert.deepEqual(objectValue(workflow.value.on, "supply-chain.yml.on"), {
    push: { branches: ["main"] },
    pull_request: null,
    workflow_dispatch: null,
  });
  assert.deepEqual(objectValue(workflow.value.concurrency, "supply-chain.yml.concurrency"), {
    group: "supply-chain-${{ github.workflow }}-${{ github.ref }}",
    "cancel-in-progress": true,
  });
  assert.deepEqual(objectValue(workflow.value.permissions, "supply-chain.yml.permissions"), {
    contents: "read",
    "security-events": "write",
  });
  const job = workflowJob(workflow, "image-sbom-vulnerability-gate");
  exactKeys(
    job,
    ["name", "runs-on", "timeout-minutes", "env", "steps"],
    "supply-chain.yml.jobs.image-sbom-vulnerability-gate",
  );
  assert.equal(job.name, "Image SBOM + high/critical gate");
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(job["timeout-minutes"], 45);
  assert.deepEqual(
    jobSteps(job, "supply-chain.yml job").map((step, index) =>
      stepIdentity(step, `supply-chain.yml.steps[${index}]`),
    ),
    [
      `uses:${CHECKOUT}`,
      `uses:${SETUP_NODE}`,
      "id:runtime_lock_anchors",
      "id:build_image",
      "name:Exercise the constrained production runtime",
      "id:install_scanners",
      "name:Verify tool provenance",
      "name:Import the immutable vulnerability database snapshot",
      "name:Generate retained image SBOMs",
      "id:seal_sbom",
      "name:Retain SBOM evidence before vulnerability scanning",
      "id:grype_reports",
      "id:grype_high_critical_gate",
      "id:validate_supply_evidence",
      "name:Upload Grype SARIF to GitHub code scanning",
      "name:Retain SBOM, scan, database, and provenance evidence",
    ],
    "the image gate must keep its exact build, seal, scan, gate, and retain sequence",
  );
  const environment = objectValue(job.env, "supply-chain.yml job env");
  const program = jobProgram(job, "supply-chain.yml job");
  const programText = program.join("\n");
  const expected = {
    syftVersion: "1.46.0",
    syftSha: "d654f678b709eb53c393d38519d5ed7d2e57205529404018614cfefa0fb2b5ca",
    syftBinarySha: "574df1a0862ff88ad933be214e81069e35b17618a13e019f8f1c84fe063222a2",
    grypeVersion: "0.115.0",
    grypeSha: "3fad92940650e514c0aa2dad83526942a055e210cec09a8a59d9c024adc2b90e",
    grypeBinarySha: "05ffd2c28a607e48fb2269d9aac5b3d53e8a51bbac501946644745eae2119907",
    dbUrl: "https://grype.anchore.io/databases/v6/vulnerability-db_v6.1.8_2026-07-15T00:32:35Z_1784139280.tar.zst",
    dbSha: "0d9ac9d49c93649ea6bf713c60960b46e33c939d49ac7de52df649453d29cf8e",
    syftPolicySha: "426021b3be44dd47ae4ca10de945f7e3fe4fd520619d5825c48e1324f925a533",
    grypePolicySha: "5c7e79f0d60429243c7e085a483997ec0be11d0303b413bafae716c8ffae68b5",
    runtimePackagesSha: "1314f23bb0d8ff37a45494fdf5763ec944c6f11aa3358d0e20c45ccecfe45659",
    runtimeInventorySha: "43aaf8086d5bad54e1152cb8e2ae1a7c172aff1c21b72af2bd8dde91dac61786",
    runtimeArchivesSha: "fa52b2f0cf44a64bc10c96f8989e48b2ca04d6fd20d2bd2eca420d0b52acd5da",
  };
  exactKeys(
    environment,
    [
      "IMAGE",
      "EVIDENCE_DIR",
      "TOOLS_DIR",
      "BASH_ENV",
      "DOCKER_BUILDKIT",
      "SYFT_VERSION",
      "SYFT_SHA256",
      "EXPECTED_SYFT_BINARY_SHA256",
      "SYFT_CHECK_FOR_APP_UPDATE",
      "GRYPE_VERSION",
      "GRYPE_SHA256",
      "EXPECTED_GRYPE_BINARY_SHA256",
      "GRYPE_DB_URL",
      "GRYPE_DB_SHA256",
      "GRYPE_DB_CACHE_DIR",
      "GRYPE_DB_AUTO_UPDATE",
      "GRYPE_DB_VALIDATE_AGE",
      "GRYPE_DB_REQUIRE_UPDATE_CHECK",
      "GRYPE_CHECK_FOR_APP_UPDATE",
      "GRYPE_EXTERNAL_SOURCES_ENABLE",
      "EXPECTED_SYFT_POLICY_SHA256",
      "EXPECTED_GRYPE_POLICY_SHA256",
      "EXPECTED_RUNTIME_PACKAGES_LOCK_SHA256",
      "EXPECTED_RUNTIME_APK_INVENTORY_LOCK_SHA256",
      "EXPECTED_RUNTIME_APK_ARCHIVES_MANIFEST_SHA256",
    ],
    "supply-chain.yml job env",
  );
  assert.equal(environment.BASH_ENV, "/dev/null");
  assert.equal(environment.DOCKER_BUILDKIT, "1");
  assert.equal(environment.SYFT_VERSION, expected.syftVersion);
  assert.equal(environment.SYFT_SHA256, expected.syftSha);
  assert.equal(environment.EXPECTED_SYFT_BINARY_SHA256, expected.syftBinarySha);
  assert.equal(environment.SYFT_CHECK_FOR_APP_UPDATE, "false");
  assert.equal(environment.GRYPE_VERSION, expected.grypeVersion);
  assert.equal(environment.GRYPE_SHA256, expected.grypeSha);
  assert.equal(environment.EXPECTED_GRYPE_BINARY_SHA256, expected.grypeBinarySha);
  assert.equal(environment.GRYPE_DB_URL, expected.dbUrl);
  assert.equal(environment.GRYPE_DB_SHA256, expected.dbSha);
  assert.equal(environment.GRYPE_DB_AUTO_UPDATE, "false");
  assert.equal(environment.GRYPE_DB_VALIDATE_AGE, "false");
  assert.equal(environment.GRYPE_DB_REQUIRE_UPDATE_CHECK, "false");
  assert.equal(environment.GRYPE_CHECK_FOR_APP_UPDATE, "false");
  assert.equal(environment.GRYPE_EXTERNAL_SOURCES_ENABLE, "false");
  assert.equal(environment.EXPECTED_SYFT_POLICY_SHA256, expected.syftPolicySha);
  assert.equal(environment.EXPECTED_GRYPE_POLICY_SHA256, expected.grypePolicySha);
  assert.equal(sha256(readText(".syft.yaml")), expected.syftPolicySha);
  assert.equal(sha256(readText(".grype.yaml")), expected.grypePolicySha);
  assert.equal(environment.EXPECTED_RUNTIME_PACKAGES_LOCK_SHA256, expected.runtimePackagesSha);
  assert.equal(environment.EXPECTED_RUNTIME_APK_INVENTORY_LOCK_SHA256, expected.runtimeInventorySha);
  assert.equal(environment.EXPECTED_RUNTIME_APK_ARCHIVES_MANIFEST_SHA256, expected.runtimeArchivesSha);
  const supplyDocumentation = readText("docs/SUPPLY_CHAIN.md");
  assert.ok(supplyDocumentation.includes(expected.syftBinarySha));
  assert.ok(supplyDocumentation.includes(expected.grypeBinarySha));

  const nodeStep = stepByUses(job, SETUP_NODE, "supply-chain.yml job");
  exactKeys(nodeStep, ["uses", "with"], "supply-chain setup-node step");
  assert.deepEqual(objectValue(nodeStep.with, "supply-chain setup-node with"), {
    "node-version": "24.18.0",
    cache: "npm",
  });

  const buildStep = stepByName(job, "Build the exact production image", "supply-chain.yml job");
  exactKeys(buildStep, ["name", "id", "shell", "run"], "production image build step");
  assert.equal(buildStep.id, "build_image");
  assert.equal(buildStep.shell, "bash");
  assert.deepEqual(executableLines(buildStep.run, "production image build run"), [
    "set -euo pipefail",
    'test "$(sha256sum runtime-packages.lock | cut -d \' \' -f 1)" = "$EXPECTED_RUNTIME_PACKAGES_LOCK_SHA256"',
    'test "$(sha256sum runtime-apk-inventory.lock | cut -d \' \' -f 1)" = "$EXPECTED_RUNTIME_APK_INVENTORY_LOCK_SHA256"',
    'test "$(sha256sum runtime-apk-archives.sha256 | cut -d \' \' -f 1)" = "$EXPECTED_RUNTIME_APK_ARCHIVES_MANIFEST_SHA256"',
    'docker build --pull=false --platform linux/amd64 --target runtime --tag "$IMAGE" .',
    'IMAGE_ID="$(docker image inspect --format \'{{.Id}}\' "$IMAGE")"',
    'test -n "$IMAGE_ID"',
    'echo "image_id=$IMAGE_ID" >> "$GITHUB_OUTPUT"',
  ]);

  const lockAnchorStep = stepById(job, "runtime_lock_anchors", "supply-chain.yml job");
  exactKeys(lockAnchorStep, ["name", "id", "shell", "run"], "runtime lock anchor step");
  assert.equal(lockAnchorStep.name, "Anchor LF runtime package inputs before build");
  assert.equal(lockAnchorStep.shell, "bash");
  const lockAnchorLines = executableLines(lockAnchorStep.run, "runtime lock anchor run");
  const lockAnchorProgram = lockAnchorLines.join("\n");
  for (const required of [
    "set -euo pipefail",
    "runtime-packages.lock",
    "runtime-apk-inventory.lock",
    "runtime-apk-archives.sha256",
    "test \"$(wc -l < runtime-apk-archives.sha256)\" -eq 45",
    "test \"$(LC_ALL=C sort -u /tmp/manifest-runtime-apk-archives | wc -l)\" -eq 45",
    "diff -u /tmp/expected-runtime-apk-archives /tmp/manifest-runtime-apk-archives",
    "RUNTIME_PACKAGES_LOCK_SHA256=\"$(sha256sum runtime-packages.lock | cut -d ' ' -f 1)\"",
    "RUNTIME_APK_INVENTORY_LOCK_SHA256=\"$(sha256sum runtime-apk-inventory.lock | cut -d ' ' -f 1)\"",
    "RUNTIME_APK_ARCHIVES_MANIFEST_SHA256=\"$(sha256sum runtime-apk-archives.sha256 | cut -d ' ' -f 1)\"",
    "test \"$RUNTIME_PACKAGES_LOCK_SHA256\" = \"$EXPECTED_RUNTIME_PACKAGES_LOCK_SHA256\"",
    "test \"$RUNTIME_APK_INVENTORY_LOCK_SHA256\" = \"$EXPECTED_RUNTIME_APK_INVENTORY_LOCK_SHA256\"",
    "test \"$RUNTIME_APK_ARCHIVES_MANIFEST_SHA256\" = \"$EXPECTED_RUNTIME_APK_ARCHIVES_MANIFEST_SHA256\"",
    'cp -- "$input" "$EVIDENCE_DIR/input-locks/$input"',
    'cmp -- "$input" "$EVIDENCE_DIR/input-locks/$input"',
    "input-locks/runtime-packages.lock \\",
    "input-locks/runtime-apk-inventory.lock \\",
    "input-locks/runtime-apk-archives.sha256 \\",
    "sha256sum --check --strict runtime-package-inputs.prebuild.sha256",
  ]) {
    assert.ok(lockAnchorLines.includes(required), `the runtime lock anchor omitted: ${required}`);
  }
  assert.doesNotMatch(lockAnchorProgram, /\|\|\s*true|continue-on-error/);
  assert.equal(
    program.filter((line) => line.includes('>> "$GITHUB_ENV"')).length,
    1,
    "only the reviewed lock-anchor step may persist job environment values",
  );

  const scannerInstallStep = stepById(job, "install_scanners", "supply-chain.yml job");
  assertScannerInstallStep(scannerInstallStep);

  const provenanceStep = stepByName(job, "Verify tool provenance", "supply-chain.yml job");
  exactKeys(provenanceStep, ["name", "env", "shell", "run"], "tool provenance step");
  assert.deepEqual(objectValue(provenanceStep.env, "tool provenance env"), {
    EXPECTED_SYFT_BINARY_SHA256: "${{ env.EXPECTED_SYFT_BINARY_SHA256 }}",
    EXPECTED_GRYPE_BINARY_SHA256: "${{ env.EXPECTED_GRYPE_BINARY_SHA256 }}",
  });
  assert.equal(provenanceStep.shell, "bash");
  const provenanceLines = executableLines(provenanceStep.run, "tool provenance run");
  for (const required of [
    'test "$(sha256sum "$TOOLS_DIR/syft/syft" | cut -d \' \' -f 1)" = "$EXPECTED_SYFT_BINARY_SHA256"',
    'test "$(sha256sum "$TOOLS_DIR/grype/grype" | cut -d \' \' -f 1)" = "$EXPECTED_GRYPE_BINARY_SHA256"',
    'test "$(sha256sum .syft.yaml | cut -d \' \' -f 1)" = "$EXPECTED_SYFT_POLICY_SHA256"',
    'test "$(sha256sum .grype.yaml | cut -d \' \' -f 1)" = "$EXPECTED_GRYPE_POLICY_SHA256"',
    `cp -- .syft.yaml "${SYFT_POLICY_PATH}"`,
    `cp -- .grype.yaml "${GRYPE_POLICY_PATH}"`,
    `cmp -- .syft.yaml "${SYFT_POLICY_PATH}"`,
    `cmp -- .grype.yaml "${GRYPE_POLICY_PATH}"`,
    `test "$(sha256sum "${SYFT_POLICY_PATH}" | cut -d ' ' -f 1)" = "$EXPECTED_SYFT_POLICY_SHA256"`,
    `test "$(sha256sum "${GRYPE_POLICY_PATH}" | cut -d ' ' -f 1)" = "$EXPECTED_GRYPE_POLICY_SHA256"`,
    "GRYPE_CHECK_FOR_APP_UPDATE \\",
    "GRYPE_EXTERNAL_SOURCES_ENABLE \\",
    "SYFT_CHECK_FOR_APP_UPDATE \\",
    "env | cut -d= -f1 | grep -E '^(GRYPE|SYFT)_' \\",
    "diff -u /tmp/expected-scanner-environment /tmp/actual-scanner-environment",
    `${SYFT_COMMAND} --config "${SYFT_POLICY_PATH}" config --load \\`,
    `${GRYPE_COMMAND} --config "${GRYPE_POLICY_PATH}" config --load \\`,
    `${SYFT_COMMAND} --config "${SYFT_POLICY_PATH}" version \\`,
    `${GRYPE_COMMAND} --config "${GRYPE_POLICY_PATH}" version \\`,
    "test \"$(grep -Ec '^(default-catalogers|select-catalogers|exclude):[[:space:]]+\\[\\]$' \"$EVIDENCE_DIR/syft-config.effective.yaml\")\" -eq 3",
    "grep -E '^check-for-app-update:[[:space:]]+false$' \"$EVIDENCE_DIR/grype-config.effective.yaml\"",
    "grep -E '^ignore:[[:space:]]+\\[\\]$' \"$EVIDENCE_DIR/grype-config.effective.yaml\"",
    "test \"$(grep -Ec '^  (enable|auto-update|validate-age|require-update-check):[[:space:]]+false$' \"$EVIDENCE_DIR/grype-config.effective.yaml\")\" -eq 4",
  ]) {
    assert.ok(provenanceLines.includes(required), `scanner environment guard omitted: ${required}`);
  }
  assertExplicitSyftInvocations(program, "supply-chain.yml");
  const grypeInvocations = program.filter((line) => /^(?:grype|"\$TOOLS_DIR\/grype\/grype")\s/.test(line));
  assert.deepEqual(grypeInvocations, [
    `${GRYPE_COMMAND} --config "${GRYPE_POLICY_PATH}" config --load \\`,
    `${GRYPE_COMMAND} --config "${GRYPE_POLICY_PATH}" version \\`,
    `${GRYPE_COMMAND} --config "${GRYPE_POLICY_PATH}" db import "$DB_ARCHIVE"`,
    `${GRYPE_COMMAND} --config "${GRYPE_POLICY_PATH}" db status \\`,
    `${GRYPE_COMMAND} --config "${GRYPE_POLICY_PATH}" "sbom:$EVIDENCE_DIR/autopilot.syft.json" --by-cve \\`,
    `${GRYPE_COMMAND} --config "${GRYPE_POLICY_PATH}" "sbom:$EVIDENCE_DIR/autopilot.syft.json" \\`,
  ]);
  assert.equal(
    program.filter((line) => line.includes("$GITHUB_PATH")).length,
    0,
    "scanner execution must not depend on mutable PATH precedence",
  );

  const databaseImportStep = stepByName(
    job,
    "Import the immutable vulnerability database snapshot",
    "supply-chain.yml job",
  );
  exactKeys(databaseImportStep, ["name", "env", "shell", "run"], "database import step");
  assert.deepEqual(objectValue(databaseImportStep.env, "database import env"), {
    EXPECTED_GRYPE_BINARY_SHA256: "${{ env.EXPECTED_GRYPE_BINARY_SHA256 }}",
  });
  const databaseImportLines = executableLines(databaseImportStep.run, "database import run");
  assert.ok(
    databaseImportLines.includes(
      'test "$(sha256sum "$TOOLS_DIR/grype/grype" | cut -d \' \' -f 1)" = "$EXPECTED_GRYPE_BINARY_SHA256"',
    ),
  );
  assert.ok(
    program.some((line) => line.includes("syft/releases/download/v${SYFT_VERSION}/")),
    "the executable workflow must download the exact Syft release",
  );
  assert.ok(
    program.some((line) => line.includes("grype/releases/download/v${GRYPE_VERSION}/")),
    "the executable workflow must download the exact Grype release",
  );
  assert.equal(
    program.filter((line) => line.includes("sha256sum --check --strict")).length,
    12,
    "all external archives and retained evidence identities must be reverified",
  );
  assert.doesNotMatch(programText, /releases\/latest|curl[^\n]+\/install(?:\.sh)?|apt-get[^\n]+(?:syft|grype)/i);

  const dockerfile = readText("Dockerfile");
  assertPackageBuildContract(JSON.parse(readText("package.json")));
  assert.match(
    readText("deploy/redeploy.sh"),
    /^DOCKER_BUILDKIT=1 docker build -t "\$IMAGE" \. \|\| die "docker build failed\."$/m,
    "the authoritative redeploy path must enable the reviewed BuildKit Dockerfile features",
  );
  const dockerfileInstructions = dockerInstructions(dockerfile);
  assert.deepEqual(
    dockerfileInstructions
      .filter((instruction) => instruction.keyword === "FROM")
      .map((instruction) => instruction.value),
    [
      "node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS build",
      "cgr.dev/chainguard/wolfi-base@sha256:02dab76bd852a70556b5b2002195c8a5fdab77d323c433bf6642aab080489795 AS runtime-apk-archives",
      "cgr.dev/chainguard/wolfi-base@sha256:02dab76bd852a70556b5b2002195c8a5fdab77d323c433bf6642aab080489795 AS runtime",
    ],
    "the exact three-stage image base inventory drifted",
  );
  assert.match(
    dockerfile,
    /^FROM node:24\.18\.0-alpine3\.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS build$/m,
  );
  assert.match(
    dockerfile,
    /^FROM cgr\.dev\/chainguard\/wolfi-base@sha256:02dab76bd852a70556b5b2002195c8a5fdab77d323c433bf6642aab080489795 AS runtime$/m,
  );
  assert.match(dockerfile, /npm prune --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /COPY --from=build --chown=1000:1000 \/app\/node_modules \.\/node_modules/);
  assert.match(dockerfile, /! command -v npm >\/dev\/null/);
  assert.doesNotMatch(
    dockerfileInstructions.map((instruction) => instruction.value).join("\n"),
    /\|\|\s*true/,
    "Docker build controls must remain fail-closed",
  );

  const buildStage = dockerStage(dockerfileInstructions, "build");
  assertBuildStageContract(buildStage);
  const archiveStage = dockerStage(dockerfileInstructions, "runtime-apk-archives");
  assertArchiveStageContract(archiveStage);
  assert.equal(
    archiveStage.filter(
      (instruction) =>
        instruction.keyword === "COPY" &&
        instruction.value === "runtime-packages.lock runtime-apk-archives.sha256 ./",
    ).length,
    1,
    "the archive resolver must receive both reviewed raw-package inputs",
  );
  const archiveRun = oneDockerInstruction(archiveStage, "RUN", "runtime-apk-archives stage");
  const archiveCommands = archiveRun.lines;
  const archiveSequence = [
    "set -eu;",
    "test \"$(wc -l < packages)\" -eq 45;",
    "test \"$(wc -l < package-names)\" -eq 45;",
    "test \"$(LC_ALL=C sort -u package-names | wc -l)\" -eq 45;",
    "test \"$(LC_ALL=C sort -u expected-archives | wc -l)\" -eq 45;",
    "test \"$(wc -l < runtime-apk-archives.sha256)\" -eq 45;",
    "test \"$(LC_ALL=C sort -u manifest-archives | wc -l)\" -eq 45;",
    "diff -u expected-archives manifest-archives;",
    "apk fetch --no-cache --output /tmp/runtime-apks $(cat package-names);",
    "test \"$(find /tmp/runtime-apks -mindepth 1 -maxdepth 1 | wc -l)\" -eq 45;",
    "test \"$(find /tmp/runtime-apks -mindepth 1 -maxdepth 1 -type f | wc -l)\" -eq 45;",
    "test \"$(wc -l < actual-archives)\" -eq 45;",
    "test \"$(LC_ALL=C sort -u actual-archives | wc -l)\" -eq 45;",
    "diff -u expected-archives actual-archives;",
    "(cd /tmp/runtime-apks && sha256sum -c /tmp/runtime-apk-lock/runtime-apk-archives.sha256)",
  ];
  let previousArchiveControl = -1;
  for (const command of archiveSequence) {
    const index = archiveCommands.indexOf(command);
    assert.ok(index >= 0, `archive resolver omitted executable control: ${command}`);
    assert.ok(index > previousArchiveControl, `archive resolver control is out of order: ${command}`);
    previousArchiveControl = index;
  }

  const runtimeStage = dockerStage(dockerfileInstructions, "runtime");
  assert.deepEqual(
    runtimeStage.map((instruction) => instruction.keyword),
    [
      "FROM",
      "ENV",
      "ENV",
      "ENV",
      "WORKDIR",
      "COPY",
      "RUN",
      "COPY",
      "COPY",
      "COPY",
      "COPY",
      "COPY",
      "COPY",
      "COPY",
      "COPY",
      "EXPOSE",
      "USER",
      "HEALTHCHECK",
      "ENTRYPOINT",
      "CMD",
    ],
    "the final runtime instruction inventory must reject post-validation system mutation",
  );
  assertRuntimeStageContract(runtimeStage);
  assert.deepEqual(
    runtimeStage
      .filter((instruction) => instruction.keyword === "COPY")
      .map((instruction) => instruction.value),
    [
      "runtime-packages.lock runtime-apk-inventory.lock runtime-apk-archives.sha256 /tmp/runtime-apk-lock/",
      "--from=build --chown=1000:1000 /app/node_modules ./node_modules",
      "--from=build --chown=1000:1000 /app/dist/src ./dist/src",
      "--from=build --chown=1000:1000 /app/dist/scripts/apply-schema.js ./dist/scripts/apply-schema.js",
      "--from=build --chown=1000:1000 /app/dist/scripts/bootstrap-db.js ./dist/scripts/bootstrap-db.js",
      "--chown=1000:1000 src/ui.html ./dist/src/ui.html",
      "--chown=1000:1000 src/db/schema.sql ./dist/src/db/schema.sql",
      "--chown=1000:1000 demo/sample-invoice.png ./dist/demo/sample-invoice.png",
      "--chown=1000:1000 package.json ./dist/package.json",
    ],
    "runtime COPY instructions may write only the reviewed application destinations",
  );
  assert.equal(
    runtimeStage.filter(
      (instruction) =>
        instruction.keyword === "COPY" &&
        instruction.value ===
          "runtime-packages.lock runtime-apk-inventory.lock runtime-apk-archives.sha256 /tmp/runtime-apk-lock/",
    ).length,
    1,
    "the runtime stage must receive all three reviewed locks",
  );
  const runtimeRun = runtimeStage.find(
    (instruction) => instruction.keyword === "RUN" && instruction.lines[0] === "--network=none",
  );
  assert.ok(runtimeRun, "the runtime APK installation must be a network-disabled RUN");
  assert.equal(
    runtimeStage.filter((instruction) => instruction.keyword === "RUN").length,
    1,
    "the runtime stage must have exactly one fail-closed installation/validation RUN",
  );
  const runtimeCommands = runtimeRun!.lines;
  const runtimeSequence = [
    "--network=none",
    "--mount=type=bind,from=runtime-apk-archives,source=/tmp/runtime-apks,target=/tmp/runtime-apks,ro",
    "set -eu;",
    "test \"$(wc -l < /tmp/runtime-apk-lock/packages)\" -eq 45;",
    "test \"$(LC_ALL=C sort -u /tmp/runtime-apk-lock/expected-archives | wc -l)\" -eq 45;",
    "test \"$(wc -l < /tmp/runtime-apk-lock/runtime-apk-archives.sha256)\" -eq 45;",
    "test \"$(LC_ALL=C sort -u /tmp/runtime-apk-lock/manifest-archives | wc -l)\" -eq 45;",
    "diff -u /tmp/runtime-apk-lock/expected-archives /tmp/runtime-apk-lock/manifest-archives;",
    "test \"$(find /tmp/runtime-apks -mindepth 1 -maxdepth 1 | wc -l)\" -eq 45;",
    "test \"$(find /tmp/runtime-apks -mindepth 1 -maxdepth 1 -type f | wc -l)\" -eq 45;",
    "test \"$(wc -l < /tmp/runtime-apk-lock/actual-archives)\" -eq 45;",
    "test \"$(LC_ALL=C sort -u /tmp/runtime-apk-lock/actual-archives | wc -l)\" -eq 45;",
    "diff -u /tmp/runtime-apk-lock/expected-archives /tmp/runtime-apk-lock/actual-archives;",
    "(cd /tmp/runtime-apks && sha256sum -c /tmp/runtime-apk-lock/runtime-apk-archives.sha256);",
    ": > /tmp/runtime-apk-lock/empty-repositories;",
    "apk --no-cache --no-network --repositories-file /tmp/runtime-apk-lock/empty-repositories",
    "add --allow-untrusted /tmp/runtime-apks/*.apk;",
    "diff -u /tmp/runtime-apk-lock/expected-inventory /tmp/runtime-apk-lock/actual-inventory;",
  ];
  let previousRuntimeControl = -1;
  for (const command of runtimeSequence) {
    const index = runtimeCommands.indexOf(command);
    assert.ok(index >= 0, `runtime stage omitted executable control: ${command}`);
    assert.ok(index > previousRuntimeControl, `runtime control is out of order: ${command}`);
    previousRuntimeControl = index;
  }
  const allDockerCommands = dockerfileInstructions.flatMap((instruction) => instruction.lines);
  assert.deepEqual(
    allDockerCommands.filter((command) => /^apk fetch\b/.test(command)),
    ["apk fetch --no-cache --output /tmp/runtime-apks $(cat package-names);"],
    "only the resolver stage may fetch APK archives",
  );
  assert.deepEqual(
    allDockerCommands.filter((command) => /(?:^|\s)add(?:\s|$)/.test(command)),
    ["add --allow-untrusted /tmp/runtime-apks/*.apk;"],
    "runtime APK installation must use only the verified local closure with networking disabled",
  );

  const runtimePackagesBytes = readFileSync(join(ROOT, "runtime-packages.lock"));
  assert.equal(
    sha256(runtimePackagesBytes),
    "1314f23bb0d8ff37a45494fdf5763ec944c6f11aa3358d0e20c45ccecfe45659",
    "the reviewed runtime requirement lock identity drifted",
  );
  assert.equal(runtimePackagesBytes.includes(Buffer.from("\r\n")), false, "the runtime requirement lock must use LF");
  const lockedPackages = runtimePackagesBytes
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.equal(lockedPackages.length, 45, "the reviewed Wolfi requirement closure must stay locked");
  assert.deepEqual(
    lockedPackages,
    [...lockedPackages].sort((left, right) =>
      left.split("=", 1)[0]!.localeCompare(right.split("=", 1)[0]!, "en"),
    ),
    "the runtime package lock must remain canonical",
  );
  for (const entry of lockedPackages) {
    assert.match(entry, /^[a-z0-9][a-z0-9+._-]*=[0-9][a-zA-Z0-9+._:-]*-r\d+$/, `runtime package is not exact: ${entry}`);
  }
  assert.ok(lockedPackages.includes("nodejs-24=24.18.0-r2"));
  assert.ok(lockedPackages.includes("poppler-utils=26.07.0-r0"));
  assert.ok(lockedPackages.includes("font-ubuntu=0.869-r3"));
  assert.ok(!lockedPackages.some((entry) => entry.startsWith("npm=")), "npm must not be installed in the runtime image");
  const runtimeInventoryBytes = readFileSync(join(ROOT, "runtime-apk-inventory.lock"));
  assert.equal(
    sha256(runtimeInventoryBytes),
    "43aaf8086d5bad54e1152cb8e2ae1a7c172aff1c21b72af2bd8dde91dac61786",
    "the reviewed final APK inventory identity drifted",
  );
  assert.equal(runtimeInventoryBytes.includes(Buffer.from("\r\n")), false, "the final APK inventory must use LF");
  const finalInventory = runtimeInventoryBytes
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.equal(finalInventory.length, 51, "the final base + added APK inventory must stay locked");
  assert.deepEqual(
    finalInventory,
    [...finalInventory].sort((left, right) =>
      left.split("=", 1)[0]!.localeCompare(right.split("=", 1)[0]!, "en"),
    ),
    "the final APK inventory lock must remain canonical",
  );
  for (const entry of lockedPackages) {
    assert.ok(finalInventory.includes(entry), `the final APK inventory omitted required package ${entry}`);
  }
  assert.deepEqual(
    finalInventory.filter((entry) => !lockedPackages.includes(entry)),
    [
      "apk-tools=2.14.10-r13",
      "busybox=1.37.0-r61",
      "libcrypt1=2.43-r11",
      "libxcrypt=4.5.2-r3",
      "wolfi-base=1-r7",
      "wolfi-keys=1-r13",
    ],
    "immutable-base-only packages must be explicit rather than hidden from the final inventory",
  );

  const archiveManifestPath = join(ROOT, "runtime-apk-archives.sha256");
  assert.ok(existsSync(archiveManifestPath), "the reviewed raw APK archive manifest is required");
  const archiveManifestBytes = readFileSync(archiveManifestPath);
  assert.equal(
    sha256(archiveManifestBytes),
    "fa52b2f0cf44a64bc10c96f8989e48b2ca04d6fd20d2bd2eca420d0b52acd5da",
    "the reviewed raw APK archive manifest identity drifted",
  );
  assert.equal(archiveManifestBytes.includes(Buffer.from("\r\n")), false, "the APK archive manifest must use LF");
  const archiveManifest = archiveManifestBytes
    .toString("ascii")
    .split("\n")
    .filter((line) => line.length > 0);
  assert.equal(archiveManifest.length, 45, "every runtime requirement needs one raw APK SHA-256");
  const manifestFiles = archiveManifest.map((line) => {
    const match = line.match(/^([0-9a-f]{64})  ([a-z0-9][a-z0-9+._-]*\.apk)$/);
    assert.ok(match, `invalid strict sha256sum manifest line: ${line}`);
    return match![2]!;
  });
  assert.deepEqual(
    manifestFiles,
    lockedPackages.map((entry) => `${entry.replace("=", "-")}.apk`),
    "the raw APK manifest must preserve and exactly cover runtime-packages.lock order",
  );
  assert.equal(new Set(manifestFiles).size, 45, "the raw APK manifest contains a duplicate archive name");

  const attributes = readText(".gitattributes");
  assert.match(attributes, /^runtime-packages\.lock text eol=lf$/m);
  assert.match(attributes, /^runtime-apk-inventory\.lock text eol=lf$/m);
  assert.match(attributes, /^runtime-apk-archives\.sha256 text eol=lf$/m);
  assert.match(attributes, /^\.syft\.yaml text eol=lf$/m);
  assert.match(attributes, /^\.grype\.yaml text eol=lf$/m);

  const runtimeStep = stepByName(
    job,
    "Exercise the constrained production runtime",
    "supply-chain.yml job",
  );
  exactKeys(runtimeStep, ["name", "env", "shell", "run"], "constrained runtime step");
  assert.deepEqual(objectValue(runtimeStep.env, "constrained runtime env"), {
    EXPECTED_IMAGE_ID: "${{ steps.build_image.outputs.image_id }}",
  });
  assert.equal(runtimeStep.shell, "bash");
  assertRuntimeCanaryStepContract(runtimeStep.run);
  const runtimeLines = executableLines(runtimeStep.run, "constrained runtime run");
  const runtimeProgram = runtimeLines.join("\n");
  for (const required of [
    'test -n "$EXPECTED_IMAGE_ID"',
    'test "$(docker image inspect --format \'{{.Id}}\' "$IMAGE")" = "$EXPECTED_IMAGE_ID"',
    "docker image inspect --format '{{json .Config}}' \"$IMAGE\" \\",
    '> "$EVIDENCE_DIR/runtime-image-config.actual.json"',
    'assert.equal(config.WorkingDir, "/app");',
    'assert.equal(config.User, "1000:1000");',
    'assert.deepEqual(config.Cmd, ["node", "dist/src/server.js"]);',
    "assert.equal(config.Entrypoint, null);",
    'assert.deepEqual(config.ExposedPorts, { "9000/tcp": {} });',
    "docker run --rm \\",
    "--network none \\",
    "--read-only \\",
    "--cap-drop ALL \\",
    "--security-opt no-new-privileges \\",
    '8a4c0b511d63ccb085c8c9044e8a4f4918d5a0af1e2287aed8b87c0cb42e5bef  $FIXTURE',
    '--mount "type=bind,src=$FIXTURE,dst=/fixture.pdf,readonly" \\',
    "runtime-apk-inventory.lock,dst=/expected-apk-inventory.lock,readonly",
    'test "$(id -u)" = "1000"',
    'test "$(id -g)" = "1000"',
    "! command -v npm >/dev/null",
    'test -f "/usr/share/fonts/ubuntu/Ubuntu[wdth,wght].ttf"',
    'test -f "/usr/share/fonts/ubuntu/Ubuntu-Italic[wdth,wght].ttf"',
    'test "$(find /usr/share/fonts/ubuntu -mindepth 1 -maxdepth 1 -type f -name "*.ttf" | wc -l)" -eq 4',
    "mkdir -p /tmp/render",
    "timeout 20s pdftoppm -f 1 -l 1 -singlefile -png -scale-to 512 \\",
    "/fixture.pdf /tmp/render/page \\",
    "> /tmp/pdftoppm.stdout 2> /tmp/pdftoppm.stderr",
    "test ! -s /tmp/pdftoppm.stdout",
    "test ! -s /tmp/pdftoppm.stderr",
    "test -s /tmp/render/page.png",
    'test "$(wc -c < /tmp/render/page.png)" -le 4194304',
    'echo "pdf-render-font-substitution-clean" >&2',
    ": > /tmp/empty-apk-repositories",
    "apk --no-network --repositories-file /tmp/empty-apk-repositories info -v \\",
    "| LC_ALL=C sort > /tmp/actual-apk-inventory",
    "diff -u /tmp/expected-apk-inventory /tmp/actual-apk-inventory",
    'grep -Eq "^[^ ]+ /proc proc " /proc/mounts',
    'grep -Eq "^[^ ]+ /sys sysfs " /proc/mounts',
    'grep -Eq "^[^ ]+ /tmp tmpfs " /proc/mounts',
    "apk --no-network --repositories-file /tmp/empty-apk-repositories \\",
    "audit --system --check-permissions \\",
    "> /tmp/apk-audit.system 2> /tmp/apk-audit.stderr || AUDIT_STATUS=$?",
    'test "$AUDIT_STATUS" -eq 0 -o "$AUDIT_STATUS" -eq 1',
    "test ! -s /tmp/apk-audit.stderr",
    'printf "%s\\n" "m proc/" "m sys/" "m tmp/" > /tmp/apk-audit.expected-runtime-mounts',
    "LC_ALL=C sort /tmp/apk-audit.system > /tmp/apk-audit.actual-runtime-mounts",
    "diff -u /tmp/apk-audit.expected-runtime-mounts /tmp/apk-audit.actual-runtime-mounts",
    'echo "apk-audit-system-clean-except-exact-runtime-mount-metadata" >&2',
    'tee "$EVIDENCE_DIR/runtime-apk-inventory.actual"',
    'APP_CANARY_ID="$(docker run --detach --rm \\',
    '--env REVIEWER_TOKEN=local-ci-canary-not-a-secret-local-ci-canary \\',
    '--env ALLOW_FAKE_QWEN=true \\',
    '--env ALLOW_IN_MEMORY_STORE=true \\',
    'test "$(docker inspect --format \'{{.Image}}\' "$APP_CANARY_ID")" = "$EXPECTED_IMAGE_ID"',
    'test "$(docker exec "$APP_CANARY_ID" id -u)" = "1000"',
    'test "$(docker exec "$APP_CANARY_ID" id -g)" = "1000"',
    'echo "default-cmd-health-canary-passed" >&2',
  ]) {
    assert.ok(runtimeProgram.includes(required), `the executable runtime canary omitted: ${required}`);
  }
  const renderIndex = runtimeLines.findIndex((line) => line.startsWith("timeout 20s pdftoppm "));
  const stdoutIndex = runtimeLines.indexOf("test ! -s /tmp/pdftoppm.stdout");
  const stderrIndex = runtimeLines.indexOf("test ! -s /tmp/pdftoppm.stderr");
  const outputIndex = runtimeLines.indexOf("test -s /tmp/render/page.png");
  const sizeIndex = runtimeLines.indexOf('test "$(wc -c < /tmp/render/page.png)" -le 4194304');
  const cleanMarkerIndex = runtimeLines.indexOf('echo "pdf-render-font-substitution-clean" >&2');
  assert.ok(
    renderIndex >= 0 &&
      stdoutIndex > renderIndex &&
      stderrIndex > stdoutIndex &&
      outputIndex > stderrIndex &&
      sizeIndex > outputIndex &&
      cleanMarkerIndex > sizeIndex,
    "bounded PDF rendering must have silent font resolution before validated output",
  );
});

test("SUPPLY 4 — retained SBOM/SARIF evidence and the high/critical gate cannot silently weaken", () => {
  const workflow = parseWorkflow("supply-chain.yml");
  const job = workflowJob(workflow, "image-sbom-vulnerability-gate");
  const steps = jobSteps(job, "supply-chain.yml job");
  const program = jobProgram(job, "supply-chain.yml job");
  const programText = program.join("\n");

  const sbomStep = stepByName(job, "Generate retained image SBOMs", "supply-chain.yml job");
  exactKeys(sbomStep, ["name", "env", "shell", "run"], "SBOM generation step");
  assert.deepEqual(objectValue(sbomStep.env, "SBOM generation env"), {
    EXPECTED_IMAGE_ID: "${{ steps.build_image.outputs.image_id }}",
    EXPECTED_SYFT_BINARY_SHA256: "${{ env.EXPECTED_SYFT_BINARY_SHA256 }}",
    EXPECTED_GRYPE_BINARY_SHA256: "${{ env.EXPECTED_GRYPE_BINARY_SHA256 }}",
  });
  assert.equal(sbomStep.shell, "bash");
  const sbomLines = executableLines(sbomStep.run, "SBOM generation run");
  assert.equal(
    sbomLines.length,
    SBOM_GENERATION_EXECUTABLE_LINES,
    "the complete SBOM generation program gained or lost an executable line",
  );
  assert.equal(
    sha256(sbomLines.join("\n")),
    SBOM_GENERATION_PROGRAM_SHA256,
    "the complete hash→scan→provenance SBOM program drifted",
  );
  assert.ok(
    sbomLines.includes(
      'test "$(sha256sum "$TOOLS_DIR/syft/syft" | cut -d \' \' -f 1)" = "$EXPECTED_SYFT_BINARY_SHA256"',
    ),
  );
  assert.ok(
    sbomLines.includes(
      `test "$(sha256sum "${SYFT_POLICY_PATH}" | cut -d ' ' -f 1)" = "$EXPECTED_SYFT_POLICY_SHA256"`,
    ),
  );
  assert.ok(sbomLines.includes('test -n "$EXPECTED_IMAGE_ID"'));
  assert.ok(sbomLines.includes('test "$IMAGE_ID" = "$EXPECTED_IMAGE_ID"'));
  assert.ok(sbomLines.includes("binarySha256: process.env.EXPECTED_SYFT_BINARY_SHA256,"));
  assert.ok(sbomLines.includes("binarySha256: process.env.EXPECTED_GRYPE_BINARY_SHA256,"));
  assert.ok(sbomLines.includes("policySha256: process.env.EXPECTED_SYFT_POLICY_SHA256,"));
  assert.ok(sbomLines.includes("policySha256: process.env.EXPECTED_GRYPE_POLICY_SHA256,"));
  for (const format of ["syft-json", "spdx-json", "cyclonedx-json"]) {
    assert.ok(
      sbomLines.some((line) => line.startsWith(`--output "${format}=`)),
      `missing retained ${format} image inventory`,
    );
  }

  const sealStep = stepById(job, "seal_sbom", "supply-chain.yml job");
  exactKeys(sealStep, ["name", "id", "shell", "run"], "SBOM seal step");
  assert.equal(sealStep.name, "Validate and retain the pre-scan SBOM bundle");
  assert.equal(sealStep.shell, "bash");
  const sealLines = executableLines(sealStep.run, "SBOM seal run");
  for (const required of [
    'SCANNED_SBOM_SHA256="$(sha256sum "$EVIDENCE_DIR/autopilot.syft.json" | cut -d \' \' -f 1)"',
    'echo "syft_sha256=$SCANNED_SBOM_SHA256" >> "$GITHUB_OUTPUT"',
    '> "$EVIDENCE_DIR/SCANNED-SBOM.sha256"',
    "assert.ok(Array.isArray(syft.artifacts));",
    'assert.ok(syft.artifacts.length >= 251, "Syft inventory is unexpectedly sparse");',
    "assert.equal(expectedApkInventory.length, 51);",
    'assert.ok(apkInventory.has(expected), `Syft omitted installed APK ${expected}`);',
    "assert.equal(packageLock.lockfileVersion, 3);",
    "assert.equal(productionEntries.length, 207);",
    "assert.equal(expectedNpmInventory.size, 200);",
    'assert.ok(npmInventory.has(expected), `Syft omitted production npm package ${expected}`);',
    "sha256sum --check --strict SCANNED-SBOM.sha256",
    "grype-config.effective.yaml \\",
    "syft-config.effective.yaml \\",
    "input-locks/syft-policy.yaml \\",
    "input-locks/grype-policy.yaml \\",
    "input-locks/runtime-packages.lock \\",
    "input-locks/runtime-apk-inventory.lock \\",
    "input-locks/runtime-apk-archives.sha256 \\",
    "runtime-image-config.actual.json \\",
    "sha256sum --check --strict SBOM-SHA256SUMS",
  ]) {
    assert.ok(sealLines.includes(required), `the SBOM seal omitted: ${required}`);
  }

  const reportStep = stepByName(
    job,
    "Produce JSON, SARIF, and human-readable vulnerability reports",
    "supply-chain.yml job",
  );
  exactKeys(reportStep, ["name", "id", "env", "shell", "run"], "Grype report step");
  assert.equal(reportStep.id, "grype_reports");
  assert.deepEqual(objectValue(reportStep.env, "Grype report env"), {
    EXPECTED_SYFT_SHA256: "${{ steps.seal_sbom.outputs.syft_sha256 }}",
    EXPECTED_GRYPE_BINARY_SHA256: "${{ env.EXPECTED_GRYPE_BINARY_SHA256 }}",
  });
  assert.equal(reportStep.shell, "bash");
  const reportLines = executableLines(reportStep.run, "Grype report run");
  assert.deepEqual(reportLines, [
    "set -euo pipefail",
    'test "$(sha256sum "$TOOLS_DIR/grype/grype" | cut -d \' \' -f 1)" = "$EXPECTED_GRYPE_BINARY_SHA256"',
    `test "$(sha256sum "${GRYPE_POLICY_PATH}" | cut -d ' ' -f 1)" = "$EXPECTED_GRYPE_POLICY_SHA256"`,
    'test -n "$EXPECTED_SYFT_SHA256"',
    'test "$(sha256sum "$EVIDENCE_DIR/autopilot.syft.json" | cut -d \' \' -f 1)" = "$EXPECTED_SYFT_SHA256"',
    '(cd "$EVIDENCE_DIR" && sha256sum --check --strict SCANNED-SBOM.sha256)',
    `${GRYPE_COMMAND} --config "${GRYPE_POLICY_PATH}" "sbom:$EVIDENCE_DIR/autopilot.syft.json" --by-cve \\`,
    '--output "json=$EVIDENCE_DIR/grype-report.json" \\',
    '--output "sarif=$EVIDENCE_DIR/grype-report.sarif" \\',
    '--output "table=$EVIDENCE_DIR/grype-report.txt"',
  ]);

  const evidenceValidationStep = stepByName(
    job,
    "Validate evidence formats and hash the retained bundle",
    "supply-chain.yml job",
  );
  exactKeys(
    evidenceValidationStep,
    ["name", "id", "if", "shell", "run"],
    "evidence validation step",
  );
  assert.equal(evidenceValidationStep.id, "validate_supply_evidence");
  assert.equal(
    evidenceValidationStep.if,
    "${{ !cancelled() && steps.grype_reports.outcome == 'success' }}",
  );
  assert.equal(evidenceValidationStep.shell, "bash");
  const evidenceValidationLines = executableLines(
    evidenceValidationStep.run,
    "evidence validation run",
  );
  for (const required of [
    "assert.ok(Array.isArray(grype.matches));",
    'const ignoredMatches = Object.hasOwn(grype, "ignoredMatches") ? grype.ignoredMatches : [];',
    "assert.ok(Array.isArray(ignoredMatches));",
    "assert.equal(ignoredMatches.length, 0);",
    "sha256sum --check --strict SCANNED-SBOM.sha256",
    "sha256sum --check --strict SBOM-SHA256SUMS",
    "sha256sum --check --strict SHA256SUMS",
  ]) {
    assert.ok(evidenceValidationLines.includes(required), `evidence validation omitted: ${required}`);
  }

  const uploadSarif = stepByUses(job, CODEQL_UPLOAD, "supply-chain.yml job");
  exactKeys(uploadSarif, ["name", "if", "uses", "with"], "Grype SARIF upload step");
  assert.equal(uploadSarif.name, "Upload Grype SARIF to GitHub code scanning");
  assert.equal(
    uploadSarif.if,
    "${{ !cancelled() && steps.validate_supply_evidence.outcome == 'success' }}",
  );
  assert.deepEqual(objectValue(uploadSarif.with, "Grype SARIF upload with"), {
    sarif_file: ".artifacts/supply-chain/grype-report.sarif",
    category: "grype-production-image",
  });

  const grypeGate = stepById(
    job,
    "grype_high_critical_gate",
    "supply-chain.yml.jobs.image-sbom-vulnerability-gate",
  );
  assertGrypeGateStep(grypeGate);
  assert.doesNotMatch(
    programText,
    /--only-fixed|--only-notfixed|--ignore-states|GRYPE_ONLY_FIXED|GRYPE_ONLY_NOTFIXED|GRYPE_IGNORE_WONTFIX|\|\|\s*true/,
  );

  const preScanArtifact = stepByName(
    job,
    "Retain SBOM evidence before vulnerability scanning",
    "supply-chain.yml job",
  );
  exactKeys(preScanArtifact, ["name", "uses", "with"], "pre-scan SBOM artifact step");
  assert.equal(preScanArtifact.uses, UPLOAD_ARTIFACT);
  const preScanWith = objectValue(preScanArtifact.with, "pre-scan SBOM artifact with");
  exactKeys(
    preScanWith,
    ["name", "path", "if-no-files-found", "retention-days"],
    "pre-scan SBOM artifact with",
  );
  assert.equal(preScanWith.name, "production-sbom-${{ github.sha }}");
  assert.equal(preScanWith["if-no-files-found"], "error");
  assert.equal(preScanWith["retention-days"], 30);
  assert.deepEqual(executableLines(preScanWith.path, "pre-scan artifact paths"), [
    ".artifacts/supply-chain/autopilot.cyclonedx.json",
    ".artifacts/supply-chain/autopilot.spdx.json",
    ".artifacts/supply-chain/autopilot.syft.json",
    ".artifacts/supply-chain/SCANNED-SBOM.sha256",
    ".artifacts/supply-chain/image-provenance.json",
    ".artifacts/supply-chain/syft-version.txt",
    ".artifacts/supply-chain/syft-config.effective.yaml",
    ".artifacts/supply-chain/grype-version.txt",
    ".artifacts/supply-chain/grype-config.effective.yaml",
    ".artifacts/supply-chain/grype-db-status.txt",
    ".artifacts/supply-chain/docker-version.txt",
    ".artifacts/supply-chain/runtime-apk-inventory.actual",
    ".artifacts/supply-chain/runtime-image-config.actual.json",
    ".artifacts/supply-chain/runtime-package-inputs.prebuild.sha256",
    ".artifacts/supply-chain/SBOM-SHA256SUMS",
    ".artifacts/supply-chain/input-locks",
  ]);

  const finalArtifact = stepByName(
    job,
    "Retain SBOM, scan, database, and provenance evidence",
    "supply-chain.yml job",
  );
  exactKeys(finalArtifact, ["name", "if", "uses", "with"], "final supply-chain artifact step");
  assert.equal(finalArtifact.if, "always()");
  assert.equal(finalArtifact.uses, UPLOAD_ARTIFACT);
  const finalWith = objectValue(finalArtifact.with, "final supply-chain artifact with");
  exactKeys(
    finalWith,
    ["name", "path", "if-no-files-found", "retention-days"],
    "final supply-chain artifact with",
  );
  assert.equal(finalWith.name, "production-supply-chain-${{ github.sha }}");
  assert.equal(finalWith["if-no-files-found"], "error");
  assert.equal(finalWith["retention-days"], 30);
  const finalPaths = executableLines(finalWith.path, "final supply-chain artifact paths");
  assert.deepEqual(finalPaths, [
    ".artifacts/supply-chain/autopilot.cyclonedx.json",
    ".artifacts/supply-chain/autopilot.spdx.json",
    ".artifacts/supply-chain/autopilot.syft.json",
    ".artifacts/supply-chain/SCANNED-SBOM.sha256",
    ".artifacts/supply-chain/grype-report.json",
    ".artifacts/supply-chain/grype-report.sarif",
    ".artifacts/supply-chain/grype-report.txt",
    ".artifacts/supply-chain/grype-db-status.txt",
    ".artifacts/supply-chain/image-provenance.json",
    ".artifacts/supply-chain/syft-version.txt",
    ".artifacts/supply-chain/syft-config.effective.yaml",
    ".artifacts/supply-chain/grype-version.txt",
    ".artifacts/supply-chain/grype-config.effective.yaml",
    ".artifacts/supply-chain/docker-version.txt",
    ".artifacts/supply-chain/runtime-apk-inventory.actual",
    ".artifacts/supply-chain/runtime-image-config.actual.json",
    ".artifacts/supply-chain/runtime-package-inputs.prebuild.sha256",
    ".artifacts/supply-chain/SBOM-SHA256SUMS",
    ".artifacts/supply-chain/SHA256SUMS",
    ".artifacts/supply-chain/input-locks",
  ]);

  assert.ok(
    steps.indexOf(preScanArtifact) < steps.indexOf(reportStep),
    "SPDX/CycloneDX evidence must be retained before Grype can fail",
  );
  assert.ok(
    steps.indexOf(reportStep) < steps.indexOf(grypeGate) &&
      steps.indexOf(grypeGate) < steps.indexOf(evidenceValidationStep) &&
      steps.indexOf(evidenceValidationStep) < steps.indexOf(uploadSarif) &&
      steps.indexOf(uploadSarif) < steps.indexOf(finalArtifact),
    "the local vulnerability gate must execute before evidence validation, external upload, and retention",
  );
  assert.ok(
    programText.includes("autopilot.spdx.json") &&
      programText.includes("grype-report.sarif") &&
      programText.includes("sha256sum --check --strict SBOM-SHA256SUMS") &&
      programText.includes("sha256sum --check --strict SHA256SUMS"),
    "the executable workflow must create and self-verify both portable evidence manifests",
  );

  assertSyftPolicy(
    parseWorkflowSource(readText(".syft.yaml"), ".syft.yaml").value,
  );
  const policy = parseWorkflowSource(readText(".grype.yaml"), ".grype.yaml").value;
  exactKeys(policy, ["check-for-app-update", "db", "external-sources", "ignore"], ".grype.yaml");
  assert.equal(policy["check-for-app-update"], false);
  assert.deepEqual(objectValue(policy.db, ".grype.yaml.db"), {
    "auto-update": false,
    "validate-age": false,
    "require-update-check": false,
  });
  assert.deepEqual(objectValue(policy["external-sources"], ".grype.yaml.external-sources"), {
    enable: false,
  });
  assert.deepEqual(arrayValue(policy.ignore, ".grype.yaml.ignore"), [], "the CVE allowlist must remain empty");
});

test("SUPPLY 4B — Grype zero-ignore encodings are narrow and fail closed", () => {
  const hasNoIgnoredMatches = (grype: JsonObject) => {
    const ignoredMatches = Object.hasOwn(grype, "ignoredMatches") ? grype.ignoredMatches : [];
    return Array.isArray(ignoredMatches) && ignoredMatches.length === 0;
  };

  assert.equal(hasNoIgnoredMatches({ matches: [] }), true);
  assert.equal(hasNoIgnoredMatches({ matches: [], ignoredMatches: [] }), true);
  for (const malformed of [
    { matches: [], ignoredMatches: null },
    { matches: [], ignoredMatches: {} },
    { matches: [], ignoredMatches: "" },
    { matches: [], ignoredMatches: [{ vulnerability: "synthetic" }] },
  ]) {
    assert.equal(hasNoIgnoredMatches(malformed), false);
  }
});

test("SUPPLY adversarial — scanner binaries cannot be substituted around a self-derived hash", () => {
  const workflow = parseWorkflow("supply-chain.yml");
  const job = workflowJob(workflow, "image-sbom-vulnerability-gate");
  const installStep = stepById(job, "install_scanners", "supply-chain.yml job");
  assertScannerInstallStep(installStep);
  assert.equal(typeof installStep.run, "string");
  const run = installStep.run as string;
  const hashAnchor = 'SYFT_BINARY_SHA256="$(sha256sum "$TOOLS_DIR/syft/syft" | cut -d \' \' -f 1)"';
  assert.ok(run.includes(hashAnchor));

  const substituted = run.replace(
    hashAnchor,
    `cp -- /tmp/substitute "$TOOLS_DIR/syft/syft"\n${hashAnchor}`,
  );
  assert.throws(() =>
    assertScannerInstallStep({ ...installStep, run: substituted }, "substituted scanner install"),
  );

  const weakened = run.replace(
    'test "$SYFT_BINARY_SHA256" = "$EXPECTED_SYFT_BINARY_SHA256"',
    'test -n "$SYFT_BINARY_SHA256"',
  );
  assert.notEqual(weakened, run);
  assert.throws(() =>
    assertScannerInstallStep({ ...installStep, run: weakened }, "weakened scanner install"),
  );
});

test("SUPPLY adversarial — trusted Syft output cannot be overwritten after the scan", () => {
  const workflow = parseWorkflow("supply-chain.yml");
  const job = workflowJob(workflow, "image-sbom-vulnerability-gate");
  const sbomStep = stepByName(job, "Generate retained image SBOMs", "supply-chain.yml job");
  assert.equal(typeof sbomStep.run, "string");
  const validLines = executableLines(sbomStep.run, "valid SBOM generation fixture");
  assert.equal(validLines.length, SBOM_GENERATION_EXECUTABLE_LINES);
  assert.equal(sha256(validLines.join("\n")), SBOM_GENERATION_PROGRAM_SHA256);

  const outputAnchor = '--output "cyclonedx-json=$EVIDENCE_DIR/autopilot.cyclonedx.json"';
  const mutated = (sbomStep.run as string).replace(
    outputAnchor,
    `${outputAnchor}\nprintf 'substituted' > "$EVIDENCE_DIR/autopilot.syft.json"`,
  );
  assert.notEqual(mutated, sbomStep.run, "the post-scan overwrite mutation must take effect");
  const mutatedLines = executableLines(mutated, "post-scan overwrite fixture");
  assert.equal(mutatedLines.length, SBOM_GENERATION_EXECUTABLE_LINES + 1);
  assert.notEqual(sha256(mutatedLines.join("\n")), SBOM_GENERATION_PROGRAM_SHA256);
});

test("SUPPLY adversarial — Syft policy cannot filter or narrow the production inventory", () => {
  const valid: JsonObject = {
    "check-for-app-update": false,
    scope: "squashed",
    "default-catalogers": [],
    "select-catalogers": [],
    exclude: [],
  };
  assertSyftPolicy(valid, "valid Syft fixture");
  for (const mutated of [
    { ...valid, "check-for-app-update": true },
    { ...valid, scope: "all-layers" },
    { ...valid, "default-catalogers": ["apk-db-cataloger"] },
    { ...valid, "select-catalogers": ["-javascript-package-cataloger"] },
    { ...valid, exclude: ["/app/**"] },
    { ...valid, parallelism: 1 },
  ]) {
    assert.throws(() => assertSyftPolicy(mutated, "weakened Syft fixture"));
  }
  assert.throws(() =>
    parseWorkflowSource(
      "check-for-app-update: false\nscope: squashed\nexclude: []\nexclude: [/app/**]\n",
      "duplicate-exclude.yml",
    ),
  );
  const invocations = [
    `${SYFT_COMMAND} --config "${SYFT_POLICY_PATH}" config --load \\`,
    `${SYFT_COMMAND} --config "${SYFT_POLICY_PATH}" version \\`,
    `${SYFT_COMMAND} --config "${SYFT_POLICY_PATH}" scan "docker:$IMAGE" --scope squashed \\`,
  ];
  assertExplicitSyftInvocations(invocations, "valid Syft invocation fixture");
  assert.throws(() =>
    assertExplicitSyftInvocations(
      invocations.map((line) => line.replace(`${SYFT_COMMAND} `, "syft ")),
      "PATH-shadowed Syft fixture",
    ),
  );
  assert.throws(() =>
    assertExplicitSyftInvocations(
      invocations.map((line) => line.replace(`--config "${SYFT_POLICY_PATH}" `, "")),
      "auto-discovered config fixture",
    ),
  );
  assert.throws(() =>
    assertExplicitSyftInvocations(
      invocations.map((line) =>
        line.includes(" scan ") ? line.replace(" --scope squashed", " --exclude /app --scope squashed") : line,
      ),
      "excluded catalog fixture",
    ),
  );
});

test("SUPPLY adversarial — quoted uses are validated and YAML comments are not executable evidence", () => {
  const quoted = parseWorkflowSource(
    `jobs:
  test:
    steps:
      - "uses": actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
`,
    "quoted-approved.yml",
  );
  assert.equal(quoted.actionUses.length, 1);
  assert.equal(validateActionUse(quoted.actionUses[0]!), "actions/checkout");

  const unapproved = parseWorkflowSource(
    `jobs:
  test:
    steps:
      - "uses": attacker/example@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # v1.0.0
`,
    "quoted-unapproved.yml",
  );
  assert.throws(() => validateActionUse(unapproved.actionUses[0]!));

  const commentOnly = parseWorkflowSource(
    `jobs:
  test:
    steps:
      # uses: attacker/example@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # v1.0.0
      - run: echo safe
`,
    "comment-only.yml",
  );
  assert.deepEqual(commentOnly.actionUses, []);
});

test("SUPPLY adversarial — ambiguous YAML, aliases, complex keys, and quoted weakening keys fail closed", () => {
  assert.throws(() =>
    parseWorkflowSource(
      `jobs:
  test:
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5
        "uses": actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5
`,
      "duplicate-key.yml",
    ),
  );
  assert.throws(() =>
    parseWorkflowSource(
      `shared: &shared
  run: echo unsafe
jobs:
  test:
    steps:
      - *shared
`,
      "alias.yml",
    ),
  );
  assert.throws(() =>
    parseWorkflowSource(
      `? [uses]
: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5
`,
      "complex-key.yml",
    ),
  );
  assert.throws(() =>
    parseWorkflowSource(
      `jobs:
  test:
    steps:
      - run: echo bypass
        "continue-on-error": true
`,
      "quoted-continue-on-error.yml",
    ),
  );
});

test("SUPPLY adversarial — gate commands cannot be skipped, commented out, or weakened", () => {
  assertCodeqlFullSourceEnvironment(
    { CODEQL_ACTION_DIFF_INFORMED_QUERIES: "false" },
    "valid full-source CodeQL fixture",
  );
  assert.throws(() =>
    assertCodeqlFullSourceEnvironment(
      { CODEQL_ACTION_DIFF_INFORMED_QUERIES: "true" },
      "diff-informed CodeQL fixture",
    ),
  );
  assert.throws(() =>
    assertCodeqlFullSourceEnvironment({}, "missing full-source CodeQL fixture"),
  );
  assert.throws(() =>
    assertCodeqlFullSourceEnvironment(
      {
        CODEQL_ACTION_DIFF_INFORMED_QUERIES: "false",
        CODEQL_ACTION_INCREMENTAL_MODE: "true",
      },
      "unexpected CodeQL feature override fixture",
    ),
  );

  const codeqlGate: JsonObject = {
    name: "Gate CodeQL high and critical SARIF results",
    id: "codeql_severity_gate",
    env: { CODEQL_RAW_SARIF: "${{ steps.analyze.outputs.sarif-output }}" },
    run: CODEQL_GATE_LINES.join("\n"),
  };
  assertCodeqlGateStep(codeqlGate, "valid CodeQL fixture");
  assert.throws(() => assertCodeqlGateStep({ ...codeqlGate, if: false }, "if:false fixture"));
  assert.throws(() =>
    assertCodeqlGateStep(
      { ...codeqlGate, run: `${CODEQL_GATE_LINES.map((line) => `# ${line}`).join("\n")}\necho bypass` },
      "comment-decoy fixture",
    ),
  );
  assert.throws(() =>
    assertCodeqlGateStep(
      { ...codeqlGate, run: `${CODEQL_GATE_LINES.join("\n")} || true` },
      "shell-bypass fixture",
    ),
  );
  assert.throws(() =>
    assertCodeqlGateStep(
      { ...codeqlGate, run: CODEQL_GATE_LINES.join("\n").replace("--threshold 7.0", "--threshold 9.0") },
      "threshold-drift fixture",
    ),
  );

  const grypeGate: JsonObject = {
    name: "Gate every high or critical finding (no current allowlist)",
    id: "grype_high_critical_gate",
    env: {
      EXPECTED_SYFT_SHA256: "${{ steps.seal_sbom.outputs.syft_sha256 }}",
      EXPECTED_GRYPE_BINARY_SHA256: "${{ env.EXPECTED_GRYPE_BINARY_SHA256 }}",
    },
    shell: "bash",
    run: GRYPE_GATE_LINES.join("\n"),
  };
  assertGrypeGateStep(grypeGate, "valid Grype fixture");
  assert.throws(() =>
    assertGrypeGateStep(
      { ...grypeGate, run: GRYPE_GATE_LINES.join("\n").replace("--fail-on high", "--fail-on critical") },
      "critical-only fixture",
    ),
  );
  assert.throws(() =>
    assertGrypeGateStep(
      { ...grypeGate, env: { ...objectValue(grypeGate.env, "fixture env"), GRYPE_ONLY_FIXED: "true" } },
      "environment-filter fixture",
    ),
  );

  assert.throws(() => stepById({ steps: [] }, "codeql_severity_gate", "missing gate fixture"));
  assert.throws(() =>
    stepById(
      { steps: [{ id: "codeql_severity_gate" }, { id: "codeql_severity_gate" }] },
      "codeql_severity_gate",
      "duplicate gate fixture",
    ),
  );
});

test("SUPPLY adversarial — runtime PDF and APK-audit evidence cannot be broadened additively", () => {
  const workflow = parseWorkflow("supply-chain.yml");
  const job = workflowJob(workflow, "image-sbom-vulnerability-gate");
  const runtimeStep = stepByName(
    job,
    "Exercise the constrained production runtime",
    "supply-chain.yml job",
  );
  assert.equal(typeof runtimeStep.run, "string");
  const source = runtimeStep.run as string;
  assert.doesNotThrow(() => assertRuntimeCanaryInnerContract(source, "valid runtime canary fixture"));

  const mutations = [
    source.replace(
      "test ! -s /tmp/pdftoppm.stderr",
      ": > /tmp/pdftoppm.stderr\n              test ! -s /tmp/pdftoppm.stderr",
    ),
    source.replace(
      'printf "%s\\n" "m proc/" "m sys/" "m tmp/" > /tmp/apk-audit.expected-runtime-mounts',
      'printf "%s\\n" "m proc/" "m sys/" "m tmp/" > /tmp/apk-audit.expected-runtime-mounts\n' +
        '              printf "%s\\n" "m etc/" >> /tmp/apk-audit.expected-runtime-mounts',
    ),
  ];
  for (const mutated of mutations) {
    assert.notEqual(mutated, source, "the adversarial runtime-canary mutation must take effect");
    assert.throws(() =>
      assertRuntimeCanaryInnerContract(mutated, "additively weakened runtime canary fixture"),
    );
  }
});

test("SUPPLY adversarial — outer runtime canary control flow cannot bypass execution", () => {
  const workflow = parseWorkflow("supply-chain.yml");
  const job = workflowJob(workflow, "image-sbom-vulnerability-gate");
  const runtimeStep = stepByName(
    job,
    "Exercise the constrained production runtime",
    "supply-chain.yml job",
  );
  assert.equal(typeof runtimeStep.run, "string");
  const source = runtimeStep.run as string;
  assert.doesNotThrow(() => assertRuntimeCanaryStepContract(source, "valid outer canary fixture"));

  const pipeline = `' | tee "$EVIDENCE_DIR/runtime-apk-inventory.actual"`;
  const falseWrappedCanary = source
    .replace("docker run --rm \\", "if false; then\n          docker run --rm \\")
    .replace(pipeline, `${pipeline}\n          fi`);
  const mutations = [
    source.replace("set -euo pipefail", "set -euo pipefail\n          exit 0"),
    source.replace(pipeline, `${pipeline} || true`),
    falseWrappedCanary,
  ];
  for (const mutated of mutations) {
    assert.notEqual(mutated, source, "the adversarial outer-canary mutation must take effect");
    assert.throws(() =>
      assertRuntimeCanaryStepContract(mutated, "control-flow-weakened outer canary fixture"),
    );
  }
});

test("SUPPLY adversarial — Docker parser directives cannot replace the reviewed frontend", () => {
  for (const directive of [
    "# syntax=attacker.example/frontend:latest",
    "# escape=`",
    "# check=skip=all",
    "  # SyNtAx = attacker.example/frontend@sha256:deadbeef  ",
    "# future-parser-control=value",
  ]) {
    assert.throws(
      () => dockerInstructions(`${directive}\nFROM scratch AS runtime\n`),
      /Docker parser directives are forbidden/,
    );
  }
  assert.doesNotThrow(() =>
    dockerInstructions("# ordinary explanatory comment\nFROM scratch AS runtime\n"),
  );
});

test("SUPPLY adversarial — runtime config and the complete install program cannot drift", () => {
  const source = readText("Dockerfile");
  const mutations = [
    source.replaceAll("WORKDIR /app", "WORKDIR /usr/bin"),
    source.replace("USER 1000:1000", "USER 0:0"),
    source.replace(
      'CMD ["node", "dist/src/server.js"]',
      'CMD ["node", "-e", "process.exit(0)"]',
    ),
    source.replace(
      "rm -rf /tmp/runtime-apk-lock",
      "rm -rf /tmp/runtime-apk-lock; touch /etc/untracked-trust-anchor",
    ),
  ];
  for (const mutated of mutations) {
    assert.notEqual(mutated, source, "the adversarial Dockerfile mutation fixture must take effect");
    assert.throws(() =>
      assertRuntimeStageContract(dockerStage(dockerInstructions(mutated), "runtime")),
    );
  }
});

test("SUPPLY adversarial — builder output and the networked APK resolver cannot drift", () => {
  const source = readText("Dockerfile");
  const manifest = JSON.parse(readText("package.json")) as JsonObject;
  const scripts = objectValue(manifest.scripts, "package.json.scripts");
  assert.throws(() =>
    assertPackageBuildContract({ ...manifest, scripts: { ...scripts, build: "tsc && node tamper.js" } }),
  );
  assert.throws(() =>
    assertPackageBuildContract({ ...manifest, scripts: { ...scripts, postbuild: "node tamper.js" } }),
  );
  const cases: Array<{
    mutated: string;
    stage: "build" | "runtime-apk-archives";
    assertContract: (instructions: DockerInstruction[]) => void;
  }> = [
    {
      mutated: source.replace("RUN npm ci --ignore-scripts", "RUN npm install --ignore-scripts"),
      stage: "build",
      assertContract: assertBuildStageContract,
    },
    {
      mutated: source.replace(
        "    && npm cache clean --force",
        "    && npm cache clean --force\nRUN printf tampered > /app/dist/src/server.js",
      ),
      stage: "build",
      assertContract: assertBuildStageContract,
    },
    {
      mutated: source.replace(
        "apk fetch --no-cache --output /tmp/runtime-apks $(cat package-names); \\",
        "echo resolver-tamper; \\\n    apk fetch --no-cache --output /tmp/runtime-apks $(cat package-names); \\",
      ),
      stage: "runtime-apk-archives",
      assertContract: assertArchiveStageContract,
    },
    {
      mutated: source.replace(
        "WORKDIR /tmp/runtime-apk-lock",
        "WORKDIR /tmp/unreviewed-resolver",
      ),
      stage: "runtime-apk-archives",
      assertContract: assertArchiveStageContract,
    },
  ];
  for (const fixture of cases) {
    assert.notEqual(fixture.mutated, source, "the adversarial build-stage mutation must take effect");
    assert.throws(() =>
      fixture.assertContract(dockerStage(dockerInstructions(fixture.mutated), fixture.stage)),
    );
  }
});

test("SUPPLY 5 — documentation preserves the exact security claim boundaries", () => {
  const supplyChain = readText("docs/SUPPLY_CHAIN.md");
  const security = readText("SECURITY.md");
  const claims = readText("docs/CLAIM_EVIDENCE_MATRIX.md");
  for (const text of [supplyChain, security, claims]) {
    assert.match(text, /as of 2026-07-15/i, "the vulnerability result must be dated to its DB snapshot");
    assert.match(text, /not (?:a )?security certification/i);
    assert.match(text, /high\/critical/i);
  }
  const normalized = supplyChain.replace(/[*_`]/g, "").replace(/\s+/g, " ");
  assert.match(normalized, /SPDX 2\.3/);
  assert.match(normalized, /CycloneDX JSON/);
  assert.match(normalized, /SARIF 2\.1\.0/);
  assert.match(normalized, /no current (?:CVE )?allowlist/i);
});

test("SUPPLY 6 — security-critical files have explicit review routing without an enforcement claim", () => {
  const codeowners = readText(".github/CODEOWNERS")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  assert.deepEqual(codeowners, [
    "/.github/CODEOWNERS @upgradedev",
    "/.gitattributes @upgradedev",
    "/.dockerignore @upgradedev",
    "/Dockerfile @upgradedev",
    "/.github/workflows/ci.yml @upgradedev",
    "/.github/workflows/codeql.yml @upgradedev",
    "/.github/workflows/supply-chain.yml @upgradedev",
    "/.syft.yaml @upgradedev",
    "/.grype.yaml @upgradedev",
    "/package.json @upgradedev",
    "/package-lock.json @upgradedev",
    "/runtime-packages.lock @upgradedev",
    "/runtime-apk-inventory.lock @upgradedev",
    "/runtime-apk-archives.sha256 @upgradedev",
    "/scripts/codeql-sarif-gate.ts @upgradedev",
    "/tests/security/codeql-sarif-gate.test.ts @upgradedev",
    "/tests/docs/docs-consistency.test.ts @upgradedev",
    "/tests/docs/supply-chain-consistency.test.ts @upgradedev",
    "/README.md @upgradedev",
    "/SECURITY.md @upgradedev",
    "/docs/CLAIM_EVIDENCE_MATRIX.md @upgradedev",
    "/docs/JUDGE-GUIDE.md @upgradedev",
    "/docs/SUPPLY_CHAIN.md @upgradedev",
    "/deploy/redeploy.sh @upgradedev",
  ]);
  const supplyChain = readText("docs/SUPPLY_CHAIN.md");
  assert.match(supplyChain, /review-routing evidence/i);
  assert.match(supplyChain, /not a claim that GitHub branch protection currently enforces approval/i);
});
