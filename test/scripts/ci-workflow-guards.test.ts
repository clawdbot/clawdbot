// Ci Workflow Guards tests cover ci workflow guards script behavior.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { NATIVE_I18N_LOCALES } from "../../scripts/native-i18n-locales.ts";
import { SUPPORTED_LOCALES } from "../../ui/src/i18n/lib/registry.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const CHECKOUT_V6 = "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10";
const CACHE_V5 = "actions/cache/restore@27d5ce7f107fe9357f9df03efb73ab90386fccae";
const SETUP_GO_V6 = "actions/setup-go@4a3601121dd01d1626a1e23e37211e3254c1c06c";
const UPLOAD_ARTIFACT_V7 = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const DOWNLOAD_ARTIFACT_V8 = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const CREATE_GITHUB_APP_TOKEN_V3 =
  "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1";
const MANTIS_ISSUE_COMMENT_REACTION_WORKFLOWS = [
  ".github/workflows/mantis-web-ui-chat-proof.yml",
  ".github/workflows/mantis-discord-status-reactions.yml",
  ".github/workflows/mantis-discord-thread-attachment.yml",
  ".github/workflows/mantis-telegram-live.yml",
] as const;
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
const AMBIGUOUS_MAIN_PUSH_DIAGNOSTIC =
  "::error title=ambiguous main push::github.event.before is zero; refusing to infer a diff base for a created or recreated main branch.";
const AMBIGUOUS_MAIN_PUSH_GUARD = `if [ "$GITHUB_EVENT_NAME" = "push" ] && [[ "$base_sha" =~ ^0+$ ]]; then
  echo "${AMBIGUOUS_MAIN_PUSH_DIAGNOSTIC}" >&2
  exit 1
fi`;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const TSX_IMPORT = import.meta.resolve("tsx");
const TYPESCRIPT_NODE_MODULES = path.dirname(
  path.dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))),
);
const MATURITY_GENERATED_PR_PATHS = [
  "qa/maturity-scores.yaml",
  "docs/maturity/scorecard.md",
  "docs/maturity/taxonomy.md",
];

type WorkflowStep = {
  env?: Record<string, unknown>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  "working-directory"?: string;
};

function readCiWorkflow() {
  return parse(readFileSync(".github/workflows/ci.yml", "utf8"));
}

function evaluateWorkflowExpression(
  expression: unknown,
  context: {
    // Runner routing keys off contributor trust, so pull-request cases default
    // to CONTRIBUTOR: same-repo PRs always come from someone with write access.
    authorAssociation?: string;
    eventName: "pull_request" | "push" | "workflow_dispatch";
    headRepository?: string;
    matrix?: Record<string, unknown>;
    repository: string;
    runnerBackend?: "" | "blacksmith" | "github" | "hybrid";
    runAttempt: number;
  },
) {
  if (typeof expression !== "string") {
    throw new TypeError("workflow expression must be a string");
  }
  const match = expression.match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/u);
  if (!match) {
    throw new Error(`invalid workflow expression: ${expression}`);
  }
  const source = match[1];
  if (source === undefined) {
    throw new Error(`workflow expression has no body: ${expression}`);
  }
  return runInNewContext(source, {
    // GitHub expression builtins the runner-routing clauses use.
    contains: (haystack: unknown, needle: unknown) =>
      Array.isArray(haystack)
        ? haystack.includes(needle)
        : String(haystack).includes(String(needle)),
    fromJSON: (value: string) => JSON.parse(value) as unknown,
    github: {
      event_name: context.eventName,
      repository: context.repository,
      run_attempt: context.runAttempt,
      event:
        context.headRepository || context.eventName === "pull_request"
          ? {
              pull_request: {
                author_association: context.authorAssociation ?? "CONTRIBUTOR",
                head: { repo: { full_name: context.headRepository ?? context.repository } },
              },
            }
          : {},
    },
    matrix: context.matrix ?? {},
    vars: {
      OPENCLAW_CI_RUNNER_BACKEND: context.runnerBackend ?? "",
    },
  });
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

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function runWorkflowShellScript(
  script: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-workflow-shell-"));
  const modulePaths: string[] = [];
  try {
    let moduleIndex = 0;
    const moduleRoot = options.cwd ?? process.cwd();
    const rewritten = script
      .replace(
        /node (?:--import tsx )?--input-type=module <<'([A-Z][A-Z0-9_]*)'\n([\s\S]*?)\n\1(?=\n|$)/gu,
        (_match, _marker: string, body: string) => {
          const modulePath = path.join(
            moduleRoot,
            `.openclaw-${path.basename(root)}-${moduleIndex}.mjs`,
          );
          moduleIndex += 1;
          modulePaths.push(modulePath);
          writeFileSync(modulePath, `${body}\n`, "utf8");
          return `${quoteShell(process.execPath)} --import ${quoteShell(TSX_IMPORT)} ${quoteShell(modulePath)}`;
        },
      )
      .replaceAll(
        "manifest_node_args+=(--import tsx)",
        `manifest_node_args+=(--import ${quoteShell(TSX_IMPORT)})`,
      );
    const scriptPath = path.join(root, "run.sh");
    writeFileSync(scriptPath, rewritten.endsWith("\n") ? rewritten : `${rewritten}\n`, "utf8");
    return spawnSync("bash", [scriptPath], {
      ...options,
      encoding: "utf8",
    });
  } finally {
    for (const modulePath of modulePaths) {
      rmSync(modulePath, { force: true });
    }
    rmSync(root, { force: true, recursive: true });
  }
}

