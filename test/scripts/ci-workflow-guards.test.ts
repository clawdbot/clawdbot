// Ci Workflow Guards tests cover ci workflow guards script behavior.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { NATIVE_I18N_LOCALES } from "../../scripts/native-app-i18n.ts";
import { SUPPORTED_LOCALES } from "../../ui/src/i18n/lib/registry.ts";

const CHECKOUT_V6 = "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10";
const CACHE_V5 = "actions/cache/restore@27d5ce7f107fe9357f9df03efb73ab90386fccae";
const SETUP_GO_V6 = "actions/setup-go@4a3601121dd01d1626a1e23e37211e3254c1c06c";
const UPLOAD_ARTIFACT_V7 = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const DOWNLOAD_ARTIFACT_V8 = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const CREATE_GITHUB_APP_TOKEN_V3 =
  "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1";
const TRUFFLEHOG_V3_95_9 = "trufflesecurity/trufflehog@27b0417c16317ca9a472a9a8092acce143b49c55";
const MANTIS_GITHUB_APP_CLIENT_ID = "Iv23liPJCozR0uHm6P7G";
const OPENGREP_PR_DIFF_WORKFLOW = ".github/workflows/opengrep-precise.yml";
const OPENGREP_FULL_WORKFLOW = ".github/workflows/opengrep-precise-full.yml";
const CONTROL_UI_LOCALE_REFRESH_WORKFLOW = ".github/workflows/control-ui-locale-refresh.yml";
const NATIVE_APP_LOCALE_REFRESH_WORKFLOW = ".github/workflows/native-app-locale-refresh.yml";
const CREATE_GENERATED_PR_TOKENS_ACTION = ".github/actions/create-generated-pr-tokens/action.yml";
const PUBLISH_GENERATED_PR_ACTION = ".github/actions/publish-generated-pr/action.yml";
const SETUP_ANDROID_TOOLCHAIN_ACTION = ".github/actions/setup-android-toolchain/action.yml";
const MATURITY_SCORECARD_WORKFLOW = ".github/workflows/maturity-scorecard.yml";
const MATURITY_SCORECARD_WORKFLOW_REF =
  "openclaw/openclaw/.github/workflows/maturity-scorecard.yml@refs/heads/main";
const OIDC_BOUND_MAIN_REUSABLE_WORKFLOWS = new Set<string>();
const MATURITY_GENERATED_PR_PATHS = [
  "qa/maturity-scores.yaml",
  "docs/maturity/scorecard.md",
  "docs/maturity/taxonomy.md",
];

