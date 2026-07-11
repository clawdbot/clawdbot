// Covers policy selection layered on the strict normalized release evidence
// produced by release-ci-summary.mjs. Topology validation belongs there.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = join(process.cwd(), "scripts/github/find-reusable-release-validation.sh");
const tempDirs = createTempDirTracker();

const REPOSITORY = "openclaw/openclaw";
const PRODUCER_SHA = "0".repeat(40);
const VERIFIER_SHA = "c".repeat(40);
const DEFAULT_INPUTS = {
  provider: "openai",
  mode: "both",
  targetContextRef: "",
  liveSuiteFilter: "",
  crossOsSuiteFilter: "",
  releasePackageSpec: "",
  packageAcceptancePackageSpec: "",
  codexPluginSpec: "",
};

interface ParentTuple {
  artifact: {
    digest: string;
    id: string;
    name: string;
    runAttempt: number;
    sizeInBytes: number;
  };
  conclusion: string;
  manifest: Record<string, unknown>;
  manifestVersion: number;
  runAttempt: number;
  runId: string;
  status: string;
  targetSha: string;
  url: string;
  producerOnTrustedMainLineage: boolean;
  workflowFullRef: string;
  workflowPath: string;
  workflowQualifiedPath: string;
  workflowRef: string;
  workflowRefProof: string;
  workflowRefType: string;
  workflowRunPath: string;
  workflowSha: string;
}

interface ChildTuple {
  conclusion: string;
  dispatchNonce: string;
  displayTitle: string;
  event: string;
  headBranch: string;
  parentJobId: string;
  path: string;
  reportPublication?: string;
  role: string;
  runAttempt: number;
  runId: string;
  sourceParentAttempt: number;
  sourceParentRunId: string;
  status: string;
  url: string;
  workflowSha: string;
}

interface NormalizedEvidence {
  children: ChildTuple[];
  conclusions: {
    allRequiredSucceeded: boolean;
    children: Record<string, string>;
    current: string;
    root: string;
  };
  controls: Record<string, unknown>;
  current: ParentTuple;
  directRoot: boolean;
  evidenceReuse: Record<string, unknown> | null;
  manifest: Record<string, unknown>;
  releaseProfile: string;
  repository: string;
  rerunGroup: string;
  root: ParentTuple;
  runReleaseSoak: boolean;
  schema: string;
  producerOnTrustedMainLineage: boolean;
  trustedWorkflowFullRef: string;
  trustedWorkflowRef: string;
  valid: boolean;
  validationInputs: Record<string, string> | null;
  verifier: {
    schemaVersion: number;
    script: string;
    scriptSha256: string;
    sourceSha: string | null;
  };
}

interface RunFixture {
  exitCode?: number;
  record?: NormalizedEvidence;
  runId: string;
}