function runCiManifestFixture(options: {
  bundledPlanner: boolean;
  changedPlannerImportFails?: boolean;
  changedPaths?: string[] | null;
  eventName?: "pull_request" | "push" | "workflow_dispatch";
  historicalCompatibility?: boolean;
  iosCapabilities?: boolean;
  iosBuildCapability?: boolean;
  androidCiCapabilities?: boolean;
  nativeI18nCapabilities?: boolean;
  openClawKitTests?: boolean;
  protocolCoverage?: boolean;
  qaSmokePlan?: boolean;
  formatCheck?: boolean;
  releaseCandidateCompatibility?: boolean;
  targetContextCompatibility?: boolean;
  nodeFastOnly?: boolean;
  nodeFastPluginContracts?: boolean;
  nodeFastCiRouting?: boolean;
  runNode?: boolean;
  runnerBackend?: "blacksmith" | "github" | "hybrid";
}) {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-ci-manifest-"));
  try {
    const scriptsDir = path.join(root, "scripts", "lib");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      path.join(scriptsDir, "ci-node-test-plan.mts"),
      options.bundledPlanner
        ? `
          export const createNodeTestShards = () => [{
            checkName: "legacy-node-plan",
            configs: ["test/vitest/legacy.config.ts"],
            requiresDist: false,
            runner: "ubuntu-24.04",
            shardName: "legacy-node-plan",
          }];
          export const createNodeTestShardBundles = (options = {}) => [{
            checkName: "bundled-node-plan",
            configs: ["test/vitest/bundled.config.ts"],
            env: {
              OPENCLAW_CI_TEST_COMPACT_MODE: options.compactMode ?? "full",
              OPENCLAW_CI_TEST_RUNNER_BACKEND: options.runnerBackend ?? "",
            },
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
          "check:assertion-safety": "true",
          "check:max-lines-ratchet": "true",
        }
      : {};
    writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify({ scripts: packageScripts })}\n`,
    );
    if (options.bundledPlanner) {
      writeFileSync(
        path.join(scriptsDir, "ci-changed-node-test-plan.mts"),
        options.changedPlannerImportFails
          ? `throw new Error("planner import failure");\n`
          : `
          export const createChangedNodeTestShards = (changedPaths) =>
            changedPaths.includes("src/focused.ts") ||
            changedPaths.includes("test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts")
              ? [{
                  checkName: "changed-node-plan",
                  configs: [],
                  requiresDist: false,
                  runner: "ubuntu-24.04",
                  shardName: "changed-node-plan",
                  targets: changedPaths.includes("src/focused.ts")
                    ? ["src/focused.test.ts"]
                    : ["test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts"],
                }]
              : null;
          export const createChangedExtensionFallbackShards = (changedPaths) =>
            changedPaths.some((changedPath) => changedPath.startsWith("extensions/"))
              ? changedPaths.some((changedPath) => changedPath.startsWith("extensions/matrix/"))
                ? [{
                    checkName: "changed-extension-fallback-plan",
                    configs: ["test/vitest/vitest.extension-matrix.config.ts"],
                    includePatterns: [
                      "extensions/matrix/src/client.test.ts",
                      "extensions/matrix/src/monitor.test.ts",
                    ],
                    requiresDist: false,
                    runner: "ubuntu-24.04",
                    shardName: "changed-extension-fallback-plan",
                  }]
                : [{
                  checkName: "changed-extension-fallback-plan",
                  configs: [],
                  requiresDist: false,
                  runner: "ubuntu-24.04",
                  shardName: "changed-extension-fallback-plan",
                  targets: ["extensions/codex/src/focused.test.ts"],
                }]
              : [];
          export const hasBuildArtifactAffectingChange = (changedPaths) =>
            !changedPaths.includes("test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts");
          export const hasSqliteSessionLifecycleAffectingChange = (changedPaths) =>
            changedPaths.includes("src/sqlite-session-owner.ts") ||
            changedPaths.includes("test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts");
        `,
        "utf8",
      );
      const sqliteLifecycleProof = path.join(
        root,
        "test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts",
      );
      mkdirSync(path.dirname(sqliteLifecycleProof), { recursive: true });
      writeFileSync(sqliteLifecycleProof, "export {};\n");
      writeFileSync(
        path.join(scriptsDir, "channel-contract-test-plan.mts"),
        `export const createChannelContractTestShards = () => [{ checkName: "channel-contracts" }];\n`,
      );
      writeFileSync(
        path.join(scriptsDir, "plugin-contract-test-plan.mts"),
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
        ...((options.openClawKitTests ?? options.bundledPlanner)
          ? ["openclawkit-tests-contract-v1"]
          : []),
      ].join("\n"),
    );
    const outputPath = path.join(root, "manifest.out");
    writeFileSync(outputPath, "", "utf8");
    const manifestStep = readCiWorkflow().jobs.preflight.steps.find(
      (step: { name?: string }) => step.name === "Build CI manifest",
    );
    const run = runWorkflowShellScript(manifestStep.run, {
      cwd: root,
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
        OPENCLAW_CI_TARGET_CONTEXT_TARGET:
          options.targetContextCompatibility === true ? "true" : "false",
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
        OPENCLAW_CI_RUNNER_BACKEND: options.runnerBackend ?? "",
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

function runTargetContextValidation(targetContextRef: string, targetRef: string) {
  const root = tempDirs.make("openclaw-ci-target-context-");
  const outputPath = path.join(root, "github-output");
  writeFileSync(outputPath, "", "utf8");
  const step = expectDefined(
    readCiWorkflow().jobs.preflight.steps.find(
      (candidate: WorkflowStep) => candidate.name === "Validate target context",
    ),
    "target context validation step",
  );
  const run = spawnSync(
    "bash",
    ["-c", expectDefined(step.run, "target context validation script")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        TARGET_CONTEXT_REF: targetContextRef,
        TARGET_REF: targetRef,
      },
    },
  );
  return {
    output: `${run.stdout}${run.stderr}`,
    outputs: readWorkflowOutputs(outputPath),
    status: run.status,
  };
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

type QaProfileTimeoutFixtureMode = "natural-124" | "self-kill" | "term" | "kill";

function runQaProfileTimeoutFixture(mode: QaProfileTimeoutFixtureMode) {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-qa-profile-timeout-"));
  try {
    const selectedRoot = path.join(root, "selected");
    mkdirSync(selectedRoot);
    const binDir = path.join(root, "bin");
    mkdirSync(binDir);
    const fakePnpm = path.join(binDir, "pnpm");
    writeFileSync(
      fakePnpm,
      `#!/usr/bin/env bash
set -u
echo "child-stderr-sentinel:\${FAKE_PNPM_MODE}" >&2
echo "child-locale:\${LC_ALL-unset}" >&2
case "\${FAKE_PNPM_MODE}" in
  natural-124)
    echo "timeout: sending signal KILL to command 'spoofed-child'" >&2
    exit 124
    ;;
  self-kill)
    kill -KILL "$$"
    ;;
  term)
    trap 'exit 0' TERM
    while :; do sleep 0.01; done
    ;;
  kill)
    trap '' TERM
    while :; do sleep 0.01 || true; done
    ;;
esac
`,
      "utf8",
    );
    chmodSync(fakePnpm, 0o755);
    const fixturePath = `${binDir}:${process.env.PATH ?? ""}`;
    const timeoutVersion = spawnSync("timeout", ["--version"], {
      encoding: "utf8",
      env: { ...process.env, PATH: fixturePath },
    });
    if (timeoutVersion.status !== 0 || !timeoutVersion.stdout.includes("(GNU coreutils)")) {
      throw new Error(
        `QA timeout fixture requires GNU timeout: ${timeoutVersion.stdout}${timeoutVersion.stderr}`,
      );
    }

    const workflow = readQaProfileEvidenceWorkflow();
    const runProfileStep = expectDefined(
      workflow.jobs.run_qa_profile_shard.steps.find(
        (step: WorkflowStep) => step.name === "Run QA profile shard",
      ),
      "Run QA profile shard step",
    );
    let script = runProfileStep.run
      .replace("--kill-after=30s 110m", "--kill-after=0.05s 0.4s")
      .replaceAll("110 minutes", "0.4 seconds")
      .replaceAll("30-second", "0.05-second");
    const timeoutSupervisorCapture = path.join(root, "timeout-supervisor.log");
    const timeoutClassificationStart = `supervisor_tee_pid=""

timeout_outcome="none"`;
    // Bash writes killed-job diagnostics outside timeout's redirected stream. Capture the
    // authoritative supervisor log before the workflow's EXIT trap removes it.
    const capturedScript = script.replace(
      timeoutClassificationStart,
      `supervisor_tee_pid=""
cp "$timeout_supervisor_log" "$TIMEOUT_SUPERVISOR_CAPTURE"

timeout_outcome="none"`,
    );
    if (capturedScript === script) {
      throw new Error("QA timeout fixture could not capture the timeout supervisor log");
    }
    script = capturedScript;
    const githubOutput = path.join(root, "github-output");
    const run = runWorkflowShellScript(script, {
      cwd: selectedRoot,
      env: {
        ...process.env,
        FAKE_PNPM_MODE: mode,
        GITHUB_OUTPUT: githubOutput,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "42",
        GITHUB_WORKSPACE: root,
        LC_ALL: "POSIX",
        PATH: fixturePath,
        CATEGORY_IDS_JSON: '["fixture.category"]',
        PROTOCOL_SINCE_BASE_SHA: "b".repeat(40),
        QA_PROFILE: "all",
        QA_SHARD_ID: "shard-01",
        REQUESTED_REF: "fixture",
        SCENARIO_IDS_JSON: '["fixture-scenario"]',
        TARGET_SHA: "a".repeat(40),
        TIMEOUT_SUPERVISOR_CAPTURE: timeoutSupervisorCapture,
      },
    });
    const outputDir = path.join(
      selectedRoot,
      ".artifacts",
      "qa-e2e",
      "profile-all-42-1",
      "shard-01",
    );
    const status = JSON.parse(
      readFileSync(path.join(outputDir, "qa-profile-run-status.json"), "utf8"),
    ) as {
      exitCode: number;
      target: { protocolBaseSha: string };
      timedOut: boolean;
      timeoutOutcome: "none" | "term" | "kill";
    };
    return {
      commandStatus: run.status,
      githubOutput: readFileSync(githubOutput, "utf8"),
      status,
      stderr: run.stderr,
      stdout: run.stdout,
      timeoutSupervisorLog: readFileSync(timeoutSupervisorCapture, "utf8"),
      timeoutVersion: timeoutVersion.stdout.trim(),
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function runQaProfileFailureGate(options: { allowFailures: boolean; qaExitCode?: string }) {
  const workflow = readQaProfileEvidenceWorkflow();
  const failStep = workflow.jobs.aggregate_qa_profile.steps.find(
    (step: WorkflowStep) => step.name === "Fail if QA profile failed",
  );
  return spawnSync("bash", ["-c", failStep.run], {
    encoding: "utf8",
    env: {
      ALLOW_FAILURES: String(options.allowFailures),
      PATH: process.env.PATH ?? "",
      QA_EXIT_CODE: options.qaExitCode ?? "",
      QA_PROFILE: "all",
    },
  });
}

function readReleaseChecksWorkflow() {
  return parse(readFileSync(".github/workflows/openclaw-release-checks.yml", "utf8"));
}

function readCriticalQualityWorkflow() {
  return readFileSync(".github/workflows/codeql-critical-quality.yml", "utf8");
}

function readWorkflow(filePath: string) {
  return parse(readFileSync(filePath, "utf8"));
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

function runPushDiffBaseFixture(options: {
  commitCount: 1 | 2 | 3;
  eventBaseSha: string | "parent";
}) {
  const root = tempDirs.make("openclaw-ci-diff-base-");
  runGit(root, ["init", "-q", "-b", "main"]);
  runGit(root, ["config", "commit.gpgsign", "false"]);
  runGit(root, ["config", "user.email", "ci-fixture@example.com"]);
  runGit(root, ["config", "user.name", "CI Fixture"]);
  for (let index = 1; index <= options.commitCount; index += 1) {
    writeFileSync(path.join(root, "fixture.txt"), `commit ${index}\n`, "utf8");
    runGit(root, ["add", "fixture.txt"]);
    runGit(root, ["commit", "-q", "-m", `fixture ${index}`]);
  }

  const headSha = runGit(root, ["rev-parse", "HEAD"]);
  const parentSha =
    options.commitCount > 1 ? runGit(root, ["rev-parse", "--verify", "HEAD^1"]) : null;
  const eventBaseSha = options.eventBaseSha === "parent" ? parentSha! : options.eventBaseSha;
  const outputPath = path.join(root, "github-output");
  writeFileSync(outputPath, "", "utf8");
  const diffBaseStep = readCiWorkflow().jobs.preflight.steps.find(
    (step: WorkflowStep) => step.name === "Resolve exact diff base",
  );
  const run = runWorkflowShellScript(diffBaseStep.run, {
    cwd: root,
    env: {
      ...process.env,
      DEFAULT_BRANCH: "main",
      EVENT_BASE_SHA: eventBaseSha,
      GITHUB_EVENT_NAME: "push",
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: "openclaw/openclaw",
      PULL_REQUEST_NUMBER: "",
      RELEASE_GATE: "false",
    },
  });
  const rawOutputs = readFileSync(outputPath, "utf8").trim();
  const outputs: Record<string, string> =
    rawOutputs === ""
      ? {}
      : Object.fromEntries(
          rawOutputs.split("\n").map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
        );
  const emittedBaseIsCommit =
    typeof outputs.sha === "string" &&
    spawnSync("git", ["cat-file", "-e", `${outputs.sha}^{commit}`], { cwd: root }).status === 0;
  return {
    emittedBaseIsCommit,
    eventBaseSha,
    headSha,
    output: `${run.stdout}${run.stderr}`,
    outputs,
    parentSha,
    status: run.status,
  };
}

function writeExecutable(filePath: string, lines: string[]): void {
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  chmodSync(filePath, 0o755);
}

function writeProtocolDescriptor(
  repo: string,
  additions: Array<{
    name: string;
    since?: string;
    compatibilityRestored?: boolean;
  }> = [],
): void {
  const rows = [{ name: "health", since: "2026.7" }, ...additions].map(
    ({ name, since, compatibilityRestored }) => {
      const sinceProperty = since === undefined ? "" : `, since: ${JSON.stringify(since)}`;
      const compatibilityProperty = compatibilityRestored ? ", compatibilityRestored: true" : "";
      return `  { name: ${JSON.stringify(name)}${sinceProperty}${compatibilityProperty} },`;
    },
  );
  const descriptor = path.join(repo, "src/gateway/methods/core-descriptors.ts");
  mkdirSync(path.dirname(descriptor), { recursive: true });
  writeFileSync(
    descriptor,
    `export const CORE_GATEWAY_METHOD_SPECS = [\n${rows.join("\n")}\n] as const;\n`,
  );
}

function commitProtocolFixture(repo: string, message: string): string {
  runGit(repo, ["add", "-A"]);
  runGit(repo, ["commit", "-q", "-m", message]);
  return runGit(repo, ["rev-parse", "HEAD"]);
}

function createQaProtocolTopology() {
  const root = tempDirs.make("openclaw-qa-protocol-topology-");
  const origin = path.join(root, "origin");
  const checkout = path.join(root, "checkout");
  const releaseBranch = "release/2026.8.1";
  const releaseTag = "v2026.8.1";
  const mainReleaseTag = "v2026.8.2";

  runGit(root, ["init", "-q", "-b", "main", origin]);
  runGit(origin, ["config", "commit.gpgsign", "false"]);
  runGit(origin, ["config", "user.email", "qa-protocol@example.invalid"]);
  runGit(origin, ["config", "user.name", "QA Protocol Fixture"]);
  writeFileSync(
    path.join(origin, "package.json"),
    '{"name":"qa-protocol-fixture","version":"2026.8.0"}\n',
  );
  writeProtocolDescriptor(origin);
  const mainBase = commitProtocolFixture(origin, "base protocol");

  writeProtocolDescriptor(origin, [{ name: "sessions.patchMany", since: "2026.8" }]);
  const mainHead = commitProtocolFixture(origin, "add main protocol method");
  runGit(origin, ["tag", mainReleaseTag]);
  writeFileSync(path.join(origin, "main-tip.txt"), "later main tip\n");
  commitProtocolFixture(origin, "advance main");

  runGit(origin, ["checkout", "-q", "-b", "compatibility/restore", mainBase]);
  writeProtocolDescriptor(origin, [
    {
      name: "gateway.restart.preflight",
      since: "<=2026.7",
      compatibilityRestored: true,
    },
  ]);
  const compatibilityHead = commitProtocolFixture(origin, "restore compatibility method");

  runGit(origin, ["checkout", "-q", "-b", "compatibility/invalid", mainBase]);
  writeProtocolDescriptor(origin, [
    {
      name: "gateway.restart.invalid",
      since: "2026.8",
      compatibilityRestored: true,
    },
  ]);
  const invalidCompatibilityHead = commitProtocolFixture(
    origin,
    "mislabel new method as compatibility",
  );

  runGit(origin, ["checkout", "-q", "-b", releaseBranch, mainBase]);
  writeProtocolDescriptor(origin, [{ name: "sessions.releaseOnly" }]);
  const releaseHead = commitProtocolFixture(origin, "add release protocol method");

  runGit(origin, ["checkout", "-q", "--detach", mainBase]);
  writeFileSync(path.join(origin, "tag.txt"), "release tag\n");
  const releaseTagHead = commitProtocolFixture(origin, "create release tag target");
  runGit(origin, ["tag", releaseTag]);

  runGit(origin, ["checkout", "-q", "-b", "feature/untrusted", mainBase]);
  writeFileSync(path.join(origin, "feature.txt"), "untrusted\n");
  const featureHead = commitProtocolFixture(origin, "add untrusted feature");
  runGit(origin, ["checkout", "-q", "main"]);

  runGit(root, ["clone", "-q", "--no-local", origin, checkout]);
  const fakeBin = path.join(root, "bin");
  mkdirSync(fakeBin);
  writeExecutable(path.join(fakeBin, "timeout"), ["#!/usr/bin/env bash", "shift 3", 'exec "$@"']);

  return {
    checkout,
    compatibilityHead,
    fakeBin,
    featureHead,
    invalidCompatibilityHead,
    mainBase,
    mainHead,
    mainReleaseTag,
    origin,
    releaseBranch,
    releaseHead,
    releaseTag,
    releaseTagHead,
  };
}

function readWorkflowOutputs(outputPath: string): Record<string, string> {
  if (!existsSync(outputPath)) {
    return {};
  }
  const output = readFileSync(outputPath, "utf8").trim();
  return output
    ? Object.fromEntries(
        output.split("\n").map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
      )
    : {};
}

function runQaSelectedRefValidation(
  topology: ReturnType<typeof createQaProtocolTopology>,
  inputRef: string,
  revision: string,
  expectedSha = revision,
) {
  runGit(topology.checkout, ["checkout", "-q", "--detach", revision]);
  const githubOutput = path.join(topology.checkout, "github-output");
  rmSync(githubOutput, { force: true });
  const validateStep = expectDefined(
    readQaProfileEvidenceWorkflow().jobs.validate_selected_ref.steps.find(
      (step: WorkflowStep) => step.name === "Validate selected ref",
    ),
    "QA profile selected-ref validation step",
  );
  const result = runWorkflowShellScript(expectDefined(validateStep.run, "validation script"), {
    cwd: topology.checkout,
    env: {
      ...process.env,
      EXPECTED_SHA: expectedSha,
      GITHUB_OUTPUT: githubOutput,
      GITHUB_STEP_SUMMARY: path.join(topology.checkout, "github-summary"),
      INPUT_REF: inputRef,
      PATH: `${topology.fakeBin}:${process.env.PATH ?? ""}`,
    },
  });
  return { ...result, outputs: readWorkflowOutputs(githubOutput) };
}

function runProtocolSinceFixture(checkout: string, baseSha: string) {
  for (const scriptPath of [
    "packages/normalization-core/src/record-coerce.ts",
    "scripts/check-protocol-since.mts",
    "scripts/lib/repo-root.mjs",
  ]) {
    const target = path.join(checkout, scriptPath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(scriptPath, "utf8"));
  }
  writeFileSync(
    path.join(checkout, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        paths: {
          "@openclaw/normalization-core/record-coerce": [
            "./packages/normalization-core/src/record-coerce.ts",
          ],
        },
      },
    }),
  );
  const nodeModules = path.join(checkout, "node_modules");
  if (!existsSync(nodeModules)) {
    symlinkSync(TYPESCRIPT_NODE_MODULES, nodeModules, "dir");
  }
  return spawnSync(process.execPath, ["--import", TSX_IMPORT, "scripts/check-protocol-since.mts"], {
    cwd: checkout,
    encoding: "utf8",
    env: { ...process.env, PROTOCOL_SINCE_BASE_SHA: baseSha },
  });
}

function runDependencyCheckFixture(options: {
  historicalTarget: boolean;
  releaseToolingEntry?: boolean;
  scripts: string[];
}): {
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
    if (options.releaseToolingEntry) {
      mkdirSync(path.join(root, "config"), { recursive: true });
      mkdirSync(path.join(root, "scripts"), { recursive: true });
      writeFileSync(
        path.join(root, "config/knip.config.ts"),
        "const repositoryScriptEntries = [\n] as const;\n",
      );
      writeFileSync(path.join(root, "scripts/generate-dependency-release-evidence.mts"), "");
    }
    writeExecutable(path.join(fakeBin, "pnpm"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [ "${EXPECT_RELEASE_TOOLING_ENTRY:-false}" = "true" ] &&',
      "  ! grep -Fq '\"scripts/generate-dependency-release-evidence.mts!\"' config/knip.config.ts; then",
      '  echo "release-only helper is missing from Knip entries" >&2',
      "  exit 1",
      "fi",
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
        EXPECT_RELEASE_TOOLING_ENTRY: options.releaseToolingEntry ? "true" : "false",
        FROZEN_TARGET: options.historicalTarget ? "true" : "false",
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

function runControlUiI18nSourceFixture(options: {
  compatibilityTarget: boolean;
  hasVerifyScript: boolean;
}): { calls: string[]; output: string; summary: string; status: number | null } {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-ci-control-ui-i18n-"));
  try {
    const fakeBin = path.join(root, "bin");
    const callsPath = path.join(root, "pnpm-calls.txt");
    const summaryPath = path.join(root, "summary.md");
    mkdirSync(fakeBin);
    writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify({
        scripts: options.hasVerifyScript ? { "ui:i18n:verify": "true" } : {},
      })}\n`,
    );
    writeExecutable(path.join(fakeBin, "pnpm"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "%s\\n" "$*" >> "$PNPM_CALLS"',
    ]);
    const sourceStep = readCiWorkflow().jobs["control-ui-i18n"].steps.find(
      (step: WorkflowStep) => step.name === "Verify Control UI i18n source",
    );
    const run = spawnSync("bash", ["-c", sourceStep.run], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        COMPATIBILITY_TARGET: options.compatibilityTarget ? "true" : "false",
        GITHUB_STEP_SUMMARY: summaryPath,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        PNPM_CALLS: callsPath,
      },
    });
    return {
      calls: existsSync(callsPath)
        ? readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean)
        : [],
      output: `${run.stdout}${run.stderr}`,
      status: run.status,
      summary: existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : "",
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
    if (baseChangePath !== null || options.updateSource) {
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

    writeExecutable(path.join(fakeBin, "sleep"), ["#!/bin/sh", "exit 0"]);
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
    const actionRun = action.runs.steps.find(
      (step: { name?: string }) => step.name === "Publish generated pull request",
    ).run;
    expect(actionRun).toContain("timeout --signal=TERM --kill-after=10s");
    const publishRun = `timeout() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --signal=*|--kill-after=*) shift ;;
      [0-9]*s) shift; break ;;
      *) break ;;
    esac
  done
  "$@"
}
${actionRun}`;
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
  it("extracts module heredocs only at exact closing marker lines", () => {
    const run = runWorkflowShellScript(
      `node --input-type=module <<'NODE'
NODE_prefix: for (const value of ["heredoc-body-preserved"]) {
  console.log(value);
  break NODE_prefix;
}
NODE
`,
      {},
    );

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe("heredoc-body-preserved\n");
  });

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

  it("keeps ClawSweeper dispatch events aligned with receiver workflows", () => {
    const workflowPath = ".github/workflows/clawsweeper-dispatch.yml";
    const source = readFileSync(workflowPath, "utf8");
    const workflow = readWorkflow(workflowPath);
    const steps = workflow.jobs.dispatch.steps as WorkflowStep[];
    const receiverDispatchSteps = steps.filter((step) =>
      step.run?.includes("repos/openclaw/clawsweeper/dispatches"),
    );
    const eventTypes = receiverDispatchSteps.map((step) => {
      const matches = [...(step.run ?? "").matchAll(/\bevent_type\s*:\s*"([^"]+)"/gu)];
      expect(matches, step.name).toHaveLength(1);
      return expectDefined(matches[0]?.[1], step.name ?? "ClawSweeper dispatch event");
    });

    // This allowlist mirrors the target repository receiver contract; changes require coordinated receiver updates.
    expect(eventTypes.toSorted()).toEqual([
      "clawsweeper_comment",
      "clawsweeper_item",
      "github_activity",
    ]);
    expect(source).not.toContain("clawsweeper_commit_review");
    expect(source).not.toContain("CLAWSWEEPER_COMMIT_REVIEW_CREATE_CHECKS");
    expect(workflow.on.push.branches).toEqual(["main"]);

    const activityRun = expectDefined(
      steps.find((step) => step.name === "Dispatch GitHub activity to ClawSweeper")?.run,
      "ClawSweeper GitHub activity dispatch",
    );
    expect(activityRun).toMatch(
      /push: \(if \$event_name == "push" then \{\s+before: \.before,\s+after: \.after,\s+ref: \.ref,\s+compare: \.compare,\s+head_commit: \.head_commit\.id\s+\} else null end\)/u,
    );

    const exactReviewStep = expectDefined(
      steps.find((step) => step.name === "Dispatch exact ClawSweeper review"),
      "ClawSweeper exact-review dispatch",
    );
    expect(exactReviewStep.env?.TARGET_BRANCH).toBe(
      "${{ github.event.repository.default_branch }}",
    );
    expect(exactReviewStep.run).toContain('--arg target_branch "$TARGET_BRANCH"');
    expect(exactReviewStep.run).toContain("target_branch:$target_branch");
    expect(exactReviewStep.run).toContain('ingress_route:"target_dispatcher"');
    expect(exactReviewStep.run).toContain("ingress_fingerprint:$ingress_fingerprint");
  });

  it("runs the PR context and evidence gate only for relevant PR changes", () => {
    const workflow = readRealBehaviorProofWorkflow();

    expect(workflow.name).toBe("PR context and evidence");
    expect(workflow.jobs["real-behavior-proof"].name).toBe("PR context and evidence");
    expect(workflow.on.pull_request_target.types).toEqual([
      "opened",
      "edited",
      "synchronize",
      "reopened",
      "ready_for_review",
    ]);
    expect(workflow.concurrency.group).toBe(
      "${{ github.workflow }}-${{ github.event.pull_request.number }}",
    );
    expect(workflow.concurrency["cancel-in-progress"]).toBe(
      "${{ github.event.action == 'synchronize' }}",
    );
  });

  it("isolates auto-response per item and ignores ClawSweeper PR label feedback", () => {
    const workflow = readWorkflow(".github/workflows/auto-response.yml");
    const guard = workflow.jobs["auto-response"].if;

    expect(workflow.on.issues.types).toEqual(["opened", "edited", "labeled"]);
    expect(workflow.on.issue_comment.types).toEqual(["created"]);
    expect(workflow.on.pull_request_target.types).toEqual([
      "opened",
      "edited",
      "synchronize",
      "reopened",
      "labeled",
      "unlabeled",
    ]);
    expect(workflow.concurrency.group).toBe(
      "${{ github.workflow }}-${{ github.event.issue.number || github.event.pull_request.number }}",
    );
    expect(workflow.concurrency["cancel-in-progress"]).toBe(
      "${{ github.event_name == 'pull_request_target' && github.event.action == 'synchronize' }}",
    );
    expect(guard).toContain("github.event_name != 'pull_request_target'");
    expect(guard).toContain("github.event.action != 'labeled'");
    expect(guard).toContain("github.event.action != 'unlabeled'");
    expect(guard).toContain("github.actor != 'clawsweeper[bot]'");
    expect(guard).toContain("github.actor != 'openclaw-clawsweeper[bot]'");
    expect(guard).not.toContain("openclaw-barnacle[bot]");
  });

  it("routes stale bug issues through ClawSweeper instead of Barnacle closure", () => {
    const staleWorkflow = readWorkflow(".github/workflows/stale.yml");
    const staleSteps = staleWorkflow.jobs.stale.steps as WorkflowStep[];
    const stepNamed = (name: string) =>
      expectDefined(
        staleSteps.find((step) => step.name === name),
        name,
      );

    for (const name of [
      "Mark stale unassigned issues and pull requests (primary)",
      "Mark stale assigned issues (primary)",
      "Mark stale unassigned issues and pull requests (fallback)",
      "Mark stale assigned issues (fallback)",
    ]) {
      const exemptLabels = String(stepNamed(name).with?.["exempt-issue-labels"])
        .split(",")
        .map((label) => label.trim());
      expect(exemptLabels, name).toContain("bug");
    }

    const bugJob = staleWorkflow.jobs["stale-bug-verification"];
    expect(bugJob.permissions).toEqual({ issues: "write" });
    expect(bugJob["runs-on"]).toBe("ubuntu-24.04");
    const bugScript = String(
      (bugJob.steps as WorkflowStep[]).find(
        (step) => step.name === "Mark inactive bugs for ClawSweeper verification",
      )?.with?.script,
    );
    expect(bugScript).toContain("const maxMarks = 25;");
    expect(bugScript).toContain('labels: "bug"');
    expect(bugScript).toContain("github.rest.issues.addLabels");
    expect(bugScript).toContain("github.rest.issues.removeLabel");
    expect(bugScript).toContain("Inactivity alone will not close a bug report.");
    expect(bugScript).toContain("requires separate backfill approval");
    expect(bugScript).toContain("slice(staleEventIndex + 1)");
    expect(bugScript).toContain("updatedAtMs > lastAutomationAtMs");
    expect(bugScript).toContain('item.state !== "open"');
    expect(bugScript).not.toContain("15_000");
    expect(bugScript).not.toContain("github.rest.issues.update");

    const backfillScript = String(
      (staleWorkflow.jobs["backfill-stale-closures"].steps as WorkflowStep[]).find(
        (step) => step.name === "Backfill stale closures",
      )?.with?.script,
    );
    expect(backfillScript).toMatch(/issueExemptLabels[\s\S]*"bug"/);

    const dispatchWorkflow = readWorkflow(".github/workflows/clawsweeper-dispatch.yml");
    const dispatchCondition = String(dispatchWorkflow.jobs.dispatch.if);
    expect(dispatchCondition).toContain("github.event.label.name == 'stale'");
    expect(dispatchCondition).toContain("contains(github.event.issue.labels.*.name, 'bug')");
    expect(dispatchCondition).toContain("github.actor_id == '257215752'");
    expect(dispatchCondition).toContain("github.actor_id == '264559031'");

    const auditJob = staleWorkflow.jobs["audit-bug-closure-reasons"];
    expect(auditJob.permissions).toEqual({ issues: "read" });
    const auditScript = String((auditJob.steps as WorkflowStep[])[0]?.with?.script);
    expect(auditScript).toContain('item.state_reason !== "not_planned"');
    expect(auditScript).toContain("github.rest.issues.listEventsForTimeline");
    expect(auditScript).toContain("github.paginate.iterator(");
    expect(auditScript).toContain("new Set([257215752, 264559031])");
    expect(auditScript).toContain("escapeSummaryCell(violation.title)");
    expect(auditScript).toContain('.replaceAll("<", "&lt;")');
    expect(auditScript).toContain("core.setFailed(");
    expect(auditScript).not.toContain("github.rest.issues.update");
    expect(auditScript).not.toContain("github.rest.issues.createComment");
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
    expect(workflow.jobs.preflight.outputs.run_ios_screenshots).toBe(
      "${{ steps.changed_scope.outputs.run_ios_screenshots }}",
    );
    const workflowSource = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(workflowSource).toContain(
      "OPENCLAW_CI_RUN_MACOS: ${{ github.event_name == 'workflow_dispatch' && !inputs.release_gate && 'true' || steps.changed_scope.outputs.run_macos || 'false' }}",
    );
    expect(workflowSource).toContain(
      "OPENCLAW_CI_RUN_IOS_BUILD: ${{ github.event_name == 'workflow_dispatch' && !inputs.release_gate && 'true' || steps.changed_scope.outputs.run_ios_build || 'false' }}",
    );
    expect(workflowSource).toContain(
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

    expect(workflow.on.pull_request).toEqual({
      types: ["opened", "reopened", "synchronize", "ready_for_review"],
      paths: [".github/workflows/**"],
    });
    expect(workflow.jobs.check.if).toBe(
      "${{ github.event_name != 'pull_request' || !github.event.pull_request.draft }}",
    );
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

  it("keeps every path-filtered hosted gate runnable on landing-relevant events", () => {
    const workflows = [
      [".github/workflows/ci-check-testbox.yml", "check"],
      [".github/workflows/ci-check-arm-testbox.yml", "check-arm"],
      [".github/workflows/ci-build-artifacts-testbox.yml", "build-artifacts"],
    ] as const;

    for (const [workflowPath, jobName] of workflows) {
      const workflow = readWorkflow(workflowPath);
      expect(workflow.on.pull_request).toEqual({
        types: ["opened", "reopened", "synchronize", "ready_for_review"],
        paths: [".github/workflows/**"],
      });
      expect(workflow.jobs[jobName].if).toBe(
        "${{ github.event_name != 'pull_request' || !github.event.pull_request.draft }}",
      );
    }
  });

  it("pins every external GitHub Action reference to a full commit SHA", () => {
    expect(findUnpinnedExternalActions()).toEqual([]);
  });

  it("schedules approved Docker refreshes from independently resolved channels", () => {
    const workflow = readWorkflow(".github/workflows/docker-image-refresh.yml");
    const releaseWorkflow = readWorkflow(".github/workflows/docker-release.yml");
    const plan = workflow.jobs.plan;
    const publish = workflow.jobs.publish;
    const planSteps = plan.steps as WorkflowStep[];
    const mainGuard = expectDefined(
      planSteps.find((step) => step.name === "Require a main-branch run"),
      "Docker refresh main-branch guard",
    );
    const resolve = expectDefined(
      planSteps.find((step) => step.name === "Resolve refresh plan"),
      "Docker refresh plan step",
    );

    expect(workflow.on.schedule).toEqual([{ cron: "17 3 * * 1" }]);
    expect(workflow.on.workflow_dispatch.inputs.channel).toEqual({
      description: "Release channel to rebuild",
      required: false,
      default: "both",
      type: "choice",
      options: ["stable", "extended-stable", "both"],
    });
    expect(workflow.on.workflow_dispatch.inputs.dry_run).toEqual({
      description: "Resolve and summarize without publishing",
      required: false,
      default: false,
      type: "boolean",
    });
    expect(plan.permissions).toEqual({ contents: "read" });
    expect(mainGuard.run).toContain('[[ "${WORKFLOW_REF}" != "refs/heads/main" ]]');
    expect(resolve.run).toContain("docker-release-policy.mjs --current");
    expect(resolve.run).toContain('git rev-parse "refs/tags/${stable_tag}^{commit}"');
    expect(resolve.run).toContain('git rev-parse "refs/tags/${extended_stable_tag}^{commit}"');
    expect(resolve.run).toContain('suffix="-r$(date -u +%Y%m%d)"');
    expect(resolve.run).toContain('echo "matrix=${matrix}"');
    expect(resolve.run).toContain('} >> "${GITHUB_OUTPUT}"');
    expect(plan.environment).toBeUndefined();
    expect(publish.environment).toBeUndefined();

    expect(publish.needs).toBe("plan");
    expect(publish.if).toBe("needs.plan.outputs.dry_run != 'true'");
    expect(publish.strategy).toEqual({
      "fail-fast": false,
      matrix: { include: "${{ fromJSON(needs.plan.outputs.matrix) }}" },
    });
    expect(publish.uses).toBe("./.github/workflows/docker-release.yml");
    expect(publish.with).toEqual({
      tag: "${{ matrix.tag }}",
      release_sha: "${{ matrix.release_sha }}",
      image_tag_suffix: "${{ needs.plan.outputs.image_tag_suffix }}",
    });
    expect(publish.secrets).toEqual({
      DOCKERHUB_USERNAME: "${{ secrets.DOCKERHUB_USERNAME }}",
      DOCKERHUB_TOKEN: "${{ secrets.DOCKERHUB_TOKEN }}",
    });
    expect(publish.permissions).toEqual({ contents: "read", packages: "write" });
    expect(releaseWorkflow.jobs.approve_docker_publish.environment).toBe("docker-release");
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
    expect(workflow.on.push.paths).toContain("apps/android/app/src/play/**");
    expect(workflow.on.push.paths).toContain("apps/android/app/src/thirdParty/**");
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
      "apps/android/app/src/main/java/ai/openclaw/app/i18n/NativeStringResources.kt",
      "apps/android/app/src/main/res/values*/assistant.xml",
      "apps/android/app/src/main/res/values*/strings.xml",
      "apps/android/app/src/thirdParty/res/values*/accessibility_strings.xml",
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
    expect(nativePublishStep.with["invalidation-paths"]).toContain("apps/android/app/src/play");
    expect(nativePublishStep.with["invalidation-paths"]).toContain(
      "apps/android/app/src/thirdParty",
    );
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
    expect(controlUiArtifactStep.run).toContain("ui/src/i18n/.i18n/${LOCALE}.tm.jsonl");
    expect(controlUiArtifactStep.run).toContain("ui/src/i18n/.i18n/${LOCALE}.meta.json");
    expect(controlUiArtifactStep.run).not.toContain("git add -A ui/src/i18n");
    expect(controlUiAggregateStep.run).toBe(
      "node --import tsx scripts/control-ui-i18n.ts sync --write",
    );
    const controlUiPublishStep = controlUiFinalize.steps.find(
      (step: { name?: string }) => step.name === "Open or update generated locale PR",
    );
    expect(controlUiPublishStep.with["generated-paths"].trim().split("\n")).toEqual([
      "ui/src/i18n/.i18n/*.tm.jsonl",
      "ui/src/i18n/.i18n/*.meta.json",
      "ui/src/i18n/.i18n/catalog-fallbacks.json",
    ]);
    expect(controlUiPublishStep.with["invalidation-paths"]).toContain(
      "scripts/lib/control-ui-i18n-catalog.ts",
    );
    expect(controlUiPublishStep.with["invalidation-paths"]).toContain(
      "scripts/lib/control-ui-i18n-sync-plan.ts",
    );
    expect(controlUiPublishStep.with["invalidation-paths"]).toContain("ui/src/i18n/locales/*.ts");
    expect(controlUiPublishStep.with["invalidation-paths"]).toContain(
      "ui/src/i18n/locales/en-agents.ts",
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

      const publishRun = parse(readFileSync(PUBLISH_GENERATED_PR_ACTION, "utf8")).runs.steps.find(
        (step: { name?: string }) => step.name === "Publish generated pull request",
      ).run;
      const invalidPolicy = spawnSync("bash", ["-c", publishRun], {
        encoding: "utf8",
        env: {
          ...process.env,
          AUTO_MERGE: "false",
          CONTENTS_TOKEN: "contents-token",
          GH_TOKEN: "pull-request-token",
          OVERLAP_POLICY: "continue",
        },
      });
      expect(invalidPolicy.status).not.toBe(0);
      expect(`${invalidPolicy.stdout}${invalidPolicy.stderr}`).toContain(
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

  it("verifies the pinned OpenGrep release binary before installing it", () => {
    for (const workflowPath of [OPENGREP_PR_DIFF_WORKFLOW, OPENGREP_FULL_WORKFLOW]) {
      const workflow = parse(readFileSync(workflowPath, "utf8"));
      const installStep = expectDefined(
        workflow.jobs.scan.steps.find((step: WorkflowStep) => step.name === "Install opengrep"),
        `Install opengrep step in ${workflowPath}`,
      );
      const run = expectDefined(installStep.run, `Install opengrep script in ${workflowPath}`);

      expect(installStep.env, workflowPath).toMatchObject({
        OPENGREP_VERSION: "v1.25.0",
        OPENGREP_LINUX_X64_SHA256:
          "9ac4aebb47ba3f7b0d8fc641ac8749cb6c2f253f616131a67d9631e00d4bea33",
      });
      expect(run, workflowPath).toContain('binary="$(mktemp "${RUNNER_TEMP}/opengrep.XXXXXX")"');
      expect(run, workflowPath).toContain("trap 'rm -f \"$binary\"' EXIT");
      expect(run, workflowPath).toContain(
        "curl -fsSL --retry 4 --retry-all-errors --retry-delay 2",
      );
      expect(run, workflowPath).toContain("--connect-timeout 10 --max-time 300");
      expect(run, workflowPath).toContain('-o "$binary"');
      expect(run, workflowPath).toContain(
        "https://github.com/opengrep/opengrep/releases/download/${OPENGREP_VERSION}/opengrep_manylinux_x86",
      );
      expect(run, workflowPath).toContain(
        'printf \'%s  %s\\n\' "$OPENGREP_LINUX_X64_SHA256" "$binary" | sha256sum --check',
      );
      expect(run, workflowPath).toContain('install -m 0755 "$binary" "$install_dir/opengrep"');
      expect(run.indexOf('-o "$binary"'), workflowPath).toBeLessThan(
        run.indexOf("sha256sum --check"),
      );
      expect(run.indexOf("sha256sum --check"), workflowPath).toBeLessThan(
        run.indexOf('install -m 0755 "$binary"'),
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
    const nodeMaxParallel =
      workflow.jobs["checks-node-core-test-nondist-shard"].strategy["max-parallel"];
    expect(nodeMaxParallel).toBe(
      "${{ (vars.OPENCLAW_CI_RUNNER_BACKEND == 'github' || vars.OPENCLAW_CI_RUNNER_BACKEND == 'hybrid') && 96 || 28 }}",
    );
    expect(
      evaluateWorkflowExpression(nodeMaxParallel, {
        eventName: "push",
        repository: "openclaw/openclaw",
        runnerBackend: "blacksmith",
        runAttempt: 1,
      }),
    ).toBe(28);
    expect(
      evaluateWorkflowExpression(nodeMaxParallel, {
        eventName: "push",
        repository: "openclaw/openclaw",
        runnerBackend: "github",
        runAttempt: 1,
      }),
    ).toBe(96);
    expect(
      evaluateWorkflowExpression(nodeMaxParallel, {
        eventName: "push",
        repository: "openclaw/openclaw",
        runnerBackend: "hybrid",
        runAttempt: 1,
      }),
    ).toBe(96);
    expect(workflow.jobs["checks-fast-plugin-contracts-shard"].strategy["max-parallel"]).toBe(12);
    expect(workflow.jobs["checks-fast-channel-contracts-shard"].strategy["max-parallel"]).toBe(12);
    expect(workflow.jobs["check-shard"].strategy["max-parallel"]).toBe(12);
    expect(workflow.jobs["check-additional-shard"].strategy["max-parallel"]).toBe(12);
    expect(workflow.jobs["checks-windows"].strategy["max-parallel"]).toBe(3);
    expect(workflow.jobs.android.strategy["max-parallel"]).toBe(2);
  });

  it("splits Windows tests only for the GitHub-hosted backend", () => {
    const workflow = readCiWorkflow();
    const runStep = workflow.jobs["checks-windows"].steps.find(
      (step: WorkflowStep) => step.name === "Run ${{ matrix.task }} (${{ matrix.runtime }})",
    );
    const blacksmith = runCiManifestFixture({
      bundledPlanner: true,
      eventName: "push",
      historicalCompatibility: false,
      runnerBackend: "blacksmith",
    });
    const github = runCiManifestFixture({
      bundledPlanner: true,
      eventName: "push",
      historicalCompatibility: false,
      runnerBackend: "github",
    });
    const hybrid = runCiManifestFixture({
      bundledPlanner: true,
      eventName: "push",
      historicalCompatibility: false,
      runnerBackend: "hybrid",
    });
    const hybridDispatch = runCiManifestFixture({
      bundledPlanner: true,
      eventName: "workflow_dispatch",
      historicalCompatibility: false,
      runnerBackend: "hybrid",
    });

    expect(blacksmith.status, blacksmith.output).toBe(0);
    expect(github.status, github.output).toBe(0);
    expect(hybrid.status, hybrid.output).toBe(0);
    expect(hybridDispatch.status, hybridDispatch.output).toBe(0);
    // Blacksmith's Windows class admits ~2 concurrent jobs, so any profile that
    // can land there uses the single lane; only guaranteed-hosted profiles split.
    const expectedBlacksmithWindowsMatrix = [
      {
        check_name: "checks-windows-node-test",
        runtime: "node",
        task: "test",
        runner: "blacksmith-8vcpu-windows-2025",
      },
    ];
    expect(
      JSON.parse(
        expectDefined(blacksmith.outputs.checks_windows_matrix, "Blacksmith Windows matrix"),
      ).include,
    ).toEqual(expectedBlacksmithWindowsMatrix);
    const expectedHostedWindowsMatrix = [
      { check_name: "checks-windows-node-test-1", runtime: "node", task: "test-1" },
      { check_name: "checks-windows-node-test-2", runtime: "node", task: "test-2" },
      { check_name: "checks-windows-node-test-3", runtime: "node", task: "test-3" },
    ];
    expect(
      JSON.parse(expectDefined(github.outputs.checks_windows_matrix, "GitHub Windows matrix"))
        .include,
    ).toEqual(expectedHostedWindowsMatrix);
    expect(
      JSON.parse(expectDefined(hybrid.outputs.checks_windows_matrix, "hybrid Windows matrix"))
        .include,
    ).toEqual(expectedBlacksmithWindowsMatrix);
    expect(
      JSON.parse(
        expectDefined(
          hybridDispatch.outputs.checks_windows_matrix,
          "hybrid dispatch Windows matrix",
        ),
      ).include,
    ).toEqual(expectedHostedWindowsMatrix);
    expect(runStep.run).toContain("test-1)\n    pnpm test:windows:ci:1");
    expect(runStep.run).toContain("test-2)\n    pnpm test:windows:ci:2");
    expect(runStep.run).toContain("test-3)\n    pnpm test:windows:ci:3");
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

  it("validates frozen target context without binding it to the live branch head", () => {
    const workflow = readCiWorkflow();
    const input = workflow.on.workflow_dispatch.inputs.target_context_ref;
    const step = expectDefined(
      workflow.jobs.preflight.steps.find(
        (candidate: WorkflowStep) => candidate.name === "Validate target context",
      ),
      "target context validation step",
    );
    const targetSha = "a".repeat(40);

    expect(input).toEqual({
      description:
        "Canonical release branch context authorizing compatibility fallbacks for an exact-SHA target",
      required: false,
      default: "",
      type: "string",
    });
    expect(step.if).toBe("inputs.target_context_ref != ''");
    expect(step.run).not.toContain("ls-remote");
    expect(step.run).not.toContain("EXPECTED_SHA");
    expect(step.run).not.toContain("git ");

    for (const contextRef of ["release/2026.8.1", "extended-stable/2026.8.33"]) {
      const result = runTargetContextValidation(contextRef, targetSha);
      expect(result.status, `${contextRef}: ${result.output}`).toBe(0);
      expect(result.outputs.eligible).toBe("true");
    }

    for (const contextRef of [
      "v2026.8.1",
      "main",
      "release-ci/2026.8.1-beta.2-frozen",
      "release/2026.8",
      "refs/heads/release/2026.8.1",
    ]) {
      const result = runTargetContextValidation(contextRef, targetSha);
      expect(result.status, contextRef).toBe(1);
      expect(result.output).toContain(
        "target_context_ref must be a canonical OpenClaw release branch.",
      );
    }

    for (const targetRef of ["main", "a".repeat(39)]) {
      const result = runTargetContextValidation("release/2026.8.1", targetRef);
      expect(result.status, targetRef).toBe(1);
      expect(result.output).toContain(
        "target_context_ref requires target_ref to be a full commit SHA.",
      );
    }
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
    const androidJob = workflow.jobs.android;
    const runStep = expectDefined(
      androidJob.steps.find((step: WorkflowStep) => step.name === "Run Android ${{ matrix.task }}"),
      "Android task runner",
    );
    const nativeResourcesSetup = expectDefined(
      androidJob.steps.find(
        (step: WorkflowStep) => step.name === "Setup Node environment for native resources",
      ),
      "Android native resources Node setup",
    );
    const buildPlayCase = expectDefined(
      runStep.run?.match(/^\s*build-play\)\n([\s\S]*?)^\s*;;$/mu)?.[1],
      "Android build-play case",
    );
    const buildPlayBranches = expectDefined(
      buildPlayCase.match(
        /if \[ "\$CI_RUNNER_BACKEND" = "github" \] \|\| \[ "\$GITHUB_EVENT_NAME" = "workflow_dispatch" \]; then\n([\s\S]*?)\n\s*else\n([\s\S]*?)\n\s*fi/u,
      ),
      "Android build-play runner branches",
    );
    const dispatchBuild = expectDefined(buildPlayBranches[1], "hosted dispatch build branch");
    const blacksmithBuild = expectDefined(buildPlayBranches[2], "Blacksmith build branch");
    const readTasks = (script: string) =>
      [...script.matchAll(/^\s+(:[a-z][A-Za-z0-9:-]*)\s*\\?$/gmu)].map((match) => match[1]);
    const dispatchTasks = readTasks(dispatchBuild);
    const blacksmithTasks = readTasks(blacksmithBuild);

    expect(source).toContain('task: useCompatibleAndroidCi ? "test-play-compat" : "test-play"');
    expect(source).toContain(
      '{ check_name: "android-test-third-party", task: "test-third-party" }',
    );
    expect(source.match(/check_name: "android-build-play"/gu)).toHaveLength(1);
    expect(source).toContain('task: useCompatibleAndroidCi ? "build-play-compat" : "build-play"');
    expect(androidJob.name).toBe("${{ matrix.check_name }}");
    expect(androidJob["runs-on"]).toBe(
      "${{ vars.OPENCLAW_CI_RUNNER_BACKEND == 'github' && 'ubuntu-24.04' || (vars.OPENCLAW_CI_RUNNER_BACKEND == 'hybrid' && github.run_attempt > 1) && 'ubuntu-24.04' || github.event_name == 'workflow_dispatch' && 'ubuntu-24.04' || (github.repository == 'openclaw/openclaw' && (github.event_name != 'pull_request' || contains(fromJSON('[\"OWNER\",\"MEMBER\",\"COLLABORATOR\",\"CONTRIBUTOR\"]'), github.event.pull_request.author_association)) && 'blacksmith-8vcpu-ubuntu-2404' || 'ubuntu-24.04') }}",
    );
    expect(runStep.env.CI_RUNNER_BACKEND).toContain(
      "vars.OPENCLAW_CI_RUNNER_BACKEND == 'hybrid' && github.run_attempt > 1",
    );
    expect(runStep.run).toContain(":app:testPlayDebugUnitTest");
    expect(runStep.run).toContain(":app:testThirdPartyDebugUnitTest");
    expect(dispatchBuild.match(/^\s*\.\/gradlew\b/gmu)).toHaveLength(3);
    expect(dispatchTasks).toEqual([
      ":app:assemblePlayDebug",
      ":app:lintPlayDebug",
      ":app:assembleThirdPartyDebug",
      ":app:lintThirdPartyDebug",
      ":benchmark:assembleDebug",
      ":wear-shared:assembleDebug",
      ":wear-shared:lintDebug",
    ]);
    expect(new Set(dispatchTasks).size).toBe(dispatchTasks.length);
    expect(blacksmithBuild.match(/^\s*\.\/gradlew\b/gmu)).toHaveLength(1);
    expect(blacksmithTasks).toEqual([
      ":app:assemblePlayDebug",
      ":app:assembleThirdPartyDebug",
      ":app:lintPlayDebug",
      ":app:lintThirdPartyDebug",
      ":benchmark:assembleDebug",
      ":wear-shared:assembleDebug",
      ":wear-shared:lintDebug",
    ]);
    expect(nativeResourcesSetup.uses).toBe("./.github/actions/setup-node-env");
    expect(nativeResourcesSetup.if).toBe(
      "needs.preflight.outputs.use_compatible_android_ci != 'true'",
    );
    expect(nativeResourcesSetup.with).toMatchObject({ "install-bun": "false" });
  });

  it("pipelines canonical main CI across two non-canceling slots", () => {
    const workflow = readCiWorkflow();

    expect(workflow.concurrency.group).toBe(
      "${{ github.event_name == 'workflow_dispatch' && format('{0}-manual-v1-{1}', github.workflow, github.run_id) || (github.event_name == 'pull_request' && format('{0}-v7-{1}', github.workflow, github.event.pull_request.number) || (github.repository == 'openclaw/openclaw' && github.event_name == 'push' && github.ref == 'refs/heads/main' && format('{0}-v8-{1}-{2}', github.workflow, github.ref, (endsWith(format('{0}', github.run_number), '0') || endsWith(format('{0}', github.run_number), '2') || endsWith(format('{0}', github.run_number), '4') || endsWith(format('{0}', github.run_number), '6') || endsWith(format('{0}', github.run_number), '8')) && 'a' || 'b') || (github.repository == 'openclaw/openclaw' && format('{0}-v7-{1}', github.workflow, github.ref) || format('{0}-v7-{1}-{2}', github.workflow, github.ref, github.sha)))) }}",
    );
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

  it("encodes GitHub, Blacksmith, and hybrid runner-backend shapes", () => {
    const workflow = readCiWorkflow();
    const jobs = workflow.jobs as Record<string, { "runs-on": unknown }>;
    const expectedHostedRunners = {
      android: "ubuntu-24.04",
      "build-artifacts": "ubuntu-24.04",
      "check-additional-shard": "ubuntu-24.04",
      "check-docs": "ubuntu-24.04",
      "check-shard": "ubuntu-24.04",
      "checks-fast-channel-contracts-shard": "ubuntu-24.04",
      "checks-fast-core": "ubuntu-24.04",
      "checks-fast-plugin-contracts-shard": "ubuntu-24.04",
      "checks-node-compat": "ubuntu-24.04",
      "checks-node-core-test-nondist-shard": "ubuntu-24.04",
      "checks-ui": "ubuntu-24.04",
      "checks-ui-e2e": "ubuntu-24.04",
      "checks-ui-e2e-real-gateway": "ubuntu-24.04",
      "control-ui-i18n": "ubuntu-24.04",
      "ios-build": "macos-26",
      "macos-node": "macos-15",
      "macos-swift": "macos-26",
      "native-i18n": "ubuntu-24.04",
      "pnpm-store-warmup": "ubuntu-24.04",
      preflight: "ubuntu-24.04",
      "qa-smoke-ci-profile": "ubuntu-24.04",
      "skills-python": "ubuntu-24.04",
      "sqlite-session-lifecycle": "ubuntu-24.04",
      "check-test-types-hosted-core-shard": "ubuntu-24.04",
      "checks-windows": "windows-2025",
    } as const;
    const expectedHybridFirstAttemptRunners = {
      ...expectedHostedRunners,
      android: "blacksmith-8vcpu-ubuntu-2404",
      "build-artifacts": "blacksmith-32vcpu-ubuntu-2404",
      "checks-node-core-test-nondist-shard": "blacksmith-32vcpu-ubuntu-2404",
      "checks-ui-e2e": "blacksmith-8vcpu-ubuntu-2404",
      "qa-smoke-ci-profile": "blacksmith-16vcpu-ubuntu-2404",
      "sqlite-session-lifecycle": "blacksmith-8vcpu-ubuntu-2404",
      "macos-node": "blacksmith-6vcpu-macos-15",
      "macos-swift": "blacksmith-12vcpu-macos-26",
      "ios-build": "blacksmith-12vcpu-macos-26",
      "check-test-types-hosted-core-shard": "blacksmith-8vcpu-ubuntu-2404",
      "checks-ui": "blacksmith-8vcpu-ubuntu-2404",
      "checks-windows": "blacksmith-8vcpu-windows-2025",
    } as const;
    const configurableJobs = Object.entries(jobs)
      .filter(([, job]) => String(job["runs-on"]).startsWith("${{"))
      .map(([jobName]) => jobName)
      .toSorted();
    const canonicalPullRequest = {
      eventName: "pull_request",
      headRepository: "openclaw/openclaw",
      matrix: { runner: "blacksmith-32vcpu-ubuntu-2404" },
      repository: "openclaw/openclaw",
      runAttempt: 1,
    } as const;

    expect(configurableJobs).toEqual(Object.keys(expectedHostedRunners).toSorted());
    expect(jobs["check-lint-hosted-core-shard"]?.["runs-on"]).toBe("ubuntu-24.04");
    for (const [jobName, hostedRunner] of Object.entries(expectedHostedRunners)) {
      const expression = jobs[jobName]?.["runs-on"];
      expect(expression, jobName).toContain("vars.OPENCLAW_CI_RUNNER_BACKEND == 'github'");
      expect(
        evaluateWorkflowExpression(expression, {
          ...canonicalPullRequest,
          runnerBackend: "github",
        }),
        jobName,
      ).toBe(hostedRunner);
      expect(
        evaluateWorkflowExpression(expression, {
          ...canonicalPullRequest,
          runnerBackend: "hybrid",
        }),
        jobName,
      ).toBe(expectedHybridFirstAttemptRunners[jobName as keyof typeof expectedHostedRunners]);
      expect(
        evaluateWorkflowExpression(expression, {
          ...canonicalPullRequest,
          runnerBackend: "hybrid",
          runAttempt: 2,
        }),
        jobName,
      ).toBe(hostedRunner);
      expect(
        evaluateWorkflowExpression(expression, {
          ...canonicalPullRequest,
          runnerBackend: "blacksmith",
        }),
        jobName,
      ).toBe(evaluateWorkflowExpression(expression, canonicalPullRequest));
      // Authors with no landed commit stay on free hosted infrastructure, so an
      // unreviewed PR cannot spend Blacksmith capacity.
      expect(
        evaluateWorkflowExpression(expression, {
          ...canonicalPullRequest,
          authorAssociation: "NONE",
          headRepository: "contributor/openclaw",
          runnerBackend: "hybrid",
        }),
        `${jobName}: untrusted fork`,
      ).toBe(hostedRunner);
      // A fork PR from someone who already landed a commit routes exactly like a
      // maintainer PR. Maintainers report CONTRIBUTOR here too (org membership is
      // concealed), so this case also protects their own routing.
      expect(
        evaluateWorkflowExpression(expression, {
          ...canonicalPullRequest,
          authorAssociation: "CONTRIBUTOR",
          headRepository: "contributor/openclaw",
          runnerBackend: "hybrid",
        }),
        `${jobName}: returning-contributor fork`,
      ).toBe(expectedHybridFirstAttemptRunners[jobName as keyof typeof expectedHostedRunners]);
    }

    const widenedHybridMatrixRows = [
      {
        jobName: "check-shard",
        matrix: { runner: "blacksmith-32vcpu-ubuntu-2404", task: "lint" },
        runner: "blacksmith-32vcpu-ubuntu-2404",
      },
      {
        jobName: "check-shard",
        matrix: { runner: "blacksmith-16vcpu-ubuntu-2404", task: "test-types" },
        runner: "blacksmith-16vcpu-ubuntu-2404",
      },
      {
        jobName: "check-shard",
        matrix: { runner: "blacksmith-32vcpu-ubuntu-2404", task: "dependencies" },
        runner: "blacksmith-32vcpu-ubuntu-2404",
      },
      {
        jobName: "check-additional-shard",
        matrix: {
          group: "extension-package-boundary",
          runner: "blacksmith-32vcpu-ubuntu-2404",
        },
        runner: "blacksmith-32vcpu-ubuntu-2404",
      },
      {
        jobName: "check-additional-shard",
        matrix: {
          group: "runtime-topology-architecture",
          runner: "blacksmith-8vcpu-ubuntu-2404",
        },
        runner: "blacksmith-8vcpu-ubuntu-2404",
      },
      {
        jobName: "check-additional-shard",
        matrix: {
          group: "plugin-sdk-api-diff",
          runner: "blacksmith-4vcpu-ubuntu-2404",
        },
        runner: "blacksmith-4vcpu-ubuntu-2404",
      },
      {
        jobName: "checks-node-core-test-nondist-shard",
        matrix: { runner: "blacksmith-4vcpu-ubuntu-2404" },
        runner: "blacksmith-4vcpu-ubuntu-2404",
      },
      {
        jobName: "checks-node-core-test-nondist-shard",
        matrix: { runner: "blacksmith-8vcpu-ubuntu-2404" },
        runner: "blacksmith-8vcpu-ubuntu-2404",
      },
    ] as const;
    for (const { jobName, matrix, runner } of widenedHybridMatrixRows) {
      const expression = jobs[jobName]?.["runs-on"];
      expect(
        evaluateWorkflowExpression(expression, {
          ...canonicalPullRequest,
          matrix,
          runnerBackend: "hybrid",
        }),
        `${jobName}: hybrid attempt 1`,
      ).toBe(runner);
      expect(
        evaluateWorkflowExpression(expression, {
          ...canonicalPullRequest,
          matrix,
          runnerBackend: "hybrid",
          runAttempt: 2,
        }),
        `${jobName}: hybrid retry`,
      ).toBe("ubuntu-24.04");
      expect(
        evaluateWorkflowExpression(expression, {
          ...canonicalPullRequest,
          matrix,
          runnerBackend: "github",
        }),
        `${jobName}: github backend`,
      ).toBe("ubuntu-24.04");
      expect(
        evaluateWorkflowExpression(expression, {
          ...canonicalPullRequest,
          authorAssociation: "NONE",
          headRepository: "contributor/openclaw",
          matrix,
          runnerBackend: "hybrid",
        }),
        `${jobName}: untrusted fork pull request`,
      ).toBe("ubuntu-24.04");
      expect(
        evaluateWorkflowExpression(expression, {
          ...canonicalPullRequest,
          eventName: "workflow_dispatch",
          matrix,
          runnerBackend: "hybrid",
        }),
        `${jobName}: workflow dispatch`,
      ).toBe("ubuntu-24.04");
    }

    for (const jobName of [
      "check-additional-shard",
      "check-lint-hosted-core-shard",
      "check-shard",
      "checks-ui-e2e",
      "qa-smoke-ci-profile",
    ]) {
      const setup = expectDefined(
        workflow.jobs[jobName].steps.find(
          (step: WorkflowStep) => step.name === "Setup Node environment",
        ),
        `${jobName} Node setup`,
      );
      const context = {
        ...canonicalPullRequest,
        matrix:
          widenedHybridMatrixRows.find((row) => row.jobName === jobName)?.matrix ??
          canonicalPullRequest.matrix,
        runnerBackend: "hybrid" as const,
      };
      expect(evaluateWorkflowExpression(setup.with?.["dependency-cache"], context), jobName).toBe(
        "false",
      );
      expect(evaluateWorkflowExpression(setup.with?.["use-actions-cache"], context), jobName).toBe(
        "true",
      );
    }
  });

  it("gives breaker-routed hosted jobs their hosted timeout budgets", () => {
    const workflow = readCiWorkflow();
    const jobs = workflow.jobs as Record<string, { "timeout-minutes": unknown }>;
    const expectedHostedTimeouts = {
      "build-artifacts": 35,
      "macos-swift": 30,
    } as const;
    const routeDependentTimeoutJobs = Object.entries(jobs)
      .filter(([, job]) => {
        const timeout = job["timeout-minutes"];
        return typeof timeout === "string" && timeout.includes("github.");
      })
      .map(([jobName]) => jobName)
      .toSorted();
    const canonicalPullRequest = {
      eventName: "pull_request",
      headRepository: "openclaw/openclaw",
      repository: "openclaw/openclaw",
      runAttempt: 1,
    } as const;

    expect(routeDependentTimeoutJobs).toEqual(Object.keys(expectedHostedTimeouts).toSorted());
    for (const [jobName, hostedTimeout] of Object.entries(expectedHostedTimeouts)) {
      const expression = jobs[jobName]?.["timeout-minutes"];
      expect(expression, jobName).toContain("vars.OPENCLAW_CI_RUNNER_BACKEND == 'github'");
      expect(
        evaluateWorkflowExpression(expression, {
          ...canonicalPullRequest,
          runnerBackend: "github",
        }),
        jobName,
      ).toBe(hostedTimeout);
      expect(
        evaluateWorkflowExpression(expression, {
          ...canonicalPullRequest,
          runnerBackend: "blacksmith",
        }),
        jobName,
      ).toBe(20);
      expect(
        evaluateWorkflowExpression(expression, {
          ...canonicalPullRequest,
          runnerBackend: "hybrid",
        }),
        jobName,
      ).toBe(20);
      expect(
        evaluateWorkflowExpression(expression, {
          ...canonicalPullRequest,
          runnerBackend: "hybrid",
          runAttempt: 2,
        }),
        jobName,
      ).toBe(hostedTimeout);
    }
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

  it("owns one exact immutable semantic dependency cache", () => {
    const actionSource = readFileSync(".github/actions/setup-node-env/action.yml", "utf8");
    const ciSource = readFileSync(".github/workflows/ci.yml", "utf8");
    const action = parse(actionSource);
    const workflow = parse(ciSource);
    const actionSteps = action.runs.steps as WorkflowStep[];
    const step = (name: string) =>
      expectDefined(
        actionSteps.find((candidate) => candidate.name === name),
        name,
      );
    const configureStore = step("Configure dependency cache store");
    const resolve = step("Resolve dependency cache key");
    const prepare = step("Prepare dependency cache restore");
    const restore = step("Restore exact dependency cache");
    const prepareFallback = step("Prepare dependency cache miss fallback");
    const setupPnpm = step("Setup pnpm");
    const install = step("Install dependencies");
    const installScript = expectDefined(install.run, "Install dependencies script");
    const save = step("Save exact dependency cache");
    const cachePaths =
      "node_modules\nui/node_modules\npackages/*/node_modules\nexamples/*/node_modules\n.cache/openclaw-pnpm-store\n";

    expect(action.inputs["dependency-cache"].default).toBe("false");
    expect(action.inputs["save-dependency-cache"].default).toBe("false");
    expect(action.inputs).not.toHaveProperty("sticky-disk");
    expect(action.inputs).not.toHaveProperty("save-sticky-disk");
    expect(actionSource).not.toContain("useblacksmith/stickydisk");

    expect(configureStore.if).toBe("inputs.dependency-cache == 'true'");
    expect(configureStore.run).toContain(
      'echo "PNPM_CONFIG_STORE_DIR=$GITHUB_WORKSPACE/.cache/openclaw-pnpm-store"',
    );
    expect(resolve.if).toBe("inputs.dependency-cache == 'true'");
    expect(resolve.run).toContain('node "$GITHUB_ACTION_PATH/dependency-fingerprint.mjs"');
    expect(resolve.run).toContain("${GITHUB_REPOSITORY:?}-node-deps-v2");
    expect(resolve.run).toContain("${RUNNER_OS:?}-arch-${RUNNER_ARCH:?}");
    expect(resolve.run).toContain("node-$(node --version)-${deps_input_fingerprint:?}");
    expect(resolve.run).not.toMatch(/GITHUB_(?:REF|SHA|RUN_ID)|RUN_(?:ID|ATTEMPT)/u);
    expect(actionSteps.indexOf(resolve)).toBeLessThan(actionSteps.indexOf(restore));
    for (const cleanup of [prepare, prepareFallback]) {
      expect(cleanup.run).toContain('rm -rf "$GITHUB_WORKSPACE/node_modules"');
      expect(cleanup.run).toContain('"$GITHUB_WORKSPACE/.cache/openclaw-pnpm-store"');
      expect(cleanup.run).toContain('"$GITHUB_WORKSPACE/packages"');
      expect(cleanup.run).toContain("-name node_modules");
    }
    expect(actionSteps.indexOf(prepare)).toBeLessThan(actionSteps.indexOf(restore));
    expect(restore).toMatchObject({
      if: "inputs.dependency-cache == 'true'",
      uses: CACHE_V5,
      with: { key: "${{ steps.dependency-cache-key.outputs.key }}", path: cachePaths },
    });
    expect((restore as WorkflowStep & { "continue-on-error"?: boolean })["continue-on-error"]).toBe(
      true,
    );
    expect(restore.with).not.toHaveProperty("restore-keys");
    expect(prepareFallback.if).toContain("steps.dependency-cache.outputs.cache-hit != 'true'");
    expect(prepareFallback.run).toContain(
      "actions/cache treats service, download, and extraction failures as",
    );
    expect(actionSteps.indexOf(restore)).toBeLessThan(actionSteps.indexOf(prepareFallback));
    expect(actionSteps.indexOf(prepareFallback)).toBeLessThan(actionSteps.indexOf(setupPnpm));
    expect(setupPnpm.with?.["use-actions-cache"]).toContain(
      "steps.dependency-cache.outputs.cache-hit != 'true'",
    );
    expect(setupPnpm.with?.["use-actions-cache"]).toContain(
      "inputs.dependency-cache != 'true' && inputs.use-actions-cache == 'true'",
    );
    expect(actionSteps.indexOf(restore)).toBeLessThan(actionSteps.indexOf(setupPnpm));

    expect(installScript).toContain("install_args+=(--package-import-method=hardlink)");
    expect(installScript).toContain("run_pnpm_install --offline");
    expect(installScript).toContain("run_pnpm_install --prefer-offline");
    expect(installScript).toContain('[ "$DEPENDENCY_CACHE_HIT" = "true" ]');
    expect(installScript).toContain('rm -rf "$GITHUB_WORKSPACE/node_modules"');
    expect(installScript).toContain('"$GITHUB_WORKSPACE/packages"');
    expect(installScript).toContain("-name node_modules");
    expect(installScript).toContain('"${PNPM_CONFIG_STORE_DIR:?}"');
    expect(installScript.match(/run_pnpm_install/g)).toHaveLength(5);
    expect(installScript).toContain('echo "OPENCLAW_BUILD_ALL_NO_PNPM=1" >> "$GITHUB_ENV"');
    expect(installScript).toContain(
      'echo "pnpm_config_verify_deps_before_run=false" >> "$GITHUB_ENV"',
    );
    expect(save).toMatchObject({
      uses: "actions/cache/save@27d5ce7f107fe9357f9df03efb73ab90386fccae",
      with: { key: "${{ steps.dependency-cache-key.outputs.key }}", path: cachePaths },
    });
    expect(save.if).toContain("inputs.save-dependency-cache == 'true'");
    expect(save.if).toContain("steps.dependency-cache.outputs.cache-hit != 'true'");
    expect((save as WorkflowStep & { "continue-on-error"?: boolean })["continue-on-error"]).toBe(
      true,
    );
    expect(actionSteps.indexOf(save)).toBe(actionSteps.indexOf(install) + 1);

    const dependencySetups = Object.entries(workflow.jobs).flatMap(([jobName, job]) =>
      ((job as { steps?: WorkflowStep[] }).steps ?? []).flatMap((candidate) =>
        candidate.uses === "./.github/actions/setup-node-env" &&
        candidate.with?.["dependency-cache"] !== undefined
          ? [{ jobName, step: candidate }]
          : [],
      ),
    );
    const writers = dependencySetups.filter(
      ({ step: candidate }) => candidate.with?.["save-dependency-cache"] === "true",
    );
    expect(writers).toHaveLength(1);
    expect(writers[0]?.jobName).toBe("preflight");
    expect(writers[0]?.step).toMatchObject({
      if: expect.stringContaining("steps.manifest.outputs.run_node == 'true'"),
      with: {
        "dependency-cache": "true",
        "save-actions-cache": "true",
        "save-dependency-cache": "true",
        "use-actions-cache": "true",
      },
    });
    expect(writers[0]?.step.if).toContain("github.ref == 'refs/heads/main'");
    expect(writers[0]?.step.if).toContain("github.event_name == 'pull_request'");
    expect(writers[0]?.step.if).toContain("vars.OPENCLAW_CI_RUNNER_BACKEND != 'github'");
    expect(writers[0]?.step.if).toContain("vars.OPENCLAW_CI_RUNNER_BACKEND != 'hybrid'");
    expect(workflow.jobs["pnpm-store-warmup"].if).toContain(
      "vars.OPENCLAW_CI_RUNNER_BACKEND == 'github'",
    );
    expect(workflow.jobs["pnpm-store-warmup"].if).toContain(
      "vars.OPENCLAW_CI_RUNNER_BACKEND == 'hybrid'",
    );
    const consumers = dependencySetups.filter(({ jobName }) => jobName !== "preflight");
    expect(consumers.map(({ jobName }) => jobName).toSorted()).toEqual([
      "build-artifacts",
      "check-additional-shard",
      "check-docs",
      "check-lint-hosted-core-shard",
      "check-shard",
      "check-test-types-hosted-core-shard",
      "checks-fast-channel-contracts-shard",
      "checks-fast-core",
      "checks-fast-plugin-contracts-shard",
      "checks-node-core-test-nondist-shard",
      "checks-ui",
      "checks-ui-e2e",
      "checks-ui-e2e-real-gateway",
      "control-ui-i18n",
      "native-i18n",
      "qa-smoke-ci-profile",
      "sqlite-session-lifecycle",
    ]);
    for (const { jobName, step: consumer } of consumers) {
      const needs = workflow.jobs[jobName].needs;
      expect(Array.isArray(needs) ? needs : [needs], jobName).toContain("preflight");
      expect(consumer.with, jobName).not.toHaveProperty("save-dependency-cache");
      expect(consumer.with?.["dependency-cache"], jobName).toContain("'true' || 'false'");
      expect(consumer.with?.["use-actions-cache"], jobName).toContain("'false' || 'true'");
      expect(consumer.with?.["dependency-cache"], jobName).toContain(
        "vars.OPENCLAW_CI_RUNNER_BACKEND",
      );
      for (const runnerBackend of ["github", "hybrid"] as const) {
        expect(
          evaluateWorkflowExpression(consumer.with?.["dependency-cache"], {
            eventName: "push",
            matrix: { node_version: "24.x" },
            repository: "openclaw/openclaw",
            runnerBackend,
            runAttempt: 1,
          }),
          `${jobName} ${runnerBackend} dependency cache`,
        ).toBe("false");
        expect(
          evaluateWorkflowExpression(consumer.with?.["use-actions-cache"], {
            eventName: "push",
            matrix: { node_version: "24.x" },
            repository: "openclaw/openclaw",
            runnerBackend,
            runAttempt: 1,
          }),
          `${jobName} ${runnerBackend} Actions cache`,
        ).toBe("true");
      }
    }
    for (const { jobName, step: setup } of Object.entries(workflow.jobs).flatMap(([jobName, job]) =>
      ((job as { steps?: WorkflowStep[] }).steps ?? [])
        .filter((candidate) => candidate.uses === "./.github/actions/setup-node-env")
        .map((candidate) => ({ jobName, step: candidate })),
    )) {
      expect(setup.with, jobName).not.toHaveProperty("sticky-disk");
      expect(setup.with, jobName).not.toHaveProperty("save-sticky-disk");
    }
  });

  it.skipIf(process.platform === "win32")(
    "preserves pnpm hard links and validates cached importers offline",
    () => {
      const root = tempDirs.make("openclaw-dependency-cache-");
      const source = path.join(root, "source");
      const registry = path.join(root, "registry");
      const workspace = path.join(root, "workspace");
      const consumer = path.join(workspace, "packages", "consumer");
      const store = path.join(workspace, ".cache", "openclaw-pnpm-store");
      const readyFile = path.join(root, "registry-ready");
      mkdirSync(source, { recursive: true });
      mkdirSync(registry, { recursive: true });
      mkdirSync(consumer, { recursive: true });
      writeFileSync(
        path.join(source, "package.json"),
        JSON.stringify({ files: ["index.js"], name: "cache-proof-dep", version: "1.0.0" }),
      );
      writeFileSync(path.join(source, "index.js"), 'module.exports = "cache-proof-v1";\n');
      execFileSync("pnpm", ["pack", "--pack-destination", registry], {
        cwd: source,
        env: { ...process.env, CI: "true" },
        stdio: "pipe",
      });
      const tarball = path.join(registry, "cache-proof-dep-1.0.0.tgz");
      const registryScript = String.raw`
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:http");
const tarballPath = process.argv[1];
const readyPath = process.argv[2];
const tarball = readFileSync(tarballPath);
const server = createServer((request, response) => {
  if (request.url === "/cache-proof-dep") {
    const port = server.address().port;
    const metadata = {
      name: "cache-proof-dep",
      "dist-tags": { latest: "1.0.0" },
      versions: {
        "1.0.0": {
          name: "cache-proof-dep",
          version: "1.0.0",
          dist: {
            tarball: "http://127.0.0.1:" + port + "/cache-proof-dep-1.0.0.tgz",
            shasum: createHash("sha1").update(tarball).digest("hex"),
            integrity: "sha512-" + createHash("sha512").update(tarball).digest("base64"),
          },
        },
      },
    };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(metadata));
    return;
  }
  if (request.url === "/cache-proof-dep-1.0.0.tgz") {
    response.setHeader("content-type", "application/octet-stream");
    response.end(tarball);
    return;
  }
  response.statusCode = 404;
  response.end();
});
server.listen(0, "127.0.0.1", () => writeFileSync(readyPath, String(server.address().port)));
`;
      const registryServer = spawn(process.execPath, ["-e", registryScript, tarball, readyFile], {
        stdio: "ignore",
      });
      try {
        for (let attempt = 0; attempt < 200 && !existsSync(readyFile); attempt += 1) {
          if (registryServer.exitCode !== null) {
            throw new Error(`fixture registry exited with ${registryServer.exitCode}`);
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        expect(existsSync(readyFile)).toBe(true);
        const registryUrl = `http://127.0.0.1:${readFileSync(readyFile, "utf8")}`;
        writeFileSync(
          path.join(workspace, "package.json"),
          JSON.stringify({
            dependencies: { "cache-proof-dep": "1.0.0" },
            name: "cache-proof-root",
            private: true,
          }),
        );
        writeFileSync(path.join(workspace, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
        writeFileSync(
          path.join(consumer, "package.json"),
          JSON.stringify({
            dependencies: { "cache-proof-dep": "1.0.0" },
            name: "cache-proof-consumer",
            private: true,
          }),
        );
        execFileSync(
          "pnpm",
          [
            "install",
            `--registry=${registryUrl}`,
            `--store-dir=${store}`,
            "--package-import-method=hardlink",
            "--ignore-scripts",
            "--config.engine-strict=false",
          ],
          { cwd: workspace, env: { ...process.env, CI: "true" }, stdio: "pipe" },
        );

        const findSameFile = (directory: string, referencePath: string): string | undefined => {
          const reference = statSync(referencePath);
          for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
              const nested = findSameFile(entryPath, referencePath);
              if (nested) {
                return nested;
              }
            } else if (entry.isFile()) {
              const candidate = statSync(entryPath);
              if (candidate.dev === reference.dev && candidate.ino === reference.ino) {
                return entryPath;
              }
            }
          }
          return undefined;
        };
        const rootPackageFile = path.join(workspace, "node_modules", "cache-proof-dep", "index.js");
        expect(findSameFile(store, rootPackageFile)).toBeDefined();

        const archive = path.join(root, "dependency-cache.tar");
        execFileSync(
          "tar",
          [
            "-cf",
            archive,
            "-C",
            workspace,
            "node_modules",
            "packages/consumer/node_modules",
            ".cache/openclaw-pnpm-store",
          ],
          { stdio: "pipe" },
        );

        rmSync(path.join(workspace, "node_modules"), { force: true, recursive: true });
        rmSync(path.join(consumer, "node_modules"), { force: true, recursive: true });
        rmSync(store, { force: true, recursive: true });
        execFileSync("tar", ["-xf", archive, "-C", workspace], { stdio: "pipe" });

        const restoredPackageFile = path.join(
          workspace,
          "node_modules",
          "cache-proof-dep",
          "index.js",
        );
        expect(findSameFile(store, restoredPackageFile)).toBeDefined();
        expect(
          readFileSync(path.join(consumer, "node_modules", "cache-proof-dep", "index.js"), "utf8"),
        ).toBe('module.exports = "cache-proof-v1";\n');

        registryServer.kill("SIGTERM");
        rmSync(registry, { force: true, recursive: true });
        const reconciliation = execFileSync(
          "pnpm",
          [
            "install",
            "--offline",
            "--frozen-lockfile",
            `--store-dir=${store}`,
            "--package-import-method=hardlink",
            "--ignore-scripts",
            "--config.engine-strict=false",
          ],
          { cwd: workspace, encoding: "utf8", env: { ...process.env, CI: "true" } },
        );
        expect(reconciliation).toContain("Already up to date");
        expect(
          readFileSync(path.join(consumer, "node_modules", "cache-proof-dep", "index.js"), "utf8"),
        ).toBe('module.exports = "cache-proof-v1";\n');
      } finally {
        registryServer.kill("SIGTERM");
      }
    },
  );

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

    const releaseChecks = parse(
      readFileSync(".github/workflows/openclaw-live-and-e2e-checks-reusable.yml", "utf8"),
    );
    expect(releaseChecks.jobs.validate_repo_e2e.env).toMatchObject({
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
    });
    expect(releaseChecks.jobs.validate_repo_e2e["timeout-minutes"]).toBe(90);
    const repoE2eSteps = releaseChecks.jobs.validate_repo_e2e.steps as WorkflowStep[];
    const sandboxSetupIndex = repoE2eSteps.findIndex(
      (step) => step.name === "Build sandbox image" && step.run === "scripts/sandbox-setup.sh",
    );
    const repoE2eIndex = repoE2eSteps.findIndex((step) => step.name === "Run repo E2E suite");
    expect(sandboxSetupIndex).toBeGreaterThanOrEqual(0);
    expect(repoE2eIndex).toBeGreaterThan(sandboxSetupIndex);
    const targetedGroupStep = releaseChecks.jobs.plan_docker_lane_groups.steps.find(
      (step: WorkflowStep) => step.name === "Build targeted Docker lane groups",
    );
    expect(targetedGroupStep.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS).toBe(
      "${{ inputs.published_upgrade_survivor_scenarios }}",
    );
    expect(releaseChecks.jobs.validate_docker_lanes["timeout-minutes"]).toBe(
      "${{ matrix.group.timeout_minutes || 60 }}",
    );
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
        openclaw: { schemaVersions: { agent: 17, state: 6 } },
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

      writeFileSync(path.join(root, ".pnpmfile.mjs"), "export const hooks = {};\n");
      const mjsHookFingerprint = fingerprint();
      expect(mjsHookFingerprint).not.toBe(baseline);
      writeFileSync(
        path.join(root, ".pnpmfile.mjs"),
        "export const hooks = { readPackage: (pkg) => pkg };\n",
      );
      expect(fingerprint()).not.toBe(mjsHookFingerprint);
      rmSync(path.join(root, ".pnpmfile.mjs"));
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

      // Repository-owned package metadata does not affect pnpm's install tree
      // or any audited install hook, so schema churn must stay warm.
      writeManifest({
        name: "fixture",
        openclaw: { schemaVersions: { agent: 17, state: 7 } },
        scripts: {
          postinstall: "node scripts/postinstall-bundled-plugins.mjs",
          preinstall: "node scripts/preinstall-package-manager-warning.mjs",
          prepare: "node scripts/prepare-git-hooks.mjs",
          test: "vitest run",
        },
        devDependencies: { vitest: "1.0.0" },
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
    const hostedTestCacheInput =
      "${{ (vars.OPENCLAW_CI_RUNNER_BACKEND == 'github' || vars.OPENCLAW_CI_RUNNER_BACKEND == 'hybrid') && 'true' || 'false' }}";
    const hostedTestCacheJobs = [
      "checks-ui",
      "checks-ui-e2e",
      "sqlite-session-lifecycle",
      "checks-fast-plugin-contracts-shard",
      "checks-fast-channel-contracts-shard",
    ];
    const hostedFastCoreTestCacheInput =
      "${{ (vars.OPENCLAW_CI_RUNNER_BACKEND == 'github' || vars.OPENCLAW_CI_RUNNER_BACKEND == 'hybrid') && (matrix.task == 'bundled-protocol' || matrix.task == 'contracts-plugins-ci-routing' || matrix.task == 'ci-routing' || matrix.task == 'bun-launcher') && 'true' || 'false' }}";

    expect(setupNodeStep.with).toMatchObject({
      "node-compile-cache": "true",
      "node-compile-cache-scope": "test",
      "save-vitest-fs-cache":
        "${{ (vars.OPENCLAW_CI_RUNNER_BACKEND == 'github' || vars.OPENCLAW_CI_RUNNER_BACKEND == 'hybrid') && matrix.save_vitest_fs_cache && 'true' || 'false' }}",
      "vitest-fs-cache": "true",
    });
    expect(setupNodeStep.with).not.toHaveProperty("save-node-compile-cache");
    expect(setupNodeStep.with).not.toHaveProperty("runtime-cache-sticky-disk");
    expect(action.inputs).not.toHaveProperty("runtime-cache-sticky-disk");
    expect(action.inputs["vitest-fs-cache"].default).toBe("false");
    expect(action.inputs["restore-test-caches"].default).toBe("false");
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
    expect(writerStep.if).toContain("runner.os != 'Windows'");
    expect(writerStep.if).not.toMatch(/runner\.(?:environment|labels|name)/u);
    expect(writerStep.with.key).toContain("vitest-fs-v3-protected-");
    expect(writerStep.with.key).toContain("github.run_id");
    expect(writerStep.with.key).toContain("github.run_attempt");
    expect(writerStep.with.key).not.toContain("pull_request");
    expect(writerStep.with["restore-keys"]).toContain("**/tsconfig*.json");
    expect(writerStep.with.key).toContain("src/state/*.sql");
    expect(writerStep.with["restore-keys"]).toContain("src/state/*.sql");
    expect(writerStep.with.key).toContain("!**/node_modules/**");
    expect(writerStep.with["restore-keys"]).toContain("!**/node_modules/**");
    expect(readerStep.uses).toBe(CACHE_V5);
    expect(readerStep.if).toContain("inputs.restore-test-caches == 'true'");
    expect(readerStep.if).toContain("inputs.save-vitest-fs-cache != 'true'");
    expect(readerStep.if).toContain("runner.os != 'Windows'");
    expect(readerStep.if).not.toMatch(/runner\.(?:environment|labels|name)/u);
    expect(readerStep.with["restore-keys"]).toBe(writerStep.with["restore-keys"]);
    expect(readerStep.with.key).toContain("!**/node_modules/**");
    expect(readerStep.with.key).toContain("src/state/*.sql");
    expect(configureStep.env.CACHE_GENERATION).toContain("!**/node_modules/**");
    expect(configureStep.env.CACHE_GENERATION).toContain("src/state/*.sql");
    expect(configureStep.if).toContain("inputs.restore-test-caches == 'true'");
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
    expect(compileEpochStep.if).toContain("inputs.restore-test-caches == 'true'");
    expect(compileReaderStep.if).toContain("inputs.restore-test-caches == 'true'");
    expect(compileReaderStep.with["restore-keys"]).toBe(compileWriterStep.with["restore-keys"]);
    expect(compileConfigureStep.if).toContain("inputs.restore-test-caches == 'true'");
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

    for (const jobName of hostedTestCacheJobs) {
      const setup = workflow.jobs[jobName].steps.find(
        (step: WorkflowStep) => step.name === "Setup Node environment",
      );
      expect(setup.with["restore-test-caches"], jobName).toBe(hostedTestCacheInput);
      expect(
        evaluateWorkflowExpression(setup.with["restore-test-caches"], {
          eventName: "push",
          repository: "openclaw/openclaw",
          runnerBackend: "github",
          runAttempt: 1,
        }),
        jobName,
      ).toBe("true");
      expect(
        evaluateWorkflowExpression(setup.with["restore-test-caches"], {
          eventName: "push",
          repository: "openclaw/openclaw",
          runnerBackend: "blacksmith",
          runAttempt: 1,
        }),
        jobName,
      ).toBe("false");
      expect(setup.with, jobName).not.toHaveProperty("save-node-compile-cache");
      expect(setup.with, jobName).not.toHaveProperty("save-vitest-fs-cache");
    }
    const fastCoreSetup = workflow.jobs["checks-fast-core"].steps.find(
      (step: WorkflowStep) => step.name === "Setup Node environment",
    );
    expect(fastCoreSetup.with["restore-test-caches"]).toBe(hostedFastCoreTestCacheInput);
    for (const task of [
      "bundled-protocol",
      "contracts-plugins-ci-routing",
      "ci-routing",
      "bun-launcher",
    ]) {
      expect(
        evaluateWorkflowExpression(fastCoreSetup.with["restore-test-caches"], {
          eventName: "push",
          matrix: { task },
          repository: "openclaw/openclaw",
          runnerBackend: "github",
          runAttempt: 1,
        }),
        task,
      ).toBe("true");
    }
    for (const task of ["baseline-ratchets", "coercion-helpers"]) {
      expect(
        evaluateWorkflowExpression(fastCoreSetup.with["restore-test-caches"], {
          eventName: "push",
          matrix: { task },
          repository: "openclaw/openclaw",
          runnerBackend: "github",
          runAttempt: 1,
        }),
        task,
      ).toBe("false");
    }
    expect(
      evaluateWorkflowExpression(fastCoreSetup.with["restore-test-caches"], {
        eventName: "push",
        matrix: { task: "bundled-protocol" },
        repository: "openclaw/openclaw",
        runnerBackend: "blacksmith",
        runAttempt: 1,
      }),
    ).toBe("false");
    expect(fastCoreSetup.with).not.toHaveProperty("save-node-compile-cache");
    expect(fastCoreSetup.with).not.toHaveProperty("save-vitest-fs-cache");

    for (const jobName of ["checks-ui-e2e-real-gateway", "native-i18n", "control-ui-i18n"]) {
      const setup = workflow.jobs[jobName].steps.find(
        (step: WorkflowStep) => step.name === "Setup Node environment",
      );
      expect(setup.with, jobName).not.toHaveProperty("restore-test-caches");
    }
  });

  it("warms protected caches without main-run cancellation", () => {
    const warmerSource = readFileSync(".github/workflows/vitest-cache-warm.yml", "utf8");
    const warmer = parse(warmerSource);
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

    expect(warmer.concurrency["cancel-in-progress"]).toBe(false);
    expect(warmer.concurrency.group).toBe("vitest-cache-warm");
    // hosted-mode cache recovery needs a maintainer-operated fallback when the
    // scheduled seed is missing or stale.
    expect(warmer.on).toHaveProperty("workflow_dispatch");
    expect(warmer.on.repository_dispatch.types).toEqual(["vitest-cache-warm"]);
    expect(warmer.jobs.warm.if).toContain("github.repository == 'openclaw/openclaw'");
    expect(warmer.jobs.warm["runs-on"]).toBe(
      "${{ vars.OPENCLAW_CI_RUNNER_BACKEND == 'github' && 'ubuntu-24.04' || 'blacksmith-8vcpu-ubuntu-2404' }}",
    );
    expect(warmer.on).not.toHaveProperty("workflow_run");
    expect(checkoutStep.with).toBeUndefined();
    expect(warmerSource).toContain('cron: "17 8 * * *"');
    expect(seedStep.run).toContain(
      'import { createVitestCacheWarmGroups } from "./scripts/lib/ci-node-test-plan.mts";',
    );
    expect(seedStep.run).toMatch(
      /const groups = createVitestCacheWarmGroups\(\);[\s\S]*appendFileSync\(\s*process\.env\.GITHUB_ENV,[\s\S]*OPENCLAW_NODE_TEST_GROUPS_JSON=\$\{JSON\.stringify\(groups\)\}/u,
    );
    expect(warmerSource).not.toContain("OPENCLAW_NODE_TEST_CONFIGS_JSON");
    expect(warmerSource).toContain('"OPENCLAW_NODE_TEST_PLAN_CONCURRENCY=1"');
    expect(warmerSetup.with).toMatchObject({
      "node-compile-cache-scope": "test",
      "save-actions-cache": "true",
      "save-node-compile-cache": "true",
      "save-vitest-fs-cache": "true",
      "use-actions-cache": "true",
    });
    expect(warmerSetup.with).not.toHaveProperty("dependency-cache");
    // No close-time cleanup workflow is needed; Actions cache LRU/TTL expires
    // old hosted-writer and warmer generations.
    expect(existsSync(".github/workflows/pr-cache-cleanup.yml")).toBe(false);
    expect(seedStep.if).toBeUndefined();
    expect(warmStep.if).toBeUndefined();
    expect(maintainStoreStep).toBeUndefined();
  });

  it("uses bundled Node shards and telemetry-backed runner sizes", () => {
    const workflow = readCiWorkflow();
    const buildArtifactsTestbox = readBuildArtifactsTestboxWorkflow();
    const source = readFileSync(".github/workflows/ci.yml", "utf8");

    expect(source).toContain("createNodeTestShardBundles");
    expect(workflow.jobs["build-artifacts"]["runs-on"]).toContain("blacksmith-32vcpu-ubuntu-2404");
    expect(workflow.jobs["build-artifacts"]["timeout-minutes"]).toBe(
      "${{ (vars.OPENCLAW_CI_RUNNER_BACKEND == 'github' || (vars.OPENCLAW_CI_RUNNER_BACKEND == 'hybrid' && github.run_attempt > 1) || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository)) && 35 || 20 }}",
    );
    // PR events validate the artifact build on hosted runners (landing gate
    // stays satisfiable during Blacksmith outages); Testbox leases are
    // dispatch-only, mirroring ci-check-testbox.yml.
    expect(buildArtifactsTestbox.jobs["build-artifacts"]["runs-on"]).toBe(
      "${{ github.event_name == 'pull_request' && 'ubuntu-24.04' || 'blacksmith-16vcpu-ubuntu-2404' }}",
    );
    for (const stepName of ["Begin Testbox", "Run Testbox"]) {
      expect(
        buildArtifactsTestbox.jobs["build-artifacts"].steps.find(
          (step: { name?: string }) => step.name === stepName,
        ).if,
      ).toContain("github.event_name == 'workflow_dispatch'");
    }
    expect(
      buildArtifactsTestbox.jobs["build-artifacts"].steps.find(
        (step: { name?: string }) => step.name === "Build dist on cache miss",
      ).env.NODE_OPTIONS,
    ).toBe(
      "${{ github.event_name == 'pull_request' && '--max-old-space-size=8192' || '--max-old-space-size=16384' }}",
    );
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
      check_name: "check-export-name-collisions",
      group: "export-name-collisions",
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
    const boundaryCache = expectDefined(
      additionalJob.steps.find(
        (step: WorkflowStep) => step.name === "Cache extension package boundary artifacts",
      ),
      "extension package boundary cache",
    );
    const hostedLintCache = expectDefined(
      checkShardJob.steps.find(
        (step: WorkflowStep) =>
          step.name === "Cache extension package boundary artifacts for hosted lint",
      ),
      "hosted lint extension package boundary cache",
    );
    expect(boundaryMount.with.key).toBe("${{ github.repository }}-ext-boundary-v2");
    expect(lintMount.with.key).toBe(boundaryMount.with.key);
    for (const gate of [boundaryMount, lintMount]) {
      expect(gate.if).toContain("vars.OPENCLAW_CI_RUNNER_BACKEND != 'github'");
    }
    expect(hostedLintCache.if).toBe(
      "matrix.task == 'lint' && (vars.OPENCLAW_CI_RUNNER_BACKEND == 'github' || vars.OPENCLAW_CI_RUNNER_BACKEND == 'hybrid')",
    );
    expect(hostedLintCache.uses).toBe("actions/cache@27d5ce7f107fe9357f9df03efb73ab90386fccae");
    expect(hostedLintCache.with).toEqual(boundaryCache.with);
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
      expect(gate.if).toContain("vars.OPENCLAW_CI_RUNNER_BACKEND != 'github'");
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
    expect(androidSteps.find((step) => step.name === "Mount Gradle sticky disk")?.if).toContain(
      "vars.OPENCLAW_CI_RUNNER_BACKEND != 'github'",
    );
    expect(pointStep.if).toContain("vars.OPENCLAW_CI_RUNNER_BACKEND != 'github'");
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
      new Set(
        retiredDisks.map(
          (disk) => `${disk.key as string}:${disk.architecture as string}:${disk.region as string}`,
        ),
      ).size,
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
    const rejectedKey = runWorkflowShellScript(validateStep.run, {
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
    const paddedKey = runWorkflowShellScript(validateStep.run, {
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
        `${retiredDisk.key as string} is still an active sticky-disk key`,
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

  it("runs the export name collision ratchet as a visible additional check", () => {
    const workflow = readCiWorkflow();
    const additionalJob = workflow.jobs["check-additional-shard"];
    const matrixRows = additionalJob.strategy.matrix.include;
    expect(matrixRows).toContainEqual({
      check_name: "check-export-name-collisions",
      group: "export-name-collisions",
      runner: "blacksmith-4vcpu-ubuntu-2404",
    });

    const runStep = additionalJob.steps.find(
      (step: WorkflowStep) => step.name === "Run additional check shard",
    );
    expect(runStep.run).toContain("export-name-collisions)");
    expect(runStep.run).toContain(
      'run_check "lint:tmp:export-name-collisions" pnpm run lint:tmp:export-name-collisions',
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

  it("reports the Plugin SDK API diff as a visible additional check", () => {
    const workflow = readCiWorkflow();
    const additionalJob = workflow.jobs["check-additional-shard"];
    const matrixRows = additionalJob.strategy.matrix.include;
    expect(matrixRows).toContainEqual({
      check_name: "report-plugin-sdk-api-diff",
      group: "plugin-sdk-api-diff",
      runner: "blacksmith-8vcpu-ubuntu-2404",
    });

    expect(workflow.jobs.preflight.outputs.diff_head_revision).toBe(
      "${{ steps.diff_base.outputs.head_sha }}",
    );
    const ensureHeadStep = additionalJob.steps.find(
      (step: WorkflowStep) => step.name === "Ensure Plugin SDK API diff head commit",
    );
    expect(ensureHeadStep.with["base-sha"]).toBe(
      "${{ needs.preflight.outputs.diff_head_revision }}",
    );
    expect(ensureHeadStep.with["fetch-ref"]).toContain("refs/pull/{0}/merge");

    const runStep = additionalJob.steps.find(
      (step: WorkflowStep) => step.name === "Run additional check shard",
    );
    expect(runStep.run).toContain("plugin-sdk-api-diff)");
    expect(runStep.run).toContain('run_check "plugin-sdk:api:diff" pnpm run plugin-sdk:api:diff');
    expect(runStep.run).toContain('--base "${{ needs.preflight.outputs.diff_base_revision }}"');
    expect(runStep.run).toContain('--head "${{ needs.preflight.outputs.diff_head_revision }}"');
    expect(runStep.run).not.toContain('--head "${{ needs.preflight.outputs.checkout_revision }}"');
  });

  it("uses the current SDK diff and preserves the historical baseline check", () => {
    const workflow = readCiWorkflow();
    const runStep = workflow.jobs["check-additional-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run additional check shard",
    );
    const runCase = (
      scripts: Record<string, string>,
      compatibilityTarget: boolean,
      eventName = "workflow_dispatch",
    ) => {
      const root = tempDirs.make("openclaw-plugin-sdk-api-workflow-");
      const binDir = path.join(root, "bin");
      const callsPath = path.join(root, "pnpm-calls.txt");
      const summaryPath = path.join(root, "summary.md");
      mkdirSync(binDir);
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts }), "utf8");
      const pnpmPath = path.join(binDir, "pnpm");
      writeFileSync(
        pnpmPath,
        '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' "$*" >> "$PNPM_CALLS"\n',
        "utf8",
      );
      chmodSync(pnpmPath, 0o755);
      const script = runStep.run
        .replaceAll("${{ needs.preflight.outputs.diff_base_revision }}", "base-sha")
        .replaceAll("${{ needs.preflight.outputs.diff_head_revision }}", "synthetic-head-sha");
      const result = runWorkflowShellScript(script, {
        cwd: root,
        env: {
          ...process.env,
          ADDITIONAL_CHECK_GROUP: "plugin-sdk-api-diff",
          COMPATIBILITY_TARGET: compatibilityTarget ? "true" : "false",
          GITHUB_EVENT_NAME: eventName,
          GITHUB_STEP_SUMMARY: summaryPath,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          PNPM_CALLS: callsPath,
          RUN_PROMPT_SNAPSHOTS: "false",
        },
      });
      return {
        calls: existsSync(callsPath) ? readFileSync(callsPath, "utf8").trim().split("\n") : [],
        result,
        summaryPath,
      };
    };

    // Pure reporting: pushes and PRs skip the diff; dispatches (including
    // release validation) still produce it.
    const pushSkip = runCase({ "plugin-sdk:api:diff": "mock" }, false, "push");
    expect(pushSkip.result.status, pushSkip.result.stderr).toBe(0);
    expect(pushSkip.calls).toEqual([]);
    expect(pushSkip.result.stdout).toContain("manual and release dispatches only");

    const current = runCase({ "plugin-sdk:api:diff": "mock" }, false);
    expect(current.result.status, current.result.stderr).toBe(0);
    expect(current.calls).toEqual([
      "run plugin-sdk:api:diff -- --base base-sha --head synthetic-head-sha --json .artifacts/plugin-sdk-api-diff.json --summary " +
        current.summaryPath,
    ]);

    const historical = runCase({ "plugin-sdk:api:check": "mock" }, true);
    expect(historical.result.status, historical.result.stderr).toBe(0);
    expect(historical.calls).toEqual(["run plugin-sdk:api:check"]);

    const missingCurrent = runCase({ "plugin-sdk:api:check": "mock" }, false);
    expect(missingCurrent.result.status).toBe(1);
    expect(missingCurrent.calls).toEqual([]);
    expect(missingCurrent.result.stdout).toContain(
      "Current CI targets must provide plugin-sdk:api:diff.",
    );
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

  it("bounds mantis discord smoke validation git fetches", () => {
    const workflowPath = ".github/workflows/mantis-discord-smoke.yml";
    const source = readFileSync(workflowPath, "utf8");
    const gitFetchLines = source.split("\n").filter((line) => line.includes("git fetch"));

    expect(gitFetchLines, workflowPath).toHaveLength(2);
    expect(
      gitFetchLines.every((line) =>
        line.trimStart().startsWith("timeout --signal=TERM --kill-after=10s 120s git fetch"),
      ),
      workflowPath,
    ).toBe(true);
  });

  it("keeps shared Mantis reaction ownership stable", () => {
    const resolveWorkflowPath = ".github/workflows/mantis-resolve-request.yml";
    const cleanupWorkflowPath = ".github/workflows/mantis-clear-reaction.yml";
    const resolveSource = readFileSync(resolveWorkflowPath, "utf8");
    const cleanupSource = readFileSync(cleanupWorkflowPath, "utf8");
    const resolveWorkflow = parse(resolveSource);
    const cleanupWorkflow = parse(cleanupSource);
    const expectedWorkflowCallSecrets = {
      MANTIS_GITHUB_APP_ID: { required: true },
      MANTIS_GITHUB_APP_PRIVATE_KEY: { required: true },
    };
    const resolveJob = resolveWorkflow.jobs.resolve;
    const cleanupJob = cleanupWorkflow.jobs.clear;
    const resolveSteps = resolveJob.steps as WorkflowStep[];
    const cleanupSteps = cleanupJob.steps as WorkflowStep[];
    const findStep = (steps: WorkflowStep[], id: string, workflowPath: string) =>
      expectDefined(
        steps.find((step) => step.id === id),
        `${workflowPath} ${id}`,
      );
    const createTokenStep = findStep(resolveSteps, "mantis_reaction_token", resolveWorkflowPath);
    const createStep = findStep(resolveSteps, "add_reaction", resolveWorkflowPath);
    const cleanupTokenStep = findStep(cleanupSteps, "mantis_reaction_token", cleanupWorkflowPath);
    const deleteStep = expectDefined(
      cleanupSteps.find((step) => step.env?.REACTION_ID),
      `${cleanupWorkflowPath} reaction cleanup step`,
    );

    expect(resolveWorkflow.on.workflow_call.secrets, resolveWorkflowPath).toEqual(
      expectedWorkflowCallSecrets,
    );
    expect(cleanupWorkflow.on.workflow_call.secrets, cleanupWorkflowPath).toEqual(
      expectedWorkflowCallSecrets,
    );
    expect(resolveJob.outputs.reaction_id, resolveWorkflowPath).toBe(
      "${{ steps.add_reaction.outputs.reaction_id }}",
    );
    for (const [label, tokenStep] of [
      ["creation", createTokenStep],
      ["cleanup", cleanupTokenStep],
    ] as const) {
      expect(tokenStep, `${label} token`).toMatchObject({
        uses: CREATE_GITHUB_APP_TOKEN_V3,
        with: {
          "app-id": "${{ secrets.MANTIS_GITHUB_APP_ID }}",
          "private-key": "${{ secrets.MANTIS_GITHUB_APP_PRIVATE_KEY }}",
        },
      });
      expect(
        Object.entries(tokenStep.with ?? {}).filter(([key]) => key.startsWith("permission-")),
        `${label} permissions`,
      ).toEqual([["permission-issues", "write"]]);
    }
    expect(createStep, resolveWorkflowPath).toMatchObject({
      if: "${{ steps.resolve.outputs.request_source == 'issue_comment' && steps.mantis_reaction_token.outcome == 'success' }}",
      uses: "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
      with: { "github-token": "${{ steps.mantis_reaction_token.outputs.token }}" },
    });
    expect(createStep.with?.script, resolveWorkflowPath).toContain("createForIssueComment");
    expect(createStep.with?.script, resolveWorkflowPath).toContain(
      'core.setOutput("reaction_id", String(reaction.id))',
    );
    expect(resolveSource.match(/createForIssueComment/gu), resolveWorkflowPath).toHaveLength(1);
    expect(cleanupJob.permissions, cleanupWorkflowPath).toEqual({});
    expect(deleteStep, cleanupWorkflowPath).toMatchObject({
      env: {
        COMMENT_ID: "${{ inputs.comment-id }}",
        REACTION_ID: "${{ inputs.reaction-id }}",
      },
      uses: "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
      with: { "github-token": "${{ steps.mantis_reaction_token.outputs.token }}" },
    });
    expect(deleteStep.with?.script, cleanupWorkflowPath).toContain("deleteForIssueComment");
    expect(deleteStep.with?.script, cleanupWorkflowPath).toContain(
      "Number(process.env.REACTION_ID)",
    );
    expect(deleteStep.with?.script, cleanupWorkflowPath).toContain("reaction_id: reactionId");
    expect(JSON.stringify(cleanupJob), cleanupWorkflowPath).not.toMatch(
      /listForIssueComment|\.filter\(|github-actions\[bot\]/u,
    );
  });

  it.each(MANTIS_ISSUE_COMMENT_REACTION_WORKFLOWS)(
    "routes Mantis reaction ownership through shared workflows in %s",
    (workflowPath) => {
      const workflow = parse(readFileSync(workflowPath, "utf8"));
      const resolveJob = workflow.jobs.resolve_request;
      const cleanupJob = workflow.jobs.clear_issue_comment_reaction;
      const expectedSecrets = {
        MANTIS_GITHUB_APP_ID: "${{ secrets.MANTIS_GITHUB_APP_ID }}",
        MANTIS_GITHUB_APP_PRIVATE_KEY: "${{ secrets.MANTIS_GITHUB_APP_PRIVATE_KEY }}",
      };

      expect(resolveJob.uses, workflowPath).toBe("./.github/workflows/mantis-resolve-request.yml");
      expect(resolveJob.secrets, workflowPath).toEqual(expectedSecrets);
      expect(cleanupJob.uses, workflowPath).toBe("./.github/workflows/mantis-clear-reaction.yml");
      expect(cleanupJob.if, workflowPath).toContain(
        "needs.resolve_request.outputs.reaction_id != ''",
      );
      expect(cleanupJob.permissions, workflowPath).toEqual({});
      expect(cleanupJob.with, workflowPath).toMatchObject({
        "comment-id": "${{ format('{0}', github.event.comment.id) }}",
        "reaction-id": "${{ needs.resolve_request.outputs.reaction_id }}",
      });
      expect(cleanupJob.secrets, workflowPath).toEqual(expectedSecrets);
    },
  );

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

  it("bounds specialized early checkout fetches", () => {
    const workflow = readCiWorkflow();

    for (const jobName of ["preflight", "skills-python"]) {
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
      expect(checkoutStep.run, jobName).toContain(
        "fetch --no-tags --prune --no-recurse-submodules --depth=1 origin",
      );
      if (jobName === "preflight") {
        expect(checkoutStep.run, jobName).toContain("--filter=blob:none");
        expect(checkoutStep.run, jobName).toContain("fetch_parent_metadata");
      }
      if (jobName === "preflight") {
        expect(checkoutStep.run, jobName).toContain('if [ "$fetch_status" = "124" ]');
        expect(checkoutStep.run, jobName).toContain("timed out");
      }
      expect(checkoutStep.run, jobName).not.toContain(
        'git -C "$GITHUB_WORKSPACE" fetch --no-tags --depth=1',
      );
    }
  });

  it("uses the maintained authenticated checkout for security-fast", () => {
    const workflow = readCiWorkflow();
    const checkoutStep = workflow.jobs["security-fast"].steps.find(
      (step: WorkflowStep) => step.name === "Checkout",
    );
    const manualCheckoutStep = workflow.jobs["security-fast"].steps.find(
      (step: WorkflowStep) => step.name === "Checkout manual target",
    );

    expect(checkoutStep.uses).toBe(CHECKOUT_V6);
    expect(checkoutStep.if).toBe(
      "github.event_name != 'workflow_dispatch' || inputs.target_ref == ''",
    );
    expect(checkoutStep.with).toEqual({ "fetch-depth": 2, "persist-credentials": false });
    expect(manualCheckoutStep.if).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.target_ref != ''",
    );
    expect(manualCheckoutStep.run).toContain("workflow_dispatch target_ref");
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

  it("uses the maintained checkout across workflow sanity jobs", () => {
    const workflow = readWorkflowSanityWorkflow();

    for (const jobName of ["no-tabs", "actionlint", "generated-doc-baselines"]) {
      const checkoutStep = workflow.jobs[jobName].steps.find(
        (step: WorkflowStep) => step.name === "Checkout",
      );

      expect(checkoutStep.uses, jobName).toBe(CHECKOUT_V6);
      expect(checkoutStep.with, jobName).toEqual({
        "fetch-depth": 1,
        "persist-credentials": false,
      });
    }
  });

  it("prepares Testbox checkouts with one maintained owner and scoped history", () => {
    const workflowPaths = [
      [
        ".github/workflows/ci-check-testbox.yml",
        "1",
        "${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || 'HEAD' }}",
      ],
      [
        ".github/workflows/ci-check-arm-testbox.yml",
        "0",
        "${{ github.event.pull_request.base.sha || 'refs/remotes/origin/main' }}",
      ],
      [
        ".github/workflows/ci-build-artifacts-testbox.yml",
        "0",
        "${{ github.event.pull_request.base.sha || 'refs/remotes/origin/main' }}",
      ],
    ] as const;

    for (const [workflowPath, dispatchFetchDepth, baseRef] of workflowPaths) {
      const workflow = parse(readFileSync(workflowPath, "utf8"));
      const job = Object.values(workflow.jobs)[0] as { steps: WorkflowStep[] };
      const checkoutStep = job.steps.find((step) => step.name === "Checkout");
      const prepareStep = job.steps.find((step) => step.name === "Prepare Testbox shell");

      expect(checkoutStep?.uses, workflowPath).toBe(CHECKOUT_V6);
      expect(checkoutStep?.with?.["persist-credentials"], workflowPath).toBe(false);
      for (const [eventName, expectedDepth] of [
        ["pull_request", "2"],
        ["workflow_dispatch", dispatchFetchDepth],
      ] as const) {
        expect(
          evaluateWorkflowExpression(checkoutStep?.with?.["fetch-depth"], {
            eventName,
            repository: "openclaw/openclaw",
            runAttempt: 1,
          }),
          `${workflowPath} ${eventName}`,
        ).toBe(expectedDepth);
      }
      expect(prepareStep?.uses, workflowPath).toBe("./.github/actions/prepare-testbox-shell");
      expect(prepareStep?.with?.["base-ref"], workflowPath).toBe(baseRef);
      const ensureBaseStep = job.steps.find(
        (step: WorkflowStep) => step.name === "Ensure Testbox base commit",
      );
      expect(ensureBaseStep?.if, workflowPath).toBe("github.event_name == 'pull_request'");
      expect(ensureBaseStep?.uses, workflowPath).toBe("./.github/actions/ensure-base-commit");
      expect(ensureBaseStep?.with, workflowPath).toEqual({
        "base-sha": "${{ github.event.pull_request.base.sha }}",
        "fetch-ref": "${{ github.event.pull_request.base.ref }}",
      });
      expect(JSON.stringify(job.steps), workflowPath).not.toContain(
        "+refs/heads/main:refs/remotes/origin/main",
      );
    }

    const action = parse(readFileSync(".github/actions/prepare-testbox-shell/action.yml", "utf8"));
    const run = action.runs.steps[0].run as string;
    expect(run).toContain('base_ref="${TESTBOX_BASE_REF:-HEAD}"');
    expect(run).toContain('git rev-parse --verify "${base_ref}^{commit}"');
    expect(run).toContain('git update-ref refs/remotes/origin/main "$base_sha"');
    expect(run).not.toContain("git fetch");
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

  it("runs committed generated baseline drift checks in workflow sanity", () => {
    const workflow = readWorkflowSanityWorkflow();
    const steps = workflow.jobs["generated-doc-baselines"].steps;
    const stepNames = steps.map((step: WorkflowStep) => step.name);

    expect(stepNames).toContain("Check SQLite sessions/transcripts schema baseline drift");
    expect(stepNames).toContain("Check plugin SDK surface budget");
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

    const macosNodeSetup = workflow.jobs["macos-node"].steps.find(
      (step: WorkflowStep) => step.name === "Setup Node environment",
    );
    expect(macosNodeSetup.with).toMatchObject({
      "install-bun": "false",
      "save-actions-cache": "true",
    });
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

  it("serializes macOS Swift tests only on hosted dispatches and retries", () => {
    const workflow = readCiWorkflow();
    const macosSwift = workflow.jobs["macos-swift"];
    const testStep = macosSwift.steps.find((step: WorkflowStep) => step.name === "Swift test");

    expect(macosSwift.env.SWIFT_TEST_EXECUTION).toBe(
      "${{ (github.event_name == 'workflow_dispatch' || github.run_attempt > 1) && 'serial' || 'parallel' }}",
    );
    expect(testStep.run).toContain(
      "swift_test_args=(--package-path apps/macos --enable-code-coverage)",
    );
    expect(testStep.run).toContain('attempt_args=("${swift_test_args[@]}")');
    expect(testStep.run).toContain(
      'if [[ "$SWIFT_TEST_EXECUTION" == "parallel" && "$attempt" -eq 1 ]]',
    );
    expect(testStep.run).toContain("attempt_args+=(--parallel)");
    expect(testStep.run).toContain("else\n    attempt_args+=(--no-parallel)");
    expect(testStep.run).toContain('swift test "${attempt_args[@]}"');
    expect(testStep.run).not.toContain(
      "swift test --package-path apps/macos --parallel --enable-code-coverage",
    );
    expect(testStep.run).toContain("for attempt in 1 2 3");
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
      workflow.indexOf("npm-lock)"),
    );
    const npmLockGuards = workflow.slice(
      workflow.indexOf("npm-lock)"),
      workflow.indexOf("prod-types)"),
    );

    expect(workflow).toContain("check-guards");
    expect(workflow).toContain("check-npm-lock");
    expect(preflightGuards).toContain('has_package_script "check:doctor-deprecation-registry"');
    expect(preflightGuards).toContain("pnpm check:doctor-deprecation-registry");
    expect(preflightGuards).toContain(
      "[skip] frozen target predates the wall-clock doctor deprecation registry guard",
    );
    expect(preflightGuards).toContain(
      "Current CI targets must provide the check:doctor-deprecation-registry package script.",
    );
    expect(preflightGuards.indexOf('elif [[ "$FROZEN_TARGET" == "true" ]]')).toBeGreaterThan(
      preflightGuards.indexOf("pnpm check:doctor-deprecation-registry"),
    );
    const checkShard = parsedWorkflow.jobs["check-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run check shard",
    );
    expect(checkShard.env.FROZEN_TARGET).toBe("${{ needs.preflight.outputs.frozen_target }}");
    expect(parsedWorkflow.jobs.preflight.outputs.frozen_target).toBe(
      "${{ steps.manifest.outputs.frozen_target }}",
    );
    expect(preflightGuards).toContain(
      'if [[ "$FROZEN_TARGET" == "true" ]]; then\n' +
        "                pnpm dup:check:coverage\n" +
        "              else\n" +
        "                pnpm dup:check\n" +
        "              fi",
    );
    expect(npmLockGuards).toContain("pnpm deps:npm-lock:check");
    expect(preflightGuards).toContain("pnpm deps:patches:check");
    expect(preflightGuards).toContain('has_package_script "check:coercion-helpers"');
    expect(preflightGuards).toContain("pnpm check:coercion-helpers");
    expect(preflightGuards).toContain(
      "[skip] historical target predates the coercion-helper declaration guard",
    );
    expect(preflightGuards).toContain(
      "Current CI targets must provide the check:coercion-helpers package script.",
    );
    expect(parsedWorkflow.jobs.preflight.outputs.diff_base_revision).toBe(
      "${{ steps.diff_base.outputs.sha }}",
    );
    const diffBaseStep = parsedWorkflow.jobs.preflight.steps.find(
      (step: WorkflowStep) => step.name === "Resolve exact diff base",
    );
    expect(diffBaseStep.run).toContain("--prefer-first-parent");
    expect(diffBaseStep.env.DEFAULT_BRANCH).toBe("${{ github.event.repository.default_branch }}");
    expect(diffBaseStep.env.GH_TOKEN).toBe(
      "${{ github.event_name == 'workflow_dispatch' && !inputs.release_gate && github.token || '' }}",
    );
    expect(diffBaseStep.run).toContain(
      '"repos/${GITHUB_REPOSITORY}/compare/${default_sha}...${head_sha}"',
    );
    expect(diffBaseStep.run).toContain("Could not resolve an exact diff base");
    expect(diffBaseStep.run).toContain(AMBIGUOUS_MAIN_PUSH_GUARD);
    const securityDiffBase = parsedWorkflow.jobs["security-fast"].steps.find(
      (step: WorkflowStep) => step.name === "Resolve security diff base",
    ).run;
    expect(securityDiffBase).toContain("git rev-list --parents -n 1 HEAD");
    expect(securityDiffBase).not.toContain("node scripts/lib/merge-head-diff-base.mjs");
    expect(securityDiffBase).toContain(AMBIGUOUS_MAIN_PUSH_GUARD);
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

  it("rejects ambiguous zero-before main pushes and preserves concrete bases", () => {
    const zeroSha = "0".repeat(40);
    const threeCommit = runPushDiffBaseFixture({ commitCount: 3, eventBaseSha: zeroSha });
    expect(threeCommit.status, threeCommit.output).toBe(1);
    expect(threeCommit.output).toContain(AMBIGUOUS_MAIN_PUSH_DIAGNOSTIC);
    expect(threeCommit.outputs).not.toHaveProperty("sha");
    expect(threeCommit.emittedBaseIsCommit).toBe(false);

    const rootCommit = runPushDiffBaseFixture({ commitCount: 1, eventBaseSha: zeroSha });
    expect(rootCommit.status, rootCommit.output).toBe(1);
    expect(rootCommit.output).toContain(AMBIGUOUS_MAIN_PUSH_DIAGNOSTIC);
    expect(rootCommit.outputs).not.toHaveProperty("sha");
    expect(rootCommit.emittedBaseIsCommit).toBe(false);

    const concreteBase = runPushDiffBaseFixture({
      commitCount: 3,
      eventBaseSha: "parent",
    });
    expect(concreteBase.status, concreteBase.output).toBe(0);
    expect(concreteBase.outputs.sha).toBe(concreteBase.eventBaseSha);
    expect(concreteBase.emittedBaseIsCommit).toBe(true);
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
      releaseToolingEntry: true,
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

    // Push/PR preflight is dependency-free and runs the .mts natively;
    // dispatches (frozen targets) keep the tsx shim path.
    expect(coverageStep.run).toContain("node scripts/check-protocol-event-coverage.mts");
    expect(coverageStep.run).toContain("node scripts/check-protocol-event-coverage.mjs");
    expect(coverageStep.if).toBe("steps.manifest.outputs.run_protocol_event_coverage == 'true'");
    expect(checkShardRun).not.toContain("check:protocol-coverage");
  });

  it("keeps type-aware oxlint within hosted fork-runner resources", () => {
    const workflow = readCiWorkflow();
    const manifestStep = workflow.jobs.preflight.steps.find(
      (step: WorkflowStep) => step.name === "Build CI manifest",
    );
    const checkShardRun = workflow.jobs["check-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run check shard",
    ).run;
    const hostedCoreLint = workflow.jobs["check-lint-hosted-core-shard"];

    expect(manifestStep.env.OPENCLAW_CI_RUNNER_BACKEND).toBe(
      "${{ vars.OPENCLAW_CI_RUNNER_BACKEND }}",
    );
    expect(manifestStep.run).toContain("runnerBackend: process.env.OPENCLAW_CI_RUNNER_BACKEND");
    expect(checkShardRun).toContain('if [ "$RUNNER_BACKEND" = "github" ]; then');
    expect(checkShardRun).toContain("lint_args=(--only=extensions --only=scripts --threads=1)");
    expect(checkShardRun).toContain('elif [ "$(nproc)" -lt 8 ]; then');
    expect(checkShardRun).toContain("lint_args=(--threads=1)");
    expect(checkShardRun).not.toContain("lint_args=(--split-core --threads=1)");
    expect(checkShardRun.match(/export GOMAXPROCS=2/gu)).toHaveLength(2);
    expect(checkShardRun).toContain('pnpm lint "${lint_args[@]}"');
    expect(checkShardRun).toContain(
      'node --import tsx scripts/run-oxlint-shards.mts "${lint_args[@]}"',
    );
    expect(hostedCoreLint.if).toContain("vars.OPENCLAW_CI_RUNNER_BACKEND == 'github'");
    expect(hostedCoreLint["runs-on"]).toBe("ubuntu-24.04");
    expect(hostedCoreLint.strategy).toEqual({
      "fail-fast": false,
      "max-parallel": 5,
      matrix: { stripe: [1, 2, 3, 4, 5] },
    });
    expect(
      hostedCoreLint.steps.find((step: WorkflowStep) => step.name === "Run hosted core lint stripe")
        .env.GOMAXPROCS,
    ).toBe("2");
    expect(
      hostedCoreLint.steps.find((step: WorkflowStep) => step.name === "Run hosted core lint stripe")
        .run,
    ).toContain("--only=core --split-core --core-stripe=${{ matrix.stripe }}/5 --threads=1");
  });

  it("runs both baseline ratchets against the exact tested tree", () => {
    const workflow = readCiWorkflow();
    const checksFastJob = workflow.jobs["checks-fast-core"];
    const checksFastSteps = checksFastJob.steps;
    const checkout = checksFastSteps.find((step: WorkflowStep) => step.name === "Checkout");
    const checksFastRun = checksFastSteps.find(
      (step: WorkflowStep) => step.name === "Run ${{ matrix.task }} (${{ matrix.runtime }})",
    );
    const releaseGateMerge = checksFastSteps.find(
      (step: WorkflowStep) => step.name === "Prepare release-gate ratchet merge tree",
    );
    expect(
      checksFastSteps.some((step: WorkflowStep) => step.name === "Resolve manual protocol base"),
    ).toBe(false);

    expect(workflow.jobs["checks-fast-core"].permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
    });
    expect(checksFastJob.env.CHECKOUT_BASE_SHA).toBe(
      "${{ matrix.task == 'baseline-ratchets' && needs.preflight.outputs.diff_base_revision || '' }}",
    );
    expect(checkout.run).toContain(
      'fetch_refs+=("+${CHECKOUT_BASE_SHA}:refs/remotes/origin/ci-ratchet-base")',
    );
    expect(checkout.run).toContain('"${fetch_refs[@]}" || return 1');
    expect(releaseGateMerge.if).toBe(
      "matrix.task == 'baseline-ratchets' && github.event_name == 'workflow_dispatch' && inputs.release_gate",
    );
    expect(checksFastRun.run).toContain("baseline-ratchets)");
    expect(checksFastRun.run).toContain("coercion-helpers)");
    expect(checksFastRun.run).toContain("pnpm check:coercion-helpers");
    expect(checksFastRun.run).toContain("bun-launcher)");
    expect(checksFastRun.run).toContain(
      "OPENCLAW_E2E_SKIP_BUILD=1 OPENCLAW_TEST_BUN_LAUNCHER=1 pnpm test test/openclaw-launcher.e2e.test.ts",
    );
    expect(checksFastRun.run).toContain(
      "for required_script in check:max-lines-ratchet check:assertion-safety; do",
    );
    expect(checksFastRun.run).toContain('has_package_script "$required_script"');
    expect(checksFastRun.env.RATCHET_PR_HEAD_SHA).toBe(
      "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || '' }}",
    );
    expect(checksFastRun.env).not.toHaveProperty("RATCHET_EVENT_BASE_SHA");
    expect(checksFastRun.env).not.toHaveProperty("RATCHET_MANUAL_TARGET_SHA");
    expect(checksFastRun.env).not.toHaveProperty("GH_TOKEN");
    expect(checksFastRun.env).not.toHaveProperty("PROTOCOL_MANUAL_BASE_SHA");
    expect(checksFastRun.env.PROTOCOL_SINCE_BASE_SHA).toBe(
      "${{ needs.preflight.outputs.diff_base_revision }}",
    );
    expect(releaseGateMerge.run).toContain(
      'gh api --method GET "repos/${GITHUB_REPOSITORY}/pulls/${PULL_REQUEST_NUMBER}"',
    );
    expect(releaseGateMerge.run).toContain(
      "release-gate pull request must be open and match the target head",
    );
    expect(releaseGateMerge.run).toContain("for attempt in {1..6}");
    expect(releaseGateMerge.run).toContain(
      '"+refs/pull/${PULL_REQUEST_NUMBER}/merge:refs/remotes/origin/ci-ratchet-merge"',
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
      'echo "RATCHET_BASE_REF=${frozen_base_sha}" >> "$GITHUB_ENV"',
    );
    expect(releaseGateMerge.run).toContain(
      'echo "RATCHET_RELEASE_MERGE_TREE=true" >> "$GITHUB_ENV"',
    );
    expect(checksFastRun.run).not.toContain("PROTOCOL_MANUAL_BASE_SHA");
    expect(checksFastRun.run).toContain(
      '"+${PROTOCOL_SINCE_BASE_SHA}:refs/remotes/origin/protocol-since-base"',
    );
    expect(checksFastRun.run).toContain(
      'base_ref="${RATCHET_BASE_REF:-refs/remotes/origin/ci-ratchet-base}"',
    );
    expect(checksFastRun.run).toContain('git cat-file -e "${base_ref}^{commit}"');
    expect(checksFastRun.run).toContain(
      "mapfile -t merge_parents < <(git cat-file -p HEAD | sed -n 's/^parent //p')",
    );
    expect(checksFastRun.run).toContain('"${#merge_parents[@]}" != "2"');
    expect(checksFastRun.run).toContain('"${merge_parents[1]:-}" != "$RATCHET_PR_HEAD_SHA"');
    expect(checksFastRun.run).toContain('prepared_base="$(git rev-parse "$base_ref")"');
    expect(checksFastRun.run).toContain('"${merge_parents[0]}" != "$prepared_base"');
    expect(checksFastRun.run).not.toContain("ci-ratchet-target^");
    expect(checksFastRun.run).not.toContain("resolve_manual_merge_base");
    expect(checksFastRun.run).not.toContain("+${merge_base}:refs/remotes/origin/ci-ratchet-base");
    expect(checksFastRun.run).toContain('pnpm check:max-lines-ratchet --base "$base_ref"');
    expect(checksFastRun.run).toContain('pnpm check:assertion-safety --base "$base_ref"');
    expect(checksFastRun.run).toContain(
      'if [[ "${RATCHET_RELEASE_MERGE_TREE:-}" == "true" ]]; then',
    );
    expect(checksFastRun.run).toContain(
      "node --import tsx scripts/run-oxlint-shards.mts --only=core --only=extensions --threads=1",
    );
    expect(checksFastRun.run).not.toContain(
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
        check_name: "checks-fast-baseline-ratchets",
        runtime: "node",
        task: "baseline-ratchets",
      },
      {
        check_name: "checks-fast-coercion-helpers",
        runtime: "node",
        task: "coercion-helpers",
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
    expect(legacy.outputs.use_compatible_android_ci).toBe("true");
    expect(legacy.outputs.run_ios_build).toBe("false");
    expect(legacy.outputs.run_native_i18n).toBe("false");
    expect(legacy.outputs.run_openclawkit_tests).toBe("false");
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
    expect(current.outputs.use_compatible_android_ci).toBe("false");
    expect(current.outputs.run_ios_build).toBe("true");
    expect(current.outputs.run_native_i18n).toBe("true");
    expect(current.outputs.run_openclawkit_tests).toBe("true");
    expect(current.outputs.run_qa_smoke_ci).toBe("true");
    expect(current.outputs.run_sqlite_session_lifecycle).toBe("true");
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
        env: {
          OPENCLAW_CI_TEST_COMPACT_MODE: "full",
          OPENCLAW_CI_TEST_RUNNER_BACKEND: "",
        },
        shard_name: "bundled-node-plan",
      }),
    );

    for (const runnerBackend of [undefined, "github", "hybrid"] as const) {
      const push = runCiManifestFixture({
        bundledPlanner: true,
        eventName: "push",
        runnerBackend,
      });
      expect(push.status, push.output).toBe(0);
      expect(
        JSON.parse(
          expectDefined(
            push.outputs.checks_node_core_nondist_matrix,
            `${runnerBackend ?? "default"} push node core nondist matrix output`,
          ),
        ).include,
      ).toContainEqual(
        expect.objectContaining({
          check_name: "bundled-node-plan",
          env: {
            OPENCLAW_CI_TEST_COMPACT_MODE: "push",
            OPENCLAW_CI_TEST_RUNNER_BACKEND: runnerBackend ?? "",
          },
        }),
      );
    }

    const changedPullRequest = runCiManifestFixture({
      bundledPlanner: true,
      changedPaths: ["src/focused.ts", "extensions/codex/src/focused.ts"],
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
    expect(
      JSON.parse(
        expectDefined(
          changedPullRequest.outputs.checks_node_core_nondist_matrix,
          "changed PR node matrix output",
        ),
      ).include,
    ).not.toContainEqual(
      expect.objectContaining({ check_name: "changed-extension-fallback-plan" }),
    );
    expect(changedPullRequest.outputs.run_checks_node_core_dist).toBe("true");
    expect(changedPullRequest.outputs.run_sqlite_session_lifecycle).toBe("false");

    const mixedFallbackPullRequest = runCiManifestFixture({
      bundledPlanner: true,
      changedPaths: [
        "packages/gateway-protocol/src/frame-guards.ts",
        "extensions/codex/src/focused.ts",
      ],
      eventName: "pull_request",
    });
    expect(mixedFallbackPullRequest.status, mixedFallbackPullRequest.output).toBe(0);
    expect(
      JSON.parse(
        expectDefined(
          mixedFallbackPullRequest.outputs.checks_node_core_nondist_matrix,
          "mixed fallback PR node matrix output",
        ),
      ).include,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check_name: "bundled-node-plan",
          env: {
            OPENCLAW_CI_TEST_COMPACT_MODE: "pull-request",
            OPENCLAW_CI_TEST_RUNNER_BACKEND: "",
          },
        }),
        expect.objectContaining({ check_name: "changed-extension-fallback-plan" }),
      ]),
    );

    const matrixFallbackPullRequest = runCiManifestFixture({
      bundledPlanner: true,
      changedPaths: [
        "packages/gateway-protocol/src/frame-guards.ts",
        "extensions/matrix/src/channel.ts",
      ],
      eventName: "pull_request",
    });
    expect(matrixFallbackPullRequest.status, matrixFallbackPullRequest.output).toBe(0);
    expect(
      JSON.parse(
        expectDefined(
          matrixFallbackPullRequest.outputs.checks_node_core_nondist_matrix,
          "Matrix fallback PR node matrix output",
        ),
      ).include,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check_name: "changed-extension-fallback-plan",
          configs: ["test/vitest/vitest.extension-matrix.config.ts"],
          includePatterns: [
            "extensions/matrix/src/client.test.ts",
            "extensions/matrix/src/monitor.test.ts",
          ],
        }),
      ]),
    );

    const sqliteLifecycleTestPullRequest = runCiManifestFixture({
      bundledPlanner: true,
      changedPaths: ["test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts"],
      eventName: "pull_request",
    });
    expect(sqliteLifecycleTestPullRequest.status, sqliteLifecycleTestPullRequest.output).toBe(0);
    expect(sqliteLifecycleTestPullRequest.outputs.run_sqlite_session_lifecycle).toBe("true");
    expect(sqliteLifecycleTestPullRequest.outputs.run_build_artifacts).toBe("true");

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
    expect(frozenMissingCurrentCapabilities.outputs.frozen_target).toBe("true");
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
    expect(releaseCandidateMissingSwiftWrappers.outputs.use_compatible_android_ci).toBe("false");
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

    const frozenTargetContext = runCiManifestFixture({
      bundledPlanner: false,
      historicalCompatibility: false,
      targetContextCompatibility: true,
    });
    expect(frozenTargetContext.status, frozenTargetContext.output).toBe(0);
    expect(frozenTargetContext.outputs.compatibility_target).toBe("true");
    expect(
      JSON.parse(
        expectDefined(
          frozenTargetContext.outputs.checks_node_core_nondist_matrix,
          "frozen target context node core nondist matrix output",
        ),
      ).include,
    ).toContainEqual(expect.objectContaining({ check_name: "legacy-node-plan" }));

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
    const openClawKitTests = workflow.jobs["macos-swift"].steps.find(
      (step: { name?: string }) => step.name === "OpenClawKit tests",
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
    expect(openClawKitTests.if).toBe("needs.preflight.outputs.run_openclawkit_tests == 'true'");

    const checkShard = workflow.jobs["check-shard"].steps.find(
      (step: { name?: string }) => step.name === "Run check shard",
    );
    expect(checkShard.env.HISTORICAL_TARGET).toBe(
      "${{ needs.preflight.outputs.compatibility_target }}",
    );
    expect(checkShard.run).toContain("pnpm tsgo:scripts");
    expect(checkShard.run).toContain('elif [[ "$HISTORICAL_TARGET" != "true" ]]');
    expect(checkShard.run).toContain('has_package_script "deps:npm-lock:check"');
    expect(checkShard.run).toContain(
      "Current CI targets must provide the deps:npm-lock:check package script.",
    );
    expect(checkShard.run).toContain(
      "[skip] historical target predates the transient npm lock contract",
    );
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
    const uiBrowserCache = workflow.jobs["checks-ui"].steps.find(
      (step: { name?: string }) => step.name === "Cache Playwright Chromium",
    );
    const uiTest = workflow.jobs["checks-ui"].steps.find(
      (step: { name?: string }) => step.name === "Test Control UI",
    );
    expect(workflow.jobs["checks-ui"].env.COMPATIBILITY_TARGET).toBe(
      "${{ needs.preflight.outputs.compatibility_target }}",
    );
    expect(uiInstall.env.FROZEN_TARGET).toBe("${{ needs.preflight.outputs.frozen_target }}");
    expect(uiInstall.run).toContain('if [[ "${COMPATIBILITY_TARGET:-false}" == "true" ]]');
    expect(uiInstall.run).toContain("pnpm --dir ui exec playwright install chromium");
    expect(uiInstall.run).toContain("node --import tsx scripts/ensure-playwright-chromium.mts");
    expect(uiInstall.run).toContain(
      'elif [[ "$FROZEN_TARGET" == "true" && -f scripts/ensure-playwright-chromium.mjs ]]',
    );
    expect(uiInstall.run).toContain("node scripts/ensure-playwright-chromium.mjs");
    expect(uiInstall.run).toContain(
      "Target does not provide a supported Playwright Chromium installer.",
    );
    expect(uiInstall.run).not.toContain("OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM");
    const playwrightVersion = JSON.parse(readFileSync("package.json", "utf8")).devDependencies
      .playwright;
    expect(playwrightVersion).toBe(
      JSON.parse(readFileSync("ui/package.json", "utf8")).devDependencies.playwright,
    );
    expect(uiBrowserCache).toMatchObject({
      if: "needs.preflight.outputs.compatibility_target != 'true'",
      uses: "actions/cache@27d5ce7f107fe9357f9df03efb73ab90386fccae",
      with: {
        key: "${{ runner.os }}-playwright-chromium-" + playwrightVersion,
        path: "~/.cache/ms-playwright",
      },
    });
    expect(uiTest.run).toContain('if [[ "$COMPATIBILITY_TARGET" == "true" ]]');
    expect(uiTest.run).toContain("pnpm --dir ui test --testTimeout=30000 --isolate");
    expect(uiTest.run).not.toContain("--retry");
    expect(uiTest.run).toContain("pnpm --dir ui test");
  });

  it("gates current Control UI changes on ordinary and real-Gateway Chromium E2E", () => {
    const workflow = readCiWorkflow();
    const ui = workflow.jobs["checks-ui"];
    const uiE2e = workflow.jobs["checks-ui-e2e"];
    const uiE2eRealGateway = workflow.jobs["checks-ui-e2e-real-gateway"];

    expect(uiE2e.permissions).toEqual({ contents: "read" });
    expect(uiE2e.needs).toEqual(["preflight"]);
    expect(uiE2e.if).toBe(
      "needs.preflight.outputs.run_ui_tests == 'true' && needs.preflight.outputs.compatibility_target != 'true'",
    );
    expect(uiE2e["runs-on"]).not.toBe(ui["runs-on"]);
    expect(uiE2e["timeout-minutes"]).toBe(25);
    expect(uiE2e.env).toEqual({ OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY: "1" });
    expect(uiE2e.strategy["fail-fast"]).toBe(false);
    expect(uiE2e.strategy["max-parallel"]).toBe(
      "${{ (vars.OPENCLAW_CI_RUNNER_BACKEND == 'github' || vars.OPENCLAW_CI_RUNNER_BACKEND == 'hybrid') && 12 || 4 }}",
    );
    expect(uiE2e.strategy.matrix).toBe("${{ fromJson(needs.preflight.outputs.ui_e2e_matrix) }}");
    const expectedUiE2eMatrix = (shardCount: number) => ({
      include: Array.from({ length: shardCount }, (_, index) => {
        const shard = index + 1;
        return {
          shard,
          shard_count: shardCount,
          task: shard === shardCount ? "browser-extension" : "control-ui",
          vitest_shard_count: shardCount - 1,
        };
      }),
    });
    for (const [runnerBackend, shardCount] of [
      ["blacksmith", 4],
      ["github", 12],
      ["hybrid", 12],
    ] as const) {
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        eventName: "push",
        historicalCompatibility: false,
        runnerBackend,
      });
      expect(manifest.status, manifest.output).toBe(0);
      expect(
        JSON.parse(expectDefined(manifest.outputs.ui_e2e_matrix, `${runnerBackend} UI E2E matrix`)),
      ).toEqual(expectedUiE2eMatrix(shardCount));
      expect(
        evaluateWorkflowExpression(uiE2e.strategy["max-parallel"], {
          eventName: "push",
          repository: "openclaw/openclaw",
          runnerBackend,
          runAttempt: 1,
        }),
      ).toBe(shardCount);
    }
    expect(workflow.jobs["ci-gate"].needs).toContain("checks-ui-e2e");
    expect(workflow.jobs["ci-gate"].needs).toContain("checks-ui-e2e-real-gateway");

    expect(uiE2eRealGateway.permissions).toEqual(uiE2e.permissions);
    expect(uiE2eRealGateway.needs).toEqual(uiE2e.needs);
    expect(uiE2eRealGateway.if).toBe(uiE2e.if);
    expect(uiE2eRealGateway["timeout-minutes"]).toBe(20);
    expect(uiE2eRealGateway.env).toBeUndefined();

    const uiE2eSetup = expectDefined(
      uiE2e.steps.find((step: WorkflowStep) => step.name === "Setup Node environment"),
      "Control UI E2E Node setup",
    );
    expect(uiE2eSetup.uses).toBe("./.github/actions/setup-node-env");
    const expectedSharedUiE2eSetup = {
      "node-version": "24.x",
      "install-bun": "false",
      "dependency-cache":
        "${{ (vars.OPENCLAW_CI_RUNNER_BACKEND == 'github' || vars.OPENCLAW_CI_RUNNER_BACKEND == 'hybrid' || github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request' && github.run_attempt > 1)) && 'false' || (github.repository == 'openclaw/openclaw' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == 'openclaw/openclaw') && 'true' || 'false') }}",
      "use-actions-cache":
        "${{ (vars.OPENCLAW_CI_RUNNER_BACKEND == 'github' || vars.OPENCLAW_CI_RUNNER_BACKEND == 'hybrid' || github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request' && github.run_attempt > 1)) && 'true' || (github.repository == 'openclaw/openclaw' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == 'openclaw/openclaw') && 'false' || 'true') }}",
    } as const;
    const expectedUiE2eSetup = {
      ...expectedSharedUiE2eSetup,
      "restore-test-caches":
        "${{ (vars.OPENCLAW_CI_RUNNER_BACKEND == 'github' || vars.OPENCLAW_CI_RUNNER_BACKEND == 'hybrid') && 'true' || 'false' }}",
    } as const;
    expect(uiE2eSetup.with).toEqual(expectedUiE2eSetup);
    const realGatewaySetup = expectDefined(
      uiE2eRealGateway.steps.find((step: WorkflowStep) => step.name === "Setup Node environment"),
      "real-Gateway Control UI E2E Node setup",
    );
    expect(realGatewaySetup).toMatchObject({
      uses: uiE2eSetup.uses,
      with: expectedSharedUiE2eSetup,
    });
    expect(realGatewaySetup.with).toEqual(expectedSharedUiE2eSetup);

    const routedUiE2eJobs = [
      {
        job: uiE2e,
        hybridFirstAttempt: true,
        name: "checks-ui-e2e",
        setup: uiE2eSetup,
        blacksmithRunner: "blacksmith-8vcpu-ubuntu-2404",
        runsOn:
          "${{ vars.OPENCLAW_CI_RUNNER_BACKEND == 'github' && 'ubuntu-24.04' || (vars.OPENCLAW_CI_RUNNER_BACKEND == 'hybrid' && github.run_attempt > 1) && 'ubuntu-24.04' || (github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request' && github.run_attempt > 1)) && 'ubuntu-24.04' || (github.repository == 'openclaw/openclaw' && (github.event_name != 'pull_request' || contains(fromJSON('[\"OWNER\",\"MEMBER\",\"COLLABORATOR\",\"CONTRIBUTOR\"]'), github.event.pull_request.author_association)) && 'blacksmith-8vcpu-ubuntu-2404' || 'ubuntu-24.04') }}",
      },
      {
        job: uiE2eRealGateway,
        hybridFirstAttempt: false,
        name: "checks-ui-e2e-real-gateway",
        setup: realGatewaySetup,
        blacksmithRunner: "blacksmith-16vcpu-ubuntu-2404",
        runsOn:
          "${{ (vars.OPENCLAW_CI_RUNNER_BACKEND == 'github' || vars.OPENCLAW_CI_RUNNER_BACKEND == 'hybrid') && 'ubuntu-24.04' || (github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request' && github.run_attempt > 1)) && 'ubuntu-24.04' || (github.repository == 'openclaw/openclaw' && (github.event_name != 'pull_request' || contains(fromJSON('[\"OWNER\",\"MEMBER\",\"COLLABORATOR\",\"CONTRIBUTOR\"]'), github.event.pull_request.author_association)) && 'blacksmith-16vcpu-ubuntu-2404' || 'ubuntu-24.04') }}",
      },
    ] as const;
    const routingScenarios = [
      {
        name: "same-repo pull request first attempt",
        context: {
          eventName: "pull_request",
          headRepository: "openclaw/openclaw",
          repository: "openclaw/openclaw",
          runAttempt: 1,
        },
        expected: { blacksmith: true, dependencyCache: "true", useActionsCache: "false" },
      },
      {
        name: "same-repo pull request with GitHub backend",
        context: {
          eventName: "pull_request",
          headRepository: "openclaw/openclaw",
          repository: "openclaw/openclaw",
          runnerBackend: "github",
          runAttempt: 1,
        },
        expected: { blacksmith: false, dependencyCache: "false", useActionsCache: "true" },
      },
      {
        name: "same-repo pull request with hybrid backend",
        context: {
          eventName: "pull_request",
          headRepository: "openclaw/openclaw",
          repository: "openclaw/openclaw",
          runnerBackend: "hybrid",
          runAttempt: 1,
        },
        expected: { blacksmith: false, dependencyCache: "false", useActionsCache: "true" },
      },
      {
        name: "same-repo pull request retry",
        context: {
          eventName: "pull_request",
          headRepository: "openclaw/openclaw",
          repository: "openclaw/openclaw",
          runAttempt: 2,
        },
        expected: { blacksmith: false, dependencyCache: "false", useActionsCache: "true" },
      },
      {
        // Runner routing follows contributor trust; the exact dependency cache
        // stays fork-gated either way, so a fork never writes what main reads.
        name: "fork pull request from returning contributor",
        context: {
          authorAssociation: "CONTRIBUTOR",
          eventName: "pull_request",
          headRepository: "contributor/openclaw",
          repository: "openclaw/openclaw",
          runAttempt: 1,
        },
        expected: { blacksmith: true, dependencyCache: "false", useActionsCache: "true" },
      },
      {
        name: "fork pull request from unknown author",
        context: {
          authorAssociation: "NONE",
          eventName: "pull_request",
          headRepository: "contributor/openclaw",
          repository: "openclaw/openclaw",
          runAttempt: 1,
        },
        expected: { blacksmith: false, dependencyCache: "false", useActionsCache: "true" },
      },
      {
        name: "workflow dispatch",
        context: {
          eventName: "workflow_dispatch",
          repository: "openclaw/openclaw",
          runAttempt: 1,
        },
        expected: { blacksmith: false, dependencyCache: "false", useActionsCache: "true" },
      },
      {
        name: "canonical push retry",
        context: {
          eventName: "push",
          repository: "openclaw/openclaw",
          runAttempt: 2,
        },
        expected: { blacksmith: true, dependencyCache: "true", useActionsCache: "false" },
      },
    ] as const;
    for (const {
      blacksmithRunner,
      hybridFirstAttempt,
      job,
      name: jobName,
      runsOn,
      setup,
    } of routedUiE2eJobs) {
      expect(job["runs-on"]).toBe(runsOn);
      for (const { context, expected, name: scenarioName } of routingScenarios) {
        const assertionName = `${jobName}: ${scenarioName}`;
        const useBlacksmith =
          scenarioName === "same-repo pull request with hybrid backend"
            ? hybridFirstAttempt
            : expected.blacksmith;
        const expectedRunner = useBlacksmith ? blacksmithRunner : "ubuntu-24.04";
        expect(evaluateWorkflowExpression(job["runs-on"], context), assertionName).toBe(
          expectedRunner,
        );
        expect(
          evaluateWorkflowExpression(setup.with?.["dependency-cache"], context),
          assertionName,
        ).toBe(expected.dependencyCache);
        expect(
          evaluateWorkflowExpression(setup.with?.["use-actions-cache"], context),
          assertionName,
        ).toBe(expected.useActionsCache);
      }
    }

    const chromiumInstall = expectDefined(
      uiE2e.steps.find((step: WorkflowStep) => step.name === "Install Playwright Chromium"),
      "Control UI E2E Chromium installation",
    );
    expect(chromiumInstall.env.FROZEN_TARGET).toBe("${{ needs.preflight.outputs.frozen_target }}");
    expect(chromiumInstall.run).toContain(
      "node --import tsx scripts/ensure-playwright-chromium.mts",
    );
    expect(chromiumInstall.run).toContain("node scripts/ensure-playwright-chromium.mjs");
    const chromiumCache = expectDefined(
      uiE2e.steps.find((step: WorkflowStep) => step.name === "Cache Playwright Chromium"),
      "Control UI E2E Chromium cache",
    );
    const realGatewayChromiumInstall = expectDefined(
      uiE2eRealGateway.steps.find(
        (step: WorkflowStep) => step.name === "Install Playwright Chromium",
      ),
      "real-Gateway Control UI E2E Chromium installation",
    );
    expect(realGatewayChromiumInstall).toEqual(chromiumInstall);
    const realGatewayChromiumCache = expectDefined(
      uiE2eRealGateway.steps.find(
        (step: WorkflowStep) => step.name === "Cache Playwright Chromium",
      ),
      "real-Gateway Control UI E2E Chromium cache",
    );
    expect(realGatewayChromiumCache).toEqual(chromiumCache);

    const scenario = expectDefined(
      uiE2e.steps.find((step: WorkflowStep) => step.name === "Test Control UI end-to-end"),
      "Control UI E2E suite",
    );
    expect(scenario.if).toBe("matrix.task == 'control-ui'");
    expect(scenario.env).toEqual({
      OPENCLAW_UI_E2E_DIAGNOSTIC_DIR:
        ".artifacts/control-ui-e2e-timeouts/shard-${{ matrix.shard }}-attempt-${{ github.run_attempt }}",
      SHARD_INDEX: "${{ matrix.shard }}",
      VITEST_SHARD_COUNT: "${{ matrix.vitest_shard_count }}",
    });
    expect(scenario.run).toBe(
      'node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner --shard "$SHARD_INDEX/$VITEST_SHARD_COUNT"',
    );
    const timeoutDiagnostics = expectDefined(
      uiE2e.steps.find(
        (step: WorkflowStep) => step.name === "Upload Control UI E2E timeout diagnostics",
      ),
      "Control UI E2E timeout diagnostic upload",
    );
    expect(timeoutDiagnostics).toEqual({
      name: "Upload Control UI E2E timeout diagnostics",
      if: "failure() && matrix.task == 'control-ui'",
      uses: UPLOAD_ARTIFACT_V7,
      with: {
        name: "control-ui-e2e-timeout-${{ matrix.shard }}-${{ github.run_attempt }}",
        path: ".artifacts/control-ui-e2e-timeouts/shard-${{ matrix.shard }}-attempt-${{ github.run_attempt }}",
        "if-no-files-found": "ignore",
        "retention-days": 7,
      },
    });
    const browserExtension = expectDefined(
      uiE2e.steps.find(
        (step: WorkflowStep) => step.name === "Test browser extension bootstrap end-to-end",
      ),
      "browser extension bootstrap E2E suite",
    );
    expect(browserExtension.if).toBe("matrix.task == 'browser-extension'");
    expect(browserExtension.run).toBe("pnpm test:e2e:browser-extension");
    for (const { job } of routedUiE2eJobs) {
      const jobContract = JSON.stringify(job);
      expect(jobContract).not.toContain("OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM");
      expect(jobContract).not.toContain("OPENCLAW_VITEST_NO_OUTPUT_RETRY");
    }

    const realGatewayRuns = uiE2eRealGateway.steps
      .filter((step: WorkflowStep) => step.name?.includes("with a real Gateway"))
      .map((step: WorkflowStep) => step.run);
    expect(realGatewayRuns).toEqual([
      "node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner ui/src/e2e/mcp-app-conformance.e2e.test.ts",
      "node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner ui/src/e2e/control-ui-auth-transports.e2e.test.ts",
      "node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner ui/src/e2e/logs-lifecycle.e2e.test.ts",
    ]);
    const realGatewayRunContract = realGatewayRuns.join("\n");
    expect(realGatewayRunContract).not.toContain("--retry");
    expect(realGatewayRunContract).not.toContain("--hookTimeout");
    expect(realGatewayRunContract).not.toContain("--testTimeout");
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
    const sourceStep = localeJob.steps.find(
      (step: WorkflowStep) => step.name === "Verify Control UI i18n source",
    );
    const localeStep = localeJob.steps.find(
      (step: WorkflowStep) => step.name === "Check Control UI locale parity",
    );

    expect(buildArtifactSteps).not.toContainEqual(
      expect.objectContaining({ run: "pnpm ui:i18n:check" }),
    );
    expect(JSON.parse(readFileSync("package.json", "utf8")).scripts["test:ui"]).not.toContain(
      "ui:i18n:check",
    );
    expect(workflowSource.match(/pnpm ui:i18n:verify/gu)).toHaveLength(1);
    expect(workflowSource.match(/pnpm ui:i18n:check/gu)).toHaveLength(1);
    expect(readFileSync("ui/src/i18n/test/translate.test.ts", "utf8")).not.toContain(
      "keeps shipped locales structurally aligned with English",
    );
    expect(localeJob.needs).toEqual(["preflight"]);
    expect(localeJob.if).toBe("needs.preflight.outputs.run_control_ui_i18n == 'true'");
    expect(localeJob["continue-on-error"]).toBeUndefined();
    expect(localeJob.env.COMPATIBILITY_TARGET).toBe(
      "${{ needs.preflight.outputs.compatibility_target }}",
    );
    expect(sourceStep["continue-on-error"]).toBeUndefined();
    const compatibilityWithoutVerify = runControlUiI18nSourceFixture({
      compatibilityTarget: true,
      hasVerifyScript: false,
    });
    expect(compatibilityWithoutVerify.status, compatibilityWithoutVerify.output).toBe(0);
    expect(compatibilityWithoutVerify.calls).toEqual([]);
    expect(compatibilityWithoutVerify.summary).toContain(
      "Skipping ui:i18n:verify: unavailable on the selected compatibility target.",
    );

    const currentWithoutVerify = runControlUiI18nSourceFixture({
      compatibilityTarget: false,
      hasVerifyScript: false,
    });
    expect(currentWithoutVerify.status).toBe(1);
    expect(currentWithoutVerify.calls).toEqual([]);
    expect(currentWithoutVerify.output).toContain(
      "ui:i18n:verify is required for non-compatibility targets.",
    );

    const currentWithVerify = runControlUiI18nSourceFixture({
      compatibilityTarget: false,
      hasVerifyScript: true,
    });
    expect(currentWithVerify.status, currentWithVerify.output).toBe(0);
    expect(currentWithVerify.calls).toEqual(["ui:i18n:verify"]);
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

  it("runs built runtime verifiers inside the artifact-check wave", () => {
    const workflow = readCiWorkflow();
    const steps = workflow.jobs["build-artifacts"].steps;
    const verifierStep = steps.find(
      (step: WorkflowStep) => step.name === "Run built artifact checks",
    );

    // The verifiers always run, so the shared step cannot be gated on the
    // selected checks; each check keeps its own RUN_* gate inside the body.
    expect(verifierStep.if).toBeUndefined();
    expect(steps.some((step: WorkflowStep) => step.name === "Verify built runtime artifacts")).toBe(
      false,
    );
    // The hosted RSS allowance and the serial fallback keep the startup-memory
    // measurement unperturbed on 4-core hosted runners.
    expect(verifierStep.env.OPENCLAW_STARTUP_MEMORY_PLUGINS_LIST_MB).toBe(
      "${{ runner.environment == 'github-hosted' && '425' || '400' }}",
    );
    expect(verifierStep.env.PARALLEL_BUILT_VERIFIERS).toBe(
      "${{ runner.environment != 'github-hosted' && 'true' || 'false' }}",
    );
    expect(verifierStep.run).toContain(
      "test/scripts/doctor-config-preflight-plugin-index.built-cli.e2e.test.ts",
    );
    expect(verifierStep.run).toContain(
      "env OPENCLAW_E2E_USE_PREBUILT_DIST=1 OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=660000 node scripts/run-vitest.mjs run",
    );
    expect(verifierStep.run).toContain("--config test/vitest/vitest.e2e.config.ts");
    expect(verifierStep.run).toContain("Selected target predates");
    expect(verifierStep.run).toContain("pnpm test:build:singleton");
    // The startup asset rebuild must complete before any verifier forks so
    // concurrent readers never observe dist mid-write.
    expect(verifierStep.run).toContain("scripts/ensure-cli-startup-build.mts");
    expect(verifierStep.run).toContain("scripts/check-cli-startup-memory.mjs");
    expect(verifierStep.run).toContain(".artifacts/startup-memory/summary.md");
    // Every verifier reports through the shared results map so a failure can
    // never be swallowed by the wave.
    for (const name of ["doctor-plugin-index", "plugin-singleton", "startup-memory"]) {
      expect(verifierStep.run).toContain(`run_verifier "${name}"`);
      expect(verifierStep.run).toContain(`["${name}"]="skipped"`);
    }
    expect(verifierStep.run).toContain(
      "for name in channels core-support-boundary doctor-plugin-index gateway-watch plugin-singleton startup-memory tui-pty; do",
    );
  });

  it("runs the scoped SQLite lifecycle proof against the exact built artifact", () => {
    const workflow = readCiWorkflow();
    const additionalJob = workflow.jobs["check-additional-shard"];
    const additionalRunStep = additionalJob.steps.find(
      (step: WorkflowStep) => step.name === "Run additional check shard",
    );
    const lifecycleJob = workflow.jobs["sqlite-session-lifecycle"];
    const downloadStep = lifecycleJob.steps.find(
      (step: WorkflowStep) => step.name === "Download exact-run built runtime",
    );
    const extractStep = lifecycleJob.steps.find(
      (step: WorkflowStep) => step.name === "Extract built runtime",
    );
    const proofStep = lifecycleJob.steps.find(
      (step: WorkflowStep) => step.name === "Verify SQLite session lifecycle",
    );

    expect(additionalJob.strategy.matrix.include).not.toContainEqual(
      expect.objectContaining({ group: "sqlite-session-flip-proof" }),
    );
    expect(additionalRunStep.run).not.toContain("sqlite-session-flip-proof)");
    expect(lifecycleJob.needs).toEqual(["preflight", "build-artifacts"]);
    expect(lifecycleJob.if).toContain(
      "needs.preflight.outputs.run_sqlite_session_lifecycle == 'true'",
    );
    expect(downloadStep.uses).toBe(DOWNLOAD_ARTIFACT_V8);
    expect(downloadStep.with.name).toBe("dist-runtime-build");
    expect(extractStep.run).toContain("dist-runtime-build.tar.zst");
    expect(proofStep.env.OPENCLAW_E2E_USE_PREBUILT_DIST).toBe("1");
    expect(proofStep.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBe("660000");
    expect(proofStep.run).toContain(
      "test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts",
    );
    expect(workflow.jobs["ci-gate"].needs).toContain("sqlite-session-lifecycle");
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

  it("keeps the full built TUI PTY suite out of the artifact canary gate", () => {
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
    const firstWait = run.indexOf("\nwait_checks\n");
    const hostedGatewayWatch = run.indexOf(
      'if [ "$RUN_GATEWAY_WATCH" = "true" ] && [ "$PARALLEL_GATEWAY_WATCH" != "true" ]; then',
    );
    const tuiPty = run.indexOf('if [ "$RUN_TUI_PTY" = "true" ]; then');
    const hostedGatewayWait = run.indexOf("\n  wait_checks\n", hostedGatewayWatch);
    const tuiPtyWait = run.indexOf("\n  wait_checks\n", tuiPty);
    expect(firstWait).toBeGreaterThan(run.indexOf('start_check "core-support-boundary"'));
    expect(hostedGatewayWatch).toBeGreaterThan(firstWait);
    expect(hostedGatewayWait).toBeGreaterThan(hostedGatewayWatch);
    expect(tuiPty).toBeGreaterThan(hostedGatewayWait);
    expect(tuiPtyWait).toBeGreaterThan(tuiPty);
    expect(run.slice(tuiPty, tuiPtyWait)).toContain("src/tui/tui-pty-local.e2e.test.ts");
    expect(run.slice(tuiPty, tuiPtyWait)).toContain("--testNamePattern");
    expect(run.slice(tuiPty, tuiPtyWait)).toContain(
      "launches openclaw (chat as local mode|tui against a real Gateway) through a real PTY",
    );
    expect(run).toContain("wait_checks()");
    // Three wave barriers plus the one inside run_verifier, which serializes
    // the built-runtime verifiers on hosted runners only.
    expect(run.match(/wait_checks$/gmu)).toHaveLength(4);
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
    expect(runStep.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBe(
      "${{ needs.preflight.outputs.compatibility_target == 'true' && '660000' || '300000' }}",
    );
    expect(runStep.env.OPENCLAW_VITEST_NO_OUTPUT_RETRY).toBe("1");
    expect(runStep.env.OPENCLAW_NODE_TEST_ENV_JSON).toBe("${{ toJson(matrix.env) }}");
    expect(runStep.env.OPENCLAW_NODE_TEST_TARGETS_JSON).toBe("${{ toJson(matrix.targets) }}");
    expect(runStep.env.OPENCLAW_NODE_TEST_VITEST_ARGS_JSON).toBe(
      "${{ needs.preflight.outputs.compatibility_target == 'true' && '[\"--hookTimeout=600000\"]' || '[]' }}",
    );
    const trustedRunnerStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Checkout trusted Node shard runner",
    );
    expect(trustedRunnerStep).toMatchObject({
      if: "${{ hashFiles('scripts/ci-run-node-test-shard.mts') == '' }}",
      uses: CHECKOUT_V6,
      with: {
        ref: "${{ github.workflow_sha }}",
        path: ".ci-workflow",
        "sparse-checkout": expect.stringContaining("scripts/ci-run-node-test-shard.mts"),
        "sparse-checkout-cone-mode": false,
        "persist-credentials": false,
      },
    });
    // Non-cone sparse-checkout ignores missing paths silently, so a renamed
    // script would surface only as a runtime module-not-found on the frozen
    // lane. Require every listed path to exist at this revision.
    const sparseCheckoutPaths = String(trustedRunnerStep?.with?.["sparse-checkout"] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(sparseCheckoutPaths).toContain("scripts/ci-run-node-test-shard.mts");
    for (const sparsePath of sparseCheckoutPaths) {
      expect({ sparsePath, exists: existsSync(sparsePath) }).toEqual({ sparsePath, exists: true });
    }
  });

  it("uses candidate-owned script interfaces for frozen target CI", () => {
    const workflow = readCiWorkflow();
    const buildChecks = workflow.jobs["build-artifacts"].steps.find(
      (step: WorkflowStep) => step.name === "Run built artifact checks",
    );
    const qaBuild = workflow.jobs["qa-smoke-ci-profile"].steps.find(
      (step: WorkflowStep) => step.name === "Build QA smoke runtime",
    );
    const additionalChecks = workflow.jobs["check-additional-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run additional check shard",
    );

    expect(buildChecks.run).toContain("pnpm test:gateway:watch-regression -- --skip-build");
    expect(buildChecks.run).not.toContain("scripts/check-gateway-watch-regression.mts");
    expect(qaBuild.run.match(/pnpm build qaRuntime/gu)).toHaveLength(1);
    expect(qaBuild.run).not.toContain("package-openclaw-for-docker");
    expect(additionalChecks.run).toContain(
      "boundary_runner=(node --import tsx scripts/run-additional-boundary-checks.mts)",
    );
    expect(additionalChecks.run).toContain(
      "boundary_runner=(node scripts/run-additional-boundary-checks.mjs)",
    );
    expect(additionalChecks.run).not.toContain(
      "if [ ! -f scripts/check-session-accessor-boundary.mts ]",
    );
    expect(additionalChecks.run).not.toContain(
      "if [ ! -f scripts/check-session-transcript-reader-boundary.mts ]",
    );
  });

  it("emits one final CI gate after every selected lane", () => {
    const workflow = readCiWorkflow();
    const gate = workflow.jobs["ci-gate"];
    const requiredJobs = ["preflight", "security-fast"];
    const selectedJobs = [
      "pnpm-store-warmup",
      "build-artifacts",
      "sqlite-session-lifecycle",
      "native-i18n",
      "checks-ui",
      "checks-ui-e2e",
      "checks-ui-e2e-real-gateway",
      "control-ui-i18n",
      "checks-fast-core",
      "qa-smoke-ci-profile",
      "checks-fast-plugin-contracts-shard",
      "checks-fast-channel-contracts-shard",
      "checks-node-compat",
      "checks-node-core-test-nondist-shard",
      "check-shard",
      "check-lint-hosted-core-shard",
      "check-test-types-hosted-core-shard",
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
    // Every job in the file is gated; a new lane cannot slip in ungated.
    expect(gate.needs.toSorted()).toEqual(
      Object.keys(workflow.jobs)
        .filter((job) => job !== "ci-gate")
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

  it("runs Node 22 compatibility only from manual CI dispatches", () => {
    const workflow = readCiWorkflow();
    const compatibilityJob = workflow.jobs["checks-node-compat"];
    const fullReleaseWorkflow = readWorkflow(".github/workflows/full-release-validation.yml");
    const fullReleaseDispatch = fullReleaseWorkflow.jobs.normal_ci.steps.find(
      (step: WorkflowStep) => step.name === "Dispatch and monitor CI",
    );

    expect(compatibilityJob.name).toBe("checks-node-compat-node22");
    expect(compatibilityJob.if).toBe(
      "needs.preflight.outputs.run_build_artifacts == 'true' && github.event_name == 'workflow_dispatch'",
    );
    expect(fullReleaseDispatch.env.CHILD_WORKFLOW_KIND).toBe("ci");
    expect(fullReleaseDispatch.run).toContain('dispatch_and_wait ci.yml "$dispatch_run_name"');
    expect(fullReleaseDispatch.run).toContain('-f target_ref="$TARGET_SHA"');
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

      const failedUiE2e = runCiGateFixture(
        "preflight=success\nsecurity-fast=success",
        "checks-ui=success\nchecks-ui-e2e=failure",
      );
      expect(failedUiE2e.status).not.toBe(0);
      expect(failedUiE2e.stdout).toContain("checks-ui-e2e finished with failure");
    },
  );

  it.skipIf(process.platform === "win32")(
    "resolves topology-aware protocol bases and drives the real guard",
    () => {
      const topology = createQaProtocolTopology();
      const cases = [
        ["main", topology.mainHead, "main-ancestor", topology.mainBase],
        [topology.releaseBranch, topology.releaseHead, "release-branch-head", topology.mainBase],
        [topology.releaseTag, topology.releaseTagHead, "release-tag", topology.mainBase],
        [topology.releaseTagHead, topology.releaseTagHead, "release-tag", topology.mainBase],
        [topology.mainReleaseTag, topology.mainHead, "release-tag", topology.mainHead],
      ] as const;

      for (const [inputRef, revision, trustedReason, protocolBase] of cases) {
        const result = runQaSelectedRefValidation(topology, inputRef, revision);
        expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
        expect(result.outputs).toEqual({
          protocol_base_revision: protocolBase,
          selected_revision: revision,
          trusted_reason: trustedReason,
        });
      }

      runGit(topology.checkout, ["checkout", "-q", "--detach", topology.mainHead]);
      const mainCheck = runProtocolSinceFixture(topology.checkout, topology.mainBase);
      expect(mainCheck.status, `${mainCheck.stdout}${mainCheck.stderr}`).toBe(0);
      expect(mainCheck.stdout).toContain("1 new core method");

      runGit(topology.checkout, ["checkout", "-q", "--detach", topology.compatibilityHead]);
      const compatibilityCheck = runProtocolSinceFixture(topology.checkout, topology.mainBase);
      expect(
        compatibilityCheck.status,
        `${compatibilityCheck.stdout}${compatibilityCheck.stderr}`,
      ).toBe(0);
      expect(compatibilityCheck.stdout).toContain("1 restored compatibility method");

      runGit(topology.checkout, ["checkout", "-q", "--detach", topology.invalidCompatibilityHead]);
      const invalidCompatibilityCheck = runProtocolSinceFixture(
        topology.checkout,
        topology.mainBase,
      );
      expect(invalidCompatibilityCheck.status).not.toBe(0);
      expect(invalidCompatibilityCheck.stderr).toContain(
        "restored compatibility methods must retain <= vintage metadata",
      );

      runGit(topology.checkout, ["checkout", "-q", "--detach", topology.releaseHead]);
      const releaseCheck = runProtocolSinceFixture(topology.checkout, topology.mainBase);
      expect(releaseCheck.status).not.toBe(0);
      expect(releaseCheck.stderr).toContain("sessions.releaseOnly is missing since metadata");

      for (const [expectedSha, inputRef, revision] of [
        ["not-a-sha", "main", topology.mainHead],
        [topology.featureHead, topology.featureHead, topology.featureHead],
        [topology.mainHead, topology.releaseTag, topology.releaseTagHead],
      ] as const) {
        const result = runQaSelectedRefValidation(topology, inputRef, revision, expectedSha);
        expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
        expect(result.outputs).toEqual({});
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "wires and fetches one explicit protocol base before QA execution",
    () => {
      const qaWorkflow = readQaProfileEvidenceWorkflow();
      const maturityWorkflow = readMaturityScorecardWorkflow();
      const validateJob = qaWorkflow.jobs.validate_selected_ref;
      const runJob = qaWorkflow.jobs.run_qa_profile_shard;
      const aggregateJob = qaWorkflow.jobs.aggregate_qa_profile;
      const stepNames = runJob.steps.map((step: WorkflowStep) => step.name);
      const buildStep = expectDefined(
        runJob.steps.find((step: WorkflowStep) => step.name === "Build private QA runtime"),
        "private QA runtime build",
      );
      const fetchStep = expectDefined(
        runJob.steps.find((step: WorkflowStep) => step.name === "Fetch protocol comparison base"),
        "protocol comparison base fetch",
      );
      const runStep = expectDefined(
        runJob.steps.find((step: WorkflowStep) => step.name === "Run QA profile shard"),
        "QA profile shard run",
      );
      const evidenceStep = expectDefined(
        aggregateJob.steps.find(
          (step: WorkflowStep) => step.name === "Finalize QA profile evidence",
        ),
        "QA profile evidence finalization",
      );
      const protocolOutput = "${{ needs.validate_selected_ref.outputs.protocol_base_revision }}";
      const trustedInput = "${{ inputs.trusted_ref || inputs.ref }}";

      expect(qaWorkflow.on.workflow_call.inputs.trusted_ref).toEqual({
        description: "Optional trusted branch, tag, or SHA identity for an immutable ref",
        required: false,
        default: "",
        type: "string",
      });
      expect(validateJob.outputs.protocol_base_revision).toBe(
        "${{ steps.validate.outputs.protocol_base_revision }}",
      );
      const validateStep = expectDefined(
        validateJob.steps.find((step: WorkflowStep) => step.name === "Validate selected ref"),
        "QA selected-ref validation",
      );
      expect(validateStep.env.INPUT_REF).toBe(trustedInput);
      const ordered = [
        "Checkout trusted QA harness",
        "Setup Node environment",
        "Checkout selected ref",
        "Verify selected checkout SHA",
        "Install selected dependencies",
        "Fetch protocol comparison base",
        "Build private QA runtime",
        "Run QA profile shard",
      ].map((name) => stepNames.indexOf(name));
      expect(ordered.every((index, position) => index > (ordered[position - 1] ?? -1))).toBe(true);
      expect(fetchStep.env?.PROTOCOL_SINCE_BASE_SHA).toBe(protocolOutput);
      expect(buildStep.run).toBe("pnpm build qaRuntime");
      expect(runStep.env?.PROTOCOL_SINCE_BASE_SHA).toBe(protocolOutput);
      expect(runStep.env?.REQUESTED_REF).toBe(trustedInput);
      expect(runStep.run).toContain("protocolBaseSha: process.env.PROTOCOL_SINCE_BASE_SHA");
      expect(evidenceStep.env?.PROTOCOL_BASE_SHA).toBe(protocolOutput);
      expect(evidenceStep.env?.REQUESTED_REF).toBe(trustedInput);
      expect(evidenceStep.run).toContain("protocolBaseSha: process.env.PROTOCOL_BASE_SHA");
      expect(maturityWorkflow.jobs.generate_qa_evidence.with.trusted_ref).toBe("${{ inputs.ref }}");

      const topology = createQaProtocolTopology();
      const checkout = tempDirs.make("openclaw-qa-protocol-fetch-");
      runGit(checkout, ["init", "-q", "-b", "main"]);
      runGit(checkout, ["remote", "add", "origin", topology.origin]);
      runGit(checkout, [
        "fetch",
        "-q",
        "--depth=1",
        "origin",
        `+${topology.mainHead}:refs/remotes/origin/selected`,
      ]);
      runGit(checkout, ["checkout", "-q", "--detach", "refs/remotes/origin/selected"]);
      const sentinel = path.join(checkout, "qa-sentinel");
      const runFetch = (baseSha: string) =>
        runWorkflowShellScript(
          `${expectDefined(fetchStep.run, "protocol fetch script")}\nprintf 'ran\\n' > "$QA_SENTINEL"\n`,
          {
            cwd: checkout,
            env: {
              ...process.env,
              PATH: `${topology.fakeBin}:${process.env.PATH ?? ""}`,
              PROTOCOL_SINCE_BASE_SHA: baseSha,
              QA_SENTINEL: sentinel,
            },
          },
        );

      const success = runFetch(topology.mainBase);
      expect(success.status, `${success.stdout}${success.stderr}`).toBe(0);
      expect(runGit(checkout, ["rev-parse", "refs/remotes/origin/qa-protocol-base"])).toBe(
        topology.mainBase,
      );
      expect(existsSync(sentinel)).toBe(true);

      rmSync(sentinel);
      const failure = runFetch("f".repeat(40));
      expect(failure.status, `${failure.stdout}${failure.stderr}`).not.toBe(0);
      expect(existsSync(sentinel)).toBe(false);
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

    expect(gitFetchLines).toHaveLength(3);
    expect(
      gitFetchLines.every((line: string) =>
        line.trimStart().startsWith("timeout --signal=TERM --kill-after=10s 120s git fetch"),
      ),
    ).toBe(true);
    expect(gitFetchLines.some((line: string) => line.includes("+refs/tags/"))).toBe(true);
  });

  it.skipIf(process.platform !== "linux")(
    "classifies QA timeouts only from isolated supervisor diagnostics",
    () => {
      const scenarios = [
        {
          exitCode: 124,
          mode: "natural-124",
          supervisorSignals: [],
          timedOut: false,
          timeoutOutcome: "none",
        },
        {
          exitCode: 137,
          mode: "self-kill",
          supervisorSignals: [],
          timedOut: false,
          timeoutOutcome: "none",
        },
        {
          exitCode: 124,
          mode: "term",
          supervisorSignals: ["TERM"],
          timedOut: true,
          timeoutOutcome: "term",
        },
        {
          exitCode: 137,
          mode: "kill",
          supervisorSignals: ["TERM", "KILL"],
          timedOut: true,
          timeoutOutcome: "kill",
        },
      ] as const;

      for (const scenario of scenarios) {
        const result = runQaProfileTimeoutFixture(scenario.mode);
        expect(result.commandStatus, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.status).toMatchObject({
          exitCode: scenario.exitCode,
          target: { protocolBaseSha: "b".repeat(40) },
          timedOut: scenario.timedOut,
          timeoutOutcome: scenario.timeoutOutcome,
        });
        expect(result.githubOutput).toContain(`qa_exit_code=${scenario.exitCode}`);
        expect(result.stderr).toContain(`child-stderr-sentinel:${scenario.mode}`);
        expect(result.stderr).toContain("child-locale:POSIX");
        expect(result.timeoutVersion).toContain("(GNU coreutils)");

        const supervisorSignals: readonly ("TERM" | "KILL")[] = scenario.supervisorSignals;
        for (const signal of ["TERM", "KILL"] as const) {
          const diagnostic = `timeout: sending signal ${signal} to command 'env'`;
          if (supervisorSignals.includes(signal)) {
            expect(result.timeoutSupervisorLog).toContain(diagnostic);
          } else {
            expect(result.timeoutSupervisorLog).not.toContain(diagnostic);
          }
        }

        if (scenario.mode === "natural-124") {
          expect(result.stderr).toContain(
            "timeout: sending signal KILL to command 'spoofed-child'",
          );
          expect(result.timeoutSupervisorLog).not.toContain("spoofed-child");
        }
        if (scenario.timeoutOutcome === "term") {
          expect(result.stdout).toContain(
            "::warning::QA profile 'all' timed out after 0.4 seconds and was terminated",
          );
        } else if (scenario.timeoutOutcome === "kill") {
          expect(result.stdout).toContain(
            "::warning::QA profile 'all' timed out after 0.4 seconds and required SIGKILL after the 0.05-second grace period",
          );
        } else {
          expect(result.stdout).not.toContain("::warning::QA profile");
        }
      }
    },
  );

  it("keeps maturity scorecard generated QA evidence handoff strict", () => {
    const maturityWorkflow = readMaturityScorecardWorkflow();
    const qaEvidenceWorkflow = readQaProfileEvidenceWorkflow();
    const generateJob = maturityWorkflow.jobs.generate_qa_evidence;
    const publisherPreflight = maturityWorkflow.jobs.publisher_preflight;
    const publishJob = maturityWorkflow.jobs.publish;
    const publishPrJob = maturityWorkflow.jobs.publish_generated_pr;
    const qaPlanJob = qaEvidenceWorkflow.jobs.plan_qa_profile;
    const qaShardJob = qaEvidenceWorkflow.jobs.run_qa_profile_shard;
    const qaAggregateJob = qaEvidenceWorkflow.jobs.aggregate_qa_profile;
    const qaValidateJob = qaEvidenceWorkflow.jobs.validate_selected_ref;

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
      allow_failures: {
        description: "Allow rendering from valid incomplete QA evidence",
        required: false,
        default: false,
        type: "boolean",
      },
    });
    expect(maturityWorkflow.on.workflow_dispatch.inputs.allow_failures).toEqual({
      description: "Allow rendering from valid incomplete QA evidence",
      required: false,
      default: true,
      type: "boolean",
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
    for (const trigger of ["workflow_dispatch", "workflow_call"] as const) {
      expect(qaEvidenceWorkflow.on[trigger].inputs.allow_failures).toEqual({
        description: "Continue after validated QA result failures",
        required: false,
        default: false,
        type: "boolean",
      });
    }
    expect(qaEvidenceWorkflow.on.workflow_dispatch.inputs.qa_profile).not.toHaveProperty("options");
    expect(qaEvidenceWorkflow.on.workflow_dispatch.inputs.qa_profile.default).toBe("all");
    expect(qaEvidenceWorkflow.on.workflow_call.inputs.qa_profile.type).toBe("string");
    for (const outputName of [
      "artifact_name",
      "qa_profile",
      "qa_exit_code",
      "qa_passed",
      "target_sha",
      "trusted_reason",
      "qa_evidence_path",
    ]) {
      expect(qaEvidenceWorkflow.on.workflow_call.outputs[outputName].value).toContain(
        `jobs.aggregate_qa_profile.outputs.${outputName}`,
      );
    }
    expect(qaPlanJob.needs).toBe("validate_selected_ref");
    expect(qaPlanJob.outputs).toEqual({
      channel_driver: "${{ steps.plan.outputs.channel_driver }}",
      matrix: "${{ steps.plan.outputs.matrix }}",
      profile: "${{ steps.plan.outputs.profile }}",
      shard_count: "${{ steps.plan.outputs.shard_count }}",
    });
    expect(qaValidateJob.outputs).toMatchObject({
      workflow_repository: "${{ steps.workflow.outputs.workflow_repository }}",
      workflow_sha: "${{ steps.workflow.outputs.workflow_sha }}",
    });
    const workflowIdentityStep = qaValidateJob.steps[0];
    expect(workflowIdentityStep).toMatchObject({
      name: "Resolve job workflow identity",
      id: "workflow",
      env: { JOB_CONTEXT: "${{ toJSON(job) }}" },
    });
    expect(workflowIdentityStep.run).toContain("job.workflow_repository");
    expect(workflowIdentityStep.run).toContain("job.workflow_sha");
    expect(workflowIdentityStep.run).toContain("^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+$");
    expect(workflowIdentityStep.run).toContain("^[0-9a-f]{40}$");

    const selectedCodeSteps = new Map([
      [qaPlanJob, ["Build private QA runtime", "Resolve taxonomy profile shards"]],
      [
        qaShardJob,
        [
          "Fetch protocol comparison base",
          "Build private QA runtime",
          "Ensure Playwright Chromium",
          "Run QA profile shard",
          "Validate QA profile shard evidence",
        ],
      ],
      [
        qaAggregateJob,
        [
          "Build private QA runtime",
          "Aggregate validated shard evidence",
          "Finalize QA profile evidence",
        ],
      ],
    ]);
    for (const [job, codeStepNames] of selectedCodeSteps) {
      expect(job.environment).toBe("qa-live-shared");
      const stepIndex = (name: string) =>
        job.steps.findIndex((step: WorkflowStep) => step.name === name);
      const trustedCheckout = job.steps[0];
      const setupStep = expectDefined(
        job.steps.find((step: WorkflowStep) => step.name === "Setup Node environment"),
        "trusted QA harness Node setup",
      );
      const selectedCheckout = expectDefined(
        job.steps.find((step: WorkflowStep) => step.name === "Checkout selected ref"),
        "selected QA checkout",
      );
      const verifySelected = expectDefined(
        job.steps.find((step: WorkflowStep) => step.name === "Verify selected checkout SHA"),
        "selected QA checkout verification",
      );
      const installSelected = expectDefined(
        job.steps.find((step: WorkflowStep) => step.name === "Install selected dependencies"),
        "selected QA dependency install",
      );

      expect(trustedCheckout).toMatchObject({
        name: "Checkout trusted QA harness",
        uses: CHECKOUT_V6,
        with: {
          repository: "${{ needs.validate_selected_ref.outputs.workflow_repository }}",
          ref: "${{ needs.validate_selected_ref.outputs.workflow_sha }}",
          "fetch-depth": 1,
          "persist-credentials": false,
        },
      });
      expect(job.steps.filter((step: WorkflowStep) => step.uses === CHECKOUT_V6)).toHaveLength(2);
      expect(job.steps.some((step: WorkflowStep) => step.uses?.startsWith("actions/cache/"))).toBe(
        false,
      );
      expect(setupStep.with?.["install-deps"]).toBe("false");
      expect(setupStep.with?.["use-actions-cache"]).toBe("false");
      expect(selectedCheckout).toMatchObject({
        uses: CHECKOUT_V6,
        with: {
          ref: "${{ needs.validate_selected_ref.outputs.selected_revision }}",
          path: "selected",
          "fetch-depth": 1,
          "persist-credentials": false,
        },
      });
      expect(verifySelected.run).toContain("git -C selected rev-parse HEAD");
      expect(verifySelected.env?.EXPECTED_SHA).toBe(
        "${{ needs.validate_selected_ref.outputs.selected_revision }}",
      );
      expect(installSelected["working-directory"]).toBe("selected");
      expect(installSelected.run).toContain(
        '--store-dir "$RUNNER_TEMP/openclaw-qa-selected-pnpm-store"',
      );
      for (const installFlag of [
        "--frozen-lockfile",
        "--ignore-scripts=false",
        "--config.engine-strict=false",
        "--config.enable-pre-post-scripts=true",
        "--config.side-effects-cache=true",
      ]) {
        expect(installSelected.run).toContain(installFlag);
      }
      const ordered = [
        0,
        stepIndex("Setup Node environment"),
        stepIndex("Checkout selected ref"),
        stepIndex("Verify selected checkout SHA"),
        stepIndex("Install selected dependencies"),
      ];
      expect(ordered.every((index, position) => index > (ordered[position - 1] ?? -1))).toBe(true);
      for (const codeStepName of codeStepNames) {
        const codeStep = expectDefined(
          job.steps.find((step: WorkflowStep) => step.name === codeStepName),
          `selected QA step ${codeStepName}`,
        );
        expect(codeStep["working-directory"], codeStepName).toBe("selected");
      }
    }
    const validateProfileStep = qaPlanJob.steps.find(
      (step: WorkflowStep) => step.name === "Resolve taxonomy profile shards",
    );
    expect(validateProfileStep.run).toContain("createQaProfileEvidenceShardPlan(requested)");
    expect(validateProfileStep.run).toContain("matrix=${JSON.stringify({ include: plan.shards })}");
    expect(validateProfileStep.run).toContain("shard_count=${plan.shards.length}");

    expect(qaShardJob["timeout-minutes"]).toBe(150);
    expect(qaShardJob.needs).toEqual(["validate_selected_ref", "plan_qa_profile"]);
    expect(qaShardJob.strategy).toMatchObject({
      "fail-fast": false,
      "max-parallel": 8,
      matrix: "${{ fromJSON(needs.plan_qa_profile.outputs.matrix) }}",
    });
    const ensurePlaywrightStep = qaShardJob.steps.find(
      (step: WorkflowStep) => step.name === "Ensure Playwright Chromium",
    );
    expect(ensurePlaywrightStep.run).toContain("scripts/ensure-playwright-chromium.mts");
    expect(ensurePlaywrightStep.run).toContain("scripts/ensure-playwright-chromium.mjs");
    const runProfileStep = qaShardJob.steps.find(
      (step: WorkflowStep) => step.name === "Run QA profile shard",
    );
    expect(runProfileStep.env?.OPENCLAW_QA_ALLOW_UPDATE_RUN_SELF).toBe("1");
    expect(runProfileStep.env?.OPENCLAW_QA_CREDENTIAL_ACQUIRE_TIMEOUT_MS).toBe("120000");
    expect(runProfileStep.env?.PROTOCOL_SINCE_BASE_SHA).toBe(
      "${{ needs.validate_selected_ref.outputs.protocol_base_revision }}",
    );
    expect(runProfileStep.env?.REQUESTED_REF).toBe("${{ inputs.trusted_ref || inputs.ref }}");
    expect(runProfileStep.env?.TARGET_SHA).toBe(
      "${{ needs.validate_selected_ref.outputs.selected_revision }}",
    );
    expect(runProfileStep.run).toContain("--concurrency 3");
    expect(runProfileStep.run).toContain("--fast");
    expect(runProfileStep.run).toContain(
      'output_dir="${GITHUB_WORKSPACE}/selected/.artifacts/qa-e2e/',
    );
    expect(runProfileStep.run).toContain('mkdir -p "$output_dir"');
    expect(runProfileStep.run.indexOf('mkdir -p "$output_dir"')).toBeLessThan(
      runProfileStep.run.indexOf('echo "output_dir=${output_dir}" >> "$GITHUB_OUTPUT"'),
    );
    expect(runProfileStep.run).toContain(
      "LC_ALL=C timeout --verbose --signal=TERM --kill-after=30s 110m",
    );
    expect(runProfileStep.run).toContain("qa_exit_code=$?");
    expect(runProfileStep.run).toContain('timeout_child_env+=("LC_ALL=$LC_ALL")');
    expect(runProfileStep.run).toContain('timeout_child_env+=("-u" "LC_ALL")');
    expect(runProfileStep.run).toContain(`bash -c 'exec "$@" 2>&3' bash`);
    expect(runProfileStep.run).toContain('3>&2 2>"$timeout_supervisor_fifo"');
    expect(runProfileStep.run).toContain('mkfifo "$timeout_supervisor_fifo"');
    expect(runProfileStep.run).toContain(
      'tee "$timeout_supervisor_log" <"$timeout_supervisor_fifo" >&2 &',
    );
    expect(runProfileStep.run).toContain("supervisor_tee_pid=$!");
    expect(runProfileStep.run).toContain("trap cleanup_timeout_supervisor EXIT");
    expect(runProfileStep.run).toContain(
      'rm -f "$timeout_supervisor_fifo" "$timeout_supervisor_log"',
    );
    expect(runProfileStep.run).not.toContain(">(tee");
    const teeWait = runProfileStep.run.indexOf('wait "$supervisor_tee_pid"');
    const timeoutClassification = runProfileStep.run.indexOf(
      'grep -Eq "^timeout: sending signal KILL',
    );
    expect(teeWait).toBeGreaterThan(-1);
    expect(teeWait).toBeLessThan(timeoutClassification);
    expect(runProfileStep.run).toContain(
      `[[ "$qa_exit_code" -eq 137 ]] && grep -Eq "^timeout: sending signal KILL to command '[A-Za-z0-9_./+-]+'$"`,
    );
    expect(runProfileStep.run).toContain(
      `[[ "$qa_exit_code" -eq 124 ]] && grep -Eq "^timeout: sending signal TERM to command '[A-Za-z0-9_./+-]+'$"`,
    );
    expect(runProfileStep.run).not.toContain('case "$qa_exit_code"');
    expect(runProfileStep.run).toContain('TIMEOUT_OUTCOME="$timeout_outcome"');
    expect(runProfileStep.run).toContain("qa-profile-run-status.json");
    expect(runProfileStep.run).toContain("protocolBaseSha: process.env.PROTOCOL_SINCE_BASE_SHA");
    expect(runProfileStep.run).toContain("exitCode: Number(process.env.QA_EXIT_CODE)");
    expect(runProfileStep.run).toContain('timedOut: process.env.TIMEOUT_OUTCOME !== "none"');
    expect(runProfileStep.run).toContain("timeoutOutcome: process.env.TIMEOUT_OUTCOME");
    expect(runProfileStep.run).toContain("completedAt: new Date().toISOString()");
    expect(runProfileStep.run).toContain("id: process.env.QA_SHARD_ID");
    expect(runProfileStep.run).toContain("scenarioIds: JSON.parse(process.env.SCENARIO_IDS_JSON)");
    expect(runProfileStep.run).not.toContain("--allow-failures");

    const shardEvidenceStep = qaShardJob.steps.find(
      (step: WorkflowStep) => step.name === "Validate QA profile shard evidence",
    );
    expect(shardEvidenceStep.if).toBe("always()");
    expect(shardEvidenceStep.run).toContain("qaProfileEvidencePlan.attest");
    const shardUploadStep = qaShardJob.steps.find(
      (step: WorkflowStep) => step.name === "Upload QA profile shard evidence",
    );
    expect(shardUploadStep.if).toBe("always()");
    expect(shardUploadStep.with).toMatchObject({
      name: "qa-profile-evidence-shard-${{ matrix.id }}-${{ needs.validate_selected_ref.outputs.selected_revision }}",
      path: "${{ steps.run_profile.outputs.output_dir }}",
      "if-no-files-found": "error",
    });

    expect(qaAggregateJob.needs).toEqual([
      "validate_selected_ref",
      "plan_qa_profile",
      "run_qa_profile_shard",
    ]);
    expect(qaAggregateJob.if.replace(/\s+/gu, " ")).toBe(
      "${{ always() && needs.validate_selected_ref.result == 'success' && needs.plan_qa_profile.result == 'success' }}",
    );
    const aggregateDownloadStep = qaAggregateJob.steps.find(
      (step: WorkflowStep) => step.name === "Download QA profile shard evidence",
    );
    expect(aggregateDownloadStep.with).toMatchObject({
      pattern:
        "qa-profile-evidence-shard-*-${{ needs.validate_selected_ref.outputs.selected_revision }}",
      path: "selected/.artifacts/qa-profile-shards",
      "merge-multiple": false,
    });
    const aggregateStep = qaAggregateJob.steps.find(
      (step: WorkflowStep) => step.name === "Aggregate validated shard evidence",
    );
    expect(aggregateStep.run).toContain(
      "Expected ${SHARD_COUNT} completed status and evidence files",
    );
    expect(aggregateStep.run).toContain("Timed-out QA shard cannot contribute partial evidence");
    expect(aggregateStep.run).toContain("-mindepth 2 -maxdepth 2");
    expect(aggregateStep.run).toContain("aggregateQaProfileEvidenceShards");
    expect(aggregateStep.run).toContain("if jq -e '.timedOut == true'");
    expect(aggregateStep.env?.OUTPUT_DIR).toContain(
      "${{ github.workspace }}/selected/.artifacts/qa-e2e/",
    );
    const aggregateUploadStep = qaAggregateJob.steps.find(
      (step: WorkflowStep) => step.name === "Upload QA profile evidence",
    );
    expect(aggregateUploadStep.with?.path).toBe("${{ steps.aggregate.outputs.output_dir }}");

    const failProfileStep = qaAggregateJob.steps.find(
      (step: WorkflowStep) => step.name === "Fail if QA profile failed",
    );
    expect(failProfileStep.env?.ALLOW_FAILURES).toBe("${{ inputs.allow_failures }}");
    expect(failProfileStep.run).toContain('[[ -z "${QA_EXIT_CODE:-}" ]]');
    expect(failProfileStep.run).toContain(
      '[[ "$QA_EXIT_CODE" != "0" && "$ALLOW_FAILURES" != "true" ]]',
    );
    expect(failProfileStep.run).toContain('exit "$QA_EXIT_CODE"');
    expect(generateJob.needs).toEqual(["validate_selected_ref", "publisher_preflight"]);
    expect(generateJob.if.replace(/\s+/gu, " ")).toBe(
      "${{ always() && needs.validate_selected_ref.result == 'success' && (!inputs.publish_pull_request || needs.publisher_preflight.result == 'success') && inputs.qa_evidence_run_id == '' }}",
    );
    expect(generateJob.uses).toBe("./.github/workflows/qa-profile-evidence.yml");
    expect(generateJob.with).toMatchObject({
      ref: "${{ needs.validate_selected_ref.outputs.selected_revision }}",
      trusted_ref: "${{ inputs.ref }}",
      expected_sha: "${{ needs.validate_selected_ref.outputs.selected_revision }}",
      qa_profile: "all",
      allow_failures: "${{ inputs.allow_failures }}",
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
    expect(validateManifestStep.run).toMatch(
      /qaProfileEvidencePlan\.attest\(\s*evidence\.profilePlan,\s*manifest\.qaPassed === true,?\s*\)/u,
    );
    expect(validateManifestStep.run).toContain("profilePlanSha256");
    expect(validateManifestStep.run).toContain("rerun the QA Profile Evidence workflow");

    expect(qaAggregateJob.outputs.artifact_name).toBe(
      "${{ steps.evidence.outputs.artifact_name }}",
    );
    const qaEvidenceStep = qaAggregateJob.steps.find(
      (step: WorkflowStep) => step.name === "Finalize QA profile evidence",
    );
    expect(qaEvidenceStep.env.ARTIFACT_NAME).toBe(
      "qa-profile-evidence-${{ needs.plan_qa_profile.outputs.profile }}-${{ needs.validate_selected_ref.outputs.selected_revision }}",
    );
    expect(qaEvidenceStep.run).toContain("qa-profile-evidence-manifest.json");
    expect(qaEvidenceStep.run).toContain("validateQaEvidenceSummaryJson");
    expect(qaEvidenceStep.run).toMatch(
      /qaProfileEvidencePlan\.attest\(\s*payload\.profilePlan,\s*process\.env\.QA_EXIT_CODE === "0",?\s*\)/u,
    );
    expect(qaEvidenceStep.run).toContain("profilePlanSha256");
    expect(qaEvidenceStep.env.PROTOCOL_BASE_SHA).toBe(
      "${{ needs.validate_selected_ref.outputs.protocol_base_revision }}",
    );
    expect(qaEvidenceStep.env.REQUESTED_REF).toBe("${{ inputs.trusted_ref || inputs.ref }}");
    expect(qaEvidenceStep.env.ALLOW_FAILURES).toBe("${{ inputs.allow_failures }}");
    expect(qaEvidenceStep.run).toContain("qaExitCode: Number(process.env.QA_EXIT_CODE)");
    expect(qaEvidenceStep.run).toContain('qaPassed: process.env.QA_EXIT_CODE === "0"');
    expect(qaEvidenceStep.run).toContain('allowFailures: process.env.ALLOW_FAILURES === "true"');
    expect(qaEvidenceStep.run).toContain("protocolBaseSha: process.env.PROTOCOL_BASE_SHA");

    const qaUploadStep = qaAggregateJob.steps.find(
      (step: WorkflowStep) => step.name === "Upload QA profile evidence",
    );
    expect(qaUploadStep.if).toBe("always() && steps.evidence.outcome == 'success'");
    expect(qaUploadStep.with).toMatchObject({
      name: "qa-profile-evidence-${{ needs.plan_qa_profile.outputs.profile }}-${{ needs.validate_selected_ref.outputs.selected_revision }}",
      path: "${{ steps.aggregate.outputs.output_dir }}",
      "if-no-files-found": "error",
    });

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

    for (const stepName of ["Render artifact docs", "Render committed docs preview"]) {
      const renderStep = publishJob.steps.find((step: WorkflowStep) => step.name === stepName);
      expect(renderStep.env.ALLOW_FAILURES).toBe("${{ inputs.allow_failures }}");
      expect(renderStep.run).toContain('[[ "$ALLOW_FAILURES" == "true" ]]');
      expect(renderStep.run).toContain("allow_failures_args+=(--allow-failures)");
      expect(renderStep.run).toContain('"${allow_failures_args[@]}"');
    }
    const renderArtifactStep = publishJob.steps.find(
      (step: WorkflowStep) => step.name === "Render artifact docs",
    );
    expect(renderArtifactStep.run).toContain("QA failures allowed:");

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
    "round-trips profile evidence and rejects digest drift",
    () => {
      const qaWorkflow = readQaProfileEvidenceWorkflow();
      const maturityWorkflow = readMaturityScorecardWorkflow();
      const producerStep = qaWorkflow.jobs.aggregate_qa_profile.steps.find(
        (step: WorkflowStep) => step.name === "Finalize QA profile evidence",
      );
      const consumerStep = maturityWorkflow.jobs.publish.steps.find(
        (step: WorkflowStep) => step.name === "Validate QA evidence manifest",
      );
      const producerScript = expectDefined(producerStep?.run, "QA evidence producer script");
      const consumerScript = expectDefined(consumerStep?.run, "QA evidence consumer script");
      const root = tempDirs.make("openclaw-qa-profile-artifact-");
      const evidencePath = path.join(root, "qa-evidence.json");
      const manifestPath = path.join(root, "qa-profile-evidence-manifest.json");
      const protocolBaseSha = "b".repeat(40);
      const targetSha = "a".repeat(40);
      const expectedCell = {
        scenarioId: "scenario-one",
        executionKind: "flow",
        channel: null,
      };
      const scorecard = {
        filters: { surface: null, category: null },
        run: { evidenceEntryCount: 0 },
        categories: { total: 1, fulfilled: 1, partial: 0, missing: 0, fulfillmentPercent: 100 },
        features: { total: 1, fulfilled: 1, partial: 0, missing: 0, fulfillmentPercent: 100 },
        coverageIds: {
          total: 1,
          fulfilled: 1,
          missing: 0,
          fulfillmentPercent: 100,
        },
        categoryReports: [
          {
            id: "surface.category",
            surfaceId: "surface",
            name: "Category",
            status: "fulfilled",
            features: {
              total: 1,
              fulfilled: 1,
              partial: 0,
              missing: 0,
              fulfillmentPercent: 100,
            },
            coverageIds: {
              total: 1,
              fulfilled: 1,
              missing: 0,
              fulfillmentPercent: 100,
              secondaryOnly: 0,
            },
            missingCoverageIds: [],
          },
        ],
      };

      const writeEvidence = () => {
        writeFileSync(
          evidencePath,
          `${JSON.stringify({
            kind: "openclaw.qa.evidence-summary",
            schemaVersion: 2,
            generatedAt: "2026-08-05T00:00:00.000Z",
            evidenceMode: "full",
            entries: [],
            profile: "all",
            profilePlan: {
              profile: "all",
              membership: ["scenario-one"],
              selected: ["scenario-one"],
              excluded: [],
              expectedCells: [expectedCell],
              observedCells: [expectedCell],
              missingCells: [],
              counts: {
                membership: 1,
                selected: 1,
                excluded: 0,
                expectedCells: 1,
                observedCells: 1,
                missingCells: 0,
              },
            },
            scorecard,
          })}\n`,
          "utf8",
        );
      };
      const runProducer = (qaExitCode: string) =>
        runWorkflowShellScript(producerScript, {
          env: {
            ...process.env,
            ALLOW_FAILURES: "true",
            ARTIFACT_NAME: `qa-profile-evidence-all-${targetSha}`,
            GITHUB_OUTPUT: path.join(root, "github-output"),
            GITHUB_STEP_SUMMARY: path.join(root, "github-summary"),
            OUTPUT_DIR: root,
            PROTOCOL_BASE_SHA: protocolBaseSha,
            QA_EXIT_CODE: qaExitCode,
            QA_PROFILE: "all",
            REQUESTED_REF: targetSha,
            TARGET_SHA: targetSha,
            TRUSTED_REASON: "fixture",
          },
        });
      const runConsumer = () =>
        runWorkflowShellScript(consumerScript, {
          env: {
            ...process.env,
            QA_EVIDENCE_PATH: evidencePath,
            TARGET_SHA: targetSha,
          },
        });

      try {
        writeEvidence();
        const completeProducer = runProducer("0");
        expect(
          completeProducer.status,
          `${completeProducer.stdout}${completeProducer.stderr}`,
        ).toBe(0);
        const completeManifest = readFileSync(manifestPath, "utf8");
        expect(JSON.parse(completeManifest)).toMatchObject({
          protocolBaseSha,
          targetSha,
        });
        const manifest = JSON.parse(completeManifest) as Record<string, unknown>;
        manifest.profilePlanSha256 = "0".repeat(64);
        writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
        const mismatched = runConsumer();
        expect(mismatched.status).toBe(1);
        expect(`${mismatched.stdout}${mismatched.stderr}`).toContain(
          "QA evidence profilePlan digest does not match the manifest",
        );
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "suppresses only reported QA result failures when explicitly allowed",
    () => {
      expect(runQaProfileFailureGate({ allowFailures: false, qaExitCode: "7" }).status).toBe(7);
      expect(runQaProfileFailureGate({ allowFailures: true, qaExitCode: "7" }).status).toBe(0);
      expect(runQaProfileFailureGate({ allowFailures: true }).status).toBe(1);
      expect(runQaProfileFailureGate({ allowFailures: false, qaExitCode: "0" }).status).toBe(0);
    },
  );

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

  it("keeps exact release validation identity separate from release context", () => {
    const fullReleaseWorkflow = readWorkflow(".github/workflows/full-release-validation.yml");
    const releaseWorkflow = readReleaseChecksWorkflow();
    const telegramWorkflow = readWorkflow(".github/workflows/openclaw-release-telegram-qa.yml");
    const telegramProvenanceHelper = readFileSync("scripts/release-telegram-provenance.sh", "utf8");
    const fullReleaseDispatchStep = fullReleaseWorkflow.jobs.release_checks.steps.find(
      (step: WorkflowStep) => step.name === "Dispatch and monitor release checks",
    );
    const dispatchStep = releaseWorkflow.jobs.qa_live_telegram_release_checks.steps.find(
      (step: WorkflowStep) => step.name === "Dispatch and await trusted Telegram QA",
    );
    const identityStep = telegramWorkflow.jobs.trusted_identity.steps.find(
      (step: WorkflowStep) => step.name === "Verify dispatched-main identity",
    );
    const provenanceSteps = [
      telegramWorkflow.jobs.build_candidate.steps.find(
        (step: WorkflowStep) => step.name === "Validate candidate release provenance",
      ),
      telegramWorkflow.jobs.run_telegram.steps.find(
        (step: WorkflowStep) => step.name === "Revalidate candidate release provenance",
      ),
    ];

    expect(fullReleaseWorkflow.on.workflow_dispatch.inputs.target_context_ref).toMatchObject({
      required: false,
      default: "",
      type: "string",
    });
    expect(fullReleaseDispatchStep.run).toContain('-f ref="$TARGET_SHA"');
    expect(fullReleaseDispatchStep.run).toContain('-f target_context_ref="$TARGET_CONTEXT_REF"');
    expect(fullReleaseDispatchStep.run).not.toContain(
      'release_checks_target_ref="${TARGET_CONTEXT_REF:-$TARGET_REF}"',
    );
    expect(releaseWorkflow.on.workflow_dispatch.inputs.target_context_ref).toMatchObject({
      required: false,
      default: "",
      type: "string",
    });
    expect(telegramWorkflow.on.workflow_dispatch.inputs.target_context_ref).toMatchObject({
      required: false,
      default: "",
      type: "string",
    });
    expect(dispatchStep.env.TARGET_SHA).toBe("${{ needs.resolve_target.outputs.revision }}");
    expect(dispatchStep.env.TARGET_CONTEXT_REF).toBe("${{ inputs.target_context_ref }}");
    expect(dispatchStep.run).toContain('-f target_context_ref="$TARGET_CONTEXT_REF"');
    expect(dispatchStep.run).toContain('-f target_ref="$TARGET_SHA"');
    expect(dispatchStep.run).not.toContain("telegram_target_ref=");
    expect(identityStep.run).toContain(
      "Telegram QA target context must be a canonical release branch or tag.",
    );
    expect(identityStep.run).toContain(
      "Telegram QA release context requires an exact-SHA target ref.",
    );
    for (const provenanceStep of provenanceSteps) {
      expect(provenanceStep.env.TARGET_CONTEXT_REF).toBe("${{ inputs.target_context_ref }}");
      expect(provenanceStep.run.trim()).toBe(
        'bash "${GITHUB_WORKSPACE}/scripts/release-telegram-provenance.sh"',
      );
    }
    expect(telegramProvenanceHelper).toContain(
      'if [[ "$candidate_version" == "$release_version" ]]; then',
    );
    expect(telegramProvenanceHelper).toContain(
      'elif [[ "$candidate_version" =~ ^${release_version_pattern}-beta\\.[0-9]+$ ]]; then',
    );
    expect(telegramProvenanceHelper).toContain(
      'frozen_release_branch_pattern="^release/${candidate_version_pattern}-code-frozen(-r[1-9][0-9]*)?$"',
    );
    expect(telegramProvenanceHelper).toContain(
      '"$TARGET_REF" =~ ^[a-f0-9]{40}$ && "$TARGET_REF" == "$candidate_sha"',
    );
    expect(telegramProvenanceHelper).toContain('trusted_reason="frozen-release-branch-head"');
    expect(telegramProvenanceHelper).toContain(
      '"$signature_status" != "valid" || "$signer" == "web-flow"',
    );
    expect(telegramProvenanceHelper).toContain('context_release_branch="$normalized_context_ref"');
    expect(telegramProvenanceHelper).toContain('context_release_tag="$normalized_context_ref"');
    expect(telegramProvenanceHelper).toContain(
      "Telegram candidate version ${candidate_version} does not belong to release ${release_version}.",
    );
    expect(telegramProvenanceHelper).toContain(
      "Telegram candidate version ${candidate_version} does not match context ${normalized_context_ref}.",
    );
    expect(telegramProvenanceHelper).toContain(
      'select(.state == "OPEN" and .headRepository.nameWithOwner == $repo and',
    );
    expect(telegramProvenanceHelper).toContain(
      'select(.state == "MERGED" and .baseRepository.nameWithOwner == $repo and',
    );
    expect(telegramProvenanceHelper).toContain(".mergeCommit.oid == $sha)]");
    expect(telegramProvenanceHelper).toContain(
      'if [[ "$(jq \'length\' <<<"$matching_merge_prs")" != "1" ]]; then',
    );
    expect(telegramProvenanceHelper).toContain(
      'if [[ "$permission" != "admin" && "$role_name" != "maintain" ]]; then',
    );
    expect(telegramProvenanceHelper).not.toContain(".baseRefName ==");
  });

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
      surfaces: Array<{ id: string; categories: Array<{ id: string }> }>;
    };
    const taxonomyCategoryIds = taxonomy.surfaces.flatMap((surface) =>
      surface.categories.map((category) => `${surface.id}.${category.id}`),
    );
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
    expect(taxonomyCategoryIds.length).toBeGreaterThan(0);
    for (const categoryId of taxonomyCategoryIds) {
      expect(ciWorkflowText).not.toContain(`"${categoryId}"`);
    }
    expect(runStep.run).toContain("bundled-protocol)");
    expect(runStep.run).not.toContain("qa-smoke-ci)");
    expect(runStep.run).toContain("contracts-plugins-ci-routing)");
    expect(runStep.run).toContain("ci-routing)");
    expect(fastCoreJob["runs-on"]).toContain("matrix.runner");
    expect(smokeProfileJob.name).toBe("QA Smoke CI (${{ matrix.name }})");
    // Leak invariant: dist must never be packed after the private overlay
    // build. Today that holds vacuously — the smoke set has no docker-lane
    // scenario, so the step performs exactly one private build and no pack;
    // the run step fails closed if a docker-lane scenario returns.
    expect(smokeBuildStep.run).toContain("OPENCLAW_BUILD_PRIVATE_QA=1 pnpm build qaRuntime");
    expect(smokeBuildStep.run.match(/pnpm build qaRuntime/g)).toHaveLength(1);
    expect(smokeBuildStep.run).not.toContain("package-openclaw-for-docker");
    expect(smokeBuildStep.run).not.toContain("npm pack");
    expect(smokeBuildStep.env).not.toHaveProperty("OPENCLAW_BUILD_PRIVATE_QA");
    const smokePlanRunStep = smokeProfileJob.steps.find(
      (step: WorkflowStep) => step.name === "Run smoke profile part",
    );
    expect(smokePlanRunStep.run).toContain("restore the public pack step in ci.yml");
    expect(smokePlanRunStep.run).not.toContain("OPENCLAW_CURRENT_PACKAGE_TGZ");
    expect(workflow.jobs["qa-smoke-ci-artifacts"]).toBeUndefined();
    expect(workflow.jobs["qa-smoke-ci"]).toBeUndefined();
    expect(smokeProfileJob.needs).toEqual(["preflight"]);
    expect(smokeProfileJob.strategy["max-parallel"]).toBe(
      "${{ (vars.OPENCLAW_CI_RUNNER_BACKEND == 'github' || vars.OPENCLAW_CI_RUNNER_BACKEND == 'hybrid') && 6 || 4 }}",
    );
    expect(smokeProfileJob.strategy.matrix).toBe(
      "${{ fromJson(needs.preflight.outputs.qa_smoke_ci_matrix) }}",
    );
    const qaMatrices = Object.fromEntries(
      (["blacksmith", "github", "hybrid"] as const).map((runnerBackend) => {
        const manifest = runCiManifestFixture({
          bundledPlanner: true,
          eventName: "push",
          historicalCompatibility: false,
          runnerBackend,
        });
        expect(manifest.status, manifest.output).toBe(0);
        return [
          runnerBackend,
          JSON.parse(
            expectDefined(manifest.outputs.qa_smoke_ci_matrix, `${runnerBackend} QA smoke matrix`),
          ).include,
        ];
      }),
    ) as Record<
      "blacksmith" | "github" | "hybrid",
      Array<{ docker_cache?: boolean; slug: string }>
    >;
    expect(qaMatrices.blacksmith.map((entry) => entry.slug)).toEqual([
      "profile-1-of-4",
      "profile-2-of-4",
      "profile-3-of-4",
      "profile-4-of-4",
    ]);
    expect(qaMatrices.github.map((entry) => entry.slug)).toEqual([
      "profile-1-of-6",
      "profile-2-of-6",
      "profile-3-of-6",
      "profile-4-of-6",
      "profile-5-of-6",
      "profile-6-of-6",
    ]);
    expect(qaMatrices.hybrid).toEqual(qaMatrices.github);
    // The smoke set has no docker-lane scenarios; no part requests a Docker
    // layer cache in any backend shape.
    expect(qaMatrices.blacksmith.filter((entry) => entry.docker_cache)).toEqual([]);
    expect(qaMatrices.github.filter((entry) => entry.docker_cache)).toEqual([]);
    for (const [runnerBackend, expected] of [
      ["blacksmith", 4],
      ["github", 6],
      ["hybrid", 6],
    ] as const) {
      expect(
        evaluateWorkflowExpression(smokeProfileJob.strategy["max-parallel"], {
          eventName: "push",
          repository: "openclaw/openclaw",
          runnerBackend,
          runAttempt: 1,
        }),
      ).toBe(expected);
    }
    expect(smokeProfileJob["runs-on"]).toContain("blacksmith-16vcpu-ubuntu-2404");
    expect(smokeDockerCacheStep).toBeUndefined();
    expect(smokeRunStep.run).toContain("createQaSmokeCiPart");
    expect(smokeRunStep.run).toContain("createQaSmokeCiPart(partId, partCount)");
    expect(smokeRunStep.env.PROFILE_PART_COUNT).toBe("${{ matrix.part_count }}");
    expect(smokeRunStep.run).toContain("createQaSmokeCiMatrix");
    expect(smokeRunStep.run).toContain("readQaScenarioPack");
    expect(smokeRunStep.run).toContain("isolate each scenario");
    expect(smokeRunStep.run).toContain("scenario_ids: [scenarioId]");
    expect(smokeRunStep.run).not.toContain("scenarioIdsByKind");
    const compatibilityScenarioBlock = smokeRunStep.run.match(
      /const compatibilityScenarioIds = new Set\(\[([\s\S]*?)\]\);/u,
    )?.[1];
    expect(compatibilityScenarioBlock?.match(/^\s+"[^"]+",$/gmu)).toHaveLength(11);
    expect(compatibilityScenarioBlock).not.toContain('"dreaming-shadow-trial-report"');
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
      "vars.OPENCLAW_CI_RUNNER_BACKEND != 'github'",
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
    expect(smokeRunStep.run).toContain("--max-old-space-size=16384");
    expect(smokeRunStep.run).not.toContain("scripts/build-all.mts qaRuntime");
    expect(smokeRunStep.run).not.toContain("OPENAI_API_KEY");
    expect(smokeUploadStep.if).toBe("always()");
    expect(smokeUploadStep.with).toMatchObject({
      path: ".artifacts/qa-e2e/smoke-ci-profile-${{ matrix.slug }}/",
      "if-no-files-found": "warn",
    });
    expect(runStep.run.match(/src\/scripts\/ci-changed-scope\*\.test\.ts/g)).toHaveLength(2);
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

  it("skips generated-asset validation only when a frozen candidate lacks the contract", () => {
    const workflow = readCiWorkflow();
    const buildArtifactsJob = workflow.jobs["build-artifacts"];
    const assetCheckStep = buildArtifactsJob.steps.find(
      (step: WorkflowStep) => step.name === "Check bundled plugin generated assets",
    );

    expect(assetCheckStep.run).toContain('packageJson.scripts?.["plugins:assets:check"]');
    expect(assetCheckStep.run).toContain("pnpm plugins:assets:check");
    expect(assetCheckStep.run).toContain("predates plugins:assets:check");
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