type WorkflowStep = {
  env?: Record<string, unknown>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

function readCiWorkflow() {
  return parse(readFileSync(".github/workflows/ci.yml", "utf8"));
}

function runCiGateFixture(requiredResults: string, selectedResults: string) {
  const gateStep = readCiWorkflow().jobs["ci-gate"].steps.find(
    (step: WorkflowStep) => step.name === "Verify selected CI lanes",
  );
  return spawnSync("bash", ["-c", gateStep.run], {
    encoding: "utf8",
    env: {
      ...process.env,
      REQUIRED_RESULTS: requiredResults,
      SELECTED_RESULTS: selectedResults,
    },
  });
}

function runCiManifestFixture(options: {
  bundledPlanner: boolean;
  changedPlannerImportFails?: boolean;
  changedPaths?: string[] | null;
  eventName?: "pull_request" | "workflow_dispatch";
  historicalCompatibility?: boolean;
  iosCapabilities?: boolean;
  iosBuildCapability?: boolean;
  androidCiCapabilities?: boolean;
  nativeI18nCapabilities?: boolean;
  protocolCoverage?: boolean;
  qaSmokePlan?: boolean;
  formatCheck?: boolean;
  releaseCandidateCompatibility?: boolean;
  nodeFastOnly?: boolean;
  nodeFastPluginContracts?: boolean;
  nodeFastCiRouting?: boolean;
  runNode?: boolean;
}) {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-ci-manifest-"));
  try {
    const scriptsDir = path.join(root, "scripts", "lib");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      path.join(scriptsDir, "ci-node-test-plan.mjs"),
      options.bundledPlanner
        ? `
          export const createNodeTestShards = () => [{
            checkName: "legacy-node-plan",
            configs: ["test/vitest/legacy.config.ts"],
            requiresDist: false,
            runner: "ubuntu-24.04",
            shardName: "legacy-node-plan",
          }];
          export const createNodeTestShardBundles = () => [{
            checkName: "bundled-node-plan",
            configs: ["test/vitest/bundled.config.ts"],
            requiresDist: false,
            runner: "ubuntu-24.04",
            shardName: "bundled-node-plan",
          }];
        `
        : `
          export const createNodeTestShards = () => [{
            checkName: "legacy-node-plan",
            configs: ["test/vitest/legacy.config.ts"],
            requiresDist: false,
            runner: "ubuntu-24.04",
            shardName: "legacy-node-plan",
          }];
        `,
      "utf8",
    );
    const iosCapabilities = options.iosCapabilities ?? options.bundledPlanner;
    const iosBuildCapability = options.iosBuildCapability ?? iosCapabilities;
    const nativeI18nCapabilities = options.nativeI18nCapabilities ?? options.bundledPlanner;
    const packageScripts = options.bundledPlanner
      ? {
          ...(nativeI18nCapabilities
            ? {
                "android:i18n:check": "true",
                "apple:i18n:check": "true",
                "native:i18n:check": "true",
              }
            : {}),
          ...(iosBuildCapability ? { "ios:build": "true" } : {}),
          "check:max-lines-ratchet": "true",
        }
      : {};
    writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify({ scripts: packageScripts })}\n`,
    );
    if (options.bundledPlanner) {
      writeFileSync(
        path.join(scriptsDir, "ci-changed-node-test-plan.mjs"),
        options.changedPlannerImportFails
          ? `throw new Error("planner import failure");\n`
          : `
          export const createChangedNodeTestShards = (changedPaths) =>
            changedPaths.includes("src/focused.ts")
              ? [{
                  checkName: "changed-node-plan",
                  configs: [],
                  requiresDist: false,
                  runner: "ubuntu-24.04",
                  shardName: "changed-node-plan",
                  targets: ["src/focused.test.ts"],
                }]
              : null;
        `,
        "utf8",
      );
      writeFileSync(
        path.join(scriptsDir, "channel-contract-test-plan.mjs"),
        `export const createChannelContractTestShards = () => [{ checkName: "channel-contracts" }];\n`,
      );
      writeFileSync(
        path.join(scriptsDir, "plugin-contract-test-plan.mjs"),
        `export const createPluginContractTestShards = () => [{ checkName: "plugin-contracts" }];\n`,
      );
    }
    if (options.qaSmokePlan ?? options.bundledPlanner) {
      const smokePlan = path.join(root, "extensions", "qa-lab", "src", "ci-smoke-plan.ts");
      mkdirSync(path.dirname(smokePlan), { recursive: true });
      writeFileSync(smokePlan, "export {};\n");
    }
    if (iosCapabilities) {
      for (const name of [
        "install-swift-tools.sh",
        "install-xcodegen.sh",
        "lint-swift.sh",
        "format-swift.sh",
      ]) {
        writeFileSync(path.join(root, "scripts", name), "#!/bin/sh\n");
      }
    }
    if (options.protocolCoverage ?? options.bundledPlanner) {
      writeFileSync(path.join(root, "scripts", "check-protocol-event-coverage.mjs"), "");
    }
    const targetWorkflow = path.join(root, ".github", "workflows", "ci.yml");
    mkdirSync(path.dirname(targetWorkflow), { recursive: true });
    writeFileSync(
      targetWorkflow,
      [
        ...((options.formatCheck ?? options.bundledPlanner)
          ? ["pnpm format:check", "pnpm format:check"]
          : []),
        ...((options.androidCiCapabilities ?? options.bundledPlanner)
          ? ["android-ci-contract-v2"]
          : []),
      ].join("\n"),
    );
    const outputPath = path.join(root, "manifest.out");
    writeFileSync(outputPath, "", "utf8");
    const manifestStep = readCiWorkflow().jobs.preflight.steps.find(
      (step: { name?: string }) => step.name === "Build CI manifest",
    );
    const run = spawnSync("bash", ["-c", manifestStep.run], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        OPENCLAW_CI_CHANGED_PATHS_JSON: JSON.stringify(options.changedPaths ?? null),
        OPENCLAW_CI_CHECKOUT_REVISION: "a".repeat(40),
        OPENCLAW_CI_DOCS_CHANGED: "true",
        OPENCLAW_CI_DOCS_ONLY: "false",
        OPENCLAW_CI_EVENT_NAME: options.eventName ?? "workflow_dispatch",
        OPENCLAW_CI_HISTORICAL_TARGET:
          (options.historicalCompatibility ?? true) &&
          (options.eventName ?? "workflow_dispatch") === "workflow_dispatch"
            ? "true"
            : "false",
        OPENCLAW_CI_RELEASE_CANDIDATE_TARGET:
          options.releaseCandidateCompatibility === true ? "true" : "false",
        OPENCLAW_CI_REPOSITORY: "openclaw/openclaw",
        OPENCLAW_CI_RUN_ANDROID: "true",
        OPENCLAW_CI_RUN_CONTROL_UI_I18N: "true",
        OPENCLAW_CI_RUN_IOS_BUILD: "true",
        OPENCLAW_CI_RUN_MACOS: "true",
        OPENCLAW_CI_RUN_NATIVE_I18N: "true",
        OPENCLAW_CI_RUN_NODE: String(options.runNode ?? true),
        OPENCLAW_CI_RUN_NODE_FAST_CI_ROUTING: String(options.nodeFastCiRouting ?? false),
        OPENCLAW_CI_RUN_NODE_FAST_ONLY: String(options.nodeFastOnly ?? false),
        OPENCLAW_CI_RUN_NODE_FAST_PLUGIN_CONTRACTS: String(
          options.nodeFastPluginContracts ?? false,
        ),
        OPENCLAW_CI_RUN_SKILLS_PYTHON: "true",
        OPENCLAW_CI_RUN_WINDOWS: "true",
        OPENCLAW_CI_WORKFLOW_REVISION: "b".repeat(40),
      },
    });
    const outputs = Object.fromEntries(
      readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    return { output: `${run.stdout}${run.stderr}`, outputs, status: run.status };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function readAndroidReleaseWorkflow() {
  return parse(readFileSync(".github/workflows/android-release.yml", "utf8"));
}

function readAndroidToolchainAction() {
  return parse(readFileSync(SETUP_ANDROID_TOOLCHAIN_ACTION, "utf8"));
}

function readBuildArtifactsTestboxWorkflow() {
  return parse(readFileSync(".github/workflows/ci-build-artifacts-testbox.yml", "utf8"));
}

function readTestboxWorkflow() {
  return parse(readFileSync(".github/workflows/ci-check-testbox.yml", "utf8"));
}

function readWorkflowSanityWorkflow() {
  return parse(readFileSync(".github/workflows/workflow-sanity.yml", "utf8"));
}

function readRealBehaviorProofWorkflow() {
  return parse(readFileSync(".github/workflows/real-behavior-proof.yml", "utf8"));
}

function readMaturityScorecardWorkflow() {
  return parse(readFileSync(MATURITY_SCORECARD_WORKFLOW, "utf8"));
}

function runMaturityInvocationScenario(options: {
  callerEventName: string;
  callerWorkflowRef: string;
  jobWorkflowRef?: string;
  publishPullRequest: boolean;
}) {
  const workflow = readMaturityScorecardWorkflow();
  const authorizeStep = workflow.jobs.validate_selected_ref.steps.find(
    (step: { name?: string }) => step.name === "Authorize workflow invocation",
  );
  const authorizeRun = spawnSync("bash", ["-c", authorizeStep.run], {
    encoding: "utf8",
    env: {
      CALLER_EVENT_NAME: options.callerEventName,
      CALLER_WORKFLOW_REF: options.callerWorkflowRef,
      JOB_WORKFLOW_FILE_PATH: MATURITY_SCORECARD_WORKFLOW,
      JOB_WORKFLOW_REF: options.jobWorkflowRef ?? MATURITY_SCORECARD_WORKFLOW_REF,
      JOB_WORKFLOW_REPOSITORY: "openclaw/openclaw",
      PATH: process.env.PATH ?? "",
      PUBLISH_PULL_REQUEST: String(options.publishPullRequest),
    },
  });
  return {
    output: `${authorizeRun.stdout}${authorizeRun.stderr}`,
    status: authorizeRun.status,
  };
}

function runMaturityArtifactCopyScenario(
  options: { destinationSymlink?: boolean; extraFile?: boolean; sourceSymlink?: boolean } = {},
) {
  const workflow = readMaturityScorecardWorkflow();
  const copyStep = workflow.jobs.publish_generated_pr.steps.find(
    (step: { name?: string }) => step.name === "Validate and copy generated PR files",
  );
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-maturity-copy-"));
  const staging = path.join(root, "staging");
  try {
    for (const generatedPath of MATURITY_GENERATED_PR_PATHS) {
      const staged = path.join(staging, generatedPath);
      const selected = path.join(root, "selected", generatedPath);
      mkdirSync(path.dirname(staged), { recursive: true });
      mkdirSync(path.dirname(selected), { recursive: true });
      writeFileSync(staged, `new ${generatedPath}\n`, "utf8");
      writeFileSync(selected, `old ${generatedPath}\n`, "utf8");
    }
    if (options.extraFile) {
      writeFileSync(path.join(staging, "unexpected.txt"), "unexpected\n", "utf8");
    }
    const firstGeneratedPath = expectDefined(
      MATURITY_GENERATED_PR_PATHS[0],
      "first maturity generated PR path",
    );
    if (options.sourceSymlink) {
      const staged = path.join(staging, firstGeneratedPath);
      rmSync(staged);
      symlinkSync("missing-score-source", staged);
    }
    const escaped = path.join(root, "escaped.txt");
    if (options.destinationSymlink) {
      const selected = path.join(root, "selected", firstGeneratedPath);
      writeFileSync(escaped, "outside\n", "utf8");
      rmSync(selected);
      symlinkSync(escaped, selected);
    }
    const run = spawnSync("bash", ["-c", copyStep.run], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", STAGING_DIR: staging },
    });
    return {
      copied: MATURITY_GENERATED_PR_PATHS.map((generatedPath) =>
        readFileSync(path.join(root, "selected", generatedPath), "utf8"),
      ),
      escaped: existsSync(escaped) ? readFileSync(escaped, "utf8") : "",
      output: `${run.stdout}${run.stderr}`,
      status: run.status,
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function readQaProfileEvidenceWorkflow() {
  return parse(readFileSync(".github/workflows/qa-profile-evidence.yml", "utf8"));
}

function readReleaseChecksWorkflow() {
  return parse(readFileSync(".github/workflows/openclaw-release-checks.yml", "utf8"));
}

function readCriticalQualityWorkflow() {
  return readFileSync(".github/workflows/codeql-critical-quality.yml", "utf8");
}

function readWorkflow(path: string) {
  return parse(readFileSync(path, "utf8"));
}

const PULL_REQUEST_EDIT_FIELDS = ["title", "body", "base"] as const;

function readPullRequestEditFields(condition: unknown) {
  const expression = typeof condition === "string" ? condition : "";
  return PULL_REQUEST_EDIT_FIELDS.filter((field) =>
    expression.includes(`github.event.changes.${field}`),
  );
}

function readTrackedText(relativePath: string): string {
  if (existsSync(relativePath)) {
    return readFileSync(relativePath, "utf8");
  }
  return execFileSync("git", ["show", `:${relativePath}`], { encoding: "utf8" });
}

function readAndroidCompileSdk(relativePath: string): number {
  const match = readTrackedText(relativePath).match(/^\s*compileSdk\s*=\s*(\d+)\s*$/mu);
  if (!match) {
    throw new Error(`Missing compileSdk in ${relativePath}`);
  }
  return Number(match[1]);
}

function findYamlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return findYamlFiles(entryPath);
    }
    return entry.isFile() && /\.ya?ml$/u.test(entry.name) ? [entryPath] : [];
  });
}

function findUnpinnedExternalActions(): string[] {
  const violations: string[] = [];
  for (const workflowPath of [
    ...findYamlFiles(".github/workflows"),
    ...findYamlFiles(".github/actions"),
  ]) {
    for (const [index, line] of readFileSync(workflowPath, "utf8").split("\n").entries()) {
      const uses = line.match(/^\s*(?:-\s*)?uses:\s*([^#\s]+)/u)?.[1];
      if (
        !uses ||
        uses.startsWith("./") ||
        uses.startsWith("docker://") ||
        OIDC_BOUND_MAIN_REUSABLE_WORKFLOWS.has(uses)
      ) {
        continue;
      }
      const at = uses.lastIndexOf("@");
      if (at < 1 || !/^[a-f0-9]{40}$/u.test(uses.slice(at + 1))) {
        violations.push(`${workflowPath}:${index + 1}: ${uses}`);
      }
    }
  }
  return violations;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeExecutable(filePath: string, lines: string[]): void {
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  chmodSync(filePath, 0o755);
}

function runDependencyCheckFixture(options: { historicalTarget: boolean; scripts: string[] }): {
  calls: string[];
  output: string;
  status: number | null;
} {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-ci-deadcode-"));
  try {
    const fakeBin = path.join(root, "bin");
    const callsPath = path.join(root, "pnpm-calls.txt");
    mkdirSync(fakeBin);
    writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify({
        scripts: Object.fromEntries(options.scripts.map((name) => [name, "true"])),
      })}\n`,
    );
    writeExecutable(path.join(fakeBin, "pnpm"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "%s\\n" "$*" >> "$PNPM_CALLS"',
    ]);
    const checkShardRun = readCiWorkflow().jobs["check-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run check shard",
    ).run;
    const run = spawnSync("bash", ["-c", checkShardRun], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        FORMAT_CHECK: "false",
        HISTORICAL_TARGET: options.historicalTarget ? "true" : "false",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        PNPM_CALLS: callsPath,
        PR_BASE_SHA: "",
        TASK: "dependencies",
      },
    });
    return {
      calls: existsSync(callsPath)
        ? readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean)
        : [],
      output: `${run.stdout}${run.stderr}`,
      status: run.status,
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function runGeneratedPublisherScenario(
  baseChangePath: "a" | "b" | null,
  options: {
    autoMerge?: boolean;
    existingAutoMergeMethod?: "MERGE" | "REBASE" | "SQUASH";
    existingPr?: boolean;
    expectFailure?: boolean;
    failGeneratedPush?: boolean;
    mergeGeneratedPush?: boolean;
    noGeneratedChange?: boolean;
    overlapPolicy?: string;
    stalePrHeadOnce?: boolean;
    stalePrViewHeadOnce?: boolean;
    updateSource?: boolean;
  } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-generated-pr-"));
  try {
    const origin = path.join(root, "origin.git");
    const updater = path.join(root, "updater");
    const worktree = path.join(root, "worktree");
    const generatedDir = path.join(worktree, "generated");
    const sourceDir = path.join(worktree, "source");
    const fakeBin = path.join(root, "bin");
    const runnerTemp = path.join(root, "runner-temp");
    const prState = path.join(root, "pr-open");
    const mergeCalls = path.join(root, "merge-calls");
    const stalePrHeadOnce = path.join(root, "stale-pr-head-once");
    const stalePrViewHeadOnce = path.join(root, "stale-pr-view-head-once");
    const summary = path.join(root, "summary.md");

    mkdirSync(generatedDir, { recursive: true });
    mkdirSync(sourceDir);
    mkdirSync(fakeBin);
    mkdirSync(runnerTemp);
    writeFileSync(summary, "", "utf8");
    if (options.stalePrHeadOnce) {
      writeFileSync(stalePrHeadOnce, "", "utf8");
    }
    if (options.stalePrViewHeadOnce) {
      writeFileSync(stalePrViewHeadOnce, "", "utf8");
    }
    runGit(root, ["init", "--bare", origin]);
    runGit(root, ["init", "--initial-branch=main", worktree]);
    runGit(worktree, ["config", "user.name", "Test Publisher"]);
    runGit(worktree, ["config", "user.email", "publisher@example.com"]);
    writeFileSync(path.join(generatedDir, "a.txt"), "old-a\n", "utf8");
    writeFileSync(path.join(generatedDir, "b.txt"), "old-b\n", "utf8");
    writeFileSync(path.join(sourceDir, "input.txt"), "old-input\n", "utf8");
    runGit(worktree, ["add", "generated", "source"]);
    runGit(worktree, ["commit", "-m", "base"]);
    runGit(worktree, ["remote", "add", "origin", origin]);
    runGit(worktree, ["push", "-u", "origin", "main"]);
    runGit(root, ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"]);
    if (options.existingPr) {
      runGit(worktree, ["switch", "-c", "automation/locale"]);
      writeFileSync(path.join(generatedDir, "a.txt"), "stale-pr-a\n", "utf8");
      runGit(worktree, ["add", "generated"]);
      runGit(worktree, ["commit", "-m", "stale generated pull request"]);
      runGit(worktree, ["push", "-u", "origin", "automation/locale"]);
      writeFileSync(prState, "", "utf8");
      runGit(worktree, ["switch", "main"]);
    }
    runGit(root, ["clone", "--branch", "main", origin, updater]);
    runGit(updater, ["config", "user.name", "Base Updater"]);
    runGit(updater, ["config", "user.email", "updater@example.com"]);
    if (baseChangePath !== null) {
      writeFileSync(
        path.join(updater, "generated", `${baseChangePath}.txt`),
        `newer-${baseChangePath}\n`,
        "utf8",
      );
    }
    if (options.updateSource) {
      writeFileSync(path.join(updater, "source", "input.txt"), "newer-input\n", "utf8");
    }
    if (baseChangePath !== null || options.updateSource) {
      runGit(updater, ["add", "generated", "source"]);
      runGit(updater, ["commit", "-m", "update base"]);
      runGit(updater, ["push", "origin", "main"]);
    }
    if (!options.noGeneratedChange) {
      writeFileSync(path.join(generatedDir, "a.txt"), "desired-a\n", "utf8");
    }
    if (options.failGeneratedPush) {
      writeExecutable(path.join(origin, "hooks", "pre-receive"), [
        "#!/bin/sh",
        'rm -f "$0"',
        "exit 1",
      ]);
    }
    if (options.mergeGeneratedPush) {
      writeExecutable(path.join(origin, "hooks", "post-receive"), [
        "#!/bin/sh",
        "while read -r old_head new_head ref; do",
        '  if [ "$ref" = "refs/heads/automation/locale" ]; then',
        '    git update-ref refs/heads/main "$new_head"',
        '    git update-ref -d refs/heads/automation/locale "$new_head"',
        "  fi",
        "done",
      ]);
    }

    writeExecutable(path.join(fakeBin, "timeout"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'while [[ "$#" -gt 0 ]]; do',
      '  case "$1" in',
      "    --signal=*|--kill-after=*) shift ;;",
      "    [0-9]*s) shift; break ;;",
      "    *) break ;;",
      "  esac",
      "done",
      'exec "$@"',
    ]);
    writeExecutable(path.join(fakeBin, "gh"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'case "${1-}:${2-}" in',
      "  auth:setup-git) exit 0 ;;",
      "  api:*)",
      '    if [[ -f "$FAKE_PR_STATE" ]]; then',
      '      if [[ -f "$FAKE_STALE_HEAD_ONCE" ]]; then',
      '        head="0000000000000000000000000000000000000000"',
      '        rm -f "$FAKE_STALE_HEAD_ONCE"',
      "      else",
      '        head="$(git --git-dir="$FAKE_ORIGIN" rev-parse refs/heads/automation/locale)"',
      "      fi",
      '      printf "https://github.com/openclaw/openclaw/pull/1\\t%s\\n" "$head"',
      "    fi",
      "    ;;",
      "  pr:create)",
      '    : > "$FAKE_PR_STATE"',
      '    printf "%s\\n" "https://github.com/openclaw/openclaw/pull/1"',
      "    ;;",
      "  pr:edit) exit 0 ;;",
      "  pr:view)",
      '    [[ -n "${GH_TOKEN:-}" ]]',
      '    [[ -f "$FAKE_PR_STATE" ]]',
      '    if [[ -f "$FAKE_STALE_PR_VIEW_HEAD_ONCE" ]]; then',
      '      head="0000000000000000000000000000000000000000"',
      '      rm -f "$FAKE_STALE_PR_VIEW_HEAD_ONCE"',
      "    else",
      '      head="$(git --git-dir="$FAKE_ORIGIN" rev-parse refs/heads/automation/locale)"',
      "    fi",
      '    printf "%s\\t%s\\n" "$head" "$FAKE_AUTO_MERGE_METHOD"',
      "    ;;",
      "  pr:merge)",
      '    [[ "$GH_TOKEN" == "test-token" ]]',
      '    printf "%s\\n" "$*" >> "$FAKE_MERGE_CALLS"',
      "    ;;",
      '  *) printf "unexpected gh call: %s\\n" "$*" >&2; exit 2 ;;',
      "esac",
    ]);

    const action = parse(readFileSync(PUBLISH_GENERATED_PR_ACTION, "utf8"));
    const publishRun = action.runs.steps.find(
      (step: { name?: string }) => step.name === "Publish generated pull request",
    ).run;
    const publish = spawnSync("bash", ["-c", publishRun], {
      cwd: worktree,
      encoding: "utf8",
      env: {
        ...process.env,
        BASE_BRANCH: "main",
        COMMIT_MESSAGE: "chore(test): refresh generated output",
        AUTO_MERGE: String(options.autoMerge ?? false),
        FAKE_AUTO_MERGE_METHOD: options.existingAutoMergeMethod ?? "",
        FAKE_ORIGIN: origin,
        FAKE_MERGE_CALLS: mergeCalls,
        FAKE_PR_STATE: prState,
        FAKE_STALE_HEAD_ONCE: stalePrHeadOnce,
        FAKE_STALE_PR_VIEW_HEAD_ONCE: stalePrViewHeadOnce,
        GENERATED_PATHS: "generated",
        INVALIDATION_PATHS: "source",
        OVERLAP_POLICY: options.overlapPolicy ?? "defer",
        CONTENTS_TOKEN: "contents-token",
        GH_TOKEN: "test-token",
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_REPOSITORY_OWNER: "openclaw",
        GITHUB_STEP_SUMMARY: summary,
        HEAD_BRANCH: "automation/locale",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        PR_BODY: "Generated test body",
        PR_TITLE: "chore(test): refresh generated output",
        RUNNER_TEMP: runnerTemp,
      },
    });
    const publishOutput = `${publish.stdout}${publish.stderr}`;
    if (options.expectFailure ? publish.status === 0 : publish.status !== 0) {
      throw new Error(
        `generated publisher exited ${String(publish.status)} (expected ${options.expectFailure ? "failure" : "success"}):\n${publishOutput}`,
      );
    }
    const authHeader = spawnSync(
      "git",
      ["config", "--local", "--get-all", "http.https://github.com/.extraheader"],
      { cwd: worktree, encoding: "utf8" },
    );
    if (authHeader.status !== 1 || authHeader.stdout.trim() !== "") {
      throw new Error("generated publisher left its Git authorization header configured");
    }

    const branchRef = "refs/heads/automation/locale";
    const branchExists =
      spawnSync("git", ["--git-dir", origin, "show-ref", "--verify", branchRef]).status === 0;
    const branchHead = branchExists
      ? runGit(root, ["--git-dir", origin, "rev-parse", branchRef])
      : "";
    return {
      branchExists,
      branchHead,
      generatedA: branchExists
        ? runGit(root, ["--git-dir", origin, "show", `${branchRef}:generated/a.txt`])
        : "",
      generatedB: branchExists
        ? runGit(root, ["--git-dir", origin, "show", `${branchRef}:generated/b.txt`])
        : "",
      mainGeneratedA: runGit(root, [
        "--git-dir",
        origin,
        "show",
        "refs/heads/main:generated/a.txt",
      ]),
      mainHead: runGit(root, ["--git-dir", origin, "rev-parse", "refs/heads/main"]),
      mergeCalls: existsSync(mergeCalls) ? readFileSync(mergeCalls, "utf8") : "",
      publishOutput,
      summary: readFileSync(summary, "utf8"),
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe("ci workflow guards", () => {
  it("routes PR edited metadata only to interested automation", () => {
    const autoResponse = readWorkflow(".github/workflows/auto-response.yml");
    const clawsweeperDispatch = readWorkflow(".github/workflows/clawsweeper-dispatch.yml");
    const labeler = readWorkflow(".github/workflows/labeler.yml");
    const realBehaviorProof = readWorkflow(".github/workflows/real-behavior-proof.yml");

    for (const workflow of [autoResponse, clawsweeperDispatch, labeler, realBehaviorProof]) {
      expect(workflow.on.pull_request_target.types).toContain("edited");
    }

    expect({
      autoResponse: readPullRequestEditFields(autoResponse.jobs["auto-response"].if),
      clawsweeperDispatch: readPullRequestEditFields(clawsweeperDispatch.jobs.dispatch.if),
      labeler: readPullRequestEditFields(labeler.jobs.label.if),
      realBehaviorProof: readPullRequestEditFields(
        realBehaviorProof.jobs["real-behavior-proof"].if,
      ),
    }).toEqual({
      autoResponse: [],
      clawsweeperDispatch: [],
      labeler: ["title", "base"],
      realBehaviorProof: ["body", "base"],
    });

    const labelerSteps = labeler.jobs.label.steps;
    const changedFieldsForStep = (matcher: (step: WorkflowStep) => boolean) =>
      readPullRequestEditFields(labelerSteps.find(matcher)?.if);
    expect({
      pathLabels: changedFieldsForStep(
        (step) => step.uses?.startsWith("actions/labeler@") === true,
      ),
      size: changedFieldsForStep((step) => step.name === "Apply PR size label"),
      contributor: changedFieldsForStep(
        (step) => step.name === "Apply maintainer or trusted-contributor label",
      ),
      betaBlocker: changedFieldsForStep((step) => step.name === "Apply beta-blocker title label"),
      activePrLimit: changedFieldsForStep((step) => step.name === "Apply too-many-prs label"),
    }).toEqual({
      pathLabels: ["base"],
      size: ["base"],
      contributor: [],
      betaBlocker: ["title"],
      activePrLimit: [],
    });
  });

  it("makes the hosted release-gate fallback explicit and exact-SHA only", () => {
    const workflow = readCiWorkflow();
    const releaseGate = workflow.on.workflow_dispatch.inputs.release_gate;

    expect(releaseGate).toEqual({
      description:
        "Run an exact-SHA maintainer release-gate fallback when PR CI is capacity-stalled.",
      required: false,
      default: false,
      type: "boolean",
    });
    expect(workflow.on.workflow_dispatch.inputs.dispatch_id).toEqual({
      description: "Optional parent workflow dispatch identifier",
      required: false,
      default: "",
      type: "string",
    });
    expect(workflow.on.workflow_dispatch.inputs.pull_request_number).toEqual({
      description: "Pull request number required by the exact-SHA release gate.",
      required: false,
      default: "",
      type: "string",
    });
    expect(workflow.on.workflow_dispatch.inputs).not.toHaveProperty("loc_base_ref");
    expect(workflow.on.workflow_dispatch.inputs).not.toHaveProperty("pr_number");
    expect(readFileSync(".github/workflows/ci.yml", "utf8")).toContain(
      "run-name: ${{ github.event_name == 'workflow_dispatch' && inputs.dispatch_id != '' && format('CI {0}', inputs.dispatch_id) || (github.event_name == 'workflow_dispatch' && inputs.release_gate && format('CI release gate {0}', inputs.target_ref) || 'CI') }}",
    );
    const preflightSteps = workflow.jobs.preflight.steps;
    const validationStep = preflightSteps.find(
      (step: WorkflowStep) => step.name === "Validate release-gate dispatch",
    );
    expect(validationStep.if).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.release_gate",
    );
    expect(validationStep.run).toContain(
      "release_gate requires target_ref to be a full commit SHA",
    );
    expect(validationStep.run).toContain("release_gate requires pull_request_number");
    expect(validationStep.run).toContain("release_gate must run from the branch at target_ref");
    expect(validationStep.run).toContain(
      "release_gate cannot be combined with historical_target_tag",
    );
    const diffBaseStep = preflightSteps.find(
      (step: WorkflowStep) => step.name === "Resolve exact diff base",
    );
    expect(diffBaseStep.env).toMatchObject({
      PULL_REQUEST_NUMBER: "${{ inputs.pull_request_number }}",
      RELEASE_GATE: "${{ inputs.release_gate }}",
    });
    expect(diffBaseStep.run).toContain("refs/pull/${PULL_REQUEST_NUMBER}/merge");
    expect(diffBaseStep.run).toContain('release_gate_head="$(git rev-parse "${merge_ref}^2")"');
    expect(diffBaseStep.run).toContain(
      "release_gate pull request head ${release_gate_head} does not match target ${target_head}",
    );
    expect(diffBaseStep.run).toContain('base_sha="$(git rev-parse "${merge_ref}^1")"');
    expect(diffBaseStep.run).toContain('head_sha="$(git rev-parse "$merge_ref")"');
    expect(diffBaseStep.run).toContain('echo "head_sha=$head_sha" >> "$GITHUB_OUTPUT"');
    const changedScopeStep = preflightSteps.find(
      (step: WorkflowStep) => step.name === "Detect changed scopes",
    );
    expect(changedScopeStep.if).toContain(
      "github.event_name == 'workflow_dispatch' && inputs.release_gate",
    );
    expect(changedScopeStep.env?.OPENCLAW_ALLOW_RELEASE_GENERATED_MIX).toContain(
      "github.event_name == 'workflow_dispatch'",
    );
    expect(changedScopeStep.run).toContain('elif [ "${{ github.event_name }}" = "pull_request" ]');
    expect(changedScopeStep.run).toContain('HEAD_SHA="${{ steps.diff_base.outputs.head_sha }}"');
    expect(changedScopeStep.run).toContain(
      'node scripts/ci-changed-scope.mjs --base "$BASE" --head "$HEAD_SHA"',
    );
    expect(workflow.jobs.preflight.permissions).toEqual({ contents: "read" });
    expect(readFileSync(".github/workflows/ci.yml", "utf8")).toContain(
      "OPENCLAW_CI_RUN_ANDROID: ${{ github.event_name == 'workflow_dispatch' && (inputs.release_gate || inputs.include_android) && 'true' || steps.changed_scope.outputs.run_android || 'false' }}",
    );

    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const runsOn = (job as { "runs-on"?: unknown })["runs-on"];
      if (typeof runsOn !== "string" || !runsOn.includes("blacksmith-")) {
        continue;
      }
      expect(runsOn, `${jobName} must use GitHub-hosted capacity for release gates`).toContain(
        "github.event_name == 'workflow_dispatch'",
      );
    }

    for (const jobName of ["macos-node", "macos-swift", "ios-build"]) {
      expect(
        workflow.jobs[jobName]["runs-on"],
        `${jobName} retries must escape stalled Blacksmith macOS capacity`,
      ).toContain("github.run_attempt > 1");
    }
  });

  it("keeps Testbox pull request validation off leased runner capacity", () => {
    const workflow = readTestboxWorkflow();

    expect(workflow.jobs.check["runs-on"]).toBe(
      "${{ github.event_name == 'pull_request' && 'ubuntu-24.04' || 'blacksmith-16vcpu-ubuntu-2404' }}",
    );
    const beginStep = workflow.jobs.check.steps.find(
      (step: { name?: string }) => step.name === "Begin Testbox",
    );
    const runStep = workflow.jobs.check.steps.find(
      (step: { name?: string }) => step.name === "Run Testbox",
    );
    expect(beginStep).toMatchObject({
      if: "github.event_name == 'workflow_dispatch'",
      with: { testbox_id: "${{ inputs.testbox_id }}" },
    });
    expect(runStep).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && always()",
    });
  });

  it("pins every external GitHub Action reference to a full commit SHA", () => {
    expect(findUnpinnedExternalActions()).toEqual([]);
  });

  it("forbids moving reusable workflow references", () => {
    expect([...OIDC_BOUND_MAIN_REUSABLE_WORKFLOWS]).toEqual([]);
  });

  it("keeps locale refresh matrices alive and publishes each aggregate through a PR", () => {
    const controlUiWorkflow = parse(readFileSync(CONTROL_UI_LOCALE_REFRESH_WORKFLOW, "utf8"));
    const workflow = parse(readFileSync(NATIVE_APP_LOCALE_REFRESH_WORKFLOW, "utf8"));
    const controlUiResolveBase = controlUiWorkflow.jobs["resolve-base"];
    const nativeResolveBase = workflow.jobs["resolve-base"];
    const controlUiPreflight = controlUiWorkflow.jobs["publisher-preflight"];
    const nativePreflight = workflow.jobs["publisher-preflight"];
    const refresh = workflow.jobs.refresh;
    const nativeFinalize = workflow.jobs.finalize;
    const controlUiFinalize = controlUiWorkflow.jobs.finalize;
    const refreshStep = refresh.steps.find(
      (step: { name?: string }) => step.name === "Refresh native locale artifact",
    );
    const nativeArtifactStep = refresh.steps.find(
      (step: { name?: string }) => step.name === "Prepare locale artifact",
    );
    const nativeGeneratedStep = nativeFinalize.steps.find(
      (step: { name?: string }) => step.name === "Refresh native generated artifacts",
    );
    const nativeValidationStep = nativeFinalize.steps.find(
      (step: { name?: string }) => step.name === "Validate native locale refresh",
    );
    const nativePublishStep = nativeFinalize.steps.find(
      (step: { name?: string }) => step.name === "Open or update generated locale PR",
    );
    const controlUiRefreshStep = controlUiWorkflow.jobs.refresh.steps.find(
      (step: { name?: string }) => step.name === "Refresh control UI locale files",
    );
    const controlUiAggregateStep = controlUiFinalize.steps.find(
      (step: { name?: string }) => step.name === "Finalize control UI generated artifacts",
    );
    const controlUiValidationStep = controlUiFinalize.steps.find(
      (step: { name?: string }) => step.name === "Validate control UI locale refresh",
    );

    expect(refresh.if).toBe(
      "needs.resolve-base.result == 'success' && needs.publisher-preflight.result == 'success'",
    );
    expect(refresh.strategy.matrix.locale).toEqual(NATIVE_I18N_LOCALES);
    expect(controlUiWorkflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(controlUiWorkflow.concurrency.group.replace(/\s+/gu, " ")).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.token_preflight_only && format('control-ui-locale-token-preflight-{0}', github.ref) || 'control-ui-locale-refresh' }}",
    );
    expect(controlUiWorkflow.jobs.plan).toBeUndefined();
    expect(controlUiWorkflow.jobs.refresh.if).toBe(
      "needs.resolve-base.result == 'success' && needs.publisher-preflight.result == 'success' && !(github.event_name == 'workflow_dispatch' && inputs.token_preflight_only)",
    );
    expect(controlUiWorkflow.jobs.refresh.strategy.matrix.locale).toEqual(
      SUPPORTED_LOCALES.filter((locale) => locale !== "en"),
    );
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(workflow.concurrency.group).toBe("native-app-locale-refresh");
    expect(controlUiResolveBase.if).not.toContain("chore(ui): refresh control ui locales");
    expect(nativeResolveBase.if).not.toContain("chore(i18n): refresh native locales");
    const controlResolveCondition = controlUiResolveBase.if.replace(/\s+/gu, " ");
    expect(controlResolveCondition).toBe(
      "github.repository == 'openclaw/openclaw' && (github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/main')",
    );
    expect(controlResolveCondition).not.toContain("inputs.token_preflight_only");
    expect(controlResolveCondition).not.toContain("github.ref_type");
    expect(nativeResolveBase.if).toBe(
      "github.repository == 'openclaw/openclaw' && (github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/main')",
    );
    expect(controlUiWorkflow.on.workflow_dispatch.inputs.token_preflight_only).toEqual({
      description: "Verify generated PR App permissions without running locale generation.",
      required: false,
      default: false,
      type: "boolean",
    });
    expect(workflow.on.workflow_dispatch?.inputs).toBeUndefined();
    expect(workflow.on.push.paths).toContain("ui/src/i18n/.i18n/glossary.*.json");
    expect(workflow.on.push.paths).toContain("apps/.i18n/native/**");
    expect(workflow.on.push.paths).toContain("apps/.i18n/native-source.json");
    expect(workflow.on.push.paths).toContain("apps/android/wear/src/main/**");
    expect(workflow.on.push.paths).toContain("scripts/android-app-i18n.ts");
    expect(workflow.on.push.paths).toContain("scripts/apple-app-i18n.ts");
    expect(refreshStep.run).toContain("run_refresh anthropic");
    expect(refreshStep.run).toContain("retrying with OpenAI");
    expect(refreshStep.run).toContain("run_openai_refresh");
    expect(refreshStep.run).toContain("repository OpenAI key");
    expect(refreshStep.env.OPENCLAW_DOCS_I18N_OPENAI_API_KEY).toBe(
      "${{ secrets.OPENCLAW_DOCS_I18N_OPENAI_API_KEY }}",
    );
    expect(refreshStep.env.OPENAI_API_KEY).toBe("${{ secrets.OPENAI_API_KEY }}");
    expect(nativeArtifactStep.run).toContain("git add -A apps/.i18n/native");
    expect(nativeArtifactStep.run).not.toContain("native-source.json");
    expect(nativeGeneratedStep.run).toBe(
      "node --import tsx scripts/native-app-i18n.ts sync --write",
    );
    expect(nativeValidationStep.run).toBe("node --import tsx scripts/native-app-i18n.ts check");
    expect(nativeFinalize.steps.map((step: { name?: string }) => step.name)).not.toContain(
      "Refresh Android native resources",
    );
    expect(nativeFinalize.steps.map((step: { name?: string }) => step.name)).not.toContain(
      "Refresh Apple native resources",
    );
    expect(nativePublishStep.with["generated-paths"].trim().split("\n")).toEqual([
      "apps/.i18n/native",
      "apps/.i18n/apple-translation-contradictions.json",
      "apps/android/app/src/main/java/ai/openclaw/app/i18n/NativeStringResources.kt",
      "apps/android/app/src/main/res/values*/assistant.xml",
      "apps/android/app/src/main/res/values*/strings.xml",
      "apps/android/wear/src/main/res/values*/strings.xml",
      "apps/ios/Resources/Localizable.xcstrings",
      "apps/macos/Sources/OpenClaw/Resources/Localizable.xcstrings",
      "apps/ios/Sources/*.lproj/InfoPlist.strings",
      "apps/ios/WatchApp/*.lproj/InfoPlist.strings",
      "apps/ios/ShareExtension/*.lproj/InfoPlist.strings",
      "apps/ios/ActivityWidget/*.lproj/InfoPlist.strings",
    ]);
    expect(nativePublishStep.with["invalidation-paths"]).toContain("scripts/android-app-i18n.ts");
    expect(nativePublishStep.with["invalidation-paths"]).toContain("scripts/apple-app-i18n.ts");
    expect(nativePublishStep.with["invalidation-paths"]).toContain("apps/.i18n/native-source.json");
    expect(nativePublishStep.with["auto-merge"]).toBe("true");
    expect(controlUiRefreshStep.run).toContain("run_refresh anthropic");
    expect(controlUiRefreshStep.run).toContain("retrying with OpenAI");
    expect(controlUiRefreshStep.run).toContain("run_openai_refresh");
    expect(controlUiRefreshStep.run).toContain("repository OpenAI key");
    expect(controlUiRefreshStep.env.OPENCLAW_DOCS_I18N_OPENAI_API_KEY).toBe(
      "${{ secrets.OPENCLAW_DOCS_I18N_OPENAI_API_KEY }}",
    );
    expect(controlUiRefreshStep.env.OPENAI_API_KEY).toBe("${{ secrets.OPENAI_API_KEY }}");
    expect(controlUiRefreshStep.env.OPENCLAW_CONTROL_UI_I18N_AUTH_OPTIONAL).toBe("0");
    const controlUiArtifactStep = controlUiWorkflow.jobs.refresh.steps.find(
      (step: { name?: string }) => step.name === "Prepare locale artifact",
    );
    expect(controlUiArtifactStep.run).toContain(
      ":(exclude)ui/src/i18n/.i18n/catalog-fallbacks.json",
    );
    expect(controlUiAggregateStep.run).toBe(
      "node --import tsx scripts/control-ui-i18n.ts sync --write",
    );
    const controlUiPublishStep = controlUiFinalize.steps.find(
      (step: { name?: string }) => step.name === "Open or update generated locale PR",
    );
    expect(controlUiPublishStep.with["invalidation-paths"]).toContain(
      "scripts/control-ui-i18n-verify.ts",
    );
    expect(controlUiPublishStep.with["invalidation-paths"]).toContain(
      "scripts/lib/control-ui-i18n-raw-copy.ts",
    );
    expect(controlUiFinalize.steps.indexOf(controlUiAggregateStep)).toBeLessThan(
      controlUiFinalize.steps.indexOf(controlUiValidationStep),
    );

    for (const ownerWorkflow of [controlUiWorkflow, workflow]) {
      expect(ownerWorkflow.on.push.paths).toContain(CREATE_GENERATED_PR_TOKENS_ACTION);
      expect(ownerWorkflow.on.push.paths).toContain(PUBLISH_GENERATED_PR_ACTION);
      const resolveBase = ownerWorkflow.jobs["resolve-base"];
      const resolveStep = resolveBase.steps.find(
        (step: { name?: string }) =>
          step.name ===
          (ownerWorkflow === controlUiWorkflow
            ? "Resolve source commit"
            : "Resolve default branch head"),
      );
      expect(resolveBase.outputs.sha).toBe("${{ steps.base.outputs.sha }}");
      expect(resolveStep.env.GH_TOKEN).toBe("${{ github.token }}");
      expect(resolveStep.run).toContain(
        'gh api --method GET "repos/${REPOSITORY}/commits/${DEFAULT_BRANCH}" --jq .sha',
      );
      expect(resolveStep.run).toContain('[[ ! "${sha}" =~ ^[0-9a-f]{40}$ ]]');

      const checkoutSteps = (
        Object.values(ownerWorkflow.jobs) as Array<{
          steps?: Array<{ uses?: string; with?: Record<string, unknown> }>;
        }>
      ).flatMap((job: { steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }) =>
        (job.steps ?? []).filter((step: WorkflowStep) => step.uses === CHECKOUT_V6),
      );
      expect(checkoutSteps.length).toBeGreaterThan(0);
      for (const checkoutStep of checkoutSteps) {
        expect(checkoutStep.with?.ref).toBe("${{ needs.resolve-base.outputs.sha }}");
        expect(checkoutStep.with?.["persist-credentials"]).toBe(false);
      }
    }

    const controlUiResolveStep = controlUiResolveBase.steps.find(
      (step: { name?: string }) => step.name === "Resolve source commit",
    );
    expect(controlUiResolveStep.env.TOKEN_PREFLIGHT_ONLY).toContain("inputs.token_preflight_only");
    expect(controlUiResolveStep.env.WORKFLOW_SHA).toBe("${{ github.workflow_sha }}");
    expect(controlUiResolveStep.run).toContain(
      'if [[ "${TOKEN_PREFLIGHT_ONLY}" == "true" ]]; then',
    );
    expect(controlUiResolveStep.run).toContain('sha="${WORKFLOW_SHA}"');

    for (const preflight of [controlUiPreflight, nativePreflight]) {
      expect(preflight.needs).toBe("resolve-base");
      expect(preflight.if).toBe("needs.resolve-base.result == 'success'");
      expect(preflight.strategy).toBeUndefined();
      expect(preflight.steps).toHaveLength(3);
      const checkoutStep = preflight.steps.find(
        (step: { uses?: string }) => step.uses === CHECKOUT_V6,
      );
      const tokensStep = preflight.steps.find(
        (step: { name?: string }) => step.name === "Create generated PR tokens",
      );
      expect(checkoutStep.with).toMatchObject({
        ref: "${{ needs.resolve-base.outputs.sha }}",
        "persist-credentials": false,
      });
      expect(tokensStep.uses).toBe("./.github/actions/create-generated-pr-tokens");
      expect(tokensStep.with).toEqual({
        "contents-client-id": "Iv23liOECG0slfuhz093",
        "contents-private-key": "${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}",
        "pull-request-client-id": MANTIS_GITHUB_APP_CLIENT_ID,
        "pull-request-contents-permission": "write",
        "pull-request-private-key": "${{ secrets.MANTIS_GITHUB_APP_PRIVATE_KEY }}",
      });
    }
    for (const preflight of [controlUiPreflight, nativePreflight]) {
      const tokensStep = preflight.steps.find(
        (step: { name?: string }) => step.name === "Create generated PR tokens",
      );
      const autoMergeSettingStep = preflight.steps.find(
        (step: { name?: string }) => step.name === "Verify repository auto-merge setting",
      );
      expect(tokensStep.id).toBe("tokens");
      expect(autoMergeSettingStep.env.GH_TOKEN).toBe(
        "${{ steps.tokens.outputs.pull-request-token }}",
      );
      expect(autoMergeSettingStep.run).toContain("autoMergeAllowed");
      expect(autoMergeSettingStep.run).toContain("Repository auto-merge must be enabled");
    }

    const tokenAction = parse(readFileSync(CREATE_GENERATED_PR_TOKENS_ACTION, "utf8"));
    const tokenActionSource = readFileSync(CREATE_GENERATED_PR_TOKENS_ACTION, "utf8");
    const contentsTokenStep = tokenAction.runs.steps.find(
      (step: { name?: string }) => step.name === "Create generated branch app token",
    );
    const pullRequestTokenStep = tokenAction.runs.steps.find(
      (step: { name?: string }) => step.name === "Create generated PR app token",
    );
    const publishAction = parse(readFileSync(PUBLISH_GENERATED_PR_ACTION, "utf8"));
    const publishActionSource = readFileSync(PUBLISH_GENERATED_PR_ACTION, "utf8");
    const createTokensStep = publishAction.runs.steps.find(
      (step: { name?: string }) => step.name === "Create generated PR tokens",
    );
    const actionPublishStep = publishAction.runs.steps.find(
      (step: { name?: string }) => step.name === "Publish generated pull request",
    );

    expect(tokenAction.runs.steps).toHaveLength(2);
    for (const input of [
      "contents-client-id",
      "contents-private-key",
      "pull-request-client-id",
      "pull-request-private-key",
    ]) {
      expect(tokenAction.inputs[input].required).toBe(true);
      expect(publishAction.inputs[input].required).toBe(true);
    }
    expect(`${tokenActionSource}\n${publishActionSource}`).not.toMatch(
      /2729701|2971289|primary-private-key|fallback-private-key/u,
    );
    expect(contentsTokenStep).toEqual({
      name: "Create generated branch app token",
      id: "contents-token",
      uses: CREATE_GITHUB_APP_TOKEN_V3,
      with: {
        "client-id": "${{ inputs.contents-client-id }}",
        "private-key": "${{ inputs.contents-private-key }}",
        owner: "${{ github.repository_owner }}",
        repositories: "${{ github.event.repository.name }}",
        "permission-contents": "write",
      },
    });
    expect(pullRequestTokenStep).toEqual({
      name: "Create generated PR app token",
      id: "pull-request-token",
      uses: CREATE_GITHUB_APP_TOKEN_V3,
      with: {
        "client-id": "${{ inputs.pull-request-client-id }}",
        "private-key": "${{ inputs.pull-request-private-key }}",
        owner: "${{ github.repository_owner }}",
        repositories: "${{ github.event.repository.name }}",
        "permission-contents": "${{ inputs.pull-request-contents-permission }}",
        "permission-pull-requests": "write",
      },
    });
    expect(tokenAction.inputs["pull-request-contents-permission"].required).toBe(false);
    expect(tokenAction.outputs["contents-token"].value).toBe(
      "${{ steps.contents-token.outputs.token }}",
    );
    expect(tokenAction.outputs["pull-request-token"].value).toBe(
      "${{ steps.pull-request-token.outputs.token }}",
    );
    expect(createTokensStep).toMatchObject({
      id: "tokens",
      uses: "./.github/actions/create-generated-pr-tokens",
      with: {
        "contents-client-id": "${{ inputs.contents-client-id }}",
        "contents-private-key": "${{ inputs.contents-private-key }}",
        "pull-request-client-id": "${{ inputs.pull-request-client-id }}",
        "pull-request-contents-permission": "${{ inputs.auto-merge == 'true' && 'write' || '' }}",
        "pull-request-private-key": "${{ inputs.pull-request-private-key }}",
      },
    });
    expect(
      publishAction.runs.steps.filter(
        (step: { uses?: string }) => step.uses === CREATE_GITHUB_APP_TOKEN_V3,
      ),
    ).toEqual([]);
    expect(actionPublishStep.env.CONTENTS_TOKEN).toBe("${{ steps.tokens.outputs.contents-token }}");
    expect(actionPublishStep.env.GH_TOKEN).toBe("${{ steps.tokens.outputs.pull-request-token }}");
    expect(actionPublishStep.env.INVALIDATION_PATHS).toBe("${{ inputs.invalidation-paths }}");
    expect(publishAction.inputs["working-directory"]).toEqual({
      description: "Repository root containing the generated files.",
      required: false,
      default: ".",
    });
    expect(actionPublishStep["working-directory"]).toBe("${{ inputs.working-directory }}");
    expect(publishAction.inputs["overlap-policy"]).toEqual({
      description: "Whether stale inputs or owned-path overlap defer to a successor run or fail.",
      required: false,
      default: "defer",
    });
    expect(publishAction.inputs["auto-merge"]).toEqual({
      description: "Enable squash auto-merge; false rejects an inherited auto-merge request.",
      required: false,
      default: "false",
    });
    expect(actionPublishStep.env.OVERLAP_POLICY).toBe("${{ inputs.overlap-policy }}");
    expect(actionPublishStep.env.AUTO_MERGE).toBe("${{ inputs.auto-merge }}");
    expect(actionPublishStep.run).toContain('case "${OVERLAP_POLICY}" in');
    expect(actionPublishStep.run).toContain("defer | fail");
    expect(actionPublishStep.run).toContain("GIT_TERMINAL_PROMPT=0");
    expect(actionPublishStep.run).toContain(
      'git config --local http.https://github.com/.extraheader "AUTHORIZATION: basic ${git_auth}"',
    );
    expect(actionPublishStep.run).toContain("printf '::add-mask::%s\\n' \"${git_auth}\"");
    expect(actionPublishStep.run).toContain(
      "git config --local --unset-all http.https://github.com/.extraheader",
    );
    expect(actionPublishStep.run).toContain("trap cleanup_git_auth EXIT");
    expect(actionPublishStep.run).not.toContain("gh auth setup-git");
    expect(actionPublishStep.run).toContain("timeout --signal=TERM --kill-after=10s 120s");
    expect(actionPublishStep.run).toContain("--force-with-lease=refs/heads/");
    expect(actionPublishStep.run).toContain(
      "GH013|repository rule violations|required status check",
    );
    expect(actionPublishStep.run).toContain("refusing a doomed retry");
    expect(actionPublishStep.run).toContain("branch_was_deleted");
    expect(actionPublishStep.run).toContain(
      '[[ -n "${remote_head}" && -z "${current_remote_head}" ]]',
    );
    expect(actionPublishStep.run).toContain('push_generated_branch ""');
    expect(actionPublishStep.run).toContain(
      "overlap policy decides whether stale output defers or fails",
    );
    expect(actionPublishStep.run).toContain(
      'gh api --method GET "repos/${GITHUB_REPOSITORY}/pulls"',
    );
    expect(actionPublishStep.run).toContain('-f "head=${GITHUB_REPOSITORY_OWNER}:${HEAD_BRANCH}"');
    expect(actionPublishStep.run).toContain(".head.repo.full_name == env.GITHUB_REPOSITORY");
    expect(actionPublishStep.run).toContain(".head.ref == env.HEAD_BRANCH");
    expect(actionPublishStep.run).toContain(".head.sha");
    expect(actionPublishStep.run).not.toContain("gh pr list");
    expect(actionPublishStep.run).toContain("neutralize_stale_pr");
    expect(actionPublishStep.run).toContain(
      'git diff --quiet "${source_commit}" "${base_ref}" -- "${invalidation_paths[@]}"',
    );
    expect(actionPublishStep.run).not.toContain("force_retirement");
    expect(actionPublishStep.run).toContain("unsafe close mutation");
    expect(actionPublishStep.run).not.toContain("gh pr close");
    expect(actionPublishStep.run).toContain('source_commit="$(git rev-parse HEAD)"');
    expect(actionPublishStep.run).toContain(
      'git merge-base --is-ancestor "${source_commit}" "${base_ref}"',
    );
    expect(actionPublishStep.run).toContain("Snapshot the generator's desired blobs");
    expect(actionPublishStep.run).toContain(
      'git diff --name-only -z --no-renames "${source_commit}" "${desired_commit}"',
    );
    expect(actionPublishStep.run).toContain(
      '[[ "${source_entry}" != "${base_entry}" && "${desired_entry}" != "${base_entry}" ]]',
    );
    expect(actionPublishStep.run).toContain('git switch -C "${HEAD_BRANCH}" "${base_ref}"');
    expect(actionPublishStep.run).toContain(
      'git restore --source="${desired_commit}" --staged --worktree -- "${path}"',
    );
    expect(actionPublishStep.run).not.toContain("git rebase");
    expect(actionPublishStep.run).toContain("verify_publication");
    expect(actionPublishStep.run).toContain("desired_matches_tree");
    expect(actionPublishStep.run).toContain(
      '[[ "${current_remote_head}" != "${published_commit}" ]]',
    );
    expect(actionPublishStep.run).toContain('[[ "${final_pr_head}" != "${published_commit}" ]]');
    expect(actionPublishStep.run).toContain("gh pr edit");
    expect(actionPublishStep.run).toContain("gh pr create");
    expect(actionPublishStep.run).toContain('--base "${BASE_BRANCH}"');
    expect(actionPublishStep.run).toContain('--head "${HEAD_BRANCH}"');
    expect(actionPublishStep.run).toContain('--body-file "${body_file}"');
    expect(actionPublishStep.run).toContain("ensure_auto_merge_compatible");
    expect(actionPublishStep.run).toContain("enable_auto_merge");
    expect(actionPublishStep.run).not.toContain("disable_existing_auto_merge");
    expect(actionPublishStep.run).not.toContain("--disable-auto");
    expect(actionPublishStep.run).toContain("--json autoMergeRequest");
    expect(actionPublishStep.run).not.toContain('GH_TOKEN="${CONTENTS_TOKEN}"');
    expect(actionPublishStep.run).toContain(
      '--auto --squash --match-head-commit "${published_commit}"',
    );
    expect(actionPublishStep.run).not.toContain('HEAD:"${BASE_BRANCH}"');
    expect(readFileSync(".github/workflows/ci.yml", "utf8")).toContain(
      "OPENCLAW_ALLOW_RELEASE_GENERATED_MIX",
    );

    for (const [
      ownerWorkflow,
      refreshJob,
      finalizeJob,
      artifactPattern,
      commitMessage,
      automationBranch,
    ] of [
      [
        workflow,
        refresh,
        nativeFinalize,
        "native-locale-*",
        "chore(i18n): refresh native locales",
        "automation/native-app-locale-refresh",
      ],
      [
        controlUiWorkflow,
        controlUiWorkflow.jobs.refresh,
        controlUiFinalize,
        "control-ui-locale-*",
        "chore(ui): refresh control ui locales",
        "automation/control-ui-locale-refresh",
      ],
    ] as const) {
      const uploadStep = refreshJob.steps.find(
        (step: { name?: string }) => step.name === "Upload locale artifact",
      );
      const downloadStep = finalizeJob.steps.find(
        (step: { name?: string }) => step.name === "Download locale artifacts",
      );
      const checkoutStep = finalizeJob.steps.find(
        (step: { uses?: string }) => step.uses === CHECKOUT_V6,
      );
      const publishStep = finalizeJob.steps.find(
        (step: { name?: string }) => step.name === "Open or update generated locale PR",
      );

      expect(ownerWorkflow.permissions.contents).toBe("read");
      expect(refreshJob.needs).toEqual(["resolve-base", "publisher-preflight"]);
      expect(finalizeJob.needs).toEqual(["resolve-base", "publisher-preflight", "refresh"]);
      const isNative = automationBranch.includes("native");
      expect(finalizeJob.if).toBe(
        isNative
          ? "needs.resolve-base.result == 'success' && needs.publisher-preflight.result == 'success' && needs.refresh.result == 'success'"
          : "needs.resolve-base.result == 'success' && needs.publisher-preflight.result == 'success' && needs.refresh.result == 'success' && !(github.event_name == 'workflow_dispatch' && inputs.token_preflight_only)",
      );
      expect(uploadStep.uses).toBe(UPLOAD_ARTIFACT_V7);
      expect(downloadStep.uses).toBe(DOWNLOAD_ARTIFACT_V8);
      expect(downloadStep.with.pattern).toBe(artifactPattern);
      expect(downloadStep.with["merge-multiple"]).toBe(true);
      expect(checkoutStep.with["persist-credentials"]).toBe(false);
      expect(checkoutStep.with["fetch-depth"]).toBe(0);
      expect(publishStep.uses).toBe("./.github/actions/publish-generated-pr");
      expect(publishStep.with).toMatchObject({
        "contents-client-id": "Iv23liOECG0slfuhz093",
        "contents-private-key": "${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}",
        "pull-request-client-id": MANTIS_GITHUB_APP_CLIENT_ID,
        "pull-request-private-key": "${{ secrets.MANTIS_GITHUB_APP_PRIVATE_KEY }}",
        "base-branch": "${{ github.event.repository.default_branch }}",
        "head-branch": automationBranch,
        "commit-message": commitMessage,
        "pr-title": commitMessage,
      });
      expect(publishStep.with["generated-paths"]).toContain(
        automationBranch.includes("native") ? "apps/.i18n/native" : "ui/src/i18n",
      );
      expect(publishStep.with["invalidation-paths"]).toContain(
        automationBranch.includes("native")
          ? "apps/android/app/src/main"
          : "ui/src/i18n/locales/en.ts",
      );
      expect(publishStep.with["invalidation-paths"]).toContain(
        ".github/actions/create-generated-pr-tokens/action.yml",
      );
      expect(publishStep.with["invalidation-paths"]).toContain(
        ".github/actions/publish-generated-pr/action.yml",
      );
      expect(publishStep.with).not.toHaveProperty("overlap-policy");
      expect(publishStep.with["auto-merge"]).toBe("true");
      expect(publishStep.with["pr-body"]).toContain("## What Problem This Solves");
      expect(publishStep.with["pr-body"]).toContain("## Evidence");
      expect(publishStep.with["pr-body"]).toContain("${{ needs.resolve-base.outputs.sha }}");
      expect(publishStep.with["pr-body"]).not.toContain("${{ github.sha }}");
    }
  });

  it.skipIf(process.platform === "win32")(
    "enables auto-merge for the exact generated pull request head",
    () => {
      const result = runGeneratedPublisherScenario(null, { autoMerge: true });

      expect(result.branchExists).toBe(true);
      expect(result.mergeCalls).toContain("pr merge https://github.com/openclaw/openclaw/pull/1");
      expect(result.mergeCalls).toContain("--auto --squash --match-head-commit");
      expect(result.summary).toContain("Enabled squash auto-merge for exact generated head");
    },
  );

  it.skipIf(process.platform === "win32")(
    "waits for the published pull request head before enabling auto-merge",
    () => {
      const result = runGeneratedPublisherScenario(null, {
        autoMerge: true,
        stalePrViewHeadOnce: true,
      });

      expect(result.mergeCalls).toContain("--auto --squash --match-head-commit");
      expect(result.publishOutput).toContain(
        "Generated pull request head has not converged yet; rechecking",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves inherited auto-merge while replacing a generated pull request head",
    () => {
      const result = runGeneratedPublisherScenario(null, {
        autoMerge: true,
        existingAutoMergeMethod: "SQUASH",
        existingPr: true,
      });

      expect(result.generatedA).toBe("desired-a");
      expect(result.mergeCalls).toBe("");
      expect(result.summary).toContain(
        "Squash auto-merge already enabled for generated pull request",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "accepts inherited auto-merge completing immediately after publication",
    () => {
      const result = runGeneratedPublisherScenario(null, {
        autoMerge: true,
        existingAutoMergeMethod: "SQUASH",
        existingPr: true,
        mergeGeneratedPush: true,
      });

      expect(result.branchExists).toBe(false);
      expect(result.mainGeneratedA).toBe("desired-a");
      expect(result.mergeCalls).toBe("");
      expect(result.summary).toContain(
        "Generated output was merged before pull request reconciliation",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "waits for the existing pull request head before replacing it",
    () => {
      const result = runGeneratedPublisherScenario(null, {
        autoMerge: true,
        existingAutoMergeMethod: "SQUASH",
        existingPr: true,
        stalePrHeadOnce: true,
      });

      expect(result.generatedA).toBe("desired-a");
      expect(result.publishOutput).toContain(
        "Generated pull request head has not converged yet; rechecking",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses to replace an auto-merge-enabled head when publication opts out",
    () => {
      const result = runGeneratedPublisherScenario(null, {
        autoMerge: false,
        existingAutoMergeMethod: "SQUASH",
        existingPr: true,
        expectFailure: true,
      });

      expect(result.generatedA).toBe("stale-pr-a");
      expect(result.mergeCalls).toBe("");
      expect(result.publishOutput).toContain("auto-merge enabled while publication opted out");
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not mutate inherited auto-merge when generated publication fails",
    () => {
      const result = runGeneratedPublisherScenario(null, {
        autoMerge: true,
        existingAutoMergeMethod: "SQUASH",
        existingPr: true,
        expectFailure: true,
        failGeneratedPush: true,
      });

      expect(result.generatedA).toBe("stale-pr-a");
      expect(result.mergeCalls).toBe("");
      expect(result.summary).not.toContain("auto-merge");
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects an incompatible inherited auto-merge method without mutating it",
    () => {
      const result = runGeneratedPublisherScenario(null, {
        autoMerge: true,
        existingAutoMergeMethod: "MERGE",
        existingPr: true,
        expectFailure: true,
      });

      expect(result.generatedA).toBe("stale-pr-a");
      expect(result.mergeCalls).toBe("");
      expect(result.publishOutput).toContain(
        "Generated pull request already uses incompatible MERGE auto-merge",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "defers a newer owned snapshot even when the desired diff is disjoint",
    () => {
      const result = runGeneratedPublisherScenario("b");

      expect(result.branchExists).toBe(false);
      expect(result.summary).toContain(
        "Deferred stale generated output because owned generated paths changed on main.",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "defers instead of overwriting a newer overlapping generated path",
    () => {
      const result = runGeneratedPublisherScenario("a");

      expect(result.branchExists).toBe(false);
      expect(result.summary).toContain(
        "Deferred stale generated output because owned generated paths changed on main.",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "retries a stale pull request head read after the branch push",
    () => {
      const result = runGeneratedPublisherScenario(null, { stalePrHeadOnce: true });

      expect(result.branchExists).toBe(true);
      expect(result.generatedA).toBe("desired-a");
      expect(result.summary).toContain("https://github.com/openclaw/openclaw/pull/1");
    },
  );

  it.skipIf(process.platform === "win32")(
    "defers stale generator inputs and neutralizes an existing pull request",
    () => {
      const result = runGeneratedPublisherScenario(null, {
        existingPr: true,
        updateSource: true,
      });

      expect(result.branchHead).toBe(result.mainHead);
      expect(result.generatedA).toBe("old-a");
      expect(result.summary).toContain(
        "Deferred stale generated output because generator inputs changed on main.",
      );
      expect(result.summary).toContain("Neutralized stale generated pull request");
    },
  );

  it.skipIf(process.platform === "win32")(
    "neutralizes an existing pull request when generation has no changes",
    () => {
      const result = runGeneratedPublisherScenario("b", {
        existingPr: true,
        noGeneratedChange: true,
      });

      expect(result.branchHead).toBe(result.mainHead);
      expect(result.generatedA).toBe("old-a");
      expect(result.generatedB).toBe("newer-b");
      expect(result.summary).toContain(
        "Deferred stale generated output because owned generated paths changed on main.",
      );
      expect(result.summary).toContain("Neutralized stale generated pull request");
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails stale generated publication when no successor run is guaranteed",
    () => {
      const overlap = runGeneratedPublisherScenario("a", {
        expectFailure: true,
        overlapPolicy: "fail",
      });
      expect(overlap.branchExists).toBe(false);
      expect(overlap.publishOutput).toContain(
        "::error::Refusing stale generated output because owned generated paths changed on main.",
      );

      const stalePr = runGeneratedPublisherScenario(null, {
        existingPr: true,
        expectFailure: true,
        noGeneratedChange: true,
        overlapPolicy: "fail",
        updateSource: true,
      });
      expect(stalePr.branchHead).toBe(stalePr.mainHead);
      expect(stalePr.summary).toContain("Neutralized stale generated pull request");
      expect(stalePr.publishOutput).toContain(
        "::error::Refusing stale generated output because generator inputs changed on main.",
      );

      const noPr = runGeneratedPublisherScenario(null, {
        expectFailure: true,
        noGeneratedChange: true,
        overlapPolicy: "fail",
        updateSource: true,
      });
      expect(noPr.branchExists).toBe(false);
      expect(noPr.publishOutput).toContain(
        "::error::Refusing stale generated output because generator inputs changed on main.",
      );

      const unchangedOverlap = runGeneratedPublisherScenario("b", {
        expectFailure: true,
        noGeneratedChange: true,
        overlapPolicy: "fail",
      });
      expect(unchangedOverlap.branchExists).toBe(false);
      expect(unchangedOverlap.publishOutput).toContain(
        "::error::Refusing stale generated output because owned generated paths changed on main.",
      );

      const invalidPolicy = runGeneratedPublisherScenario("b", {
        expectFailure: true,
        overlapPolicy: "continue",
      });
      expect(invalidPolicy.branchExists).toBe(false);
      expect(invalidPolicy.publishOutput).toContain(
        "Generated PR publication overlap policy must be 'defer' or 'fail'.",
      );
    },
  );

  it("fails OpenGrep SARIF artifact uploads when reports are missing", () => {
    const cases = [
      {
        workflowPath: OPENGREP_PR_DIFF_WORKFLOW,
        artifactName: "opengrep-pr-diff-sarif",
      },
      {
        workflowPath: OPENGREP_FULL_WORKFLOW,
        artifactName: "opengrep-full-sarif",
      },
    ];

    for (const item of cases) {
      const workflow = parse(readFileSync(item.workflowPath, "utf8"));
      const uploadStep = workflow.jobs.scan.steps.find(
        (step: WorkflowStep) => step.name === "Upload SARIF as workflow artifact",
      );

      expect(uploadStep.if, item.workflowPath).toBe("always()");
      expect(uploadStep.uses, item.workflowPath).toBe(UPLOAD_ARTIFACT_V7);
      expect(uploadStep.with, item.workflowPath).toMatchObject({
        name: item.artifactName,
        path: ".opengrep-out/precise.sarif",
        "if-no-files-found": "error",
      });
    }
  });

  it("downloads the opengrep installer completely before execution", () => {
    for (const workflowPath of [OPENGREP_PR_DIFF_WORKFLOW, OPENGREP_FULL_WORKFLOW]) {
      const workflow = parse(readFileSync(workflowPath, "utf8"));
      const run = expectDefined(
        workflow.jobs.scan.steps.find((step: WorkflowStep) => step.name === "Install opengrep")
          ?.run,
        `Install opengrep step in ${workflowPath}`,
      );

      expect(run, workflowPath).toContain(
        'installer="$(mktemp "${RUNNER_TEMP}/opengrep-install.XXXXXX")"',
      );
      expect(run, workflowPath).toContain("curl -fsSL --connect-timeout 10 --max-time 120 \\");
      expect(run, workflowPath).toContain('-o "$installer"');
      expect(run, workflowPath).toContain('bash "$installer" -v "$OPENGREP_VERSION"');
      expect(run, workflowPath).toContain("trap 'rm -f \"$installer\"' EXIT");
      expect(run.indexOf('-o "$installer"'), workflowPath).toBeLessThan(
        run.indexOf('bash "$installer"'),
      );
      expect(run, workflowPath).not.toMatch(/\|\s*bash/u);
    }
  });

  it("runs real behavior proof from the trusted workflow revision", () => {
    const workflow = readRealBehaviorProofWorkflow();
    const source = readFileSync(".github/workflows/real-behavior-proof.yml", "utf8");
    const checkout = workflow.jobs["real-behavior-proof"].steps.find(
      (step: WorkflowStep) => step.uses === CHECKOUT_V6,
    );

    expect(checkout.with.ref).toBe("${{ github.workflow_sha }}");
    expect(checkout.with.ref).not.toBe("${{ github.event.pull_request.base.sha }}");
    expect(source).toContain("Old PR events can carry a stale base SHA");
  });

  it("keeps docs-change detection fail-safe and fixture-aware", () => {
    const action = readFileSync(".github/actions/detect-docs-changes/action.yml", "utf8");

    expect(action).toContain("base-sha:");
    expect(action).toContain("docs_only:");
    expect(action).toContain("docs_changed:");
    expect(action).toContain("BASE_SHA: ${{ inputs.base-sha }}");
    expect(action).toContain('BASE="$BASE_SHA"');
    expect(action).toContain(
      'CHANGED=$(git diff --name-only "$BASE" HEAD 2>/dev/null || echo "UNKNOWN")',
    );
    expect(action).toContain('if [ "$CHANGED" = "UNKNOWN" ] || [ -z "$CHANGED" ]; then');
    expect(action).toContain("docs_only=false");
    expect(action).toContain("docs_changed=false");
    expect(action).toContain("test/fixtures/*)");
    expect(action).toContain("docs/* | *.md | *.mdx)");
  });

  it("bounds matrix fan-out for runner-registration pressure", () => {
    const workflow = readCiWorkflow();

    expect(workflow.concurrency.group).toContain("github.event.pull_request.number");
    expect(workflow.concurrency["cancel-in-progress"]).toContain(
      "github.event_name == 'pull_request'",
    );
    expect(workflow.jobs["checks-fast-core"].strategy["max-parallel"]).toBe(12);
    expect(workflow.jobs["checks-node-core-test-nondist-shard"].strategy["max-parallel"]).toBe(28);
    expect(workflow.jobs["checks-fast-plugin-contracts-shard"].strategy["max-parallel"]).toBe(12);
    expect(workflow.jobs["checks-fast-channel-contracts-shard"].strategy["max-parallel"]).toBe(12);
    expect(workflow.jobs["check-shard"].strategy["max-parallel"]).toBe(12);
    expect(workflow.jobs["check-additional-shard"].strategy["max-parallel"]).toBe(12);
    expect(workflow.jobs["checks-windows"].strategy["max-parallel"]).toBe(2);
    expect(workflow.jobs.android.strategy["max-parallel"]).toBe(2);
  });

  it("installs the Android SDK platform used by Gradle", () => {
    const workflow = readCiWorkflow();
    const releaseWorkflow = readAndroidReleaseWorkflow();
    const action = readAndroidToolchainAction();
    const appCompileSdk = readAndroidCompileSdk("apps/android/app/build.gradle.kts");
    const benchmarkCompileSdk = readAndroidCompileSdk("apps/android/benchmark/build.gradle.kts");
    const packageId = `platforms;android-${appCompileSdk}.0`;

    expect(appCompileSdk).toBe(benchmarkCompileSdk);
    expect(
      workflow.jobs.android.steps.filter(
        (step: WorkflowStep) =>
          step.uses === "./.ci-workflow/.github/actions/setup-android-toolchain",
      ),
    ).toHaveLength(1);
    expect(
      releaseWorkflow.jobs.publish_signed_android_apk.steps.filter(
        (step: WorkflowStep) => step.uses === "./.github/actions/setup-android-toolchain",
      ),
    ).toHaveLength(1);

    const cacheStep = expectDefined(
      action.runs.steps.find((step: WorkflowStep) => step.name === "Cache Android SDK"),
      "Android SDK cache step",
    );
    const javaStep = expectDefined(
      action.runs.steps.find((step: WorkflowStep) => step.name === "Setup Java"),
      "Android Java setup step",
    );
    const installStep = expectDefined(
      action.runs.steps.find((step: WorkflowStep) => step.name === "Install Android SDK packages"),
      "Android SDK package install step",
    );

    expect(javaStep.uses).toBe("actions/setup-java@ad2b38190b15e4d6bdf0c97fb4fca8412226d287");
    expect(javaStep.with).toMatchObject({
      cache: "gradle",
      distribution: "temurin",
      "java-version": 17,
    });
    expect(javaStep.with?.["cache-dependency-path"]).toContain(
      "apps/android/gradle/libs.versions.toml",
    );
    expect(cacheStep.with?.key).toContain(`platform-${appCompileSdk}.0-`);
    expect(installStep.run).toContain(`"${packageId}"`);
    expect(installStep.run).toContain(
      'yes | sdkmanager --sdk_root="${ANDROID_SDK_ROOT}" --licenses >/dev/null || [[ "${PIPESTATUS[1]}" -eq 0 ]]',
    );
  });

  it("loads Android CI setup from the workflow revision for frozen targets", () => {
    const steps = readCiWorkflow().jobs.android.steps as WorkflowStep[];
    const checkoutIndex = steps.findIndex((step) => step.name === "Checkout");
    const actionCheckoutIndex = steps.findIndex(
      (step) => step.name === "Checkout CI Android toolchain action",
    );
    const setupIndex = steps.findIndex((step) => step.name === "Setup Android toolchain");
    const actionCheckout = expectDefined(steps[actionCheckoutIndex], "Android action checkout");

    expect(actionCheckout.uses).toBe(CHECKOUT_V6);
    expect(actionCheckout.with).toMatchObject({
      path: ".ci-workflow",
      "persist-credentials": false,
      ref: "${{ github.workflow_sha }}",
      "sparse-checkout": ".github/actions/setup-android-toolchain",
    });
    expect(checkoutIndex).toBeLessThan(actionCheckoutIndex);
    expect(actionCheckoutIndex).toBeLessThan(setupIndex);
  });

  it("bounds Android SDK command-line tools downloads", () => {
    const action = readAndroidToolchainAction();
    const setupStep = expectDefined(
      action.runs.steps.find((step: WorkflowStep) =>
        step.run?.includes("commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip"),
      ),
      "Android SDK setup step",
    );

    expect(setupStep.run).toContain("curl -fsSL --connect-timeout 10 --max-time 300");
  });

  it("covers Android app variants, lint, and benchmark compilation", () => {
    const workflow = readCiWorkflow();
    const source = readFileSync(".github/workflows/ci.yml", "utf8");
    const runStep = workflow.jobs.android.steps.find(
      (step: WorkflowStep) => step.name === "Run Android ${{ matrix.task }}",
    );

    expect(source).toContain('task: useCompatibleAndroidCi ? "test-play-compat" : "test-play"');
    expect(source).toContain(
      '{ check_name: "android-test-third-party", task: "test-third-party" }',
    );
    expect(source).toContain('check_name: "android-build-play"');
    expect(source).toContain('task: useCompatibleAndroidCi ? "build-play-compat" : "build-play"');
    expect(runStep.run).toContain(":app:testPlayDebugUnitTest");
    expect(runStep.run).toContain(":app:testThirdPartyDebugUnitTest");
    expect(runStep.run).toContain(":app:assemblePlayDebug");
    expect(runStep.run).toContain(":app:assembleThirdPartyDebug");
    expect(runStep.run).toContain(":app:lintPlayDebug");
    expect(runStep.run).toContain(":app:lintThirdPartyDebug");
    expect(runStep.run).toContain(":benchmark:assembleDebug");
  });

  it("runs canonical main CI single-flight while coalescing the pending tip", () => {
    const workflow = readCiWorkflow();

    // GitHub concurrency keeps one running and one pending run by default.
    // Replacing only the pending run preserves a complete integration cycle
    // while coalescing merge bursts to the newest main tip.
    expect(workflow.concurrency["cancel-in-progress"]).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
    expect(workflow.jobs["runner-admission"]).toBeUndefined();
    const preflight = workflow.jobs.preflight;
    expect(preflight.needs).toBeUndefined();
    expect(preflight.env?.OPENCLAW_MAIN_CI_DEBOUNCE_SECONDS).toBeUndefined();
    const steps = preflight.steps as Array<{ if?: string; name?: string; run?: string }>;
    expect(steps.some((step) => step.name === "Record debounce epoch")).toBe(false);
    expect(steps.some((step) => step.name === "Debounce canonical main fan-out")).toBe(false);
    expect(workflow.jobs["security-fast"].needs).toBeUndefined();
  });

  it("keeps CodeQL critical quality scans off Blacksmith registrations", () => {
    const source = readCriticalQualityWorkflow();
    const workflow = parse(source);
    const blacksmithJobs = Object.entries(workflow.jobs)
      .filter(([, job]) => job && typeof job === "object")
      .filter(([, job]) => (job as Record<string, unknown>)["runs-on"] !== "ubuntu-24.04")
      .map(([name]) => name);

    expect(blacksmithJobs).toEqual([]);
    expect(source).not.toContain("blacksmith-");
  });

  it("keeps security checks hosted and the cache writer on Blacksmith", () => {
    const workflow = readCiWorkflow();

    expect(workflow.jobs.preflight["runs-on"]).toContain("blacksmith-4vcpu-ubuntu-2404");
    expect(workflow.jobs["security-fast"]["runs-on"]).toBe("ubuntu-24.04");
    expect(workflow.jobs["pnpm-store-warmup"]["runs-on"]).toContain("blacksmith-4vcpu-ubuntu-2404");
  });

  it("scans only the pull request commit range for leaked credentials", () => {
    const securitySteps = readCiWorkflow().jobs["security-fast"].steps as WorkflowStep[];
    const fetchScanHistoryIndex = securitySteps.findIndex(
      (step) => step.name === "Fetch pull request scan history",
    );
    const scanIndex = securitySteps.findIndex(
      (step) => step.name === "Scan pull request for leaked credentials",
    );
    const fetchScanHistoryStep = expectDefined(
      securitySteps[fetchScanHistoryIndex],
      "TruffleHog history fetch step",
    );
    const scanStep = expectDefined(securitySteps[scanIndex], "TruffleHog pull request scan step");

    expect(scanIndex).toBeGreaterThan(fetchScanHistoryIndex);
    expect(fetchScanHistoryStep.if).toBe("github.event_name == 'pull_request'");
    expect(fetchScanHistoryStep.env).toEqual({
      PR_COMMIT_COUNT: "${{ github.event.pull_request.commits }}",
      PR_MERGE_SHA: "${{ github.sha }}",
    });
    expect(fetchScanHistoryStep.run).toContain("fetch_depth=$((PR_COMMIT_COUNT + 2))");
    expect(fetchScanHistoryStep.run).toContain(
      'fetch --no-tags --no-recurse-submodules --depth="$fetch_depth" origin "$PR_MERGE_SHA"',
    );
    expect(scanStep.if).toBe("github.event_name == 'pull_request'");
    expect(scanStep.uses).toBe(TRUFFLEHOG_V3_95_9);
    expect(scanStep.with).toEqual({
      base: "${{ steps.diff_base.outputs.sha }}",
      head: "${{ github.sha }}",
      version: "3.95.9@sha256:59b244249d1a1aef4baa24fe73d3c931616264482580d806d77f6c74d26b3e42",
      extra_args: "--results=verified,unknown --fail-on-scan-errors",
    });
  });

  it("keeps sticky dependency snapshots on trusted Blacksmith Node shards", () => {
    const workflow = readCiWorkflow();
    const blacksmithJobs = Object.entries(workflow.jobs).filter(([, job]) => {
      const runsOn = (job as { "runs-on"?: unknown })["runs-on"];
      return typeof runsOn === "string" && runsOn.includes("blacksmith-");
    });
    const stickySteps = Object.entries(workflow.jobs).flatMap(([jobName, job]) => {
      const steps = (job as { steps?: WorkflowStep[] }).steps ?? [];
      return steps.flatMap((step) => {
        const stepWith = step.with;
        if (!stepWith || stepWith["sticky-disk"] === undefined) {
          return [];
        }
        return [{ jobName, stepWith }];
      });
    });
    const preflightWriter = stickySteps.find((entry) => entry.jobName === "preflight");
    const stickyConsumers = stickySteps.filter((entry) => entry.jobName !== "preflight");
    // Every Linux Blacksmith lane that installs Node dependencies consumes
    // the snapshot; missing entries silently pay the full install again.
    expect(stickyConsumers.map((entry) => entry.jobName).toSorted()).toEqual([
      "build-artifacts",
      "check-additional-shard",
      "check-docs",
      "check-shard",
      "checks-fast-channel-contracts-shard",
      "checks-fast-core",
      "checks-fast-plugin-contracts-shard",
      "checks-node-core-test-nondist-shard",
      "checks-ui",
      "control-ui-i18n",
      "native-i18n",
      "qa-smoke-ci-profile",
    ]);
    for (const { jobName, stepWith } of stickyConsumers) {
      const stickyCondition = stepWith["sticky-disk"];
      const cacheCondition = stepWith["use-actions-cache"];
      expect(stickyCondition, jobName).toContain("github.event_name != 'workflow_dispatch'");
      expect(stickyCondition, jobName).toContain(
        "github.event.pull_request.head.repo.full_name == 'openclaw/openclaw'",
      );
      expect(cacheCondition, jobName).toContain("github.event_name != 'workflow_dispatch'");
      expect(cacheCondition, jobName).toContain(
        "github.event.pull_request.head.repo.full_name == 'openclaw/openclaw'",
      );
      expect(cacheCondition, jobName).toContain("&& 'false' || 'true'");
    }
    // Required CI jobs only clone the snapshot. The disposable warmer below
    // owns commits so writer coalescing cannot cancel a required build job.
    for (const { jobName, stepWith } of stickyConsumers) {
      expect(stepWith["save-sticky-disk"], jobName).toBeUndefined();
    }
    expect(preflightWriter?.stepWith).toMatchObject({
      "save-sticky-disk": "true",
      "sticky-disk": "true",
      "use-actions-cache": "false",
    });
    const preflightSteps = workflow.jobs.preflight.steps as WorkflowStep[];
    const refreshStep = preflightSteps.find(
      (step: WorkflowStep) => step.name === "Refresh sticky dependency snapshot",
    )!;
    const maintainStep = preflightSteps.find(
      (step: WorkflowStep) => step.name === "Maintain sticky dependency store budget",
    )!;
    expect(refreshStep.if).toContain("github.event_name == 'push'");
    expect(refreshStep.if).toContain("github.repository == 'openclaw/openclaw'");
    expect(refreshStep.if).toContain("github.ref == 'refs/heads/main'");
    expect(refreshStep.if).toContain("steps.manifest.outputs.run_node == 'true'");
    expect(maintainStep.if).toBe(refreshStep.if);
    expect(preflightSteps.indexOf(refreshStep)).toBeLessThan(preflightSteps.indexOf(maintainStep));
    expect(maintainStep.env?.OPENCLAW_PNPM_STORE_MAX_KIB).toBe("8388608");
    expect(maintainStep.run).toContain('store_dir="${PNPM_CONFIG_STORE_DIR:?}"');
    expect(maintainStep.run).toContain('PNPM_CONFIG_STORE_DIR="$store_dir" pnpm store prune');
    expect(maintainStep.run).toContain('>> "$GITHUB_STEP_SUMMARY"');
    expect(workflow.jobs["pnpm-store-warmup"].if).toContain("github.ref == 'refs/heads/main'");
    expect(workflow.jobs["pnpm-store-warmup"].if).toContain(
      "github.repository == 'openclaw/openclaw'",
    );
    // Current sticky consumers all use the single supported Node line. A
    // planner-provided version would silently create a writerless disk.
    for (const { jobName, stepWith } of stickyConsumers) {
      const nodeVersion = stepWith["node-version"];
      expect(
        nodeVersion === undefined ||
          nodeVersion === "24.x" ||
          nodeVersion === "${{ matrix.node_version || '24.x' }}",
        `${jobName} must resolve to the writer's 24.x snapshot key (got ${String(nodeVersion)})`,
      ).toBe(true);
      if (nodeVersion === "${{ matrix.node_version || '24.x' }}") {
        expect(stepWith["sticky-disk"], jobName).toContain(
          "matrix.node_version == null || matrix.node_version == '24.x'",
        );
      }
    }
    const warmWorkflow = parse(readFileSync(".github/workflows/vitest-cache-warm.yml", "utf8"));
    const warmSetupStep = warmWorkflow.jobs.warm.steps.find(
      (step: WorkflowStep) => step.name === "Setup Node environment",
    );
    expect(warmSetupStep.with["save-sticky-disk"]).toBeUndefined();
    expect(warmSetupStep.with["sticky-disk"]).toBe("false");
    expect(warmWorkflow.on).not.toHaveProperty("pull_request");
    expect(warmWorkflow.on).not.toHaveProperty("workflow_dispatch");
    expect(warmWorkflow.on).not.toHaveProperty("workflow_run");
    const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
    const validateLayoutStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Validate sticky pnpm layout",
    );
    const setupPnpmStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Setup pnpm",
    );
    const mountStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Mount dependency sticky disk",
    );
    const cleanupStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Register sticky bind cleanup",
    );
    const bindStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Bind sticky node_modules into workspace",
    );
    const installStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Install dependencies",
    );

    expect(blacksmithJobs.length).toBeGreaterThan(0);
    for (const [jobName, job] of blacksmithJobs) {
      expect(
        (job as { "runs-on": string })["runs-on"],
        `${jobName} must route fork pull requests to GitHub-hosted runners`,
      ).toContain(
        "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == 'openclaw/openclaw'",
      );
    }
    expect(action.inputs["sticky-disk"].default).toBe("false");
    // Writers omit node-version, so the default is the writers' key segment.
    expect(action.inputs["node-version"].default).toBe("24.x");
    expect(action.inputs["save-sticky-disk"].default).toBe("false");
    expect(validateLayoutStep.if).toBe("inputs.sticky-disk == 'true'");
    expect(validateLayoutStep.run).toContain("for config_name in modules-dir virtual-store-dir");
    expect(validateLayoutStep.run).toContain('config_value="$(pnpm config get "$config_name")"');
    expect(validateLayoutStep.run).toContain(
      "sticky mode requires pnpm's stock node_modules layout",
    );
    expect(action.runs.steps.indexOf(setupPnpmStep)).toBeLessThan(
      action.runs.steps.indexOf(validateLayoutStep),
    );
    expect(action.runs.steps.indexOf(validateLayoutStep)).toBeLessThan(
      action.runs.steps.indexOf(mountStep),
    );
    expect(mountStep).toMatchObject({
      if: "inputs.sticky-disk == 'true'",
      uses: "useblacksmith/stickydisk@6d373c96a74cbde0c99fedc5ea5d3a7ba66ba494",
      with: {
        path: "/var/tmp/openclaw-node-deps",
      },
    });
    // Bounded disks: Blacksmith caps sticky disks per installation, and the old
    // per-PR/per-manifest-hash keys saturated that cap. Install inputs and exact
    // runtime patches belong in the marker, not the backing-disk key.
    expect(mountStep.with.key).toBe(
      "${{ github.repository }}-node-deps-bind-v6-${{ inputs.node-version }}",
    );
    expect(mountStep.with.commit).toBe(
      "${{ inputs.save-sticky-disk == 'true' && github.event_name != 'pull_request' && 'true' || 'false' }}",
    );
    expect(cleanupStep).toMatchObject({
      if: "inputs.sticky-disk == 'true'",
      uses: "./.github/actions/register-bind-mount-cleanup",
      with: { path: "${{ github.workspace }}/node_modules" },
    });
    expect(action.runs.steps.indexOf(mountStep)).toBeLessThan(
      action.runs.steps.indexOf(cleanupStep),
    );
    expect(action.runs.steps.indexOf(cleanupStep)).toBeLessThan(
      action.runs.steps.indexOf(bindStep),
    );
    expect(bindStep.run).toContain('sudo mount --bind "$sticky_modules" "$workspace_modules"');
    expect(bindStep.run).toContain('echo "PNPM_CONFIG_STORE_DIR=$sticky_store"');
    expect(bindStep.run).toContain('echo "OPENCLAW_BUILD_ALL_NO_PNPM=1"');
    expect(bindStep.run).toContain(
      'deps_fingerprint="os-${RUNNER_OS:?}-arch-${RUNNER_ARCH:?}-node-$(node --version)-${deps_input_fingerprint:?}"',
    );
    expect(bindStep.run).toContain('echo "OPENCLAW_STICKY_DEPS_FINGERPRINT=$deps_fingerprint"');
    expect(bindStep.run).not.toContain("PNPM_CONFIG_MODULES_DIR");
    expect(bindStep.run).not.toContain("PNPM_CONFIG_VIRTUAL_STORE_DIR");
    // Compute from the checkout before the bind mount adds snapshot-internal
    // manifests. Ordinary package scripts must not rotate dependency trees.
    expect(bindStep.env.FROZEN_LOCKFILE).toBe("${{ inputs.frozen-lockfile }}");
    expect(bindStep.env).not.toHaveProperty("DEPS_INPUT_FINGERPRINT");
    expect(bindStep.run).toContain('node "$GITHUB_ACTION_PATH/dependency-fingerprint.mjs"');
    expect(bindStep.run.indexOf("dependency-fingerprint.mjs")).toBeLessThan(
      bindStep.run.indexOf('sudo mount --bind "$sticky_modules" "$workspace_modules"'),
    );
    expect(installStep.env).toMatchObject({
      STICKY_DISK: "${{ inputs.sticky-disk }}",
      STICKY_ROOT: "/var/tmp/openclaw-node-deps",
      STICKY_WRITER:
        "${{ inputs.save-sticky-disk == 'true' && github.event_name != 'pull_request' && 'true' || 'false' }}",
    });
    expect(installStep.run).toContain('sticky_marker="$STICKY_ROOT/.openclaw-deps-fingerprint"');
    expect(installStep.run).toContain(
      '[ "$sticky_fingerprint" = "${OPENCLAW_STICKY_DEPS_FINGERPRINT:?}" ]',
    );
    expect(installStep.run).toContain('sticky_fingerprint_matches="true"');
    expect(installStep.run).toContain(
      "Sticky dependency fingerprint matches, but restored importer contents are incomplete; reinstalling",
    );
    expect(installStep.run).toContain('[ "$STICKY_WRITER" != "true" ]');
    expect(installStep.run).toContain('sudo umount "$GITHUB_WORKSPACE/node_modules"');
    expect(installStep.run).toContain('ephemeral_store="${RUNNER_TEMP:?}/openclaw-pnpm-store"');
    expect(installStep.run).toContain(
      "Sticky dependency snapshot is unusable; using runner-local storage for this read-only run",
    );
    expect(installStep.run).toContain(
      'bash "$GITHUB_ACTION_PATH/sticky-importers.sh" restore "$STICKY_ROOT" "$GITHUB_WORKSPACE"',
    );
    expect(installStep.run).toContain(
      "Sticky dependency snapshot matches the install fingerprint and importer contents; skipping pnpm install",
    );
    expect(installStep.run).toContain("timeout --signal=TERM --kill-after=15s 4m");
    expect(installStep.run).toContain('pnpm "${install_args[@]}" --config.fetch-retries=0');
    expect(installStep.run).toContain("install_attempts=2");
    expect(installStep.run).toContain("install_attempts=3");
    expect(installStep.run).toContain(
      "for (( attempt = 1; attempt <= install_attempts; attempt += 1 )); do",
    );
    expect(installStep.run).toContain('if [ "$install_status" -ne 0 ]; then');
    expect(installStep.run).not.toContain("accepting the populated sticky tree");
    // Read-only consumers never capture; only the designated writer refreshes
    // the archive and publishes the fingerprint after a successful install.
    expect(installStep.run).toContain('[ "$STICKY_WRITER" = "true" ]');
    expect(installStep.run.indexOf('pnpm "${install_args[@]}"')).toBeLessThan(
      installStep.run.indexOf(
        'bash "$GITHUB_ACTION_PATH/sticky-importers.sh" capture "$STICKY_ROOT" "$GITHUB_WORKSPACE" "$OPENCLAW_STICKY_DEPS_FINGERPRINT"',
      ),
    );
    // The content-validated snapshot or successful install already owns
    // dependency validation. pnpm's redundant check sees intentionally pruned
    // plugin importers as stale, so it must not mutate during shard fanout.
    const disableImplicitInstall =
      'echo "pnpm_config_verify_deps_before_run=false" >> "$GITHUB_ENV"';
    expect(installStep.run).toContain('if [ "$STICKY_DISK" = "true" ]; then');
    expect(installStep.run).not.toContain("pnpm_config_verify_deps_before_run=install pnpm exec");
    expect(installStep.run).toContain(disableImplicitInstall);
    expect(installStep.run.indexOf('sticky-importers.sh" restore')).toBeLessThan(
      installStep.run.indexOf(disableImplicitInstall),
    );
    const cleanupAction = parse(
      readFileSync(".github/actions/register-bind-mount-cleanup/action.yml", "utf8"),
    );
    expect(cleanupAction.runs).toMatchObject({
      using: "node24",
      main: "main.cjs",
      post: "post.cjs",
      "post-if": "always()",
    });
    const cleanupPost = readFileSync(
      ".github/actions/register-bind-mount-cleanup/post.cjs",
      "utf8",
    );
    expect(cleanupPost).toContain("mountpoint.status === 32");
    expect(cleanupPost).toContain('spawnSync("sudo", ["umount", mountPath]');
    expect(readFileSync(".github/actions/setup-pnpm-store-cache/action.yml", "utf8")).toContain(
      "actions/cache/restore@",
    );
  });

  it("persists content-validated public full-build declarations", () => {
    const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
    const installStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Install dependencies",
    );
    const cacheStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Restore and save build-all cache",
    );

    expect(action.inputs["build-all-cache-scope"].default).toBe("");
    expect(cacheStep).toMatchObject({
      if: "inputs.build-all-cache-scope != ''",
      uses: "actions/cache@27d5ce7f107fe9357f9df03efb73ab90386fccae",
      with: { path: ".artifacts/build-all-cache" },
    });
    expect(cacheStep.with.key).toContain("build-all-v1-${{ inputs.build-all-cache-scope }}");
    expect(cacheStep.with.key).toContain("${{ runner.os }}-${{ runner.arch }}");
    expect(cacheStep.with.key).toContain("scripts/lib/optional-bundled-clusters.mjs");
    expect(cacheStep.with.key).toContain("'src/**', 'packages/**', 'extensions/**'");
    expect(cacheStep.with["restore-keys"]).not.toContain("hashFiles");
    expect(action.runs.steps.indexOf(installStep)).toBeLessThan(
      action.runs.steps.indexOf(cacheStep),
    );

    const privateQaWorkflows = [
      ".github/workflows/mantis-discord-smoke.yml",
      ".github/workflows/mantis-discord-status-reactions.yml",
      ".github/workflows/mantis-discord-thread-attachment.yml",
      ".github/workflows/mantis-slack-desktop-smoke.yml",
      ".github/workflows/mantis-telegram-live.yml",
      ".github/workflows/qa-live-transports-convex.yml",
    ];
    for (const workflowPath of privateQaWorkflows) {
      const source = readFileSync(workflowPath, "utf8");
      expect(source, workflowPath).not.toContain("build-all-cache-scope:");
    }
  });

  it("persists Node 22 declarations through trusted bounded artifacts", () => {
    const workflow = parse(readFileSync(".github/workflows/node22-compat.yml", "utf8"));
    const steps = workflow.jobs.compat.steps as WorkflowStep[];
    const setupStep = steps.find((step) => step.name === "Setup Node environment");
    const resolveStep = steps.find(
      (step) => step.name === "Resolve trusted declaration cache artifact",
    );
    const downloadStep = steps.find(
      (step) => step.name === "Restore trusted declaration cache artifact",
    );
    const uploadStep = steps.find(
      (step) => step.name === "Publish trusted declaration cache artifact",
    );

    expect(workflow.permissions).toMatchObject({ actions: "read", contents: "read" });
    expect(setupStep?.with).not.toHaveProperty("build-all-cache-scope");
    expect(resolveStep?.run).toContain('.head_branch == "main"');
    expect(resolveStep?.run).toContain('(.path | split("@")[0])');
    expect(resolveStep?.run).toContain('.conclusion == "success"');
    expect(resolveStep?.run).toContain("status=success&per_page=5");
    expect(resolveStep?.run).toContain("artifacts?per_page=10");
    expect(resolveStep?.run).not.toContain("--paginate");
    expect(downloadStep).toMatchObject({
      if: "steps.declaration_cache.outputs.artifact_id != ''",
      uses: DOWNLOAD_ARTIFACT_V8,
      with: {
        path: ".artifacts/build-all-cache",
        repository: "${{ github.repository }}",
      },
    });
    expect(uploadStep).toMatchObject({
      if: "success() && github.repository == 'openclaw/openclaw' && github.ref == 'refs/heads/main'",
      uses: UPLOAD_ARTIFACT_V7,
      with: {
        "if-no-files-found": "error",
        "include-hidden-files": true,
        overwrite: true,
        path: ".artifacts/build-all-cache",
        "retention-days": 14,
      },
    });
  });

  it("restores importer-local node_modules from sticky snapshots", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-sticky-importers-"));
    try {
      const workspace = path.join(root, "workspace");
      const stickyRoot = path.join(root, "sticky");
      const importerRoot = path.join(workspace, "packages", "example");
      const rootModules = path.join(workspace, "node_modules");
      const importerModules = path.join(importerRoot, "node_modules");
      const rootDependency = path.join(rootModules, "ipaddr.js");
      const rootOptionalDependency = path.join(rootModules, "optional-ipaddr");
      const importerDependency = path.join(importerModules, "ipaddr.js");
      const helper = path.resolve(".github/actions/setup-node-env/sticky-importers.sh");
      const lockfile = [
        "lockfileVersion: '9.0'",
        "importers:",
        "  packages/example:",
        "    dependencies:",
        "      ipaddr.js:",
        "        specifier: 2.4.0",
        "        version: 2.4.0",
        "      aliased-ipaddr:",
        "        specifier: npm:ipaddr.js@2.4.0",
        "        version: ipaddr.js@2.4.0",
        "      local-helper:",
        "        specifier: file:../local-helper",
        "        version: file:../local-helper",
        "    optionalDependencies:",
        "      optional-ipaddr:",
        "        specifier: npm:ipaddr.js@2.4.0",
        "        version: ipaddr.js@2.4.0",
        "      unsupported-optional:",
        "        specifier: 3.0.0",
        "        version: 3.0.0",
        "",
      ].join("\n");
      mkdirSync(workspace, { recursive: true });
      writeFileSync(path.join(workspace, "pnpm-lock.yaml"), lockfile, "utf8");
      mkdirSync(rootDependency, { recursive: true });
      mkdirSync(rootOptionalDependency, { recursive: true });
      mkdirSync(importerDependency, { recursive: true });
      writeFileSync(
        path.join(rootDependency, "package.json"),
        JSON.stringify({ name: "ipaddr.js", version: "1.9.1" }),
        "utf8",
      );
      writeFileSync(
        path.join(rootOptionalDependency, "package.json"),
        JSON.stringify({ name: "ipaddr.js", version: "1.9.1" }),
        "utf8",
      );
      writeFileSync(
        path.join(importerDependency, "package.json"),
        JSON.stringify({ name: "ipaddr.js", version: "2.4.0" }),
        "utf8",
      );
      for (const dependencyName of ["aliased-ipaddr", "optional-ipaddr"]) {
        const dependencyRoot = path.join(importerModules, dependencyName);
        mkdirSync(dependencyRoot, { recursive: true });
        writeFileSync(
          path.join(dependencyRoot, "package.json"),
          JSON.stringify({ name: "ipaddr.js", version: "2.4.0" }),
          "utf8",
        );
      }
      writeFileSync(
        path.join(rootModules, ".modules.yaml"),
        JSON.stringify({
          hoistedLocations: {
            "ipaddr.js@1.9.1": ["node_modules/ipaddr.js", "node_modules/optional-ipaddr"],
            "ipaddr.js@2.4.0": [
              "packages/example/node_modules/ipaddr.js",
              "packages/example/node_modules/aliased-ipaddr",
              "packages/example/node_modules/optional-ipaddr",
            ],
          },
        }),
        "utf8",
      );
      writeFileSync(path.join(rootModules, "root-sentinel"), "before", "utf8");

      execFileSync("bash", [helper, "capture", stickyRoot, workspace, "fingerprint-a"]);
      rmSync(importerModules, { recursive: true });
      writeFileSync(path.join(rootModules, "root-sentinel"), "after", "utf8");
      execFileSync("bash", [helper, "restore", stickyRoot, workspace]);

      expect(
        JSON.parse(readFileSync(path.join(importerDependency, "package.json"), "utf8")),
      ).toMatchObject({ version: "2.4.0" });
      expect(readFileSync(path.join(rootModules, "root-sentinel"), "utf8")).toBe("after");
      expect(readFileSync(path.join(stickyRoot, ".openclaw-deps-fingerprint"), "utf8")).toBe(
        "fingerprint-a\n",
      );

      // Recreate the reported failure shape: a marker-matching archive can be
      // structurally valid yet omit the importer-local override, causing Node
      // to fall through to the stale root-hoisted version.
      rmSync(importerModules, { recursive: true });
      const archive = path.join(stickyRoot, "importer-node-modules.tar");
      execFileSync("tar", ["--create", "--file", archive, "--files-from", "/dev/null"]);
      const manifest = path.join(stickyRoot, "importer-node-modules.manifest");
      const archiveChecksum = createHash("sha256").update(readFileSync(archive)).digest("hex");
      const manifestChecksum = createHash("sha256").update(readFileSync(manifest)).digest("hex");
      writeFileSync(
        path.join(stickyRoot, ".openclaw-importer-archive.sha256"),
        `${archiveChecksum}\n${manifestChecksum}\n`,
        "utf8",
      );
      const failedRestore = spawnSync("bash", [helper, "restore", stickyRoot, workspace], {
        encoding: "utf8",
      });
      expect(failedRestore.status).toBe(1);
      expect(failedRestore.stderr).toContain(
        "ipaddr.js expected ipaddr.js@2.4.0, resolved ipaddr.js@1.9.1",
      );
      expect(existsSync(importerModules)).toBe(false);

      const failedCapture = spawnSync(
        "bash",
        [helper, "capture", stickyRoot, workspace, "fingerprint-b"],
        { encoding: "utf8" },
      );
      expect(failedCapture.status).toBe(1);
      expect(failedCapture.stderr).toContain(
        "ipaddr.js expected ipaddr.js@2.4.0, resolved ipaddr.js@1.9.1",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fingerprints dependency install inputs without ordinary script churn", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-dependency-fingerprint-"));
    try {
      const helper = path.resolve(".github/actions/setup-node-env/dependency-fingerprint.mjs");
      const writeManifest = (manifest: Record<string, unknown>) => {
        writeFileSync(path.join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      };
      const fingerprint = (frozenLockfile = true) =>
        execFileSync(
          process.execPath,
          [helper, "--workspace", root, "--frozen-lockfile", frozenLockfile ? "true" : "false"],
          { encoding: "utf8" },
        ).trim();

      execFileSync("git", ["init", "-q"], { cwd: root });
      writeManifest({
        name: "fixture",
        scripts: {
          postinstall: "node scripts/postinstall-bundled-plugins.mjs",
          preinstall: "node scripts/preinstall-package-manager-warning.mjs",
          prepare: "node scripts/prepare-git-hooks.mjs",
          test: "vitest run",
        },
        devDependencies: { vitest: "1.0.0" },
      });
      writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      execFileSync("git", ["add", "package.json", "pnpm-lock.yaml"], { cwd: root });

      const baseline = fingerprint();
      expect(baseline).toMatch(/^v2-[a-f0-9]{64}$/);

      // Presence is part of the record type, so a real file cannot collide
      // with the representation of an absent optional install input.
      writeFileSync(path.join(root, ".pnpmfile.cjs"), "<missing>");
      expect(fingerprint()).not.toBe(baseline);
      rmSync(path.join(root, ".pnpmfile.cjs"));
      expect(fingerprint()).toBe(baseline);

      mkdirSync(path.join(root, "scripts"), { recursive: true });
      writeFileSync(path.join(root, "scripts", "prepare-git-hooks.mjs"), "export {};\n");
      expect(fingerprint()).not.toBe(baseline);
      rmSync(path.join(root, "scripts"), { recursive: true });
      expect(fingerprint()).toBe(baseline);

      // Formatting, key order, and scripts that pnpm install never executes
      // should keep the existing dependency snapshot warm.
      writeManifest({
        devDependencies: { vitest: "1.0.0" },
        scripts: {
          test: "vitest run --reporter=dot",
          prepare: "node scripts/prepare-git-hooks.mjs",
          postinstall: "node scripts/postinstall-bundled-plugins.mjs",
          preinstall: "node scripts/preinstall-package-manager-warning.mjs",
        },
        name: "fixture",
      });
      expect(fingerprint()).toBe(baseline);

      writeManifest({
        name: "fixture",
        scripts: {
          postinstall: "node scripts/postinstall-bundled-plugins.mjs",
          preinstall: "node scripts/preinstall-package-manager-warning.mjs",
          prepare: "node scripts/prepare-git-hooks.mjs",
          test: "vitest run",
        },
        devDependencies: { vitest: "2.0.0" },
      });
      expect(fingerprint()).not.toBe(baseline);

      writeManifest({
        name: "fixture",
        scripts: { postinstall: "node install-v2.mjs", test: "vitest run" },
        devDependencies: { vitest: "1.0.0" },
      });
      expect(() => fingerprint()).toThrow(/unaudited install lifecycle scripts in package\.json/);

      mkdirSync(path.join(root, "packages", "worker"), { recursive: true });
      writeManifest({
        name: "fixture",
        scripts: {
          postinstall: "node scripts/postinstall-bundled-plugins.mjs",
          preinstall: "node scripts/preinstall-package-manager-warning.mjs",
          prepare: "node scripts/prepare-git-hooks.mjs",
        },
        devDependencies: { vitest: "1.0.0" },
      });
      const workerManifest = path.join(root, "packages", "worker", "package.json");
      writeFileSync(
        workerManifest,
        `${JSON.stringify({ name: "worker", scripts: { prepare: "node build.mjs" } })}\n`,
      );
      execFileSync("git", ["add", "packages/worker/package.json"], { cwd: root });
      expect(() => fingerprint()).toThrow(
        /unaudited install lifecycle scripts in packages\/worker\/package\.json/,
      );
      writeFileSync(
        workerManifest,
        `${JSON.stringify({ name: "worker", scripts: { build: "node build.mjs" } })}\n`,
      );

      writeManifest({
        name: "fixture",
        scripts: {
          postinstall: "node scripts/postinstall-bundled-plugins.mjs",
          preinstall: "node scripts/preinstall-package-manager-warning.mjs",
          prepare: "node scripts/prepare-git-hooks.mjs",
          test: "vitest run",
        },
        devDependencies: { vitest: "1.0.0" },
      });
      writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.1'\n");
      expect(fingerprint()).not.toBe(baseline);
      expect(fingerprint(false)).not.toBe(baseline);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists isolated transform and compile caches through immutable protected archives", () => {
    const workflow = readCiWorkflow();
    const nodeTestJob = workflow.jobs["checks-node-core-test-nondist-shard"];
    const setupNodeStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Setup Node environment",
    );
    const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
    const writerStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Restore and save Vitest transform cache",
    );
    const readerStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Restore Vitest transform cache",
    );
    const configureStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Configure Vitest transform cache",
    );
    const compileEpochStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Select Node compile cache epoch",
    );
    const compileWriterStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Restore and save Node compile cache",
    );
    const compileReaderStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Restore Node compile cache",
    );
    const compileConfigureStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Configure Node compile cache",
    );
    const buildSetupNodeStep = workflow.jobs["build-artifacts"].steps.find(
      (step: WorkflowStep) => step.name === "Setup Node environment",
    );
    const buildStepCache = workflow.jobs["build-artifacts"].steps.find(
      (step: WorkflowStep) => step.name === "Restore build-all step cache",
    );

    expect(setupNodeStep.with).toMatchObject({
      "node-compile-cache": "true",
      "node-compile-cache-scope": "test",
      "vitest-fs-cache": "true",
    });
    expect(setupNodeStep.with).not.toHaveProperty("save-node-compile-cache");
    expect(setupNodeStep.with).not.toHaveProperty("save-vitest-fs-cache");
    expect(setupNodeStep.with).not.toHaveProperty("runtime-cache-sticky-disk");
    expect(action.inputs).not.toHaveProperty("runtime-cache-sticky-disk");
    expect(action.inputs["vitest-fs-cache"].default).toBe("false");
    expect(action.inputs["save-vitest-fs-cache"].default).toBe("false");
    expect(action.inputs["node-compile-cache"].default).toBe("false");
    expect(action.inputs["node-compile-cache-scope"].default).toBe("test");
    expect(action.inputs["save-node-compile-cache"].default).toBe("false");
    expect(
      action.runs.steps.some((step: WorkflowStep) =>
        step.name?.includes("transform cache sticky disk"),
      ),
    ).toBe(false);
    expect(
      action.runs.steps.some((step: WorkflowStep) =>
        step.name?.includes("compile cache sticky disk"),
      ),
    ).toBe(false);
    expect(writerStep.uses).toBe("actions/cache@27d5ce7f107fe9357f9df03efb73ab90386fccae");
    expect(writerStep.if).toContain("inputs.save-vitest-fs-cache == 'true'");
    expect(writerStep.with.key).toContain("vitest-fs-v3-protected-");
    expect(writerStep.with.key).toContain("github.run_id");
    expect(writerStep.with.key).toContain("github.run_attempt");
    expect(writerStep.with.key).not.toContain("pull_request");
    expect(writerStep.with["restore-keys"]).toContain("**/tsconfig*.json");
    expect(writerStep.with.key).toContain("!**/node_modules/**");
    expect(writerStep.with["restore-keys"]).toContain("!**/node_modules/**");
    expect(readerStep.uses).toBe(CACHE_V5);
    expect(readerStep.if).toContain("inputs.save-vitest-fs-cache != 'true'");
    expect(readerStep.with["restore-keys"]).toBe(writerStep.with["restore-keys"]);
    expect(readerStep.with.key).toContain("!**/node_modules/**");
    expect(configureStep.env.CACHE_GENERATION).toContain("!**/node_modules/**");
    expect(configureStep.run).toContain("OPENCLAW_VITEST_FS_MODULE_CACHE_PATH=$cache_root");
    expect(configureStep.run).toContain(".openclaw-transform-generation");
    expect(configureStep.run).not.toContain("protected Vitest transform seed");
    expect(configureStep.env.CACHE_WRITER).toBe(
      "${{ inputs.save-vitest-fs-cache == 'true' && '1' || '0' }}",
    );
    expect(configureStep.run).toContain("OPENCLAW_VITEST_FS_MODULE_CACHE_WRITER=");
    expect(compileEpochStep.run).toContain('if [ "$CACHE_SCOPE" = "build" ]');
    expect(compileEpochStep.run).toContain("date -u +%Y%m%d");
    expect(compileEpochStep.run).toContain("GITHUB_RUN_ID");
    expect(compileWriterStep.with.key).toContain(
      "node-compile-v3-${{ inputs.node-compile-cache-scope }}-protected-",
    );
    expect(compileWriterStep.with.key).toContain("steps.node-compile-cache-epoch.outputs.value");
    expect(compileWriterStep.with.key).not.toContain("pull_request");
    expect(compileReaderStep.with["restore-keys"]).toBe(compileWriterStep.with["restore-keys"]);
    expect(compileConfigureStep.run).toContain("NODE_COMPILE_CACHE=$cache_root");
    expect(compileConfigureStep.run).toContain("NODE_COMPILE_CACHE_PORTABLE=1");
    expect(compileConfigureStep.env.CACHE_WRITER).toBe(
      "${{ inputs.save-node-compile-cache == 'true' && '1' || '0' }}",
    );
    expect(buildSetupNodeStep.with).toMatchObject({
      "node-compile-cache": "true",
      "node-compile-cache-scope": "build",
      "save-node-compile-cache":
        "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && 'true' || 'false' }}",
    });
    expect(buildSetupNodeStep.with["node-compile-cache-scope"]).not.toBe(
      setupNodeStep.with["node-compile-cache-scope"],
    );
    expect(buildStepCache.with.key).toContain("build-all-v4-");
    expect(buildStepCache.with.key).toContain("'src/**'");
    expect(buildStepCache.with.key).toContain("'packages/**'");
    expect(buildStepCache.with.key).toContain("'!packages/**/dist/**'");
    expect(buildStepCache.with.key).toContain("'!packages/**/node_modules/**'");
    expect(buildStepCache.with["restore-keys"]).toContain("build-all-v4-");
  });

  it("warms protected caches without main-run cancellation", () => {
    const warmerSource = readFileSync(".github/workflows/vitest-cache-warm.yml", "utf8");
    const warmer = parse(warmerSource);
    const workflow = readCiWorkflow();
    const warmerSetup = warmer.jobs.warm.steps.find(
      (step: WorkflowStep) => step.name === "Setup Node environment",
    );
    const checkoutStep = warmer.jobs.warm.steps.find(
      (step: WorkflowStep) => step.name === "Checkout",
    );
    const seedStep = warmer.jobs.warm.steps.find(
      (step: WorkflowStep) => step.name === "Select broad cache seed",
    );
    const warmStep = warmer.jobs.warm.steps.find(
      (step: WorkflowStep) => step.name === "Warm transform and compile caches",
    );
    const maintainStoreStep = warmer.jobs.warm.steps.find(
      (step: WorkflowStep) => step.name === "Maintain dependency store budget",
    );
    const maintainStickyStoreStep = workflow.jobs.preflight.steps.find(
      (step: WorkflowStep) => step.name === "Maintain sticky dependency store budget",
    )!;

    expect(warmer.concurrency["cancel-in-progress"]).toBe(false);
    expect(warmer.concurrency.group).toBe("vitest-cache-warm");
    expect(warmer.on.workflow_dispatch).toBeUndefined();
    expect(warmer.on.repository_dispatch.types).toEqual(["vitest-cache-warm"]);
    expect(warmer.jobs.warm.if).toContain("github.repository == 'openclaw/openclaw'");
    expect(warmer.on).not.toHaveProperty("workflow_run");
    expect(checkoutStep.with).toBeUndefined();
    expect(warmerSource).toContain('cron: "17 8 * * *"');
    expect(warmerSource).toContain('candidate.shardName.startsWith("core-unit-fast")');
    expect(warmerSource).toContain('"agentic-agents-embedded"');
    expect(warmerSource).toContain('"agentic-gateway-methods"');
    expect(warmerSource).toContain('"auto-reply-reply-commands-3"');
    expect(warmerSetup.with).toMatchObject({
      "node-compile-cache-scope": "test",
      "save-actions-cache": "true",
      "save-node-compile-cache": "true",
      "save-vitest-fs-cache": "true",
      "sticky-disk": "false",
      "use-actions-cache": "true",
    });
    // CI is restore-only, so no per-PR runtime cache family or close-time
    // cleanup workflow exists. Actions cache LRU/TTL expires old warmers.
    expect(existsSync(".github/workflows/pr-cache-cleanup.yml")).toBe(false);
    expect(seedStep.if).toBeUndefined();
    expect(warmStep.if).toBeUndefined();
    expect(maintainStoreStep).toBeUndefined();
    expect(maintainStickyStoreStep.env.OPENCLAW_PNPM_STORE_MAX_KIB).toBe("8388608");

    const maintenanceRoot = mkdtempSync(path.join(tmpdir(), "openclaw-pnpm-maintenance-"));
    try {
      const storeDir = path.join(maintenanceRoot, "store");
      const summaryPath = path.join(maintenanceRoot, "summary.md");
      mkdirSync(storeDir);
      const result = spawnSync("bash", ["-c", maintainStickyStoreStep.run], {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: summaryPath,
          OPENCLAW_PNPM_STORE_MAX_KIB: "-1",
          PNPM_CONFIG_STORE_DIR: storeDir,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("pruning above -1 KiB ceiling");
      expect(readFileSync(summaryPath, "utf8")).toContain("- Pruned: true");
    } finally {
      rmSync(maintenanceRoot, { force: true, recursive: true });
    }
  });

  it("uses bundled Node shards and telemetry-backed runner sizes", () => {
    const workflow = readCiWorkflow();
    const buildArtifactsTestbox = readBuildArtifactsTestboxWorkflow();
    const source = readFileSync(".github/workflows/ci.yml", "utf8");

    expect(source).toContain("createNodeTestShardBundles");
    expect(workflow.jobs["build-artifacts"]["runs-on"]).toContain("blacksmith-32vcpu-ubuntu-2404");
    expect(buildArtifactsTestbox.jobs["build-artifacts"]["runs-on"]).toBe(
      "blacksmith-16vcpu-ubuntu-2404",
    );
    expect(
      buildArtifactsTestbox.jobs["build-artifacts"].steps.find(
        (step: { name?: string }) => step.name === "Build dist on cache miss",
      ).env.NODE_OPTIONS,
    ).toBe("--max-old-space-size=16384");
    expect(workflow.jobs["checks-node-core-test-nondist-shard"]["runs-on"]).toContain(
      "blacksmith-4vcpu-ubuntu-2404",
    );
    expect(workflow.jobs["check-shard"].strategy.matrix.include).toContainEqual({
      check_name: "check-dependencies",
      task: "dependencies",
      // Concurrent Knip scans need cores and memory headroom.
      runner: "blacksmith-32vcpu-ubuntu-2404",
    });
    expect(workflow.jobs["check-additional-shard"]["runs-on"]).toContain("matrix.runner");
    expect(workflow.jobs["check-additional-shard"].strategy.matrix.include).toContainEqual({
      check_name: "check-session-accessor-boundary",
      group: "session-accessor-boundary",
      runner: "blacksmith-4vcpu-ubuntu-2404",
    });
    expect(workflow.jobs["check-additional-shard"].strategy.matrix.include).toContainEqual({
      check_name: "check-sqlite-session-schema-baseline",
      group: "sqlite-session-schema-baseline",
      runner: "blacksmith-4vcpu-ubuntu-2404",
    });
    expect(workflow.jobs["checks-windows"]["runs-on"]).toContain("matrix.runner");
    expect(source).toContain("blacksmith-8vcpu-windows-2025");
  });

  it("keeps the extension boundary sticky disk on one protected key", () => {
    const workflow = readCiWorkflow();
    const additionalJob = workflow.jobs["check-additional-shard"];
    const checkShardJob = workflow.jobs["check-shard"];

    // Light-run pole: cold prep + 122 plugin compiles scale with cores at
    // similar billed core-minutes.
    expect(additionalJob.strategy.matrix.include).toContainEqual({
      check_name: "check-additional-extension-package-boundary",
      group: "extension-package-boundary",
      runner: "blacksmith-32vcpu-ubuntu-2404",
    });
    const runStep = additionalJob.steps.find(
      (step: WorkflowStep) => step.name === "Run additional check shard",
    );
    expect(runStep.env.OPENCLAW_EXTENSION_BOUNDARY_CONCURRENCY).toBe(16);

    // O(1) disks: Blacksmith caps sticky disks per installation, and the old
    // per-PR/per-config keys minted new disks until every mount 429-failed
    // fleet-wide. Snapshot validity lives in the in-job marker, not the key.
    const boundaryMount = additionalJob.steps.find(
      (step: WorkflowStep) => step.name === "Mount extension boundary sticky disk",
    );
    const lintMount = checkShardJob.steps.find(
      (step: WorkflowStep) => step.name === "Mount extension boundary sticky disk",
    );
    expect(boundaryMount.with.key).toBe("${{ github.repository }}-ext-boundary-v2");
    expect(lintMount.with.key).toBe(boundaryMount.with.key);
    // Single semantic writer: protected pushes commit explicitly (not
    // on-change/if-missing, whose allocated-byte heuristic can strand a stale
    // marker); PR clones and the lint consumer stay read-only.
    expect(boundaryMount.with.commit).toBe(
      "${{ github.event_name != 'pull_request' && 'true' || 'false' }}",
    );
    expect(lintMount.with.commit).toBe("false");

    // The key no longer hashes config/scripts/lockfile, so every gate must
    // compose the identical marker fingerprint or restores silently tear.
    const restoreStep = additionalJob.steps.find(
      (step: WorkflowStep) => step.name === "Restore extension boundary artifacts from sticky disk",
    );
    const lintRestoreStep = checkShardJob.steps.find(
      (step: WorkflowStep) => step.name === "Restore extension boundary artifacts from sticky disk",
    );
    const seedStep = additionalJob.steps.find(
      (step: WorkflowStep) => step.name === "Seed extension boundary sticky disk",
    );
    const configHash = seedStep.env.BOUNDARY_CONFIG_HASH;
    expect(configHash).toContain("hashFiles(");
    expect(configHash).toContain("pnpm-lock.yaml");
    expect(restoreStep.env.BOUNDARY_CONFIG_HASH).toBe(configHash);
    expect(lintRestoreStep.env.BOUNDARY_CONFIG_HASH).toBe(configHash);
    for (const gate of [restoreStep, lintRestoreStep, seedStep]) {
      expect(gate.run).toContain('echo "$BOUNDARY_CONFIG_HASH"');
    }
    // Seeding is writer-only work: PR mounts never commit, so seeding there
    // would burn wall clock on a discarded clone.
    expect(seedStep.if).toContain("github.event_name != 'pull_request'");
    expect(seedStep.if).toContain("steps.boundary-sticky-restore.outputs.restored == 'false'");
  });

  it("keeps the Gradle sticky disk on O(1) per-task protected keys", () => {
    const workflow = readCiWorkflow();
    const androidSteps = workflow.jobs.android.steps as WorkflowStep[];
    const mountWith = expectDefined(
      androidSteps.find((step) => step.name === "Mount Gradle sticky disk")?.with,
      "Gradle sticky mount step",
    );
    const pointStep = expectDefined(
      androidSteps.find((step) => step.name === "Point Gradle at the sticky disk"),
      "Gradle sticky point step",
    );
    const pointEnv = expectDefined(pointStep.env, "Gradle sticky point step env");

    // Task scope stays in the key (a light task like ktlint must never seed
    // heavy build lanes), but PR number and dependency hash must not: those
    // minted a backing disk per PR/bump until Blacksmith's installation-wide
    // budget 429-failed every mount fleet-wide.
    expect(mountWith.key).toBe("${{ github.repository }}-gradle-v2-${{ matrix.task }}");
    // Single semantic writer: protected pushes commit explicitly (on-change's
    // allocated-byte heuristic can miss a same-size refresh and strand the
    // fingerprint marker); PR clones stay read-only.
    expect(mountWith.commit).toBe(
      "${{ github.event_name != 'pull_request' && 'true' || 'false' }}",
    );
    // The dependency hash moved from the key into a runtime fingerprint that
    // bounds disk growth: the writer rebuilds cold when inputs change so
    // retired artifacts do not accumulate on the O(1) key forever.
    expect(pointEnv.GRADLE_DEPS_FINGERPRINT).toContain("hashFiles(");
    expect(pointEnv.GRADLE_DEPS_FINGERPRINT).toContain("apps/android/gradle/libs.versions.toml");
    expect(pointEnv.STICKY_WRITER).toContain("github.event_name != 'pull_request'");
    expect(pointStep.run).toContain(".openclaw-gradle-deps-fingerprint");
    expect(pointStep.run).toContain('rm -rf "$sticky_root/gradle-user-home"');
  });

  it("never keys a Blacksmith sticky disk by unbounded run dimensions", () => {
    // Blacksmith caps backing disks per installation; per-PR, per-commit,
    // per-run, or per-hash key segments mint disks until every mount 429s.
    // Snapshot validity belongs in in-job fingerprints/markers, never the key.
    const workflowFiles = readdirSync(".github/workflows")
      .filter((name) => name.endsWith(".yml"))
      .map((name) => `.github/workflows/${name}`);
    const actionFiles = readdirSync(".github/actions").map(
      (name) => `.github/actions/${name}/action.yml`,
    );
    const stickyKeys: Array<{ file: string; key: string }> = [];
    for (const file of [...workflowFiles, ...actionFiles]) {
      if (!existsSync(file)) {
        continue;
      }
      const parsed = parse(readFileSync(file, "utf8"));
      const jobs = parsed?.jobs ? Object.values(parsed.jobs) : [];
      const stepLists = [
        ...jobs.map((job) => (job as { steps?: WorkflowStep[] }).steps ?? []),
        (parsed?.runs?.steps ?? []) as WorkflowStep[],
      ];
      for (const step of stepLists.flat()) {
        if (typeof step?.uses !== "string" || !step.uses.startsWith("useblacksmith/stickydisk@")) {
          continue;
        }
        const key = step.with?.key;
        stickyKeys.push({ file, key: typeof key === "string" ? key : "" });
      }
    }
    expect(stickyKeys.length).toBeGreaterThan(0);
    for (const { file, key } of stickyKeys) {
      expect(key, file).not.toContain("github.event.pull_request.number");
      expect(key, file).not.toContain("github.sha");
      expect(key, file).not.toContain("github.ref");
      expect(key, file).not.toContain("github.run_");
      expect(key, file).not.toContain("hashFiles(");
    }
  });

  it("deletes only exact allowlisted retired sticky disks from protected main", () => {
    const cleanupSource = readFileSync(".github/workflows/sticky-disk-cleanup.yml", "utf8");
    const cleanup = parse(cleanupSource);
    const job = cleanup.jobs.delete;
    const checkoutStep = job.steps.find(
      (step: WorkflowStep) => step.name === "Checkout protected manifest",
    );
    const validateStep = job.steps.find(
      (step: WorkflowStep) => step.name === "Validate exact retired key",
    );
    const deleteStep = job.steps.find(
      (step: WorkflowStep) => step.name === "Delete retired sticky disk",
    );
    const retiredDisks = JSON.parse(
      readFileSync(".github/retired-sticky-disks.json", "utf8"),
    ) as Array<{ architecture?: unknown; key?: unknown; region?: unknown }>;

    expect(Array.isArray(retiredDisks)).toBe(true);
    expect(
      retiredDisks.every(
        (disk) =>
          typeof disk.key === "string" &&
          disk.key.length > 0 &&
          disk.key === disk.key.trim() &&
          (disk.architecture === "amd64" || disk.architecture === "arm64") &&
          typeof disk.region === "string" &&
          disk.region.length > 0 &&
          disk.region === disk.region.trim(),
      ),
    ).toBe(true);
    expect(
      new Set(retiredDisks.map((disk) => `${disk.key}:${disk.architecture}:${disk.region}`)).size,
    ).toBe(retiredDisks.length);
    expect(cleanup.on).toHaveProperty("workflow_dispatch");
    expect(cleanup.permissions).toEqual({ contents: "read" });
    expect(cleanup.concurrency).toEqual({
      group: "sticky-disk-cleanup",
      "cancel-in-progress": false,
    });
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(job.if).toContain("inputs.confirm");
    expect(checkoutStep.with.ref).toBe("refs/heads/main");
    expect(job["runs-on"]).toContain("inputs.architecture == 'arm64'");
    expect(validateStep.env.RETIRED_ARCHITECTURE).toBe("${{ inputs.architecture }}");
    expect(validateStep.env.RETIRED_KEY).toBe("${{ inputs.retired_key }}");
    expect(validateStep.env.RETIRED_REGION).toBe("${{ inputs.region }}");
    expect(validateStep.run).toContain('process.env.BLACKSMITH_ENV?.includes("arm")');
    expect(validateStep.run).toContain("requestedRegion !== process.env.BLACKSMITH_REGION");
    expect(validateStep.run).toContain("requestedKey !== requestedKey.trim()");
    expect(validateStep.run).toContain("disk?.key === requestedKey");
    const rejectedKey = spawnSync("bash", ["-c", validateStep.run], {
      encoding: "utf8",
      env: {
        ...process.env,
        BLACKSMITH_ENV: "production-amd64",
        BLACKSMITH_REGION: "us-test-1",
        RETIRED_ARCHITECTURE: "amd64",
        RETIRED_KEY: "openclaw/openclaw-not-retired",
        RETIRED_REGION: "us-test-1",
      },
    });
    expect(rejectedKey.status).not.toBe(0);
    expect(rejectedKey.stderr).toContain("identity is not allowlisted for retirement");
    const paddedKey = spawnSync("bash", ["-c", validateStep.run], {
      encoding: "utf8",
      env: {
        ...process.env,
        BLACKSMITH_ENV: "production-amd64",
        BLACKSMITH_REGION: "us-test-1",
        RETIRED_ARCHITECTURE: "amd64",
        RETIRED_KEY: " openclaw/openclaw-active-key ",
        RETIRED_REGION: "us-test-1",
      },
    });
    expect(paddedKey.status).not.toBe(0);
    expect(paddedKey.stderr).toContain("key must be non-empty and canonical");
    expect(deleteStep).toMatchObject({
      uses: "useblacksmith/stickydisk-delete@3bd8d43f9da764c6b80c2cd6db129bdb568c79b6",
      with: {
        "delete-docker-cache": "false",
        "delete-key": "${{ inputs.retired_key }}",
      },
    });

    // A retired-key entry must never match any disk family still mounted by
    // the repository. Expressions stand for one non-empty resolved segment.
    const workflowFiles = readdirSync(".github/workflows")
      .filter((name) => name.endsWith(".yml"))
      .map((name) => `.github/workflows/${name}`);
    const actionFiles = readdirSync(".github/actions").map(
      (name) => `.github/actions/${name}/action.yml`,
    );
    const activeKeyPatterns: RegExp[] = [];
    for (const file of [...workflowFiles, ...actionFiles]) {
      if (!existsSync(file)) {
        continue;
      }
      const parsed = parse(readFileSync(file, "utf8"));
      const jobs = parsed?.jobs ? Object.values(parsed.jobs) : [];
      const stepLists = [
        ...jobs.map((candidate) => (candidate as { steps?: WorkflowStep[] }).steps ?? []),
        (parsed?.runs?.steps ?? []) as WorkflowStep[],
      ];
      for (const step of stepLists.flat()) {
        if (typeof step?.uses !== "string" || !step.uses.startsWith("useblacksmith/stickydisk@")) {
          continue;
        }
        const key = step.with?.key;
        if (typeof key !== "string") {
          continue;
        }
        const escapedParts = key
          .split(/\$\{\{[^}]+\}\}/u)
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
        activeKeyPatterns.push(new RegExp(`^${escapedParts.join(".+")}$`, "u"));
      }
    }
    for (const retiredDisk of retiredDisks) {
      expect(
        activeKeyPatterns.some((pattern) => pattern.test(retiredDisk.key as string)),
        `${retiredDisk.key} is still an active sticky-disk key`,
      ).toBe(false);
    }
  });

  it("runs the session accessor ratchet as a visible additional check", () => {
    const workflow = readCiWorkflow();
    const additionalJob = workflow.jobs["check-additional-shard"];
    const matrixRows = additionalJob.strategy.matrix.include;
    expect(matrixRows).toContainEqual({
      check_name: "check-session-accessor-boundary",
      group: "session-accessor-boundary",
      runner: "blacksmith-4vcpu-ubuntu-2404",
    });

    const runStep = additionalJob.steps.find(
      (step: WorkflowStep) => step.name === "Run additional check shard",
    );
    expect(runStep.run).toContain("session-accessor-boundary)");
    expect(runStep.run).toContain(
      'run_check "lint:tmp:session-accessor-boundary" pnpm run lint:tmp:session-accessor-boundary',
    );
  });

  it("runs the transcript reader ratchet as a visible additional check", () => {
    const workflow = readCiWorkflow();
    const additionalJob = workflow.jobs["check-additional-shard"];
    const matrixRows = additionalJob.strategy.matrix.include;
    expect(matrixRows).toContainEqual({
      check_name: "check-session-transcript-reader-boundary",
      group: "session-transcript-reader-boundary",
      runner: "blacksmith-4vcpu-ubuntu-2404",
    });

    const runStep = additionalJob.steps.find(
      (step: WorkflowStep) => step.name === "Run additional check shard",
    );
    expect(runStep.run).toContain("session-transcript-reader-boundary)");
    expect(runStep.run).toContain(
      'run_check "lint:tmp:session-transcript-reader-boundary" pnpm run lint:tmp:session-transcript-reader-boundary',
    );
  });

  it("runs the Plugin SDK API baseline as a visible additional check", () => {
    const workflow = readCiWorkflow();
    const additionalJob = workflow.jobs["check-additional-shard"];
    const matrixRows = additionalJob.strategy.matrix.include;
    expect(matrixRows).toContainEqual({
      check_name: "check-plugin-sdk-api-baseline",
      group: "plugin-sdk-api-baseline",
      runner: "blacksmith-4vcpu-ubuntu-2404",
    });

    const runStep = additionalJob.steps.find(
      (step: WorkflowStep) => step.name === "Run additional check shard",
    );
    expect(runStep.run).toContain("plugin-sdk-api-baseline)");
    expect(runStep.run).toContain('run_check "plugin-sdk:api:check" pnpm run plugin-sdk:api:check');
  });

  it("runs the SQLite transaction ratchet in the session boundary check", () => {
    const workflow = readCiWorkflow();
    const additionalJob = workflow.jobs["check-additional-shard"];
    const matrixRows = additionalJob.strategy.matrix.include;
    expect(matrixRows).toContainEqual({
      check_name: "check-session-accessor-boundary",
      group: "session-accessor-boundary",
      runner: "blacksmith-4vcpu-ubuntu-2404",
    });

    const runStep = additionalJob.steps.find(
      (step: WorkflowStep) => step.name === "Run additional check shard",
    );
    expect(runStep.run).toContain("session-accessor-boundary)");
    expect(runStep.run).toContain(
      'run_check "lint:tmp:sqlite-transaction-boundary" pnpm run lint:tmp:sqlite-transaction-boundary',
    );
  });

  it("kills timed manual checkout fetches after the grace period", () => {
    const workflowPaths = [
      [".github/workflows/ci.yml", "120s"],
      [".github/workflows/workflow-sanity.yml", "30s"],
      [".github/workflows/ci-check-testbox.yml", "120s"],
      [".github/workflows/ci-check-arm-testbox.yml", "120s"],
      [".github/workflows/ci-build-artifacts-testbox.yml", "120s"],
      [".github/workflows/crabbox-hydrate.yml", "30s"],
    ] as const;

    for (const [workflowPath, timeoutSeconds] of workflowPaths) {
      const workflow = readFileSync(workflowPath, "utf8");
      const fetchTimeouts = workflow.match(
        new RegExp(
          `timeout --signal=TERM[^\\n]* ${timeoutSeconds} git(?: -C "(?:\\$workdir|\\$GITHUB_WORKSPACE|clawhub-source)")?`,
          "g",
        ),
      );

      expect(fetchTimeouts?.length, workflowPath).toBeGreaterThan(0);
      expect(
        fetchTimeouts?.every((line) =>
          line.startsWith(`timeout --signal=TERM --kill-after=10s ${timeoutSeconds} git`),
        ),
        workflowPath,
      ).toBe(true);
    }
  });

  it("bounds release ref validation fetches across checkout auth modes", () => {
    const resolveTargetSteps = readReleaseChecksWorkflow().jobs.resolve_target.steps;

    for (const stepName of [
      "Validate selected ref belongs to this repository",
      "Validate Tideclaw alpha target matches workflow branch",
    ]) {
      const step = resolveTargetSteps.find(
        (candidate: WorkflowStep) => candidate.name === stepName,
      );

      expect(step?.run, stepName).toContain("local -a git_args=(git)");
      expect(step?.run, stepName).toContain(
        'git_args+=(-c "http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth_header}")',
      );
      expect(step?.run, stepName).toContain(
        'timeout --signal=TERM --kill-after=10s 120s "${git_args[@]}" fetch "$@"',
      );
      expect(step?.run, stepName).not.toContain('git -c "http.https://github.com/.extraheader');
    }
  });

  it("bounds shared base commit fetches", () => {
    const action = readFileSync(".github/actions/ensure-base-commit/action.yml", "utf8");
    const exactFetch = action.indexOf('fetch_base_ref --no-tags --depth=1 origin "$BASE_SHA"');
    const branchDeepening = action.indexOf("for deepen_by in 25 100 300");

    expect(action).toContain("fetch_base_ref()");
    expect(action).toContain("timeout --signal=TERM --kill-after=10s 30s git");
    expect(action).toContain("-c protocol.version=2");
    expect(action).not.toContain("if ! git fetch --no-tags");
    expect(exactFetch).toBeGreaterThan(-1);
    expect(branchDeepening).toBeGreaterThan(exactFetch);
    expect(action).toContain("::error title=ensure-base-commit missing base::");
  });

  it("bounds early unauthenticated checkout fetches", () => {
    const workflow = readCiWorkflow();

    for (const jobName of ["preflight", "security-fast", "skills-python"]) {
      const checkoutStep = workflow.jobs[jobName].steps.find(
        (step: WorkflowStep) => step.name === "Checkout",
      );

      expect(checkoutStep.run, jobName).toContain(
        'timeout --signal=TERM --kill-after=10s 120s git -C "$GITHUB_WORKSPACE"',
      );
      expect(checkoutStep.run, jobName).toContain("for attempt in 1 2 3");
      expect(checkoutStep.run, jobName).toContain("timed out on attempt $attempt; retrying");
      expect(checkoutStep.run, jobName).not.toContain("if timeout --signal=TERM");
      expect(checkoutStep.run, jobName).toContain("-c protocol.version=2");
      // preflight fetches the head at depth 1 and supplements the parents
      // blob-less; security-fast keeps depth 2 for its diff-base needs.
      const expectedDepth = jobName === "security-fast" ? 2 : 1;
      expect(checkoutStep.run, jobName).toContain(
        `fetch --no-tags --prune --no-recurse-submodules --depth=${expectedDepth} origin`,
      );
      if (jobName === "preflight") {
        expect(checkoutStep.run, jobName).toContain("--filter=blob:none");
        expect(checkoutStep.run, jobName).toContain("fetch_parent_metadata");
      }
      if (jobName !== "skills-python") {
        expect(checkoutStep.run, jobName).toContain('if [ "$fetch_status" = "124" ]');
        expect(checkoutStep.run, jobName).toContain("timed out");
      }
      expect(checkoutStep.run, jobName).not.toContain(
        'git -C "$GITHUB_WORKSPACE" fetch --no-tags --depth=1',
      );
    }
  });

  it("refetches an exact manual target when the workflow branch moves", () => {
    const workflow = readCiWorkflow();
    const checkoutStep = workflow.jobs.preflight.steps.find(
      (step: WorkflowStep) => step.name === "Checkout",
    );
    const run = checkoutStep.run;
    const driftCheck = run.indexOf(
      'if [ "$resolved_sha" != "$requested_sha" ] && [ "$checkout_ref" != "$requested_sha" ]; then',
    );
    const exactFetch = run.indexOf('fetch_checkout_ref "$checkout_ref"', driftCheck);
    const finalCheck = run.indexOf('if [ "$resolved_sha" != "$requested_sha" ]; then', driftCheck);

    expect(driftCheck).toBeGreaterThan(-1);
    expect(run).toContain("while the manual run waits for a runner");
    expect(run).toContain('checkout_ref="$requested_sha"');
    expect(exactFetch).toBeGreaterThan(driftCheck);
    expect(finalCheck).toBeGreaterThan(exactFetch);
  });

  it("retries workflow sanity checkout fetch timeouts", () => {
    const workflow = readWorkflowSanityWorkflow();

    for (const jobName of ["no-tabs", "actionlint", "generated-doc-baselines"]) {
      const checkoutStep = workflow.jobs[jobName].steps.find(
        (step: WorkflowStep) => step.name === "Checkout",
      );

      expect(checkoutStep.run, jobName).toContain("fetch_checkout_ref()");
      expect(checkoutStep.run, jobName).toContain("for attempt in 1 2 3");
      expect(checkoutStep.run, jobName).toContain(
        'timeout --signal=TERM --kill-after=10s 30s git -C "$GITHUB_WORKSPACE"',
      );
      expect(checkoutStep.run, jobName).toContain(
        'if [ "$fetch_status" != "124" ] && [ "$fetch_status" != "137" ]; then',
      );
      expect(checkoutStep.run, jobName).toContain("timed out on attempt $attempt; retrying");
      expect(checkoutStep.run, jobName).toContain(
        "fetch --no-tags --prune --no-recurse-submodules --depth=1 origin",
      );
    }
  });

  it("bounds the workflow sanity tool downloads", () => {
    const workflow = readWorkflowSanityWorkflow();
    const shellcheckStep = expectDefined(
      workflow.jobs.actionlint.steps.find(
        (step: WorkflowStep) => step.name === "Install ShellCheck",
      ),
      "ShellCheck install step",
    );
    const actionlintStep = expectDefined(
      workflow.jobs.actionlint.steps.find(
        (step: WorkflowStep) => step.name === "Install actionlint",
      ),
      "actionlint install step",
    );

    expect(shellcheckStep.run).toContain("curl --connect-timeout 10 --max-time 120");
    expect(shellcheckStep.run).toContain("--retry 5 --retry-delay 2 --retry-all-errors");
    expect(actionlintStep.run).toContain("--connect-timeout 10");
    expect(actionlintStep.run).toContain("--max-time 120");
    expect(actionlintStep.run).toContain("--retry 5");
    expect(actionlintStep.run).toContain("--retry-delay 2");
    expect(actionlintStep.run).toContain("--retry-all-errors");
    expect(actionlintStep.run.match(/curl "\$\{curl_args\[@\]\}"/gu)).toHaveLength(2);
  });

  it("runs generated baseline drift checks in workflow sanity", () => {
    const workflow = readWorkflowSanityWorkflow();
    const steps = workflow.jobs["generated-doc-baselines"].steps;
    const stepNames = steps.map((step: WorkflowStep) => step.name);

    expect(stepNames).toContain("Check plugin SDK API contract manifest");
    expect(stepNames).toContain("Check SQLite sessions/transcripts schema baseline drift");
    expect(stepNames).toContain("Check plugin SDK surface budget");
    expect(stepNames.indexOf("Check plugin SDK API contract manifest")).toBeLessThan(
      stepNames.indexOf("Check SQLite sessions/transcripts schema baseline drift"),
    );
    expect(
      stepNames.indexOf("Check SQLite sessions/transcripts schema baseline drift"),
    ).toBeLessThan(stepNames.indexOf("Check plugin SDK surface budget"));
    expect(
      steps.find(
        (step: WorkflowStep) =>
          step.name === "Check SQLite sessions/transcripts schema baseline drift",
      ).run,
    ).toBe("pnpm sqlite:sessions-schema:check");
    expect(
      steps.find((step: WorkflowStep) => step.name === "Check plugin SDK surface budget").run,
    ).toBe("pnpm plugin-sdk:surface:check");
  });

  it("bounds platform checkout fetches without GNU timeout", () => {
    const source = readFileSync(".github/workflows/ci.yml", "utf8");
    const workflow = readCiWorkflow();

    expect(source.match(/&platform_checkout_step/gu) ?? []).toHaveLength(1);
    expect(source.match(/\*platform_checkout_step/gu) ?? []).toHaveLength(3);
    expect(source.match(/fetch_checkout_ref_once\(\)/gu) ?? []).toHaveLength(1);

    for (const jobName of ["checks-windows", "macos-node", "macos-swift", "ios-build"]) {
      const checkoutStep = workflow.jobs[jobName].steps.find(
        (step: WorkflowStep) => step.name === "Checkout",
      );

      expect(checkoutStep.run, jobName).toContain("fetch_checkout_ref()");
      expect(checkoutStep.run, jobName).toContain("fetch_checkout_ref_once()");
      expect(checkoutStep.run, jobName).toContain("for attempt in 1 2 3");
      expect(checkoutStep.run, jobName).toContain("fetch_timeout_seconds=90");
      expect(checkoutStep.run, jobName).toContain("-c protocol.version=2");
      expect(checkoutStep.run, jobName).toContain(
        "fetch --no-tags --prune --no-recurse-submodules --depth=1 origin",
      );
      expect(checkoutStep.run, jobName).toContain(
        'if [ "$elapsed" -ge "$fetch_timeout_seconds" ]; then',
      );
      expect(checkoutStep.run, jobName).toContain('kill -TERM "$fetch_pid"');
      expect(checkoutStep.run, jobName).toContain('kill -KILL "$fetch_pid"');
      expect(checkoutStep.run, jobName).toContain(
        'if [ "$fetch_status" != "124" ] && [ "$fetch_status" != "137" ]; then',
      );
      expect(checkoutStep.run, jobName).toContain("timed out on attempt $attempt; retrying");
      expect(checkoutStep.run, jobName).not.toContain(
        'git -C "$GITHUB_WORKSPACE" fetch --no-tags --depth=1',
      );
    }
  });

  it("checks native and Node state schema versions in the macOS lane", () => {
    const workflow = readCiWorkflow();
    const schemaVersionStep = workflow.jobs["macos-swift"].steps.find(
      (step: WorkflowStep) => step.name === "Native state schema version contract",
    );

    expect(schemaVersionStep.run).toContain("node scripts/check-native-state-schema-version.mjs");
    expect(schemaVersionStep.run).toContain('elif [[ "$HISTORICAL_TARGET" == "true" ]]');
  });

  it("resets SwiftPM state between macOS release build retries", () => {
    const workflow = readCiWorkflow();
    const macosInstallStep = workflow.jobs["macos-swift"].steps.find(
      (step: WorkflowStep) => step.name === "Install XcodeGen / SwiftLint / SwiftFormat",
    );
    const iosInstallStep = workflow.jobs["ios-build"].steps.find(
      (step: WorkflowStep) => step.name === "Install iOS Swift tooling",
    );
    const macosLintStep = workflow.jobs["macos-swift"].steps.find(
      (step: WorkflowStep) => step.name === "Swift lint",
    );
    const iosLintStep = workflow.jobs["ios-build"].steps.find(
      (step: WorkflowStep) => step.name === "Swift lint",
    );
    const buildStep = workflow.jobs["macos-swift"].steps.find(
      (step: WorkflowStep) => step.name === "Swift build (release)",
    );

    for (const installStep of [macosInstallStep, iosInstallStep]) {
      const currentTargetBranch = installStep.run.split('elif [[ "$HISTORICAL_TARGET"')[0];
      expect(currentTargetBranch).toContain(
        "if [[ -x ./scripts/install-xcodegen.sh && -x ./scripts/install-swift-tools.sh ]]; then",
      );
      expect(currentTargetBranch).toContain('./scripts/install-xcodegen.sh "$swift_tools_dir"');
      expect(currentTargetBranch).toContain('"$swift_tools_dir/xcodegen" --version');
      expect(currentTargetBranch).not.toContain("brew ");
      expect(installStep.run).toContain("brew install xcodegen swiftlint");
      expect(installStep.run).not.toContain("brew install xcodegen swiftlint swiftformat");
      expect(installStep.run).toContain(
        "https://github.com/nicklockwood/SwiftFormat/releases/download/$swiftformat_version/swiftformat.zip",
      );
      expect(installStep.run).toContain("--connect-timeout 10 --max-time 120");
      expect(installStep.run).toContain("--retry 3 --retry-max-time 120");
      expect(installStep.run).toContain(
        'swiftformat_checksum="b990400779aceb7d7020796eb9ba814d4480543f671d38fc0ff48cb72f04c584"',
      );
      expect(installStep.run).toContain(
        'swiftformat_checksum="7cb1cb1fae04932047c7015441c543848e8e60e1572d808d080e0a1f1661114a"',
      );
      expect(installStep.run).toContain(
        '[[ "$("$swift_tools_dir/swiftformat" --version)" == "$swiftformat_version" ]]',
      );
    }
    for (const jobName of ["macos-swift", "ios-build"]) {
      expect(workflow.jobs[jobName].env.HISTORICAL_TARGET).toBe(
        "${{ needs.preflight.outputs.compatibility_target }}",
      );
    }
    expect(iosInstallStep.run).toContain('swiftformat_link="$(brew --prefix)/bin/swiftformat"');
    expect(iosInstallStep.run).toContain(
      'ln -sfn "$swift_tools_dir/swiftformat" "$swiftformat_link"',
    );
    expect(iosInstallStep.run).toContain(
      '[[ "$("$swiftformat_link" --version)" == "$swiftformat_version" ]]',
    );
    for (const lintStep of [macosLintStep, iosLintStep]) {
      expect(lintStep.run).toContain(
        "if [[ -x ./scripts/lint-swift.sh && -x ./scripts/format-swift.sh ]]; then",
      );
    }
    expect(macosLintStep.run).toContain("swiftlint lint --config config/swiftlint.yml");
    expect(macosLintStep.run).toContain("swiftformat --lint apps/macos/Sources");
    expect(iosLintStep.run).toContain("skipping iOS lint for this frozen target");
    expect(buildStep.run).toContain("for attempt in 1 2 3");
    expect(buildStep.run).toContain('if [[ "$attempt" -eq 3 ]]; then');
    expect(buildStep.run).toContain("swift package --package-path apps/macos reset");
    expect(buildStep.run.indexOf("swift package --package-path apps/macos reset")).toBeGreaterThan(
      buildStep.run.indexOf("swift build failed"),
    );
  });

  it("bounds the Windows Crabbox hydrate main fetch", () => {
    const workflow = readFileSync(".github/workflows/crabbox-hydrate.yml", "utf8");

    expect(workflow).toContain("$fetchInfo = New-Object System.Diagnostics.ProcessStartInfo");
    expect(workflow).toContain('$fetchInfo.FileName = "git"');
    expect(workflow).toContain("$fetchInfo.WorkingDirectory = $repo");
    expect(workflow).toContain("$fetchInfo.UseShellExecute = $false");
    expect(workflow).not.toContain("$fetchInfo.RedirectStandardOutput = $true");
    expect(workflow).not.toContain("$fetchInfo.RedirectStandardError = $true");
    expect(workflow).toContain(
      "--no-tags --no-progress --prune --no-recurse-submodules --depth=50",
    );
    expect(workflow).toContain("$fetch = New-Object System.Diagnostics.Process");
    expect(workflow).toContain("$fetch.StartInfo = $fetchInfo");
    expect(workflow).toContain("$fetch.WaitForExit(30000)");
    expect(workflow).toContain("$fetch.Kill()");
    expect(workflow).not.toContain("StandardOutput.ReadToEnd()");
    expect(workflow).not.toContain("StandardError.ReadToEnd()");
    expect(workflow).toContain('throw "git fetch failed with exit code $($fetch.ExitCode)"');
    expect(workflow).toContain('throw "git fetch timed out after 30 seconds"');
    expect(workflow).not.toContain(
      'git fetch --no-tags --depth=50 origin "+refs/heads/main:refs/remotes/origin/main"',
    );
  });

  it("bounds Mantis Slack runner IP discovery", () => {
    const workflow = parse(
      readFileSync(".github/workflows/mantis-slack-desktop-smoke.yml", "utf8"),
    ) as { jobs: { run_slack_desktop: { steps: WorkflowStep[] } } };
    const runStep = workflow.jobs.run_slack_desktop.steps.find(
      (step) => step.name === "Run Slack desktop scenario",
    );

    expect(runStep?.run).toContain("for attempt in 1 2 3");
    expect(runStep?.run).toContain(
      "curl -fsS --connect-timeout 5 --max-time 15 https://checkip.amazonaws.com",
    );
    expect(runStep?.run).not.toContain("--retry");
    expect(runStep?.run).toContain('runner_ip=""');
    expect(runStep?.run).toContain('[[ ! "$runner_ip" =~ ^(0|[1-9][0-9]{0,2})\\.');
    expect(runStep?.run).toContain("((10#$octet > 255))");

    const discoveryBlock = runStep?.run?.match(
      /runner_ip=""[\s\S]*?echo "Using AWS SSH CIDR \$\{CRABBOX_AWS_SSH_CIDRS\}"/u,
    )?.[0];
    expect(discoveryBlock).toBeTruthy();

    const root = mkdtempSync(path.join(tmpdir(), "openclaw-mantis-runner-ip-"));
    try {
      const fakeBin = path.join(root, "bin");
      const callCount = path.join(root, "curl-calls");
      mkdirSync(fakeBin);
      writeFileSync(callCount, "0\n");
      writeFileSync(
        path.join(fakeBin, "curl"),
        `#!/bin/bash
count="$(<"$CURL_CALL_COUNT")"
count=$((count + 1))
printf '%s\n' "$count" >"$CURL_CALL_COUNT"
if [[ "$count" == "1" ]]; then
  printf '198.51.'
  exit 28
fi
printf '%s\n' "\${CURL_SUCCESS_IP:-203.0.113.7}"
`,
        { mode: 0o755 },
      );
      writeFileSync(path.join(fakeBin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail\n${discoveryBlock}\nprintf 'result=%s\\n' "$CRABBOX_AWS_SSH_CIDRS"`,
        ],
        {
          encoding: "utf8",
          env: {
            CURL_CALL_COUNT: callCount,
            PATH: `${fakeBin}:${process.env.PATH}`,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("result=203.0.113.7/32");
      expect(result.stdout).not.toContain("198.51.");
      expect(readFileSync(callCount, "utf8")).toBe("2\n");

      for (const invalidIp of ["999.0.0.1", "203.0.113.7."]) {
        writeFileSync(callCount, "0\n");
        const invalidResult = spawnSync("bash", ["-c", `set -euo pipefail\n${discoveryBlock}`], {
          encoding: "utf8",
          env: {
            CURL_CALL_COUNT: callCount,
            CURL_SUCCESS_IP: invalidIp,
            PATH: `${fakeBin}:${process.env.PATH}`,
          },
        });
        expect(invalidResult.status).toBe(1);
        expect(invalidResult.stderr).toContain(
          "Could not resolve GitHub runner public IPv4 for AWS SSH ingress.",
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails Windows Testbox setup when Blacksmith phone-home is not accepted", () => {
    const workflow = readFileSync(".github/workflows/windows-blacksmith-testbox.yml", "utf8");

    expect(workflow.match(/--connect-timeout 10 --max-time 30/gu)).toHaveLength(2);
    expect(workflow).toContain('echo "phone_home_hydrating_curl=${hydrating_curl_status}"');
    expect(workflow).toContain('echo "phone_home_hydrating_http=${hydrating_http_code}"');
    expect(workflow).toContain('echo "phone_home_ready_curl=${ready_curl_status}"');
    expect(workflow).toContain('echo "phone_home_ready_http=${http_code}"');
    expect(workflow).toContain('jq -e \'type == "number"\' <<<"$installation_model_id"');
    expect(workflow).toContain('--arg testbox_id "$TESTBOX_ID"');
    expect(workflow).toContain('--arg testbox_id "$testbox_id"');
    expect(workflow).toContain('--argjson installation_model_id "$installation_model_id"');
    expect(workflow).toContain('--data-binary @"$hydrating_body"');
    expect(workflow).toContain('--data-binary @"$ready_body"');
    const hydratingFailureBlock = workflow.slice(
      workflow.indexOf(
        'if (( hydrating_curl_status != 0 )) || [[ ! "$hydrating_http_code" =~ ^2 ]]; then',
      ),
      workflow.indexOf('response="$(cat "$hydrating_response")"'),
    );
    const missingSshKeyFailureBlock = workflow.slice(
      workflow.indexOf('if [ -z "$ssh_public_key" ]; then'),
      workflow.indexOf("mkdir -p ~/.ssh"),
    );
    const readyFailureBlock = workflow.slice(
      workflow.indexOf('if (( ready_curl_status != 0 )) || [[ ! "$http_code" =~ ^2 ]]; then'),
      workflow.indexOf('echo "============================================"'),
    );

    expect(workflow).toContain(')" || hydrating_curl_status=$?');
    expect(workflow).toContain(')" || ready_curl_status=$?');
    expect(hydratingFailureBlock).toContain("exit 1");
    expect(missingSshKeyFailureBlock).toContain("exit 1");
    expect(readyFailureBlock).toContain("exit 1");
    expect(workflow).toContain(
      "Blacksmith phone-home did not return an SSH public key; testbox cannot accept CLI connections.",
    );
    expect(workflow).not.toContain(
      'phone_home_ready_http=${http_code}"\n\n          echo "============================================"',
    );
    expect(workflow).not.toContain('\\"testbox_id\\": \\"${TESTBOX_ID}\\"');
    expect(workflow).not.toContain('cat > "$ready_body" <<JSON');
    expect(workflow).not.toContain('"testbox_id": "${testbox_id}"');
  });

  it("runs dependency policy guards in PR CI preflight", () => {
    const parsedWorkflow = readCiWorkflow();
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const preflightGuards = workflow.slice(
      workflow.indexOf("guards)"),
      workflow.indexOf("shrinkwrap)"),
    );
    const shrinkwrapGuards = workflow.slice(
      workflow.indexOf("shrinkwrap)"),
      workflow.indexOf("prod-types)"),
    );

    expect(workflow).toContain("check-guards");
    expect(workflow).toContain("check-shrinkwrap");
    expect(preflightGuards).toContain('has_package_script "check:script-declarations"');
    expect(preflightGuards).toContain("pnpm check:script-declarations");
    expect(preflightGuards).toContain('[[ "$HISTORICAL_TARGET" != "true" ]]');
    expect(preflightGuards).toContain(
      "Current CI targets must provide the check:script-declarations package script.",
    );
    expect(shrinkwrapGuards).toContain("pnpm deps:shrinkwrap:check");
    expect(preflightGuards).toContain("pnpm deps:patches:check");
    expect(parsedWorkflow.jobs.preflight.outputs.diff_base_revision).toBe(
      "${{ steps.diff_base.outputs.sha }}",
    );
    expect(
      parsedWorkflow.jobs.preflight.steps.find(
        (step: WorkflowStep) => step.name === "Resolve exact diff base",
      ).run,
    ).toContain("--prefer-first-parent");
    const securityDiffBase = parsedWorkflow.jobs["security-fast"].steps.find(
      (step: WorkflowStep) => step.name === "Resolve security diff base",
    ).run;
    expect(securityDiffBase).toContain("git rev-list --parents -n 1 HEAD");
    expect(securityDiffBase).not.toContain("node scripts/lib/merge-head-diff-base.mjs");
    const checkShardStep = parsedWorkflow.jobs["check-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run check shard",
    );
    expect(checkShardStep.env.PR_BASE_SHA).toBe(
      "${{ github.event_name == 'pull_request' && needs.preflight.outputs.diff_base_revision || '' }}",
    );
    expect(checkShardStep.run).toContain(
      'timeout --signal=TERM --kill-after=10s 120s git fetch --no-tags --depth=1 origin "+${PR_BASE_SHA}:refs/remotes/origin/ci-base"',
    );
  });

  it("uses stable deadcode checks for current and frozen checkouts", () => {
    const modern = runDependencyCheckFixture({
      historicalTarget: false,
      scripts: ["deadcode:dependencies", "deadcode:unused-files", "deadcode:exports"],
    });
    expect(modern.status, modern.output).toBe(0);
    // The scripts launch concurrently; completion order is nondeterministic.
    expect(modern.calls.toSorted()).toEqual([
      "deadcode:dependencies",
      "deadcode:exports",
      "deadcode:unused-files",
    ]);

    const frozenWithExports = runDependencyCheckFixture({
      historicalTarget: true,
      scripts: ["deadcode:dependencies", "deadcode:unused-files", "deadcode:exports"],
    });
    expect(frozenWithExports.status, frozenWithExports.output).toBe(0);
    expect(frozenWithExports.calls.toSorted()).toEqual([
      "deadcode:dependencies",
      "deadcode:exports",
      "deadcode:unused-files",
    ]);

    const frozen = runDependencyCheckFixture({
      historicalTarget: true,
      scripts: [
        "deadcode:ci",
        "deadcode:dependencies",
        "deadcode:report:ci:ts-unused",
        "deadcode:unused-files",
      ],
    });
    expect(frozen.status, frozen.output).toBe(0);
    expect(frozen.calls.toSorted()).toEqual(["deadcode:dependencies", "deadcode:unused-files"]);

    const currentWithoutExports = runDependencyCheckFixture({
      historicalTarget: false,
      scripts: ["deadcode:dependencies", "deadcode:unused-files"],
    });
    expect(currentWithoutExports.status).toBe(1);
    // The missing-script contract violation now fails fast before launching
    // the concurrent scans instead of wasting two Knip runs first.
    expect(currentWithoutExports.calls).toEqual([]);
    expect(currentWithoutExports.output).toContain(
      "Current CI targets must provide the deadcode:exports package script.",
    );

    const legacy = runDependencyCheckFixture({
      historicalTarget: true,
      scripts: ["deadcode:ci"],
    });
    expect(legacy.status, legacy.output).toBe(0);
    expect(legacy.calls).toEqual(["deadcode:ci"]);

    const incompleteCurrent = runDependencyCheckFixture({
      historicalTarget: false,
      scripts: ["deadcode:dependencies"],
    });
    expect(incompleteCurrent.status).toBe(1);
    expect(incompleteCurrent.calls).toEqual([]);
    expect(incompleteCurrent.output).toContain(
      "Target does not provide a supported deadcode check.",
    );
  });

  it("runs mobile protocol coverage for Node and native-only changes", () => {
    const workflow = readCiWorkflow();
    const coverageStep = workflow.jobs.preflight.steps.find(
      (step: WorkflowStep) => step.name === "Check mobile protocol event coverage",
    );
    const checkShardRun = workflow.jobs["check-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run check shard",
    ).run;

    expect(coverageStep.run).toBe("node scripts/check-protocol-event-coverage.mjs");
    expect(coverageStep.if).toBe("steps.manifest.outputs.run_protocol_event_coverage == 'true'");
    expect(checkShardRun).not.toContain("check:protocol-coverage");
  });

  it("runs the suppression-baseline max-lines ratchet against the exact tested tree", () => {
    const workflow = readCiWorkflow();
    const checksFastSteps = workflow.jobs["checks-fast-core"].steps;
    const checksFastRun = checksFastSteps.find(
      (step: WorkflowStep) => step.name === "Run ${{ matrix.task }} (${{ matrix.runtime }})",
    );
    const releaseGateMerge = checksFastSteps.find(
      (step: WorkflowStep) => step.name === "Prepare release-gate max-lines merge tree",
    );
    const protocolManualBase = checksFastSteps.find(
      (step: WorkflowStep) => step.name === "Resolve manual protocol base",
    );

    expect(workflow.jobs["checks-fast-core"].permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
    });
    expect(releaseGateMerge.if).toBe(
      "matrix.task == 'max-lines-ratchet' && github.event_name == 'workflow_dispatch' && inputs.release_gate",
    );
    expect(checksFastRun.run).toContain("max-lines-ratchet)");
    expect(checksFastRun.run).toContain('has_package_script "check:max-lines-ratchet"');
    expect(checksFastRun.env.RATCHET_EVENT_BASE_SHA).toBe(
      "${{ github.event_name == 'push' && github.event.before || '' }}",
    );
    expect(checksFastRun.env.RATCHET_PR_HEAD_SHA).toBe(
      "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || '' }}",
    );
    expect(checksFastRun.env.RATCHET_MANUAL_TARGET_SHA).toBe(
      "${{ github.event_name == 'workflow_dispatch' && !inputs.release_gate && needs.preflight.outputs.checkout_revision || '' }}",
    );
    expect(checksFastRun.env.GH_TOKEN).toBe(
      "${{ matrix.task == 'max-lines-ratchet' && github.token || '' }}",
    );
    expect(protocolManualBase.if).toBe(
      "matrix.task == 'bundled-protocol' && github.event_name == 'workflow_dispatch' && !inputs.release_gate",
    );
    expect(protocolManualBase.env.GH_TOKEN).toBe("${{ github.token }}");
    expect(protocolManualBase.run).toContain(
      '"repos/${GITHUB_REPOSITORY}/compare/${default_sha}...${TARGET_SHA}"',
    );
    expect(protocolManualBase.run).toContain('echo "sha=${merge_base_sha}" >> "$GITHUB_OUTPUT"');
    expect(checksFastRun.env.PROTOCOL_MANUAL_BASE_SHA).toBe(
      "${{ steps.protocol_manual_base.outputs.sha }}",
    );
    expect(releaseGateMerge.run).toContain(
      'gh api --method GET "repos/${GITHUB_REPOSITORY}/pulls/${PULL_REQUEST_NUMBER}"',
    );
    expect(releaseGateMerge.run).toContain(
      "release-gate pull request must be open and match the target head",
    );
    expect(releaseGateMerge.run).toContain("for attempt in {1..6}");
    expect(releaseGateMerge.run).toContain(
      '"+refs/pull/${PULL_REQUEST_NUMBER}/merge:refs/remotes/origin/ci-max-lines-merge"',
    );
    expect(releaseGateMerge.run).toContain('"$merge_head" == "$TARGET_SHA"');
    expect(releaseGateMerge.run).toContain('git show -s --format=%P "$merge_sha"');
    expect(releaseGateMerge.run).toContain(
      "timeout --signal=TERM --kill-after=10s 120s git fetch --no-tags --depth=2 origin \\",
    );
    expect(releaseGateMerge.run).toContain(
      "Freeze GitHub's canonical merge snapshot once it contains the exact head",
    );
    expect(releaseGateMerge.run).toContain(
      "Base freshness belongs to the landing gate; chasing moving main here can never converge",
    );
    expect(releaseGateMerge.run).toContain(
      "release-gate merge tree did not refresh to the target head",
    );
    expect(releaseGateMerge.run).not.toContain(".base.sha");
    expect(releaseGateMerge.run).toContain('git checkout --detach "$merge_sha"');
    expect(releaseGateMerge.run).toContain(
      'echo "RATCHET_RELEASE_BASE_SHA=${frozen_base_sha}" >> "$GITHUB_ENV"',
    );
    expect(releaseGateMerge.run).toContain(
      'echo "RATCHET_RELEASE_MERGE_TREE=true" >> "$GITHUB_ENV"',
    );
    expect(
      checksFastRun.run.match(
        /timeout --signal=TERM --kill-after=10s 120s git fetch --no-tags --depth=1 origin \\/gu,
      ),
    ).toHaveLength(4);
    expect(checksFastRun.run).toContain('git ls-remote origin "refs/heads/${default_branch}"');
    expect(checksFastRun.run).toContain(
      '"repos/${GITHUB_REPOSITORY}/compare/${default_sha}...${RATCHET_MANUAL_TARGET_SHA}"',
    );
    expect(checksFastRun.run).toContain('PROTOCOL_SINCE_BASE_SHA="$PROTOCOL_MANUAL_BASE_SHA"');
    expect(checksFastRun.run).toContain(
      '"+${PROTOCOL_SINCE_BASE_SHA}:refs/remotes/origin/protocol-since-base"',
    );
    expect(checksFastRun.run).toContain("--jq '.merge_base_commit.sha'");
    expect(checksFastRun.run).toContain(
      '"+${merge_base_sha}:refs/remotes/origin/ci-max-lines-base"',
    );
    expect(checksFastRun.run).toContain(
      'if [[ "$base_sha" == "0000000000000000000000000000000000000000" ]]',
    );
    expect(checksFastRun.run).toContain(
      "mapfile -t merge_parents < <(git cat-file -p HEAD | sed -n 's/^parent //p')",
    );
    expect(checksFastRun.run).toContain('"${#merge_parents[@]}" != "2"');
    expect(checksFastRun.run).toContain('"${merge_parents[1]:-}" != "$RATCHET_PR_HEAD_SHA"');
    expect(checksFastRun.run).toContain('"+${merge_base}:refs/remotes/origin/ci-max-lines-base"');
    expect(checksFastRun.run).not.toContain("ci-max-lines-target^");
    expect(checksFastRun.run).toContain("unset GH_TOKEN");
    expect(checksFastRun.run).toContain('pnpm check:max-lines-ratchet --base "$base_ref"');
    expect(checksFastRun.run).toContain(
      'if [[ "${RATCHET_RELEASE_MERGE_TREE:-}" == "true" ]]; then',
    );
    expect(checksFastRun.run).toContain(
      "node scripts/run-oxlint.mjs src ui/src packages extensions",
    );

    const fastOnly = runCiManifestFixture({
      bundledPlanner: true,
      eventName: "pull_request",
      historicalCompatibility: false,
      nodeFastOnly: true,
      nodeFastPluginContracts: true,
    });
    expect(fastOnly.status, fastOnly.output).toBe(0);
    expect(fastOnly.outputs.run_check).toBe("false");
    expect(fastOnly.outputs.run_checks_fast_core).toBe("true");
    expect(
      JSON.parse(expectDefined(fastOnly.outputs.checks_fast_core_matrix, "fast-only checks matrix"))
        .include,
    ).toEqual([
      {
        check_name: "checks-fast-max-lines-ratchet",
        runtime: "node",
        task: "max-lines-ratchet",
      },
    ]);
  });

  it("uses target-owned CI plans and capabilities for older release checkouts", () => {
    const androidRun = readCiWorkflow().jobs.android.steps.find(
      (step: WorkflowStep) => step.name === "Run Android ${{ matrix.task }}",
    ).run;
    expect(androidRun).toContain("build-play-compat)");
    expect(androidRun).toContain("test-play-compat)");
    expect(androidRun).toContain(":app:assemblePlayDebug");

    const legacy = runCiManifestFixture({ bundledPlanner: false });
    expect(legacy.status, legacy.output).toBe(0);
    expect(legacy.outputs.historical_target).toBe("true");
    expect(legacy.outputs.run_ios_build).toBe("false");
    expect(legacy.outputs.run_native_i18n).toBe("false");
    expect(legacy.outputs.run_qa_smoke_ci).toBe("false");
    expect(legacy.outputs.run_channel_contracts_shards).toBe("false");
    expect(legacy.outputs.run_protocol_event_coverage).toBe("false");
    expect(
      JSON.parse(expectDefined(legacy.outputs.android_matrix, "legacy Android matrix output"))
        .include,
    ).toEqual([
      { check_name: "android-test-play", task: "test-play-compat" },
      { check_name: "android-test-third-party", task: "test-third-party" },
      { check_name: "android-build-play", task: "build-play-compat" },
    ]);
    expect(
      JSON.parse(
        expectDefined(
          legacy.outputs.checks_node_core_nondist_matrix,
          "legacy node core nondist matrix output",
        ),
      ).include,
    ).toContainEqual(
      expect.objectContaining({
        check_name: "legacy-node-plan",
        shard_name: "legacy-node-plan",
      }),
    );

    const current = runCiManifestFixture({ bundledPlanner: true });
    expect(current.status, current.output).toBe(0);
    expect(current.outputs.run_ios_build).toBe("true");
    expect(current.outputs.run_native_i18n).toBe("true");
    expect(current.outputs.run_qa_smoke_ci).toBe("true");
    expect(current.outputs.run_channel_contracts_shards).toBe("true");
    expect(current.outputs.run_protocol_event_coverage).toBe("true");
    expect(current.outputs.run_format_check).toBe("true");
    expect(
      JSON.parse(expectDefined(current.outputs.android_matrix, "current Android matrix output"))
        .include,
    ).toEqual([
      { check_name: "android-test-play", task: "test-play" },
      { check_name: "android-test-third-party", task: "test-third-party" },
      { check_name: "android-test-wear", task: "test-wear" },
      { check_name: "android-build-play", task: "build-play" },
      { check_name: "android-build-wear", task: "build-wear" },
      { check_name: "android-ktlint", task: "ktlint" },
    ]);

    const currentMissingAndroidCapabilities = runCiManifestFixture({
      androidCiCapabilities: false,
      bundledPlanner: true,
      eventName: "pull_request",
    });
    expect(currentMissingAndroidCapabilities.status, currentMissingAndroidCapabilities.output).toBe(
      0,
    );
    expect(
      JSON.parse(
        expectDefined(
          currentMissingAndroidCapabilities.outputs.android_matrix,
          "current fallback-resistant Android matrix output",
        ),
      ).include,
    ).toEqual([
      { check_name: "android-test-play", task: "test-play" },
      { check_name: "android-test-third-party", task: "test-third-party" },
      { check_name: "android-test-wear", task: "test-wear" },
      { check_name: "android-build-play", task: "build-play" },
      { check_name: "android-build-wear", task: "build-wear" },
      { check_name: "android-ktlint", task: "ktlint" },
    ]);
    expect(
      JSON.parse(
        expectDefined(
          current.outputs.checks_node_core_nondist_matrix,
          "current node core nondist matrix output",
        ),
      ).include,
    ).toContainEqual(
      expect.objectContaining({
        check_name: "bundled-node-plan",
        shard_name: "bundled-node-plan",
      }),
    );

    const changedPullRequest = runCiManifestFixture({
      bundledPlanner: true,
      changedPaths: ["src/focused.ts"],
      eventName: "pull_request",
    });
    expect(changedPullRequest.status, changedPullRequest.output).toBe(0);
    expect(
      JSON.parse(
        expectDefined(
          changedPullRequest.outputs.checks_node_core_nondist_matrix,
          "changed PR node matrix output",
        ),
      ).include,
    ).toEqual([
      expect.objectContaining({
        check_name: "changed-node-plan",
        shard_name: "changed-node-plan",
        targets: ["src/focused.test.ts"],
      }),
    ]);
    expect(changedPullRequest.outputs.run_checks_node_core_dist).toBe("true");

    const plannerImportFailure = runCiManifestFixture({
      bundledPlanner: true,
      changedPaths: ["src/focused.ts"],
      changedPlannerImportFails: true,
      eventName: "pull_request",
    });
    expect(plannerImportFailure.status, plannerImportFailure.output).toBe(0);
    expect(
      JSON.parse(
        expectDefined(
          plannerImportFailure.outputs.checks_node_core_nondist_matrix,
          "planner import fallback node matrix output",
        ),
      ).include,
    ).toEqual([
      expect.objectContaining({
        check_name: "bundled-node-plan",
        shard_name: "bundled-node-plan",
      }),
    ]);

    const currentMissingIos = runCiManifestFixture({
      bundledPlanner: true,
      eventName: "pull_request",
      iosCapabilities: false,
    });
    expect(currentMissingIos.status, currentMissingIos.output).toBe(0);
    expect(currentMissingIos.outputs.historical_target).toBe("false");
    expect(currentMissingIos.outputs.run_ios_build).toBe("true");
    expect(currentMissingIos.outputs.run_macos_swift).toBe("true");

    const currentMissingQaPlan = runCiManifestFixture({
      bundledPlanner: true,
      eventName: "pull_request",
      qaSmokePlan: false,
    });
    expect(currentMissingQaPlan.status, currentMissingQaPlan.output).toBe(0);
    expect(currentMissingQaPlan.outputs.run_qa_smoke_ci).toBe("true");

    const frozenMissingCurrentCapabilities = runCiManifestFixture({
      bundledPlanner: true,
      historicalCompatibility: false,
      iosCapabilities: false,
      iosBuildCapability: true,
      nativeI18nCapabilities: false,
      protocolCoverage: false,
      qaSmokePlan: false,
      formatCheck: false,
    });
    expect(frozenMissingCurrentCapabilities.status, frozenMissingCurrentCapabilities.output).toBe(
      0,
    );
    expect(frozenMissingCurrentCapabilities.outputs.historical_target).toBe("false");
    expect(frozenMissingCurrentCapabilities.outputs.run_ios_build).toBe("false");
    expect(frozenMissingCurrentCapabilities.outputs.run_macos_swift).toBe("false");
    expect(frozenMissingCurrentCapabilities.outputs.run_native_i18n).toBe("false");
    expect(frozenMissingCurrentCapabilities.outputs.run_qa_smoke_ci).toBe("false");
    expect(frozenMissingCurrentCapabilities.outputs.run_protocol_event_coverage).toBe("false");
    expect(frozenMissingCurrentCapabilities.outputs.run_format_check).toBe("false");

    const releaseCandidateMissingSwiftWrappers = runCiManifestFixture({
      bundledPlanner: true,
      historicalCompatibility: false,
      iosCapabilities: false,
      iosBuildCapability: true,
      releaseCandidateCompatibility: true,
    });
    expect(releaseCandidateMissingSwiftWrappers.status).toBe(0);
    expect(releaseCandidateMissingSwiftWrappers.outputs.compatibility_target).toBe("true");
    expect(releaseCandidateMissingSwiftWrappers.outputs.run_ios_build).toBe("true");
    expect(releaseCandidateMissingSwiftWrappers.outputs.run_macos_swift).toBe("true");

    const releaseCandidateMissingIosBuild = runCiManifestFixture({
      bundledPlanner: true,
      historicalCompatibility: false,
      iosCapabilities: false,
      iosBuildCapability: false,
      releaseCandidateCompatibility: true,
    });
    expect(releaseCandidateMissingIosBuild.status).toBe(0);
    expect(releaseCandidateMissingIosBuild.outputs.run_ios_build).toBe("false");

    const legacyReleaseCandidate = runCiManifestFixture({
      bundledPlanner: false,
      historicalCompatibility: false,
      releaseCandidateCompatibility: true,
    });
    expect(legacyReleaseCandidate.status, legacyReleaseCandidate.output).toBe(0);
    expect(legacyReleaseCandidate.outputs.compatibility_target).toBe("true");
    expect(
      JSON.parse(
        expectDefined(
          legacyReleaseCandidate.outputs.checks_node_core_nondist_matrix,
          "release candidate node core nondist matrix output",
        ),
      ).include,
    ).toContainEqual(expect.objectContaining({ check_name: "legacy-node-plan" }));

    const currentMissingProtocolCoverage = runCiManifestFixture({
      bundledPlanner: true,
      historicalCompatibility: false,
      protocolCoverage: false,
    });
    expect(currentMissingProtocolCoverage.status, currentMissingProtocolCoverage.output).toBe(0);
    expect(currentMissingProtocolCoverage.outputs.historical_target).toBe("false");
    expect(currentMissingProtocolCoverage.outputs.run_protocol_event_coverage).toBe("false");

    const pullRequestMissingProtocolCoverage = runCiManifestFixture({
      bundledPlanner: true,
      eventName: "pull_request",
      protocolCoverage: false,
    });
    expect(
      pullRequestMissingProtocolCoverage.status,
      pullRequestMissingProtocolCoverage.output,
    ).toBe(0);
    expect(pullRequestMissingProtocolCoverage.outputs.historical_target).toBe("false");
    expect(pullRequestMissingProtocolCoverage.outputs.run_protocol_event_coverage).toBe("true");

    const currentMissingPlanner = runCiManifestFixture({
      bundledPlanner: false,
      eventName: "pull_request",
    });
    expect(currentMissingPlanner.status).not.toBe(0);
    expect(currentMissingPlanner.output).toContain(
      "CI target does not export a supported Node test shard planner",
    );

    const alternateMissingPlanner = runCiManifestFixture({
      bundledPlanner: false,
      historicalCompatibility: false,
    });
    expect(alternateMissingPlanner.status).not.toBe(0);
    expect(alternateMissingPlanner.output).toContain(
      "CI target does not export a supported Node test shard planner",
    );

    const workflow = readCiWorkflow();
    const historicalTargetStep = workflow.jobs.preflight.steps.find(
      (step: { name?: string }) => step.name === "Validate historical release target",
    );
    expect(historicalTargetStep.if).toBe("inputs.historical_target_tag != ''");
    expect(historicalTargetStep.run).toContain('git ls-remote --tags "$remote"');
    expect(historicalTargetStep.run).toContain('[[ "$tag_sha" != "$EXPECTED_SHA" ]]');
    const releaseCandidateStep = workflow.jobs.preflight.steps.find(
      (step: { name?: string }) => step.name === "Validate release candidate target",
    );
    expect(releaseCandidateStep.if).toBe("inputs.release_candidate_ref != ''");
    expect(releaseCandidateStep.run).toContain('git ls-remote --heads "$remote"');
    expect(releaseCandidateStep.run).toContain('[[ "$branch_sha" != "$EXPECTED_SHA" ]]');
    expect(workflow.jobs["qa-smoke-ci-profile"].if).toBe(
      "needs.preflight.outputs.run_qa_smoke_ci == 'true'",
    );
    expect(workflow.jobs["checks-fast-channel-contracts-shard"].if).toBe(
      "needs.preflight.outputs.run_channel_contracts_shards == 'true'",
    );
    const swiftInstall = workflow.jobs["macos-swift"].steps.find(
      (step: { name?: string }) => step.name === "Install XcodeGen / SwiftLint / SwiftFormat",
    );
    const swiftLint = workflow.jobs["macos-swift"].steps.find(
      (step: { name?: string }) => step.name === "Swift lint",
    );
    expect(swiftInstall.run).toContain("brew install xcodegen swiftlint");
    expect(swiftInstall.run).not.toContain("brew install xcodegen swiftlint swiftformat");
    expect(swiftInstall.run).toContain(
      "https://github.com/nicklockwood/SwiftFormat/releases/download/$swiftformat_version/swiftformat.zip",
    );
    expect(swiftInstall.run).toContain(
      'swiftformat_checksum="b990400779aceb7d7020796eb9ba814d4480543f671d38fc0ff48cb72f04c584"',
    );
    expect(swiftInstall.run).toContain(
      'swiftformat_checksum="7cb1cb1fae04932047c7015441c543848e8e60e1572d808d080e0a1f1661114a"',
    );
    expect(swiftInstall.run).toContain(
      'swiftformat_min_version="$(awk \'$1 == "--min-version" { print $2; exit }\' config/swiftformat)"',
    );
    expect(swiftInstall.run).toContain(
      'echo "Unsupported frozen-target SwiftFormat minimum: $swiftformat_min_version" >&2',
    );
    expect(swiftInstall.run).toContain('echo "$swift_tools_dir" >> "$GITHUB_PATH"');
    expect(swiftInstall.run).toContain(
      '[[ "$("$swift_tools_dir/swiftformat" --version)" == "$swiftformat_version" ]]',
    );
    expect(workflow.jobs["macos-swift"].env.HISTORICAL_TARGET).toBe(
      "${{ needs.preflight.outputs.compatibility_target }}",
    );
    expect(swiftInstall.run).toContain('elif [[ "$HISTORICAL_TARGET" == "true" ]]');
    expect(swiftLint.run).toContain("swiftlint lint --config config/swiftlint.yml");
    expect(swiftLint.run).toContain('elif [[ "$HISTORICAL_TARGET" == "true" ]]');

    const checkShard = workflow.jobs["check-shard"].steps.find(
      (step: { name?: string }) => step.name === "Run check shard",
    );
    expect(checkShard.env.HISTORICAL_TARGET).toBe(
      "${{ needs.preflight.outputs.compatibility_target }}",
    );
    expect(checkShard.run).toContain("pnpm tsgo:scripts");
    expect(checkShard.run).toContain('elif [[ "$HISTORICAL_TARGET" != "true" ]]');
    expect(checkShard.run).toContain('has_package_script "deadcode:dependencies"');
    expect(checkShard.run).toContain('has_package_script "deadcode:unused-files"');
    expect(checkShard.run).toContain('has_package_script "deadcode:exports"');
    // The concurrent launcher invokes scripts through the dc_scripts array.
    expect(checkShard.run).toContain("dc_scripts+=(deadcode:exports)");
    expect(checkShard.run).toContain(
      "Current CI targets must provide the deadcode:exports package script.",
    );
    expect(checkShard.run).toContain(
      'elif [[ "$HISTORICAL_TARGET" == "true" ]] && has_package_script "deadcode:ci"',
    );
    expect(checkShard.run).toContain("Target does not provide a supported deadcode check.");

    const uiInstall = workflow.jobs["checks-ui"].steps.find(
      (step: { name?: string }) => step.name === "Install Playwright Chromium",
    );
    const uiTest = workflow.jobs["checks-ui"].steps.find(
      (step: { name?: string }) => step.name === "Test Control UI",
    );
    expect(workflow.jobs["checks-ui"].env.COMPATIBILITY_TARGET).toBe(
      "${{ needs.preflight.outputs.compatibility_target }}",
    );
    expect(uiInstall.run).toContain('if [[ "$COMPATIBILITY_TARGET" == "true" ]]');
    expect(uiInstall.run).toContain("pnpm --dir ui exec playwright install chromium");
    expect(uiInstall.run).toContain("node scripts/ensure-playwright-chromium.mjs");
    expect(uiInstall.run).not.toContain("OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM");
    expect(uiTest.run).toContain('if [[ "$COMPATIBILITY_TARGET" == "true" ]]');
    expect(uiTest.run).toContain("pnpm --dir ui test --testTimeout=30000 --isolate");
    expect(uiTest.run).not.toContain("--retry");
    expect(uiTest.run).toContain("pnpm --dir ui test");
  });

  it("does not rebuild Control UI after build:ci-artifacts", () => {
    const workflow = readCiWorkflow();
    const buildArtifactSteps = workflow.jobs["build-artifacts"].steps;
    const buildDistStep = buildArtifactSteps.find(
      (step: WorkflowStep) => step.name === "Build dist",
    );

    expect(buildDistStep.run).toBe("pnpm build:ci-artifacts");
    expect(buildArtifactSteps.map((step: WorkflowStep) => step.name)).not.toContain(
      "Build Control UI",
    );
    expect(buildArtifactSteps.some((step: WorkflowStep) => step.run === "pnpm ui:build")).toBe(
      false,
    );
  });

  it("keeps source-only Control UI locale drift advisory", () => {
    const workflow = readCiWorkflow();
    const workflowSource = readFileSync(".github/workflows/ci.yml", "utf8");
    const buildArtifactSteps = workflow.jobs["build-artifacts"].steps;
    const localeJob = workflow.jobs["control-ui-i18n"];
    const localeStep = localeJob.steps.find(
      (step: WorkflowStep) => step.name === "Check Control UI locale parity",
    );

    expect(buildArtifactSteps).not.toContainEqual(
      expect.objectContaining({ run: "pnpm ui:i18n:check" }),
    );
    expect(JSON.parse(readFileSync("package.json", "utf8")).scripts["test:ui"]).not.toContain(
      "ui:i18n:check",
    );
    expect(workflowSource.match(/pnpm ui:i18n:check/gu)).toHaveLength(1);
    expect(readFileSync("ui/src/i18n/test/translate.test.ts", "utf8")).not.toContain(
      "keeps shipped locales structurally aligned with English",
    );
    expect(localeJob.needs).toEqual(["preflight"]);
    expect(localeJob.if).toBe("needs.preflight.outputs.run_control_ui_i18n == 'true'");
    expect(localeJob["continue-on-error"]).toBeUndefined();
    expect(localeStep["continue-on-error"]).toBe(
      "${{ needs.preflight.outputs.strict_control_ui_i18n != 'true' }}",
    );
    expect(localeStep.run).toBe("pnpm ui:i18n:check");
    expect(readFileSync(".github/workflows/full-release-validation.yml", "utf8")).toContain(
      'dispatch_and_wait ci.yml "$dispatch_run_name"',
    );
  });

  it("splits native source verification from generated locale parity", () => {
    const workflow = readCiWorkflow();
    const localeJob = workflow.jobs["native-i18n"];
    const sourceStep = localeJob.steps.find(
      (step: WorkflowStep) => step.name === "Verify native app i18n source",
    );
    const parityStep = localeJob.steps.find(
      (step: WorkflowStep) => step.name === "Check native app generated locale parity",
    );
    const packageScripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;

    expect(packageScripts["native:i18n:baseline"]).toContain("baseline --write");
    expect(packageScripts["native:i18n:verify"]).toContain(" verify");
    expect(workflow.jobs.preflight.outputs.strict_native_i18n).toContain(
      "steps.changed_scope.outputs.strict_native_i18n",
    );
    expect(sourceStep.run).toContain("pnpm native:i18n:verify");
    expect(sourceStep.run).toContain("Historical release targets");
    expect(parityStep.if).toBe("${{ needs.preflight.outputs.strict_native_i18n == 'true' }}");
    expect(parityStep.run).toContain("pnpm native:i18n:check");
    expect(parityStep.run).not.toContain("pnpm android:i18n:check");
    expect(parityStep.run).not.toContain("pnpm apple:i18n:check");
  });

  it("keeps the hosted plugin-list memory allowance scoped to GitHub-hosted runners", () => {
    const workflow = readCiWorkflow();
    const startupMemoryStep = workflow.jobs["build-artifacts"].steps.find(
      (step: WorkflowStep) => step.name === "Check CLI startup memory",
    );

    expect(startupMemoryStep.env.OPENCLAW_STARTUP_MEMORY_PLUGINS_LIST_MB).toBe(
      "${{ runner.environment == 'github-hosted' && '425' || '400' }}",
    );
  });

  it("restores the dist build cache before building and saves only cache misses", () => {
    const workflow = readCiWorkflow();
    const buildArtifactSteps = workflow.jobs["build-artifacts"].steps;
    const stepNames = buildArtifactSteps.map((step: WorkflowStep) => step.name);
    const restoreStep = buildArtifactSteps.find(
      (step: WorkflowStep) => step.name === "Restore dist build cache",
    );
    const buildDistStep = buildArtifactSteps.find(
      (step: WorkflowStep) => step.name === "Build dist",
    );
    const saveStep = buildArtifactSteps.find(
      (step: WorkflowStep) => step.name === "Save dist build cache",
    );

    expect(stepNames.indexOf("Restore dist build cache")).toBeLessThan(
      stepNames.indexOf("Build dist"),
    );
    expect(stepNames.indexOf("Build dist")).toBeLessThan(
      stepNames.indexOf("Pack built runtime artifacts"),
    );
    expect(stepNames.indexOf("Run built artifact checks")).toBeLessThan(
      stepNames.indexOf("Save dist build cache"),
    );
    expect(restoreStep.uses).toBe(CACHE_V5);
    expect(buildDistStep.if).toBe("steps.dist_build_cache.outputs.cache-hit != 'true'");
    expect(saveStep.uses).toBe("actions/cache/save@27d5ce7f107fe9357f9df03efb73ab90386fccae");
    expect(saveStep.if).toBe("steps.dist_build_cache.outputs.cache-hit != 'true'");
    expect(saveStep.with.key).toBe("${{ steps.dist_build_cache.outputs.cache-primary-key }}");
    expect(restoreStep.with.path).toContain("dist/");
    expect(restoreStep.with.path).toContain("dist-runtime/");
    expect(restoreStep.with.path).toContain("packages/*/dist/");
    expect(saveStep.with.path).toContain("packages/*/dist/");
    expect(restoreStep.with.key).toContain("dist-build-v3-");
    expect(
      buildArtifactSteps.find((step: WorkflowStep) => step.name === "Pack built runtime artifacts")
        .run,
    ).toContain("packages/*/dist");
    expect(restoreStep.with.path).toContain("extensions/*/src/host/**/.bundle.hash");
    expect(restoreStep.with.path).toContain("extensions/*/src/host/**/*.bundle.js");
    expect(buildArtifactSteps.map((step: WorkflowStep) => step.name)).not.toContain(
      "Cache dist build",
    );
  });

  it("keeps the AI runtime in Testbox build artifact caches", () => {
    const workflow = readBuildArtifactsTestboxWorkflow();
    const steps = workflow.jobs["build-artifacts"].steps;
    const resolveSeedsStep = steps.find(
      (step: WorkflowStep) => step.name === "Resolve release dist cache seeds",
    );
    const restoreStep = steps.find(
      (step: WorkflowStep) => step.name === "Restore dist build cache",
    );
    const verifyStep = steps.find((step: WorkflowStep) => step.name === "Verify build artifacts");
    const saveStep = steps.find((step: WorkflowStep) => step.name === "Save dist build cache");

    expect(resolveSeedsStep.run).toContain('cache_prefix="${RUNNER_OS}-dist-build-v2-"');
    expect(restoreStep.with.path).toContain("packages/*/dist/");
    expect(restoreStep.with.key).toContain("dist-build-v2-");
    expect(verifyStep.run).toContain("test -f packages/ai/dist/internal/runtime.mjs");
    expect(saveStep.with.path).toContain("packages/*/dist/");
    expect(saveStep.with.key).toContain("dist-build-v2-");
  });

  it("parallelizes gateway watch only on the large self-hosted build runner", () => {
    const workflow = readCiWorkflow();
    const buildArtifactSteps = workflow.jobs["build-artifacts"].steps;
    const builtArtifactChecks = buildArtifactSteps.find(
      (step: WorkflowStep) => step.name === "Run built artifact checks",
    );
    const run = builtArtifactChecks.run;

    expect(builtArtifactChecks.env.PARALLEL_GATEWAY_WATCH).toBe(
      "${{ runner.environment != 'github-hosted' && 'true' || 'false' }}",
    );
    expect(run).toContain('start_check "channels"');
    expect(run).toContain('start_check "core-support-boundary"');
    expect(run).toContain('start_check "gateway-watch"');
    expect(run).toContain(
      'if [ "$RUN_GATEWAY_WATCH" = "true" ] && [ "$PARALLEL_GATEWAY_WATCH" = "true" ]; then',
    );
    expect(run).toContain(
      'if [ "$RUN_GATEWAY_WATCH" = "true" ] && [ "$PARALLEL_GATEWAY_WATCH" != "true" ]; then',
    );
    expect(run).toContain("wait_checks()");
    expect(run.match(/wait_checks$/gmu)).toHaveLength(2);
  });

  it("keeps docs i18n CI on the workflow-owned patched Go toolchain", () => {
    const workflow = readCiWorkflow();
    const nodeTestJob = workflow.jobs["checks-node-core-test-nondist-shard"];
    const setupGoStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Setup Go for docs i18n",
    );
    const verifyGoStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Verify docs i18n Go toolchain",
    );
    expect(setupGoStep).toMatchObject({
      if: "matrix.requires_go == true",
      uses: SETUP_GO_V6,
      with: {
        "go-version": "1.25.12",
        "cache-dependency-path": "scripts/docs-i18n/go.sum",
      },
    });
    expect(setupGoStep.with).not.toHaveProperty("go-version-file");
    expect(verifyGoStep).toMatchObject({
      if: "matrix.requires_go == true",
      run: 'test "$(go env GOVERSION)" = "go1.25.12"',
    });

    const goMod = readTrackedText("scripts/docs-i18n/go.mod");
    expect(goMod).toMatch(/^go 1\.25\.0$/mu);
    expect(goMod).toMatch(/^toolchain go1\.25\.12$/mu);
  });

  it("fails and retries quiet Node test shard stalls quickly", () => {
    const workflow = readCiWorkflow();
    const preflightJob = workflow.jobs.preflight;
    const manifestStep = preflightJob.steps.find(
      (step: WorkflowStep) => step.name === "Build CI manifest",
    );
    const nodeTestJob = workflow.jobs["checks-node-core-test-nondist-shard"];
    const runStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Run Node test shard",
    );

    expect(JSON.stringify(preflightJob.steps)).toContain("timeout_minutes: shard.timeoutMinutes");
    expect(manifestStep.run).toContain(
      'shard.groups?.some((group) => group.shard_name.startsWith("core-tooling"))',
    );
    expect(nodeTestJob["timeout-minutes"]).toBe("${{ matrix.timeout_minutes || 60 }}");
    expect(runStep.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBe("300000");
    expect(runStep.env.OPENCLAW_VITEST_NO_OUTPUT_RETRY).toBe("1");
    expect(runStep.env.OPENCLAW_NODE_TEST_ENV_JSON).toBe("${{ toJson(matrix.env) }}");
    expect(runStep.env.OPENCLAW_NODE_TEST_TARGETS_JSON).toBe("${{ toJson(matrix.targets) }}");
    expect(runStep.env.OPENCLAW_NODE_TEST_VITEST_ARGS_JSON).toBe(
      "${{ needs.preflight.outputs.compatibility_target == 'true' && '[\"--hookTimeout=300000\"]' || '[]' }}",
    );
    expect(runStep.env.JOB_CONTEXT_JSON).toBe("${{ toJSON(job) }}");
    // Shard execution policy lives in the unit-tested wrapper script. Frozen
    // release targets load that wrapper from the exact trusted workflow SHA.
    for (const expected of [
      'runner="scripts/ci-run-node-test-shard.mjs"',
      'if [[ ! -f "$runner" ]]',
      "job_workflow_repository=$(jq -r '.workflow_repository // empty' <<<\"$JOB_CONTEXT_JSON\")",
      "job_workflow_sha=$(jq -r '.workflow_sha // empty' <<<\"$JOB_CONTEXT_JSON\")",
      'timeout --signal=TERM --kill-after=10s 120s git fetch --no-tags --depth=1 "$workflow_remote" "$job_workflow_sha"',
      'git show "${job_workflow_sha}:${file}" > "${harness_root}/${file}"',
      'node "$runner"',
    ]) {
      expect(runStep.run).toContain(expected);
    }
    expect(existsSync("scripts/ci-run-node-test-shard.mjs")).toBe(true);
  });

  it("keeps the CI timing summary parked for timing optimization work", () => {
    expect(readFileSync(".github/workflows/ci.yml", "utf8")).toContain(
      "Re-enable this job when we want to collect CI timing data for timing optimization.",
    );

    const workflow = readCiWorkflow();
    const timingJob = workflow.jobs["ci-timings-summary"];

    expect(timingJob.permissions).toMatchObject({ actions: "read", contents: "read" });
    expect(timingJob.needs).toEqual([
      "preflight",
      "security-fast",
      "pnpm-store-warmup",
      "build-artifacts",
      "checks-ui",
      "control-ui-i18n",
      "checks-fast-core",
      "checks-fast-plugin-contracts-shard",
      "checks-fast-channel-contracts-shard",
      "checks-node-compat",
      "checks-node-core-test-nondist-shard",
      "check-shard",
      "check-additional-shard",
      "check-docs",
      "skills-python",
      "checks-windows",
      "macos-node",
      "macos-swift",
      "ios-build",
      "android",
    ]);
    expect(timingJob.if).toContain("false");
    expect(timingJob.if).toContain("always()");
    expect(timingJob.if).toContain("!cancelled()");

    const checkoutStep = timingJob.steps.find(
      (step: WorkflowStep) => step.name === "Checkout timing summary helper",
    );
    expect(checkoutStep.uses).toBe(CHECKOUT_V6);
    expect(checkoutStep.with.ref).toBe(
      "${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || needs.preflight.outputs.checkout_revision || github.sha }}",
    );
    expect(checkoutStep.with["persist-credentials"]).toBe(false);

    const writeStep = timingJob.steps.find(
      (step: WorkflowStep) => step.name === "Write CI timing summary",
    );
    expect(writeStep.env).toMatchObject({ GH_TOKEN: "${{ github.token }}" });
    expect(writeStep.run).toContain(
      'node scripts/ci-run-timings.mjs "$GITHUB_RUN_ID" --limit 25 > ci-timings-summary.txt',
    );
    expect(writeStep.run).toContain('cat ci-timings-summary.txt >> "$GITHUB_STEP_SUMMARY"');

    const uploadStep = timingJob.steps.find(
      (step: WorkflowStep) => step.name === "Upload CI timing summary",
    );
    expect(uploadStep.uses).toBe(UPLOAD_ARTIFACT_V7);
    expect(uploadStep.with).toMatchObject({
      name: "ci-timings-summary",
      path: "ci-timings-summary.txt",
      "retention-days": 14,
    });
  });

  it("emits one final CI gate after every selected lane", () => {
    const workflow = readCiWorkflow();
    const gate = workflow.jobs["ci-gate"];
    const requiredJobs = ["preflight", "security-fast"];
    const selectedJobs = [
      "pnpm-store-warmup",
      "build-artifacts",
      "native-i18n",
      "checks-ui",
      "control-ui-i18n",
      "checks-fast-core",
      "qa-smoke-ci-profile",
      "checks-fast-plugin-contracts-shard",
      "checks-fast-channel-contracts-shard",
      "checks-node-compat",
      "checks-node-core-test-nondist-shard",
      "check-shard",
      "check-additional-shard",
      "check-docs",
      "skills-python",
      "checks-windows",
      "macos-node",
      "macos-swift",
      "ios-build",
      "android",
    ];

    expect(workflow.on.pull_request).not.toHaveProperty("paths-ignore");
    expect(gate.name).toBe("openclaw/ci-gate");
    expect(gate.needs).toEqual([...requiredJobs, ...selectedJobs]);
    expect(gate.needs.toSorted()).toEqual(
      Object.keys(workflow.jobs)
        .filter((job) => job !== "ci-gate" && job !== "ci-timings-summary")
        .toSorted(),
    );
    expect(gate.if).toBe(
      "${{ always() && (github.event_name != 'pull_request' || !github.event.pull_request.draft) }}",
    );
    expect(gate["runs-on"]).toBe("ubuntu-24.04");
    expect(gate.permissions).toEqual({ contents: "read" });

    const verifyStep = gate.steps.find(
      (step: WorkflowStep) => step.name === "Verify selected CI lanes",
    );
    expect(Object.keys(verifyStep.env).toSorted()).toEqual([
      "REQUIRED_RESULTS",
      "SELECTED_RESULTS",
    ]);
    for (const job of requiredJobs) {
      expect(verifyStep.env.REQUIRED_RESULTS).toContain(`${job}=\${{ needs.${job}.result }}`);
    }
    for (const job of selectedJobs) {
      expect(verifyStep.env.SELECTED_RESULTS).toContain(`${job}=\${{ needs.${job}.result }}`);
    }
    expect(verifyStep.run).toContain("Required CI job did not succeed");
    expect(verifyStep.run).toContain("success | skipped");
    expect(verifyStep.run).toContain("Selected CI job did not succeed");
  });

  it.skipIf(process.platform === "win32")(
    "accepts only successful required jobs and successful or skipped selected jobs",
    () => {
      const passing = runCiGateFixture(
        "preflight=success\nsecurity-fast=success",
        "checks-ui=success\nmacos-swift=skipped",
      );
      expect(passing.status, `${passing.stdout}\n${passing.stderr}`).toBe(0);

      const skippedRequired = runCiGateFixture(
        "preflight=skipped\nsecurity-fast=success",
        "checks-ui=skipped",
      );
      expect(skippedRequired.status).not.toBe(0);
      expect(skippedRequired.stdout).toContain("preflight finished with skipped");

      const failedSelected = runCiGateFixture(
        "preflight=success\nsecurity-fast=success",
        "checks-ui=failure\nmacos-swift=cancelled",
      );
      expect(failedSelected.status).not.toBe(0);
      expect(failedSelected.stdout).toContain("checks-ui finished with failure");
      expect(failedSelected.stdout).toContain("macos-swift finished with cancelled");
    },
  );

  it("bounds QA profile selected-ref fetches", () => {
    const validateSelectedRef = expectDefined(
      readQaProfileEvidenceWorkflow().jobs.validate_selected_ref.steps.find(
        (step: WorkflowStep) => step.name === "Validate selected ref",
      ),
      "QA profile selected-ref validation step",
    );
    const gitFetchLines = validateSelectedRef.run
      .split("\n")
      .filter((line: string) => line.includes("git fetch"));

    expect(gitFetchLines).toHaveLength(2);
    expect(
      gitFetchLines.every((line: string) =>
        line.trimStart().startsWith("timeout --signal=TERM --kill-after=10s 120s git fetch"),
      ),
    ).toBe(true);
  });

  it("keeps maturity scorecard generated QA evidence handoff strict", () => {
    const maturityWorkflow = readMaturityScorecardWorkflow();
    const qaEvidenceWorkflow = readQaProfileEvidenceWorkflow();
    const generateJob = maturityWorkflow.jobs.generate_qa_evidence;
    const publisherPreflight = maturityWorkflow.jobs.publisher_preflight;
    const publishJob = maturityWorkflow.jobs.publish;
    const publishPrJob = maturityWorkflow.jobs.publish_generated_pr;
    const qaRunJob = qaEvidenceWorkflow.jobs.run_qa_profile;

    expect(maturityWorkflow.on.workflow_call.inputs).toMatchObject({
      qa_evidence_run_id: {
        description: "Optional workflow run id containing qa-evidence.json",
        required: false,
        default: "",
        type: "string",
      },
      ref: {
        description: "OpenClaw branch, tag, or SHA containing the maturity score source",
        required: true,
        type: "string",
      },
      expected_sha: {
        description: "Optional full SHA that ref must resolve to",
        required: false,
        default: "",
        type: "string",
      },
    });
    expect(maturityWorkflow.on.workflow_dispatch.inputs.publish_pull_request).toEqual({
      description: "Open or update a pull request for generated maturity files",
      required: false,
      default: true,
      type: "boolean",
    });
    expect(maturityWorkflow.on.workflow_call.inputs).not.toHaveProperty("publish_pull_request");
    expect(maturityWorkflow.on.workflow_call.secrets.OPENAI_API_KEY.required).toBe(true);
    expect(
      maturityWorkflow.on.workflow_call.secrets.OPENCLAW_MATURITY_SCORECARD_AGENT_OPENAI_API_KEY
        .required,
    ).toBe(false);
    expect(Object.keys(maturityWorkflow.on.workflow_call.secrets).toSorted()).toEqual([
      "CLAWSWEEPER_APP_PRIVATE_KEY",
      "MANTIS_GITHUB_APP_PRIVATE_KEY",
      "OPENAI_API_KEY",
      "OPENCLAW_MATURITY_SCORECARD_AGENT_OPENAI_API_KEY",
      "OPENCLAW_QA_CONVEX_SECRET_CI",
      "OPENCLAW_QA_CONVEX_SITE_URL",
    ]);
    for (const secret of [
      "CLAWSWEEPER_APP_PRIVATE_KEY",
      "MANTIS_GITHUB_APP_PRIVATE_KEY",
      "OPENCLAW_QA_CONVEX_SECRET_CI",
      "OPENCLAW_QA_CONVEX_SITE_URL",
    ]) {
      expect(maturityWorkflow.on.workflow_call.secrets[secret].required).toBe(false);
    }
    expect(qaEvidenceWorkflow.on.workflow_dispatch.inputs).not.toHaveProperty("fail_on_qa_failure");
    expect(qaEvidenceWorkflow.on.workflow_call.inputs).not.toHaveProperty("fail_on_qa_failure");
    expect(qaEvidenceWorkflow.on.workflow_dispatch.inputs.qa_profile).not.toHaveProperty("options");
    expect(qaEvidenceWorkflow.on.workflow_dispatch.inputs.qa_profile.default).toBe("all");
    expect(qaEvidenceWorkflow.on.workflow_call.inputs.qa_profile.type).toBe("string");
    expect(qaRunJob["timeout-minutes"]).toBe(60);
    const validateProfileStep = qaRunJob.steps.find(
      (step: WorkflowStep) => step.name === "Validate QA profile input",
    );
    expect(validateProfileStep.run).toContain(
      "taxonomy.profiles.find((entry) => entry.id === requested)",
    );
    expect(validateProfileStep.run).toContain("profile=${profile.id}");
    const ensurePlaywrightStep = qaRunJob.steps.find(
      (step: WorkflowStep) => step.name === "Ensure Playwright Chromium",
    );
    expect(ensurePlaywrightStep.run).toBe("node scripts/ensure-playwright-chromium.mjs");
    const runProfileStep = qaRunJob.steps.find(
      (step: WorkflowStep) => step.name === "Run QA profile",
    );
    expect(runProfileStep.run).toContain("--concurrency 2");
    expect(runProfileStep.run).toContain("--fast");
    expect(generateJob.needs).toEqual(["validate_selected_ref", "publisher_preflight"]);
    expect(generateJob.if.replace(/\s+/gu, " ")).toBe(
      "${{ always() && needs.validate_selected_ref.result == 'success' && (!inputs.publish_pull_request || needs.publisher_preflight.result == 'success') && inputs.qa_evidence_run_id == '' }}",
    );
    expect(generateJob.uses).toBe("./.github/workflows/qa-profile-evidence.yml");
    expect(generateJob.with).toMatchObject({
      // Reusable jobs start later, so forward the immutable revision instead of a moving branch.
      ref: "${{ needs.validate_selected_ref.outputs.selected_revision }}",
      expected_sha: "${{ needs.validate_selected_ref.outputs.selected_revision }}",
      qa_profile: "all",
    });
    expect(generateJob.with).not.toHaveProperty("fail_on_qa_failure");
    expect(generateJob.secrets).toMatchObject({
      OPENAI_API_KEY: "${{ secrets.OPENAI_API_KEY }}",
      OPENCLAW_QA_CONVEX_SECRET_CI: "${{ secrets.OPENCLAW_QA_CONVEX_SECRET_CI }}",
      OPENCLAW_QA_CONVEX_SITE_URL: "${{ secrets.OPENCLAW_QA_CONVEX_SITE_URL }}",
    });

    const workflowStep = maturityWorkflow.jobs.validate_selected_ref.steps.find(
      (step: WorkflowStep) => step.name === "Resolve job workflow identity",
    );
    const authorizeStep = maturityWorkflow.jobs.validate_selected_ref.steps.find(
      (step: WorkflowStep) => step.name === "Authorize workflow invocation",
    );
    const validateRefStep = maturityWorkflow.jobs.validate_selected_ref.steps.find(
      (step: WorkflowStep) => step.name === "Validate selected ref",
    );
    expect(workflowStep.env.JOB_CONTEXT).toBe("${{ toJSON(job) }}");
    expect(workflowStep.run).toContain("job.workflow_sha must be a full lowercase commit SHA");
    expect(authorizeStep.env).toEqual({
      CALLER_EVENT_NAME: "${{ github.event_name }}",
      CALLER_WORKFLOW_REF: "${{ github.workflow_ref }}",
      JOB_WORKFLOW_FILE_PATH: "${{ steps.workflow.outputs.workflow_file_path }}",
      JOB_WORKFLOW_REF: "${{ steps.workflow.outputs.workflow_ref }}",
      JOB_WORKFLOW_REPOSITORY: "${{ steps.workflow.outputs.workflow_repository }}",
      PUBLISH_PULL_REQUEST: "${{ inputs.publish_pull_request || false }}",
    });
    expect(authorizeStep.run).toContain(
      `expected_workflow_ref="${MATURITY_SCORECARD_WORKFLOW_REF}"`,
    );
    expect(authorizeStep.run).toContain(
      '[[ "$PUBLISH_PULL_REQUEST" == "true" && "$canonical_direct" != "true" ]]',
    );
    expect(authorizeStep.run).toContain(
      "Reusable maturity workflows are artifact-only and cannot publish pull requests.",
    );
    expect(validateRefStep.env.EXPECTED_SHA).toBe("${{ inputs.expected_sha }}");
    expect(validateRefStep.env.PUBLISH_PULL_REQUEST).toBe("${{ inputs.publish_pull_request }}");
    expect(validateRefStep.env).not.toHaveProperty("TRUSTED_WORKFLOW_SHA");
    expect(validateRefStep.env.EVIDENCE_RUN_ID).toBe(
      "${{ inputs.qa_evidence_run_id || github.run_id }}",
    );
    for (const fragment of [
      "expected_sha must be a full 40-character SHA",
      'branch_candidate="${INPUT_REF#refs/heads/}"',
      "floating_default_branch=false",
      '[[ -z "${expected_sha// }" && "$branch_candidate" == "$DEFAULT_BRANCH" ]]',
      'selected_revision="$(git rev-parse refs/remotes/origin/main)"',
      '[[ "$floating_default_branch" == "true" && "$publication_base" == "$DEFAULT_BRANCH" ]]',
      'branch_lookup_status="$?"',
      "2) ;;",
      "Unable to determine whether '${INPUT_REF}' is a remote branch",
      'git merge-base --is-ancestor "$selected_revision"',
      "':(exclude)qa/maturity-scores.yaml'",
      "':(exclude)docs/maturity/scorecard.md'",
      "':(exclude)docs/maturity/taxonomy.md'",
      "qa_evidence_run_id must be a numeric GitHub Actions run id",
      'publication_head="automation/maturity-scorecard-',
    ]) {
      expect(validateRefStep.run).toContain(fragment);
    }
    expect(maturityWorkflow.jobs.validate_selected_ref.outputs).toMatchObject({
      publication_base: "${{ steps.validate.outputs.publication_base }}",
      publication_head: "${{ steps.validate.outputs.publication_head }}",
      workflow_file_path: "${{ steps.workflow.outputs.workflow_file_path }}",
      workflow_ref: "${{ steps.workflow.outputs.workflow_ref }}",
      workflow_repository: "${{ steps.workflow.outputs.workflow_repository }}",
      workflow_sha: "${{ steps.workflow.outputs.workflow_sha }}",
    });

    const trustedPublisherCondition = [
      "${{ inputs.publish_pull_request &&",
      "github.event_name == 'workflow_dispatch' &&",
      `github.workflow_ref == '${MATURITY_SCORECARD_WORKFLOW_REF}' &&`,
      `needs.validate_selected_ref.outputs.workflow_file_path == '${MATURITY_SCORECARD_WORKFLOW}' &&`,
      `needs.validate_selected_ref.outputs.workflow_ref == '${MATURITY_SCORECARD_WORKFLOW_REF}' &&`,
      "needs.validate_selected_ref.outputs.workflow_repository == 'openclaw/openclaw' }}",
    ].join(" ");
    expect(publisherPreflight.needs).toBe("validate_selected_ref");
    expect(publisherPreflight.if).toBe("${{ inputs.publish_pull_request }}");
    const preflightCheckoutStep = publisherPreflight.steps.find(
      (step: WorkflowStep) => step.name === "Checkout trusted workflow source",
    );
    const preflightTokensStep = publisherPreflight.steps.find(
      (step: WorkflowStep) => step.name === "Create generated PR tokens",
    );
    expect(preflightCheckoutStep).toMatchObject({
      uses: CHECKOUT_V6,
      with: {
        repository: "${{ needs.validate_selected_ref.outputs.workflow_repository }}",
        ref: "${{ needs.validate_selected_ref.outputs.workflow_sha }}",
        "persist-credentials": false,
        submodules: false,
      },
    });
    expect(preflightTokensStep.if.replace(/\s+/gu, " ")).toBe(trustedPublisherCondition);
    expect(preflightTokensStep).toMatchObject({
      uses: "./.github/actions/create-generated-pr-tokens",
      with: {
        "contents-client-id": "Iv23liOECG0slfuhz093",
        "contents-private-key": "${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}",
        "pull-request-client-id": MANTIS_GITHUB_APP_CLIENT_ID,
        "pull-request-private-key": "${{ secrets.MANTIS_GITHUB_APP_PRIVATE_KEY }}",
      },
    });
    expect(publishJob.needs).toEqual([
      "validate_selected_ref",
      "publisher_preflight",
      "generate_qa_evidence",
    ]);
    expect(publishJob.if.replace(/\s+/gu, " ")).toBe(
      "${{ always() && needs.validate_selected_ref.result == 'success' && (!inputs.publish_pull_request || needs.publisher_preflight.result == 'success') && (inputs.qa_evidence_run_id != '' || needs.generate_qa_evidence.result == 'success') }}",
    );
    expect(JSON.stringify(publishJob)).not.toMatch(
      /CLAWSWEEPER_APP_PRIVATE_KEY|MANTIS_GITHUB_APP/u,
    );

    const generatedDownloadStep = publishJob.steps.find(
      (step: WorkflowStep) => step.name === "Download generated QA evidence artifact",
    );
    expect(generatedDownloadStep.if).toBe("${{ inputs.qa_evidence_run_id == '' }}");
    expect(generatedDownloadStep.env.GENERATED_ARTIFACT_NAME).toBe(
      "${{ needs.generate_qa_evidence.outputs.artifact_name }}",
    );
    expect(generatedDownloadStep.run).toContain('gh run download "$GITHUB_RUN_ID"');
    expect(generatedDownloadStep.run).toContain('--name "$GENERATED_ARTIFACT_NAME"');
    expect(generatedDownloadStep.run).not.toContain("--pattern");

    const requireEvidenceStep = publishJob.steps.find(
      (step: WorkflowStep) => step.name === "Require one QA evidence file",
    );
    expect(requireEvidenceStep.run).toContain("Expected exactly one qa-evidence.json file");

    const validateManifestStep = publishJob.steps.find(
      (step: WorkflowStep) => step.name === "Validate QA evidence manifest",
    );
    expect(validateManifestStep.run).toContain("qa-profile-evidence-manifest.json");
    expect(validateManifestStep.run).toContain("qa-evidence.json profile must be all");
    expect(validateManifestStep.run).toContain("QA evidence manifest profile must be all");
    expect(validateManifestStep.run).toContain("manifest.targetSha !== targetSha");

    expect(qaRunJob.outputs.artifact_name).toBe("${{ steps.evidence.outputs.artifact_name }}");
    const qaEvidenceStep = qaRunJob.steps.find(
      (step: WorkflowStep) => step.name === "Validate QA profile evidence",
    );
    expect(qaEvidenceStep.env.ARTIFACT_NAME).toBe(
      "qa-profile-evidence-${{ steps.profile.outputs.profile }}-${{ needs.validate_selected_ref.outputs.selected_revision }}",
    );
    expect(qaEvidenceStep.run).toContain("qa-profile-evidence-manifest.json");

    const qaUploadStep = qaRunJob.steps.find(
      (step: WorkflowStep) => step.name === "Upload QA profile evidence",
    );
    expect(qaUploadStep.with).toMatchObject({
      name: "qa-profile-evidence-${{ steps.profile.outputs.profile }}-${{ needs.validate_selected_ref.outputs.selected_revision }}",
      path: "${{ steps.run_profile.outputs.output_dir }}",
      "if-no-files-found": "error",
    });

    const qaFailStep = qaRunJob.steps.find(
      (step: WorkflowStep) => step.name === "Fail if QA profile failed",
    );
    expect(qaFailStep.if).toBe("always()");

    const renderCheckoutStep = publishJob.steps.find(
      (step: WorkflowStep) => step.name === "Checkout selected ref",
    );
    const generatedPrUploadStep = publishJob.steps.find(
      (step: WorkflowStep) => step.name === "Upload generated PR files",
    );
    expect(renderCheckoutStep.with["fetch-depth"]).toBe(0);
    expect(generatedPrUploadStep).toMatchObject({
      if: "${{ inputs.publish_pull_request }}",
      uses: UPLOAD_ARTIFACT_V7,
      with: {
        name: "maturity-scorecard-pr-${{ github.run_id }}-${{ github.run_attempt }}",
        "retention-days": 1,
        "if-no-files-found": "error",
      },
    });
    expect(generatedPrUploadStep.with.path.trim().split("\n")).toEqual(MATURITY_GENERATED_PR_PATHS);

    expect(publishPrJob.needs).toEqual(["validate_selected_ref", "publisher_preflight", "publish"]);
    expect(publishPrJob["runs-on"]).toBe("ubuntu-24.04");
    for (const fragment of [
      "needs.publisher_preflight.result == 'success'",
      "needs.publish.result == 'success'",
      `github.workflow_ref == '${MATURITY_SCORECARD_WORKFLOW_REF}'`,
      `needs.validate_selected_ref.outputs.workflow_ref == '${MATURITY_SCORECARD_WORKFLOW_REF}'`,
    ]) {
      expect(publishPrJob.if).toContain(fragment);
    }
    const trustedPublishCheckoutStep = publishPrJob.steps.find(
      (step: WorkflowStep) => step.name === "Checkout trusted workflow source",
    );
    const selectedCheckoutStep = publishPrJob.steps.find(
      (step: WorkflowStep) => step.name === "Checkout selected ref",
    );
    const downloadPrFilesStep = publishPrJob.steps.find(
      (step: WorkflowStep) => step.name === "Download generated PR files",
    );
    const openDocsPrStep = publishPrJob.steps.find(
      (step: WorkflowStep) => step.name === "Open or update generated docs PR",
    );
    expect(trustedPublishCheckoutStep).toMatchObject({
      uses: CHECKOUT_V6,
      with: {
        repository: "${{ needs.validate_selected_ref.outputs.workflow_repository }}",
        ref: "${{ needs.validate_selected_ref.outputs.workflow_sha }}",
        "persist-credentials": false,
      },
    });
    expect(selectedCheckoutStep).toMatchObject({
      uses: CHECKOUT_V6,
      with: {
        ref: "${{ needs.validate_selected_ref.outputs.selected_revision }}",
        path: "selected",
        "fetch-depth": 0,
        "persist-credentials": false,
      },
    });
    expect(downloadPrFilesStep).toMatchObject({
      uses: DOWNLOAD_ARTIFACT_V8,
      with: {
        name: "maturity-scorecard-pr-${{ github.run_id }}-${{ github.run_attempt }}",
        path: "${{ steps.staging.outputs.path }}",
      },
    });
    expect(openDocsPrStep.if.replace(/\s+/gu, " ")).toBe(trustedPublisherCondition);
    expect(openDocsPrStep.uses).toBe("./.github/actions/publish-generated-pr");
    expect(openDocsPrStep.with).toMatchObject({
      "contents-client-id": "Iv23liOECG0slfuhz093",
      "contents-private-key": "${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}",
      "pull-request-client-id": MANTIS_GITHUB_APP_CLIENT_ID,
      "pull-request-private-key": "${{ secrets.MANTIS_GITHUB_APP_PRIVATE_KEY }}",
      "base-branch": "${{ needs.validate_selected_ref.outputs.publication_base }}",
      "head-branch": "${{ needs.validate_selected_ref.outputs.publication_head }}",
      "working-directory": "selected",
      "commit-message": "docs: update maturity scorecard",
      "pr-title": "docs: update maturity scorecard",
      "overlap-policy": "fail",
    });
    expect(openDocsPrStep.with["generated-paths"].trim().split("\n")).toEqual(
      MATURITY_GENERATED_PR_PATHS,
    );
    expect(openDocsPrStep.with["invalidation-paths"].trim().split("\n")).toEqual([
      ".",
      ":(exclude)qa/maturity-scores.yaml",
      ":(exclude)docs/maturity/scorecard.md",
      ":(exclude)docs/maturity/taxonomy.md",
    ]);
    for (const heading of [
      "## What Problem This Solves",
      "## Why This Change Was Made",
      "## User Impact",
      "## Evidence",
    ]) {
      expect(openDocsPrStep.with["pr-body"]).toContain(heading);
    }
    expect(publishPrJob.steps).not.toContainEqual(
      expect.objectContaining({ name: "Create generated docs PR app token" }),
    );
    const maturityWorkflowSource = readFileSync(".github/workflows/maturity-scorecard.yml", "utf8");
    expect(maturityWorkflowSource).not.toContain("permission-pull-requests: write");
    expect(maturityWorkflowSource).not.toContain("GH_APP_PRIVATE_KEY");
    expect(maturityWorkflowSource).not.toContain("gh auth setup-git");
    expect(maturityWorkflowSource).not.toContain("git push --force-with-lease");
  });

  it.skipIf(process.platform === "win32")(
    "authorizes maturity PR publication only for a canonical direct dispatch",
    () => {
      const direct = runMaturityInvocationScenario({
        callerEventName: "workflow_dispatch",
        callerWorkflowRef: MATURITY_SCORECARD_WORKFLOW_REF,
        publishPullRequest: true,
      });

      expect(direct.status).toBe(0);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps a reusable maturity call artifact-only even when its caller was dispatched",
    () => {
      const callerWorkflowRef =
        "openclaw/openclaw/.github/workflows/openclaw-release-checks.yml@refs/heads/main";
      const artifactOnly = runMaturityInvocationScenario({
        callerEventName: "workflow_dispatch",
        callerWorkflowRef,
        publishPullRequest: false,
      });

      expect(artifactOnly.status).toBe(0);
      for (const identity of [
        { callerWorkflowRef },
        { callerWorkflowRef: MATURITY_SCORECARD_WORKFLOW_REF, jobWorkflowRef: callerWorkflowRef },
      ]) {
        const rejected = runMaturityInvocationScenario({
          callerEventName: "workflow_dispatch",
          publishPullRequest: true,
          ...identity,
        });
        expect(rejected.status).not.toBe(0);
        expect(rejected.output).toContain(
          "Reusable maturity workflows are artifact-only and cannot publish pull requests.",
        );
      }
    },
  );

  // Replay the Ubuntu workflow shell only where its Bash 4 and GNU install contract exists.
  it.skipIf(process.platform !== "linux")(
    "copies only regular allowlisted maturity publication files",
    () => {
      const valid = runMaturityArtifactCopyScenario();
      expect(valid.status).toBe(0);
      expect(valid.copied).toEqual(
        MATURITY_GENERATED_PR_PATHS.map((generatedPath) => `new ${generatedPath}\n`),
      );

      const extra = runMaturityArtifactCopyScenario({ extraFile: true });
      expect(extra.status).not.toBe(0);
      expect(extra.output).toContain("Generated PR artifact must contain exactly 3 files.");

      const sourceSymlink = runMaturityArtifactCopyScenario({ sourceSymlink: true });
      expect(sourceSymlink.status).not.toBe(0);
      expect(sourceSymlink.output).toContain(
        "Generated PR artifact path must be a regular file: qa/maturity-scores.yaml",
      );

      const destinationSymlink = runMaturityArtifactCopyScenario({ destinationSymlink: true });
      expect(destinationSymlink.status).not.toBe(0);
      expect(destinationSymlink.output).toContain(
        "Selected worktree destination must be a regular file: qa/maturity-scores.yaml",
      );
      expect(destinationSymlink.escaped).toBe("outside\n");
    },
  );

  it("keeps maturity scorecard release docs opt-in from release checks", () => {
    const releaseWorkflow = readReleaseChecksWorkflow();
    const job = releaseWorkflow.jobs.maturity_scorecard_release_checks;
    const summaryJob = releaseWorkflow.jobs.summary;
    const verifyStep = summaryJob.steps.find(
      (step: WorkflowStep) => step.name === "Verify release check results",
    );
    const inputs = releaseWorkflow.on.workflow_dispatch.inputs;
    const resolveJob = releaseWorkflow.jobs.resolve_target;
    const summarizeStep = resolveJob.steps.find(
      (step: WorkflowStep) => step.name === "Summarize validated ref",
    );

    expect(releaseWorkflow.jobs).not.toHaveProperty("qa_profile_release_evidence_release_checks");
    expect(inputs.run_maturity_scorecard).toMatchObject({
      required: false,
      default: false,
      type: "boolean",
    });
    expect(resolveJob.outputs.run_maturity_scorecard).toBe(
      "${{ steps.inputs.outputs.run_maturity_scorecard }}",
    );
    expect(summarizeStep.env.RUN_MATURITY_SCORECARD).toBe(
      "${{ steps.inputs.outputs.run_maturity_scorecard }}",
    );
    expect(summarizeStep.run).toContain("- Maturity scorecard docs:");
    expect(job.name).toBe("Render maturity scorecard release docs");
    expect(job.if).toBe(
      "contains(fromJSON('[\"all\",\"qa\"]'), needs.resolve_target.outputs.rerun_group) && needs.resolve_target.outputs.run_maturity_scorecard == 'true'",
    );
    expect(job.permissions).toMatchObject({
      actions: "read",
      contents: "read",
    });
    expect(job.uses).toBe("./.github/workflows/maturity-scorecard.yml");
    expect(job.with).toMatchObject({
      ref: "${{ needs.resolve_target.outputs.ref }}",
      expected_sha: "${{ needs.resolve_target.outputs.revision }}",
    });
    expect(job.with).not.toHaveProperty("qa_profile");
    expect(job.with).not.toHaveProperty("publish_pull_request");
    expect(job.secrets).toMatchObject({
      OPENAI_API_KEY: "${{ secrets.OPENAI_API_KEY }}",
      OPENCLAW_QA_CONVEX_SECRET_CI: "${{ secrets.OPENCLAW_QA_CONVEX_SECRET_CI }}",
      OPENCLAW_QA_CONVEX_SITE_URL: "${{ secrets.OPENCLAW_QA_CONVEX_SITE_URL }}",
    });
    expect(summaryJob.needs).toContain("maturity_scorecard_release_checks");
    expect(verifyStep.env.MATURITY_SCORECARD_RELEASE_CHECKS_RESULT).toBe(
      "${{ needs.maturity_scorecard_release_checks.result }}",
    );
    expect(verifyStep.run).toContain(
      '"maturity_scorecard_release_checks=${MATURITY_SCORECARD_RELEASE_CHECKS_RESULT}"',
    );
    expect(verifyStep.run).not.toContain("qa_profile_release_evidence_release_checks");
  });

  it("keeps workflow guards in fast CI-routing checks", () => {
    const workflow = readCiWorkflow();
    const preflightStep = workflow.jobs.preflight.steps.find(
      (step: WorkflowStep) => step.name === "Build CI manifest",
    );
    const taxonomy = parse(readFileSync("taxonomy.yaml", "utf8")) as {
      profiles: Array<{ id: string; categoryIds: string[] }>;
    };
    const smokeProfile = taxonomy.profiles.find((profile) => profile.id === "smoke-ci");
    if (!smokeProfile) {
      throw new Error("taxonomy.yaml is missing the smoke-ci profile");
    }
    const fastCoreJob = workflow.jobs["checks-fast-core"];
    const runStep = fastCoreJob.steps.find(
      (step: WorkflowStep) => step.name === "Run ${{ matrix.task }} (${{ matrix.runtime }})",
    );
    const smokeProfileJob = workflow.jobs["qa-smoke-ci-profile"];
    const smokeBuildStep = smokeProfileJob.steps.find(
      (step: WorkflowStep) => step.name === "Build QA smoke runtime",
    );
    const smokeDockerCacheStep = smokeProfileJob.steps.find(
      (step: WorkflowStep) => step.name === "Set up Blacksmith Docker layer cache",
    );
    const smokeRunStep = smokeProfileJob.steps.find(
      (step: WorkflowStep) => step.name === "Run smoke profile part",
    );
    const smokeUploadStep = smokeProfileJob.steps.find(
      (step: WorkflowStep) => step.name === "Upload QA smoke profile evidence",
    );

    const ciWorkflowText = readFileSync(".github/workflows/ci.yml", "utf8");

    expect(preflightStep.run).not.toContain("qa-smoke-profile");
    expect(preflightStep.run).not.toContain("qa_category");
    expect(smokeProfile.categoryIds).toHaveLength(30);
    for (const categoryId of smokeProfile.categoryIds) {
      expect(ciWorkflowText).not.toContain(`"${categoryId}"`);
    }
    expect(runStep.run).toContain("bundled-protocol)");
    expect(runStep.run).not.toContain("qa-smoke-ci)");
    expect(runStep.run).toContain("contracts-plugins-ci-routing)");
    expect(runStep.run).toContain("ci-routing)");
    expect(fastCoreJob["runs-on"]).toContain("matrix.runner");
    expect(smokeProfileJob.name).toBe("QA Smoke CI (${{ matrix.name }})");
    expect(smokeBuildStep.run).toContain("node scripts/build-all.mjs qaRuntime");
    expect(smokeBuildStep.run).toContain("pnpm ui:build");
    expect(smokeBuildStep.env.OPENCLAW_BUILD_PRIVATE_QA).toBe("1");
    expect(smokeBuildStep.run).toContain("--skip-build");
    expect(smokeBuildStep.run).toContain("--allow-unreleased-changelog");
    expect(smokeBuildStep.run).toContain("grep -Fq");
    expect(smokeBuildStep.run).toContain('"${package_args[@]}"');
    expect(workflow.jobs["qa-smoke-ci-artifacts"]).toBeUndefined();
    expect(workflow.jobs["qa-smoke-ci"]).toBeUndefined();
    expect(smokeProfileJob.needs).toEqual(["preflight"]);
    expect(smokeProfileJob.strategy["max-parallel"]).toBe(4);
    expect(
      smokeProfileJob.strategy.matrix.include.map((entry: { slug: string }) => entry.slug),
    ).toEqual(["profile-1-of-4", "profile-2-of-4", "profile-3-of-4", "profile-4-of-4"]);
    expect(
      smokeProfileJob.strategy.matrix.include.filter(
        (entry: { docker_cache?: boolean }) => entry.docker_cache,
      ),
    ).toEqual([
      expect.objectContaining({
        lane: "profile-2",
        slug: "profile-2-of-4",
        docker_cache: true,
      }),
    ]);
    expect(smokeProfileJob["runs-on"]).toContain("blacksmith-16vcpu-ubuntu-2404");
    expect(smokeDockerCacheStep.uses).toBe(
      "useblacksmith/setup-docker-builder@ab5c1da94f53f5cd75c1038092aa276dddfccbba",
    );
    expect(smokeDockerCacheStep.if).toContain("matrix.docker_cache == true");
    expect(smokeDockerCacheStep.if).toContain("github.event_name != 'workflow_dispatch'");
    expect(smokeDockerCacheStep.if).toContain("github.repository == 'openclaw/openclaw'");
    expect(smokeDockerCacheStep.if).toContain(
      "github.event.pull_request.head.repo.full_name == 'openclaw/openclaw'",
    );
    expect(smokeDockerCacheStep.with["max-cache-size-mb"]).toBe(800000);
    expect(smokeRunStep.run).toContain("createQaSmokeCiPart");
    expect(smokeRunStep.run).toContain("createQaSmokeCiMatrix");
    expect(smokeRunStep.run).toContain("readQaScenarioPack");
    expect(smokeRunStep.run).toContain("isolate each scenario");
    expect(smokeRunStep.run).toContain("scenario_ids: [scenarioId]");
    expect(smokeRunStep.run).not.toContain("scenarioIdsByKind");
    const compatibilityScenarioBlock = smokeRunStep.run.match(
      /const compatibilityScenarioIds = new Set\(\[([\s\S]*?)\]\);/u,
    )?.[1];
    expect(compatibilityScenarioBlock?.match(/^\s+"[^"]+",$/gmu)).toHaveLength(12);
    expect(compatibilityScenarioBlock).toContain('"control-ui-chat-flow-playwright"');
    expect(compatibilityScenarioBlock).toContain('"gateway-smoke"');
    expect(compatibilityScenarioBlock).toContain('"matrix-restart-resume"');
    expect(smokeRunStep.run).toContain(
      "console.error(`[skip] ${partId} is not declared by this checkout's smoke plan`)",
    );
    expect(smokeRunStep.run).not.toContain(
      "console.log(`[skip] ${partId} is not declared by this checkout's smoke plan`)",
    );
    expect(smokeRunStep.run).toContain("No QA smoke runs assigned");
    expect(smokeRunStep.run).toContain("node openclaw.mjs qa run");
    expect(smokeRunStep.run).not.toContain("pnpm openclaw qa run");
    expect(smokeRunStep.run).toContain(
      "timeout --signal=TERM --kill-after=15s 10m node openclaw.mjs qa run",
    );
    expect(smokeRunStep.run).toContain("--qa-profile smoke-ci");
    expect(smokeRunStep.run).toContain("--concurrency 10");
    expect(smokeRunStep.env.OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS).toContain(
      "github.event_name != 'workflow_dispatch'",
    );
    expect(smokeRunStep.env.OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS).toContain(
      "github.repository == 'openclaw/openclaw'",
    );
    expect(smokeRunStep.env.OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS).toContain("'0'");
    expect(smokeRunStep.env.OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS).toContain("'1500'");
    expect(smokeRunStep.run).toContain('scenario_args+=(--scenario "$scenario_id")');
    expect(smokeRunStep.run).toContain('done <<< "$PROFILE_RUNS_TSV"');
    expect(smokeRunStep.run).not.toContain('pids+=("$!")');
    expect(smokeRunStep.run).not.toContain('wait "${pids[$index]}"');
    expect(smokeRunStep.run).not.toContain("--category");
    expect(smokeRunStep.run).not.toContain("--allow-failures");
    expect(smokeRunStep.run).toContain("qa_exit_code=0");
    expect(smokeRunStep.run).toContain('exit "$qa_exit_code"');
    expect(smokeRunStep.run).toContain("OPENCLAW_CURRENT_PACKAGE_TGZ");
    expect(smokeRunStep.run).toContain("--max-old-space-size=16384");
    expect(smokeRunStep.run).not.toContain("scripts/build-all.mjs qaRuntime");
    expect(smokeRunStep.run).not.toContain("OPENAI_API_KEY");
    expect(smokeUploadStep.if).toBe("always()");
    expect(smokeUploadStep.with).toMatchObject({
      path: ".artifacts/qa-e2e/smoke-ci-profile-${{ matrix.slug }}/",
      "if-no-files-found": "warn",
    });
    expect(runStep.run.match(/test\/scripts\/ci-workflow-guards\.test\.ts/g)?.length).toBe(2);
    expect(runStep.run.match(/test\/scripts\/ci-changed-node-test-plan\.test\.ts/g)?.length).toBe(
      2,
    );
  });

  it("keeps push docs validation ClawHub-backed", () => {
    const workflow = readFileSync(".github/workflows/docs.yml", "utf8");

    expect(workflow).toContain("repository: openclaw/clawhub");
    expect(workflow).toContain("path: clawhub-source");
    expect(workflow).toContain(
      "OPENCLAW_DOCS_SYNC_CLAWHUB_REPO: ${{ github.workspace }}/clawhub-source",
    );
  });

  it("keeps network CodeQL off unrelated source-only refactors", () => {
    const workflow = readCriticalQualityWorkflow();
    const networkConfig = readFileSync(
      ".github/codeql/codeql-network-runtime-boundary-critical-quality.yml",
      "utf8",
    );
    const rawSocketQuery = readFileSync(
      ".github/codeql/openclaw-boundary/queries/raw-socket-callsite-classification.ql",
      "utf8",
    );
    const networkSelector = workflow.slice(
      workflow.indexOf(".github/codeql/codeql-network-runtime-boundary-critical-quality.yml"),
      workflow.indexOf("network-runtime-boundary:"),
    );
    const broadCodeqlSelector = workflow.slice(
      workflow.indexOf(".github/codeql/*|.github/workflows/codeql-critical-quality.yml"),
      workflow.indexOf("src/**/*.test.ts|src/**/*.test.tsx"),
    );

    expect(broadCodeqlSelector).not.toContain("network_runtime=true");
    expect(networkSelector).toContain(
      ".github/codeql/codeql-network-runtime-boundary-critical-quality.yml",
    );
    expect(networkSelector).not.toContain("src/*.ts|src/**/*.ts");
    expect(networkSelector).not.toContain("extensions/*.ts|extensions/**/*.ts");
    expect(networkSelector).toContain("src/infra/net/*");
    expect(networkSelector).toContain("src/infra/ssh-tunnel.ts");
    expect(networkSelector).toContain("packages/net-policy/src/*");
    expect(networkConfig).not.toContain("\n  - src\n");
    expect(networkConfig).not.toContain("\n  - extensions\n");
    expect(networkConfig).toContain("\n  - src/infra/net\n");
    expect(networkConfig).toContain("\n  - packages/net-policy/src\n");
    expect(workflow).toContain("Fast PR network boundary diff scan");
    expect(workflow).toContain(
      '| select(.filename | test("(^|/)[^/]+\\\\.(?:e2e\\\\.)?test\\\\.tsx?$") | not)',
    );
    expect(workflow).toContain("Network runtime boundary-sensitive added lines");
    expect(workflow).toContain(
      'codex_transport="extensions/codex/src/app-server/transport-websocket.ts"',
    );
    expect(workflow).toContain(
      "network_codeql_contract_pattern='^\\.github/codeql/(codeql-network-runtime-boundary-critical-quality\\.yml|openclaw-boundary/queries/(raw-socket-callsite-classification|managed-proxy-runtime-mutation)\\.ql)$'",
    );
    expect(workflow).toContain(
      'if grep -Eq "$network_codeql_contract_pattern" "$changed_files" ||',
    );
    expect(workflow).toContain(
      '| select(.filename != "extensions/codex/src/app-server/transport-websocket.ts")',
    );
    expect(workflow).not.toContain('grep -Fv "$codex_transport: " "$added_lines"');
    // Raw-socket exclusions are filename-structural. A monitored package line may
    // contain the transport path as data without disappearing from the scan.
    expect(workflow).toContain("packages/net-policy/src/");
    expect(workflow).toContain(
      "grep -En 'HTTP_PROXY|HTTPS_PROXY|NO_PROXY|GLOBAL_AGENT_|OPENCLAW_PROXY_' \"$added_lines\"",
    );
    expect(workflow).toContain('echo "full_codeql=true" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain(
      "if: ${{ github.event_name != 'pull_request' || steps.network-diff-scan.outputs.full_codeql == 'true' }}",
    );
    expect(rawSocketQuery).toContain(
      'allowedOwnerScope(call, "extensions/codex/src/app-server/transport-websocket.ts", "connectCodexAppServerUnixSocket")',
    );
    expect(rawSocketQuery).not.toContain(
      'call.getFile().getRelativePath() = "extensions/codex/src/app-server/transport-websocket.ts"',
    );
  });
});