afterEach(() => {
  tempDirs.cleanup();
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commitFile(repo: string, filePath: string, content: string, message: string): string {
  writeFileSync(join(repo, filePath), content);
  git(repo, ["add", filePath]);
  git(repo, ["-c", "commit.gpgSign=false", "commit", "-qm", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function plistFor(shortVersion: string, buildVersion: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    "<dict>",
    "    <key>CFBundleShortVersionString</key>",
    `    <string>${shortVersion}</string>`,
    "    <key>CFBundleVersion</key>",
    `    <string>${buildVersion}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function createRepo(options: { plistBuildVersion?: string } = {}) {
  const origin = tempDirs.make("evidence-reuse-origin-");
  git(origin, ["init", "-q", "-b", "main"]);
  git(origin, ["config", "user.email", "test-user@example.invalid"]);
  git(origin, ["config", "user.name", "Test User"]);
  git(origin, ["config", "uploadpack.allowReachableSHA1InWant", "true"]);
  writeFileSync(
    join(origin, "package.json"),
    `${JSON.stringify({ name: "x", version: "2026.7.1" }, null, 2)}\n`,
  );
  mkdirSync(join(origin, "apps/macos/Sources/OpenClaw/Resources"), { recursive: true });
  writeFileSync(
    join(origin, "apps/macos/Sources/OpenClaw/Resources/Info.plist"),
    plistFor("2026.7.1", options.plistBuildVersion ?? "2026070100"),
  );
  mkdirSync(join(origin, "docs/install"), { recursive: true });
  writeFileSync(join(origin, "docs/install/updating.md"), "# Updating\n");
  writeFileSync(join(origin, "CHANGELOG.md"), "# Changelog\n");
  writeFileSync(join(origin, "index.ts"), "export const value = 1;\n");
  git(origin, ["add", "-A"]);
  git(origin, ["-c", "commit.gpgSign=false", "commit", "-qm", "seed"]);
  return { origin, priorSha: git(origin, ["rev-parse", "HEAD"]) };
}

function cloneHead(origin: string): string {
  const clone = tempDirs.make("evidence-reuse-clone-");
  execFileSync("git", ["clone", "-q", "--depth=1", origin, clone], { encoding: "utf8" });
  return clone;
}

function normalizedEvidence(options: {
  producerSha?: string;
  releaseProfile?: string;
  runId?: string;
  soak?: boolean;
  targetSha: string;
  validationInputs?: Record<string, string> | null;
  verifierSha?: string | null;
  workflowRef?: string;
}): NormalizedEvidence {
  const runId = options.runId ?? "111";
  const producerSha = options.producerSha ?? PRODUCER_SHA;
  const releaseProfile = options.releaseProfile ?? "full";
  const soak = options.soak ?? true;
  const workflowRef = options.workflowRef ?? "main";
  const workflowFullRef = `refs/heads/${workflowRef}`;
  const shaPinned = workflowRef.startsWith("release-ci/");
  const validationInputs =
    options.validationInputs === undefined ? DEFAULT_INPUTS : options.validationInputs;
  const manifest = {
    version: shaPinned ? 3 : 2,
    workflowName: "Full Release Validation",
    workflowRef,
    workflowSha: producerSha,
    workflowFullRef,
    workflowRefType: "branch",
    runId,
    runAttempt: "2",
    targetRef: "release/2026.7.1",
    targetSha: options.targetSha,
    rerunGroup: "all",
    releaseProfile,
    runReleaseSoak: String(soak),
    validationInputs,
    controls: {
      performanceBlocking: true,
      performanceReportPublication: "artifact-only",
      stableSoakRequired: releaseProfile === "stable" || releaseProfile === "full",
    },
    childRuns: {
      normalCi: "201",
      npmTelegram: "",
      pluginPrerelease: "202",
      releaseChecks: "203",
      productPerformance: {
        blocking: true,
        conclusion: "success",
        runId: "204",
      },
    },
  };
  const root: ParentTuple = {
    artifact: {
      digest: `sha256:${"a".repeat(64)}`,
      id: "9001",
      name: `full-release-validation-${runId}-2`,
      runAttempt: 2,
      sizeInBytes: 4096,
    },
    conclusion: "success",
    manifest,
    manifestVersion: shaPinned ? 3 : 2,
    runAttempt: 2,
    runId,
    status: "completed",
    targetSha: options.targetSha,
    url: `https://example.test/runs/${runId}`,
    producerOnTrustedMainLineage: true,
    workflowFullRef,
    workflowPath: ".github/workflows/full-release-validation.yml",
    workflowQualifiedPath: `.github/workflows/full-release-validation.yml@${workflowFullRef}`,
    workflowRef,
    workflowRefProof: shaPinned
      ? "manifest-v3-sha-pinned-main-ancestry"
      : "legacy-v2-main-ancestry",
    workflowRefType: "branch",
    workflowRunPath: shaPinned
      ? `.github/workflows/full-release-validation.yml@${workflowFullRef}`
      : ".github/workflows/full-release-validation.yml",
    workflowSha: producerSha,
  };
  const roles = [
    ["normalCi", "201", 1, 1, "CI", "ci.yml", "-ci"],
    [
      "pluginPrerelease",
      "202",
      2,
      1,
      "Plugin Prerelease",
      "plugin-prerelease.yml",
      "-plugin-prerelease",
    ],
    [
      "releaseChecks",
      "203",
      1,
      2,
      "OpenClaw Release Checks",
      "openclaw-release-checks.yml",
      "-release-checks",
    ],
    ["productPerformance", "204", 3, 2, "OpenClaw Performance", "openclaw-performance.yml", ""],
  ] as const;
  const children = roles.map(
    ([role, childRunId, runAttempt, sourceParentAttempt, name, workflow, suffix]) => ({
      conclusion: "success",
      dispatchNonce: `full-release-validation-${runId}-${sourceParentAttempt}${suffix}`,
      displayTitle: `${name} full-release-validation-${runId}-${sourceParentAttempt}${suffix}`,
      event: "workflow_dispatch",
      headBranch: workflowRef,
      parentJobId: `job-${role}`,
      path: `.github/workflows/${workflow}`,
      role,
      runAttempt,
      runId: childRunId,
      sourceParentAttempt,
      sourceParentRunId: runId,
      status: "completed",
      url: `https://example.test/runs/${childRunId}`,
      workflowSha: producerSha,
      ...(role === "productPerformance" ? { reportPublication: "artifact-only" } : {}),
    }),
  );
  return {
    children,
    conclusions: {
      allRequiredSucceeded: true,
      children: Object.fromEntries(children.map((child) => [child.role, child.conclusion])),
      current: "success",
      root: "success",
    },
    controls: {
      performanceReportPublication: "artifact-only",
    },
    current: structuredClone(root),
    directRoot: true,
    evidenceReuse: null,
    manifest,
    releaseProfile,
    repository: REPOSITORY,
    rerunGroup: "all",
    root,
    runReleaseSoak: soak,
    schema: "openclaw.release-validation-evidence/v3",
    producerOnTrustedMainLineage: true,
    trustedWorkflowFullRef: "refs/heads/main",
    trustedWorkflowRef: "main",
    valid: true,
    validationInputs,
    verifier: {
      schemaVersion: 3,
      script: "scripts/release-ci-summary.mjs",
      scriptSha256: "b".repeat(64),
      sourceSha: options.verifierSha === undefined ? VERIFIER_SHA : options.verifierSha,
    },
  };
}

const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
[[ "\${1:-}" == "api" ]] || { echo "unexpected gh command: $*" >&2; exit 1; }
shift
jq_expr=""
endpoint=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -X|-F) shift 2 ;;
    --jq) jq_expr="$2"; shift 2 ;;
    *) [[ -n "$endpoint" ]] || endpoint="$1"; shift ;;
  esac
done
fixture="\${FAKE_GH_FIXTURES}/$(printf '%s' "$endpoint" | tr '/?' '__')"
[[ -f "\${fixture}.json" ]] || { echo "no fixture for $endpoint" >&2; exit 1; }
if [[ -n "$jq_expr" ]]; then
  exec jq -r "$jq_expr" "\${fixture}.json"
fi
exec cat "\${fixture}.json"
`;

const FAKE_VALIDATOR = `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

const runIndex = process.argv.indexOf("--validate-run");
const repoIndex = process.argv.indexOf("--repo");
const trustedRefIndex = process.argv.indexOf("--trusted-workflow-ref");
if (
  runIndex < 0 ||
  repoIndex < 0 ||
  trustedRefIndex < 0 ||
  process.argv[repoIndex + 1] !== "openclaw/openclaw" ||
  process.argv[trustedRefIndex + 1] !== "main"
) {
  console.error("validator invocation contract mismatch");
  process.exit(2);
}
const fixture = JSON.parse(
  readFileSync(join(process.env.FAKE_VALIDATOR_FIXTURES, \`\${process.argv[runIndex + 1]}.json\`), "utf8"),
);
if (fixture.exitCode) {
  console.error("fixture validator rejection");
  process.exit(fixture.exitCode);
}
process.stdout.write(\`\${JSON.stringify(fixture.record)}\\n\`);
`;

function fixtureName(fixtures: string, endpoint: string): string {
  return join(fixtures, `${endpoint.replaceAll(/[/?]/gu, "_")}.json`);
}

function setUpFixtures(runs: RunFixture[]): {
  binDir: string;
  fixtures: string;
  validatorPath: string;
} {
  const root = tempDirs.make("evidence-reuse-fixtures-");
  const fixtures = join(root, "fixtures");
  const binDir = join(root, "bin");
  mkdirSync(fixtures, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "gh"), FAKE_GH);
  chmodSync(join(binDir, "gh"), 0o755);
  const validatorPath = join(root, "validator.mjs");
  writeFileSync(validatorPath, FAKE_VALIDATOR);

  writeFileSync(
    fixtureName(
      fixtures,
      "repos/openclaw/openclaw/actions/workflows/full-release-validation.yml/runs",
    ),
    JSON.stringify({ workflow_runs: runs.map(({ runId }) => ({ id: Number(runId) })) }),
  );
  for (const run of runs) {
    writeFileSync(
      join(fixtures, `${run.runId}.json`),
      JSON.stringify({ exitCode: run.exitCode ?? 0, record: run.record }),
    );
  }
  return { binDir, fixtures, validatorPath };
}

function runResolver(args: {
  binDir: string;
  fixtures: string;
  inputs?: unknown;
  releaseProfile?: string;
  repoDir: string;
  runReleaseSoak?: string;
  targetSha: string;
  validatorPath: string;
  verifierOnMain?: boolean;
  verifierSha?: string;
  workflowRef?: string;
}) {
  const verifierSha = args.verifierSha ?? VERIFIER_SHA;
  writeFileSync(
    fixtureName(args.fixtures, `repos/${REPOSITORY}/compare/${verifierSha}...main`),
    JSON.stringify({
      merge_base_commit: { sha: args.verifierOnMain === false ? "f".repeat(40) : verifierSha },
      status: args.verifierOnMain === false ? "diverged" : "ahead",
    }),
  );
  return spawnSync(
    "bash",
    [
      SCRIPT_PATH,
      "--target-sha",
      args.targetSha,
      "--workflow-sha",
      verifierSha,
      "--workflow-ref",
      args.workflowRef ?? "main",
      "--release-profile",
      args.releaseProfile ?? "full",
      "--run-release-soak",
      args.runReleaseSoak ?? "true",
      "--inputs-json",
      JSON.stringify(args.inputs === undefined ? DEFAULT_INPUTS : args.inputs),
      "--repo",
      REPOSITORY,
      "--repo-dir",
      args.repoDir,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_GH_FIXTURES: args.fixtures,
        FAKE_VALIDATOR_FIXTURES: args.fixtures,
        GITHUB_OUTPUT: "",
        OPENCLAW_RELEASE_CI_SUMMARY_VALIDATOR: args.validatorPath,
        PATH: `${args.binDir}:${process.env.PATH}`,
      },
    },
  );
}

function parseOutput(output: string): Record<string, string> {
  return Object.fromEntries(
    output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

describe("scripts/github/find-reusable-release-validation.sh", () => {
  it("reuses strict direct-root evidence produced by a canonical SHA-pinned run", () => {
    const { origin, priorSha } = createRepo();
    const clone = cloneHead(origin);
    const producerSha = "d".repeat(40);
    const producerRef = `release-ci/${producerSha.slice(0, 12)}-122`;
    const record = normalizedEvidence({
      producerSha,
      targetSha: priorSha,
      workflowRef: producerRef,
    });
    const { binDir, fixtures, validatorPath } = setUpFixtures([{ record, runId: "111" }]);

    const result = runResolver({
      binDir,
      fixtures,
      repoDir: clone,
      targetSha: priorSha,
      validatorPath,
      workflowRef: `release-ci/${VERIFIER_SHA.slice(0, 12)}-123`,
    });

    expect(result.status).toBe(0);
    expect(parseOutput(result.stdout)).toMatchObject({
      evidence_run_id: "111",
      reuse: "true",
    });
  });

  it("rejects noncanonical release refs and workflow SHAs outside trusted main", () => {
    const { origin, priorSha } = createRepo();
    const clone = cloneHead(origin);
    const record = normalizedEvidence({ targetSha: priorSha });
    const { binDir, fixtures, validatorPath } = setUpFixtures([{ record, runId: "111" }]);

    const forgedRef = runResolver({
      binDir,
      fixtures,
      repoDir: clone,
      targetSha: priorSha,
      validatorPath,
      workflowRef: "release-ci/not-trusted",
    });
    expect(parseOutput(forgedRef.stdout)).toMatchObject({ reuse: "false" });

    const untrustedSha = runResolver({
      binDir,
      fixtures,
      repoDir: clone,
      targetSha: priorSha,
      validatorPath,
      verifierOnMain: false,
      workflowRef: `release-ci/${VERIFIER_SHA.slice(0, 12)}-123`,
    });
    expect(parseOutput(untrustedSha.stdout)).toMatchObject({ reuse: "false" });
  });

  it("reuses pre-tooling trusted-main evidence for the exact target", () => {
    const { origin, priorSha } = createRepo();
    const clone = cloneHead(origin);
    const record = normalizedEvidence({ targetSha: priorSha });
    const { binDir, fixtures, validatorPath } = setUpFixtures([{ record, runId: "111" }]);

    const result = runResolver({
      binDir,
      fixtures,
      repoDir: clone,
      targetSha: priorSha,
      validatorPath,
    });

    expect(result.status).toBe(0);
    expect(record.root.workflowSha).not.toBe(record.root.targetSha);
    expect(record.verifier.sourceSha).not.toBe(record.root.workflowSha);
    expect(new Set(record.children.map((child) => child.sourceParentAttempt)).size).toBe(2);
    const output = parseOutput(result.stdout);
    expect(output).toMatchObject({
      changed_path_count: "0",
      evidence_root_run_id: "111",
      evidence_run_id: "111",
      evidence_sha: priorSha,
      reuse: "true",
    });
    expect(JSON.parse(output.changed_paths ?? "null")).toEqual([]);
    expect(JSON.parse(output.evidence_manifest ?? "{}")).toMatchObject({ targetSha: priorSha });
  });

  it("accepts exact-target trusted-main evidence without a compare request", () => {
    const { origin, priorSha } = createRepo();
    const clone = cloneHead(origin);
    const record = normalizedEvidence({
      producerSha: priorSha,
      targetSha: priorSha,
      verifierSha: priorSha,
    });
    const { binDir, fixtures, validatorPath } = setUpFixtures([{ record, runId: "111" }]);

    const result = runResolver({
      binDir,
      fixtures,
      repoDir: clone,
      targetSha: priorSha,
      validatorPath,
      verifierSha: priorSha,
    });

    expect(result.status).toBe(0);
    expect(parseOutput(result.stdout)).toMatchObject({
      changed_path_count: "0",
      changed_paths: "[]",
      reuse: "true",
    });
  });

  it.each([
    ["beta", "beta"],
    ["stable", "stable"],
    ["full", "full"],
  ] as const)("accepts exact profile identity %s -> %s", (priorProfile, requestedProfile) => {
    const { origin, priorSha } = createRepo();
    const clone = cloneHead(origin);
    const record = normalizedEvidence({
      releaseProfile: priorProfile,
      targetSha: priorSha,
    });
    const { binDir, fixtures, validatorPath } = setUpFixtures([{ record, runId: "111" }]);

    const result = runResolver({
      binDir,
      fixtures,
      releaseProfile: requestedProfile,
      repoDir: clone,
      targetSha: priorSha,
      validatorPath,
    });

    expect(result.status).toBe(0);
    expect(parseOutput(result.stdout)).toMatchObject({ reuse: "true" });
  });

  it("skips validator rejection and selects the next strict record", () => {
    const { origin, priorSha } = createRepo();
    const clone = cloneHead(origin);
    const record = normalizedEvidence({ runId: "111", targetSha: priorSha });
    const { binDir, fixtures, validatorPath } = setUpFixtures([
      { exitCode: 1, runId: "222" },
      { record, runId: "111" },
    ]);

    const result = runResolver({
      binDir,
      fixtures,
      repoDir: clone,
      targetSha: priorSha,
      validatorPath,
    });

    expect(result.status).toBe(0);
    expect(parseOutput(result.stdout)).toMatchObject({ evidence_run_id: "111", reuse: "true" });
    expect(result.stderr).toContain("run 222: shared evidence validator rejected the run");
  });

  it.each([
    {
      label: "reused wrapper",
      mutate(record: NormalizedEvidence) {
        record.directRoot = false;
        record.evidenceReuse = { rootRunId: "42" };
      },
    },
    {
      label: "untrusted producer ref",
      mutate(record: NormalizedEvidence) {
        record.trustedWorkflowRef = "release/2026.7.1";
      },
    },
    {
      label: "missing trusted-main lineage proof",
      mutate(record: NormalizedEvidence) {
        record.producerOnTrustedMainLineage = false;
      },
    },
    {
      label: "tag-qualified producer workflow",
      mutate(record: NormalizedEvidence) {
        record.root.workflowFullRef = "refs/tags/main";
        record.current.workflowFullRef = "refs/tags/main";
      },
    },
    {
      label: "verifier source drift",
      mutate(record: NormalizedEvidence) {
        record.verifier.sourceSha = "d".repeat(40);
      },
    },
    {
      label: "non-full rerun group",
      mutate(record: NormalizedEvidence) {
        record.rerunGroup = "package";
      },
    },
    {
      label: "publishing performance reports",
      mutate(record: NormalizedEvidence) {
        record.controls.performanceReportPublication = "publish";
      },
    },
    {
      label: "missing performance report publication proof",
      mutate(record: NormalizedEvidence) {
        const performance = record.children.find((child) => child.role === "productPerformance");
        if (!performance) {
          throw new Error("missing product performance child");
        }
        delete performance.reportPublication;
      },
    },
    {
      label: "missing required role",
      mutate(record: NormalizedEvidence) {
        record.children.pop();
      },
    },
    {
      label: "duplicate child run id",
      mutate(record: NormalizedEvidence) {
        record.children[1].runId = record.children[0].runId;
      },
    },
    {
      label: "failed child",
      mutate(record: NormalizedEvidence) {
        record.children[0].conclusion = "failure";
      },
    },
    {
      label: "extra child role",
      mutate(record: NormalizedEvidence) {
        record.children.push({
          ...record.children[0],
          role: "npmTelegram",
          runId: "205",
        });
      },
    },
    {
      label: "invalid root artifact digest",
      mutate(record: NormalizedEvidence) {
        record.root.artifact.digest = "sha256:not-a-digest";
        record.current.artifact.digest = "sha256:not-a-digest";
      },
    },
  ])("rejects normalized evidence that is not reusable: $label", ({ mutate }) => {
    const { origin, priorSha } = createRepo();
    const clone = cloneHead(origin);
    const record = normalizedEvidence({ targetSha: priorSha });
    mutate(record);
    const { binDir, fixtures, validatorPath } = setUpFixtures([{ record, runId: "111" }]);

    const result = runResolver({
      binDir,
      fixtures,
      repoDir: clone,
      targetSha: priorSha,
      validatorPath,
    });

    expect(result.status).toBe(0);
    expect(parseOutput(result.stdout)).toMatchObject({ reuse: "false" });
    expect(result.stderr).toContain("not a strict direct-root full validation");
  });

  it.each([
    {
      expected: "profile beta differs from stable",
      label: "beta evidence for stable",
      recordOptions: { releaseProfile: "beta" },
      resolverOptions: { releaseProfile: "stable" },
    },
    {
      expected: "profile beta differs from full",
      label: "beta evidence for full",
      recordOptions: { releaseProfile: "beta" },
      resolverOptions: { releaseProfile: "full" },
    },
    {
      expected: "profile stable differs from beta",
      label: "stable evidence for beta",
      recordOptions: { releaseProfile: "stable" },
      resolverOptions: { releaseProfile: "beta" },
    },
    {
      expected: "profile full differs from beta",
      label: "full evidence for beta",
      recordOptions: { releaseProfile: "full" },
      resolverOptions: { releaseProfile: "beta" },
    },
    {
      expected: "profile full differs from stable",
      label: "full evidence for stable",
      recordOptions: { releaseProfile: "full" },
      resolverOptions: { releaseProfile: "stable" },
    },
    {
      expected: "validation inputs differ",
      label: "different lane inputs",
      recordOptions: { validationInputs: { ...DEFAULT_INPUTS, provider: "anthropic" } },
      resolverOptions: {},
    },
    {
      expected: "soak false differs from true",
      label: "missing required soak",
      recordOptions: { soak: false },
      resolverOptions: { runReleaseSoak: "true" },
    },
    {
      expected: "soak true differs from false",
      label: "extra soak evidence",
      recordOptions: { soak: true },
      resolverOptions: { runReleaseSoak: "false" },
    },
  ])(
    "rejects evidence with incompatible policy coverage: $label",
    ({ expected, recordOptions, resolverOptions }) => {
      const { origin, priorSha } = createRepo();
      const clone = cloneHead(origin);
      const record = normalizedEvidence({ targetSha: priorSha, ...recordOptions });
      const { binDir, fixtures, validatorPath } = setUpFixtures([{ record, runId: "111" }]);

      const result = runResolver({
        binDir,
        fixtures,
        repoDir: clone,
        targetSha: priorSha,
        validatorPath,
        ...resolverOptions,
      });

      expect(result.status).toBe(0);
      expect(parseOutput(result.stdout)).toMatchObject({ reuse: "false" });
      expect(result.stderr).toContain(expected);
    },
  );

  it("rejects cross-SHA reuse even for a changelog-only delta", () => {
    const { origin, priorSha } = createRepo();
    const targetSha = commitFile(
      origin,
      "CHANGELOG.md",
      "# Changelog\n\n- beta3\n",
      "docs(changelog): refresh",
    );
    const clone = cloneHead(origin);
    const record = normalizedEvidence({ targetSha: priorSha });
    const { binDir, fixtures, validatorPath } = setUpFixtures([{ record, runId: "111" }]);

    const result = runResolver({
      binDir,
      fixtures,
      repoDir: clone,
      targetSha,
      validatorPath,
    });

    expect(result.status).toBe(0);
    expect(parseOutput(result.stdout)).toMatchObject({ reuse: "false" });
    expect(result.stderr).toContain("cross-SHA reuse requires granular artifact evidence");
  });

  it("rejects target version metadata that is internally inconsistent", () => {
    const { origin, priorSha } = createRepo({ plistBuildVersion: "2026061000" });
    const clone = cloneHead(origin);
    const record = normalizedEvidence({ targetSha: priorSha });
    const { binDir, fixtures, validatorPath } = setUpFixtures([{ record, runId: "111" }]);

    const result = runResolver({
      binDir,
      fixtures,
      repoDir: clone,
      targetSha: priorSha,
      validatorPath,
    });

    expect(result.status).toBe(0);
    expect(parseOutput(result.stdout)).toMatchObject({
      reuse: "false",
      reuse_reason: "target version metadata is inconsistent",
    });
  });

  it.each([
    { inputs: [], label: "array inputs", runReleaseSoak: "true" },
    { inputs: null, label: "null inputs", runReleaseSoak: "true" },
    { inputs: DEFAULT_INPUTS, label: "invalid soak flag", runReleaseSoak: "yes" },
  ])("rejects invalid resolver arguments: $label", ({ inputs, runReleaseSoak }) => {
    const { origin, priorSha } = createRepo();
    const clone = cloneHead(origin);
    const { binDir, fixtures, validatorPath } = setUpFixtures([]);

    const result = runResolver({
      binDir,
      fixtures,
      inputs,
      repoDir: clone,
      runReleaseSoak,
      targetSha: priorSha,
      validatorPath,
    });

    expect(result.status).toBe(2);
  });

  it("reports no reuse when no prior successful runs exist", () => {
    const { origin, priorSha } = createRepo();
    const clone = cloneHead(origin);
    const { binDir, fixtures, validatorPath } = setUpFixtures([]);

    const result = runResolver({
      binDir,
      fixtures,
      repoDir: clone,
      targetSha: priorSha,
      validatorPath,
    });

    expect(result.status).toBe(0);
    expect(parseOutput(result.stdout)).toMatchObject({
      reuse: "false",
      reuse_reason: "no prior successful validation runs",
    });
  });

  it("rewrites inherited v3 producer identity to the current immutable workflow SHA", () => {
    const workflow = readFileSync(".github/workflows/full-release-validation.yml", "utf8");
    expect(workflow).toContain('--arg workflowSha "$GITHUB_SHA"');
    expect(workflow).toContain("workflowSha: $workflowSha");
    expect(workflow).toContain("ref: ${{ github.sha }}");
  });
});
