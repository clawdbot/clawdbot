// Ci Workflow Guards tests cover ci workflow guards script behavior.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import { connect } from "node:net";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { expectDefined } from "@openclaw/normalization-core";
import { minimatch } from "minimatch";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  detectChangedScope,
  detectNodeFastScope,
  shouldRunNativeI18n,
  writeGitHubOutput,
} from "../../scripts/ci-changed-scope.mjs";
import { resolveShardPlans, runShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import { createNodeTestShardBundles } from "../../scripts/lib/ci-node-test-plan.mts";
import { visitModuleSpecifiers } from "../../scripts/lib/guard-inventory-utils.mjs";
import { pnpmLockfileDocuments } from "../../scripts/lib/pnpm-lockfile-documents.mjs";
import { resolveRunVitestSpawnEnv } from "../../scripts/lib/vitest-process-env.mts";
import { NATIVE_I18N_LOCALES } from "../../scripts/native-i18n-locales.ts";
import { resolvePnpmRunner } from "../../scripts/pnpm-runner.mts";
import {
  BOUNDARY_CHECKS,
  selectChecksForShard,
} from "../../scripts/run-additional-boundary-checks.mts";
import { createTempDirTracker, useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { sharedVitestConfig } from "../vitest/vitest.shared.config.ts";
import {
  createUiE2eVitestConfig,
  uiE2ePrivateServerTestFiles,
  uiE2eRealGatewayTestFiles,
  uiE2eRuntimeBudgetTestFile,
  uiE2eSerialTestFiles,
} from "../vitest/vitest.ui-e2e.config.ts";
import { runCiGitStep } from "./ci-git-owner.test-support.js";
import { runGeneratedPublisherScenario } from "./generated-publisher.test-support.js";

const CHECKOUT_V6 = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const CACHE_V5 = "actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9";
const CACHE_SAVE_V5 = "actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9";
const SETUP_GRADLE_V6 = "gradle/actions/setup-gradle@9c971963bec38e04b3d30dcc455b5382be2fdbfb";
const SETUP_GO_V6 = "actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e";
const UPLOAD_ARTIFACT_V7 = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const DOWNLOAD_ARTIFACT_V8 = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const CREATE_GITHUB_APP_TOKEN_V3 =
  "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1";
const MANTIS_MANUAL_ONLY_WORKFLOWS = [
  ".github/workflows/mantis-web-ui-chat-proof.yml",
  ".github/workflows/mantis-discord-status-reactions.yml",
  ".github/workflows/mantis-discord-thread-attachment.yml",
] as const;
const TRUFFLEHOG_V3_95_9 = "trufflesecurity/trufflehog@bcfcf73aaf4759d4dadc2783177c245a02792318";
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
const rootPackageManager = (
  JSON.parse(readFileSync("package.json", "utf8")) as {
    packageManager: string;
  }
).packageManager;
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
  "continue-on-error"?: boolean;
  env?: Record<string, unknown>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  "working-directory"?: string;
};

const readCiWorkflow = (() => {
  // The checked-in workflow is fixed for this suite; clones keep fixture mutations local.
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  return () => structuredClone(workflow);
})();

function evaluateWorkflowExpression(
  expression: unknown,
  context: {
    action?: string;
    // Runner routing keys off contributor trust, so pull-request cases default
    // to CONTRIBUTOR: same-repo PRs always come from someone with write access.
    authorAssociation?: string;
    cancelled?: boolean;
    dispatchId?: string;
    draft?: boolean;
    eventName: "pull_request" | "push" | "workflow_dispatch" | "repository_dispatch" | "schedule";
    failed?: boolean;
    env?: Record<string, string>;
    frozenTarget?: boolean;
    fileHashes?: Record<string, string>;
    headRepository?: string;
    headSha?: string;
    hostedRunnerProfileContract?: boolean;
    matrix?: Record<string, unknown>;
    preflightOutputs?: Record<string, string>;
    pullRequestNumber?: number;
    ref?: string;
    resolveTargetOutputs?: Record<string, string>;
    releaseGate?: boolean;
    releaseScope?: string;
    repository: string;
    runCheck?: boolean;
    runnerBackend?: "" | "blacksmith" | "github" | "hybrid";
    runnerEnvironment?: "" | "github-hosted" | "self-hosted";
    runnerProfile?: "blacksmith" | "github" | "hybrid";
    runAttempt: number;
    runId?: number;
    runNumber?: number;
    sha?: string;
    steps?: Record<string, { outputs: Record<string, string> }>;
    targetContextRef?: string;
    targetRef?: string;
    useGithubHostedRunners?: boolean;
    workflow?: string;
    workflowSha?: string;
    workflowToken?: string;
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
  // Actions permits dashes in property names; preserve quoted literals while
  // translating those accesses for the JavaScript fixture evaluator.
  const evaluableSource = source.replace(
    /'(?:[^']|'')*'|\.([A-Za-z_][\w-]*)/gu,
    (token: string, property: string | undefined) =>
      property?.includes("-") ? `[${JSON.stringify(property)}]` : token,
  );
  return runInNewContext(evaluableSource, {
    always: () => true,
    failure: () => context.failed ?? false,
    cancelled: () => context.cancelled ?? false,
    // GitHub expression builtins the runner-routing clauses use.
    contains: (haystack: unknown, needle: unknown) =>
      Array.isArray(haystack)
        ? haystack.includes(needle)
        : String(haystack).includes(String(needle)),
    endsWith: (value: unknown, suffix: unknown) =>
      String(value).toLowerCase().endsWith(String(suffix).toLowerCase()),
    fromJSON: (value: string) => JSON.parse(value) as unknown,
    format: (value: string, ...args: unknown[]) =>
      value.replace(/\{(\d+)\}/gu, (_match, index: string) => String(args[Number(index)])),
    hashFiles: (file: string) => context.fileHashes?.[file] ?? "",
    startsWith: (value: unknown, prefix: unknown) => String(value).startsWith(String(prefix)),
    toJson: (value: unknown) => JSON.stringify(value),
    github: {
      event_name: context.eventName,
      repository: context.repository,
      ref: context.ref ?? "refs/heads/main",
      run_attempt: context.runAttempt,
      run_id: context.runId,
      run_number: context.runNumber,
      sha: context.sha,
      workflow: context.workflow,
      workflow_sha: context.workflowSha,
      token: context.workflowToken,
      event:
        context.headRepository || context.eventName === "pull_request"
          ? {
              action: context.action,
              pull_request: {
                author_association: context.authorAssociation ?? "CONTRIBUTOR",
                draft: context.draft ?? false,
                number: context.pullRequestNumber,
                head: {
                  sha: context.headSha,
                  repo: { full_name: context.headRepository ?? context.repository },
                },
              },
            }
          : {},
    },
    inputs: {
      dispatch_id: context.dispatchId ?? "",
      release_gate: context.releaseGate ?? false,
      release_scope: context.releaseScope ?? "full",
      target_context_ref: context.targetContextRef ?? "",
      target_ref: context.targetRef ?? "",
      use_github_hosted_runners: context.useGithubHostedRunners ?? false,
    },
    env: context.env ?? {},
    matrix: context.matrix ?? {},
    runner: { environment: context.runnerEnvironment ?? "" },
    steps: context.steps ?? {},
    needs: {
      resolve_target: { outputs: context.resolveTargetOutputs ?? {} },
      preflight: {
        outputs: {
          frozen_target: String(context.frozenTarget ?? false),
          hosted_runner_profile_contract: String(context.hostedRunnerProfileContract ?? true),
          run_check: String(context.runCheck ?? true),
          runner_profile: context.runnerProfile ?? context.runnerBackend ?? "blacksmith",
          ...context.preflightOutputs,
        },
      },
    },
    vars: {
      OPENCLAW_CI_RUNNER_BACKEND: context.runnerBackend ?? "",
    },
  });
}

function runCiGateFixture(jobResults: string) {
  const gateStep = readCiWorkflow().jobs["ci-gate"].steps.find(
    (step: WorkflowStep) => step.name === "Verify selected CI lanes",
  );
  return spawnSync("bash", ["-c", gateStep.run], {
    encoding: "utf8",
    env: {
      ...process.env,
      JOB_RESULTS: jobResults,
    },
  });
}

function renderCiGateEnvironment(
  context: Partial<Parameters<typeof evaluateWorkflowExpression>[1]> = {},
  results: Record<string, string> = {},
) {
  const workflow = readCiWorkflow();
  const step = workflow.jobs["ci-gate"].steps.find(
    (candidate: WorkflowStep) => candidate.name === "Verify selected CI lanes",
  );
  const preflightOutputs = {
    ...Object.fromEntries(
      Object.keys(workflow.jobs.preflight.outputs)
        .filter((key) => key.startsWith("run_"))
        .map((key) => [key, "true"]),
    ),
    compatibility_target: "false",
    release_scope: "full",
    ...context.preflightOutputs,
  };
  const jobResults: string = step.env.JOB_RESULTS;
  return jobResults.replace(/\$\{\{[\s\S]*?\}\}/gu, (expression) => {
    const result = expression.match(/^\$\{\{\s*needs\.([\w-]+)\.result\s*\}\}$/u);
    if (result) {
      return results[expectDefined(result[1], expression)] ?? "success";
    }
    return String(
      evaluateWorkflowExpression(expression, {
        eventName: "workflow_dispatch",
        repository: "openclaw/openclaw",
        runAttempt: 1,
        ...context,
        preflightOutputs,
      }) ?? "",
    );
  });
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function runPreflightNodeInvocation(
  script: string,
  options: {
    checkoutRevision: string;
    eventName: "pull_request" | "push" | "workflow_dispatch";
    workflowRevision: string;
  },
) {
  const root = tempDirs.make("openclaw-preflight-runtime-");
  const binDir = path.join(root, "bin");
  const argsPath = path.join(root, "node-args");
  mkdirSync(binDir, { recursive: true });
  const nodePath = path.join(binDir, "node");
  writeFileSync(
    nodePath,
    '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$OPENCLAW_NODE_ARGS"\ncat >/dev/null\n',
  );
  chmodSync(nodePath, 0o755);
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: options.eventName,
      OPENCLAW_CI_CHECKOUT_REVISION: options.checkoutRevision,
      OPENCLAW_CI_WORKFLOW_REVISION: options.workflowRevision,
      OPENCLAW_NODE_ARGS: argsPath,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return readFileSync(argsPath, "utf8").trim().split("\n");
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
        /node (?:(?:--import tsx |"\$\{manifest_node_args\[@\]\}" ))?--input-type=module <<'([A-Z][A-Z0-9_]*)'\n([\s\S]*?)\n\1(?=\n|$)/gu,
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
      // Child caches and temporary artifacts share the fixture's cleanup owner.
      // Inheriting a huge host tsx cache makes startup depend on unrelated runs.
      env: { ...(options.env ?? process.env), TMPDIR: root, TMP: root, TEMP: root },
    });
  } finally {
    for (const modulePath of modulePaths) {
      rmSync(modulePath, { force: true });
    }
    rmSync(root, { force: true, recursive: true });
  }
}

function runCiChangedScopeFixture(changedPaths: string[]): Record<string, string> {
  const outputPath = path.join(tempDirs.make("openclaw-ci-scope-"), "scope.out");
  writeGitHubOutput(
    detectChangedScope(changedPaths),
    outputPath,
    undefined,
    detectNodeFastScope(changedPaths),
    shouldRunNativeI18n(changedPaths),
    changedPaths,
  );
  return Object.fromEntries(
    readFileSync(outputPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function runCiManifestFixture(options: {
  bundledPlanner: boolean;
  nodeTestShards?: Record<string, unknown>[];
  nodeTestGroupsCodec?: boolean;
  changedPlannerSource?: string | null;
  changedPaths?: string[] | null;
  changedCoreTestSupport?: boolean;
  repository?: string;
  eventName?: "pull_request" | "push" | "workflow_dispatch";
  historicalCompatibility?: boolean;
  iosCapabilities?: boolean;
  iosBuildCapability?: boolean;
  androidCiCapabilities?: boolean;
  nativeI18nCapabilities?: boolean;
  macosNodeParts?: boolean;
  openClawKitTests?: boolean;
  protocolCoverage?: boolean;
  packageVersion?: string;
  qaSmokePlan?: boolean;
  formatCheck?: boolean;
  releaseCandidateCompatibility?: boolean;
  releaseGate?: boolean;
  targetContextCompatibility?: boolean;
  nodeFastOnly?: boolean;
  nodeFastPluginContracts?: boolean;
  nodeFastCiRouting?: boolean;
  runNode?: boolean;
  historicalReader?: boolean;
  runnerBackend?: "blacksmith" | "github" | "hybrid";
  runnerProfile?: "blacksmith" | "github" | "hybrid";
  targetHostedRunnerProfileContract?: boolean;
  uiE2eProjectsCapability?: boolean;
  remoteTagRefs?: Record<string, string>;
  scopeEnv?: Record<string, string>;
}) {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-ci-manifest-"));
  try {
    const scriptsDir = path.join(root, "scripts", "lib");
    mkdirSync(scriptsDir, { recursive: true });
    // The manifest packs grouped Node rows through the target's codec and the
    // shard runner unpacks them; targets that predate the codec omit it.
    if (options.nodeTestGroupsCodec ?? true) {
      writeFileSync(
        path.join(scriptsDir, "ci-node-test-groups-codec.mts"),
        readFileSync("scripts/lib/ci-node-test-groups-codec.mts"),
      );
    }
    writeFileSync(
      path.join(scriptsDir, "ci-node-test-plan.mts"),
      options.nodeTestShards
        ? `export const createNodeTestShards = () => ${JSON.stringify(options.nodeTestShards)};
           export const createNodeTestShardBundles = createNodeTestShards;`
        : options.bundledPlanner
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
            includePatterns: options.changedPaths,
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
    if (options.changedCoreTestSupport) {
      for (const file of [
        "scripts/changed-lanes.mts",
        "scripts/lib/changed-path-facts.mjs",
        "scripts/lib/arg-utils.mts",
        "scripts/lib/arg-utils.runtime.mjs",
        "scripts/lib/direct-run.mjs",
        "scripts/lib/merge-head-diff-base.mjs",
        "scripts/lib/record-shared.mjs",
        "packages/normalization-core/src/stable-stringify.ts",
        "scripts/run-tsgo-core-test-shards.mts",
        "scripts/run-additional-boundary-checks.mts",
      ]) {
        const target = path.join(root, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(file));
      }
    }
    const iosCapabilities = options.iosCapabilities ?? options.bundledPlanner;
    const iosBuildCapability = options.iosBuildCapability ?? iosCapabilities;
    const nativeI18nCapabilities = options.nativeI18nCapabilities ?? options.bundledPlanner;
    const macosNodeParts = options.macosNodeParts ?? options.bundledPlanner;
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
          ...(macosNodeParts
            ? Object.fromEntries([1, 2, 3].map((part) => [`test:macos:ci:${part}`, "true"]))
            : {}),
          "check:assertion-safety": "true",
          "check:max-lines-ratchet": "true",
        }
      : {};
    writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify({ version: options.packageVersion, scripts: packageScripts })}\n`,
    );
    if (options.bundledPlanner && options.changedPlannerSource !== null) {
      writeFileSync(
        path.join(scriptsDir, "ci-changed-node-test-plan.mts"),
        options.changedPlannerSource ??
          `
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
                    predictedSeconds: 120,
                  }]
                : [{
                  checkName: "changed-extension-fallback-plan",
                  configs: [],
                  requiresDist: false,
                  runner: "ubuntu-24.04",
                  shardName: "changed-extension-fallback-plan",
                  predictedSeconds: 120,
                  targets: ["extensions/codex/src/focused.test.ts"],
                }]
              : [];
          export const hasBuildArtifactAffectingChange = (changedPaths) =>
            !changedPaths.includes("test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts");
          export const hasSqliteSessionLifecycleAffectingChange = (changedPaths) =>
            changedPaths.includes("src/sqlite-session-owner.ts") ||
            changedPaths.includes("test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts");
          export const resolveChangedDockerSeedLanes = (changedPaths) => changedPaths.includes("scripts/e2e/docker-openai-seed.ts") ? ["mcp-channels", "cron-mcp-cleanup"] : [];
        `,
        "utf8",
      );
    }
    if (options.bundledPlanner) {
      const sqliteLifecycleProof = path.join(
        root,
        "test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts",
      );
      mkdirSync(path.dirname(sqliteLifecycleProof), { recursive: true });
      writeFileSync(sqliteLifecycleProof, "export {};\n");
      writeFileSync(
        path.join(scriptsDir, "channel-contract-test-plan.mts"),
        `export const createChannelContractTestShards = () => ["a", "b"].map((suffix) => ({
          checkName: "channel-contracts-" + suffix,
          includePatterns: ["src/channels/plugins/contracts/fixture-" + suffix + ".test.ts"],
          runtime: "node",
          task: "contracts-channels",
        }));\n`,
      );
      writeFileSync(
        path.join(scriptsDir, "plugin-contract-test-plan.mts"),
        `export const createPluginContractTestShards = () => ["a", "b"].map((suffix) => ({
          checkName: "plugin-contracts-" + suffix,
          includePatterns: ["src/plugins/contracts/fixture-" + suffix + ".test.ts"],
          runtime: "node",
          task: "contracts-plugins",
        }));\n`,
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
        ...(options.bundledPlanner ? ["docker-seed-e2e-contract-v1"] : []),
        ...((options.targetHostedRunnerProfileContract ?? options.bundledPlanner)
          ? ["hosted-runner-profile-contract-v1"]
          : []),
      ].join("\n"),
    );
    const uiE2eConfig = path.join(root, "test", "vitest", "vitest.ui-e2e.config.ts");
    mkdirSync(path.dirname(uiE2eConfig), { recursive: true });
    writeFileSync(
      uiE2eConfig,
      (options.uiE2eProjectsCapability ?? options.bundledPlanner)
        ? "// ui-e2e-projects-contract-v1\n"
        : 'export default { test: { name: "ui-e2e" } };\n',
    );
    const outputPath = path.join(root, "manifest.out");
    const summaryPath = path.join(root, "summary.md");
    const gitOwner = ".github/actions/git-owner";
    const trustedGitOwner = path.join(root, ".ci-harness", gitOwner);
    mkdirSync(trustedGitOwner, { recursive: true });
    for (const name of ["test-prerequisites.mjs", "test-prerequisites.json"]) {
      writeFileSync(path.join(trustedGitOwner, name), readFileSync(path.join(gitOwner, name)));
    }
    const trustedReleasePolicy = path.join(root, ".ci-harness/scripts/lib");
    mkdirSync(trustedReleasePolicy, { recursive: true });
    for (const name of ["release-context.mjs", "release-version.mjs"]) {
      writeFileSync(path.join(trustedReleasePolicy, name), readFileSync(`scripts/lib/${name}`));
    }
    const fixtureBin = path.join(root, "bin");
    let correctionBaseSha = "";
    if (options.remoteTagRefs) {
      mkdirSync(fixtureBin);
      const ghFixture = path.join(root, "gh.mjs");
      writeFileSync(
        ghFixture,
        `
        const [command, endpoint, queryFlag, query] = process.argv.slice(2);
        const baseRef = ${JSON.stringify(`refs/tags/v${options.packageVersion}`)};
        if (process.env.GH_TOKEN !== "test-token" || command !== "api" ||
            endpoint !== "repos/openclaw/openclaw/commits/" + encodeURIComponent(baseRef) ||
            queryFlag !== "--jq" || query !== ".sha") {
          throw new Error("Expected authenticated, fully qualified correction base lookup");
        }
        const refs = ${JSON.stringify(options.remoteTagRefs)};
        if (!refs[baseRef]) throw new Error("gh: Not Found (HTTP 404)");
        process.stdout.write((refs[baseRef + "^{}"] ?? refs[baseRef]) + "\\n");
      `,
      );
      writeExecutable(path.join(fixtureBin, "gh"), [
        "#!/bin/sh",
        `exec ${quoteShell(process.execPath)} ${quoteShell(ghFixture)} "$@"`,
      ]);
      writeExecutable(path.join(fixtureBin, "git"), [
        "#!/bin/sh",
        "echo 'Anonymous Git transport is unavailable' >&2",
        "exit 128",
      ]);
      const correctionStep = expectDefined(
        readCiWorkflow().jobs.preflight.steps.find(
          (step: WorkflowStep) => step.name === "Resolve release correction base",
        ),
        "trusted correction base producer",
      );
      const correctionOutput = path.join(root, "correction.out");
      writeFileSync(correctionOutput, "");
      const correction = runWorkflowShellScript(correctionStep.run, {
        cwd: root,
        env: {
          PATH: `${fixtureBin}${path.delimiter}${process.env.PATH ?? ""}`,
          GH_TOKEN: correctionStep.env?.GH_TOKEN === "${{ github.token }}" ? "test-token" : "",
          GITHUB_REPOSITORY: "openclaw/openclaw",
          GITHUB_OUTPUT: correctionOutput,
          TARGET_CONTEXT_REF:
            options.scopeEnv?.OPENCLAW_CI_TARGET_CONTEXT_TARGET === "true"
              ? options.scopeEnv.OPENCLAW_CI_TARGET_CONTEXT_REF
              : options.scopeEnv?.OPENCLAW_CI_HISTORICAL_TARGET_TAG,
        },
      });
      if (correction.status !== 0) {
        return {
          output: `${correction.stdout}${correction.stderr}`,
          outputs: {} as Record<string, string>,
          status: correction.status,
          summary: "",
        };
      }
      correctionBaseSha = readWorkflowOutputs(correctionOutput).sha ?? "";
    }
    if (options.historicalReader) {
      const reader = path.join(root, "src/audit/message-delivery-progress-store.test.ts");
      mkdirSync(path.dirname(reader), { recursive: true });
      writeFileSync(reader, "export {};\n");
    }
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(summaryPath, "", "utf8");
    const manifestStep = readCiWorkflow().jobs.preflight.steps.find(
      (step: { name?: string }) => step.name === "Build CI manifest",
    );
    const run = runWorkflowShellScript(manifestStep.run, {
      cwd: root,
      env: {
        ...process.env,
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
        GITHUB_OUTPUT: outputPath,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_STEP_SUMMARY: summaryPath,
        RUNNER_TEMP: root,
        PATH: options.remoteTagRefs
          ? `${fixtureBin}${path.delimiter}${process.env.PATH ?? ""}`
          : process.env.PATH,
        OPENCLAW_CI_CHANGED_PATHS_JSON:
          options.changedPaths === undefined ? undefined : JSON.stringify(options.changedPaths),
        OPENCLAW_CI_CHECKOUT_REVISION: "a".repeat(40),
        OPENCLAW_CI_CORRECTION_BASE_SHA: correctionBaseSha,
        OPENCLAW_CI_DOCS_CHANGED: "true",
        OPENCLAW_CI_DOCS_ONLY: "false",
        OPENCLAW_CI_EVENT_NAME: options.eventName ?? "workflow_dispatch",
        OPENCLAW_CI_HISTORICAL_TARGET:
          (options.historicalCompatibility ?? true) &&
          (options.eventName ?? "workflow_dispatch") === "workflow_dispatch"
            ? "true"
            : "false",
        OPENCLAW_CI_RELEASE_GATE: String(options.releaseGate ?? false),
        OPENCLAW_CI_RELEASE_CANDIDATE_TARGET:
          options.releaseCandidateCompatibility === true ? "true" : "false",
        OPENCLAW_CI_TARGET_CONTEXT_TARGET:
          options.targetContextCompatibility === true ? "true" : "false",
        OPENCLAW_CI_REPOSITORY: options.repository ?? "openclaw/openclaw",
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
        OPENCLAW_CI_RUNNER_BACKEND: options.runnerBackend ?? options.runnerProfile ?? "",
        OPENCLAW_CI_RUNNER_PROFILE: options.runnerProfile ?? options.runnerBackend ?? "blacksmith",
        OPENCLAW_CI_RUN_SKILLS_PYTHON: "true",
        OPENCLAW_CI_RUN_WINDOWS: "true",
        OPENCLAW_CI_WORKFLOW_REVISION: "b".repeat(40),
        ...options.scopeEnv,
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
    return {
      output: `${run.stdout}${run.stderr}`,
      outputChars: readFileSync(outputPath, "utf8").length,
      outputs,
      status: run.status,
      summary: readFileSync(summaryPath, "utf8"),
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

const readFrozenAdditionalCheckRows = (() => {
  let rows: Array<{ check_name: string; group: string; runner: string }> | undefined;
  return () => {
    if (!rows) {
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        eventName: "workflow_dispatch",
        historicalCompatibility: true,
        changedPaths: [],
        scopeEnv: {
          OPENCLAW_CI_CHECKOUT_REVISION: "a".repeat(40),
          OPENCLAW_CI_WORKFLOW_REVISION: "b".repeat(40),
        },
      });
      expect(manifest.status, manifest.output).toBe(0);
      rows = JSON.parse(
        expectDefined(manifest.outputs.check_additional_matrix, "additional check matrix"),
      ).include;
    }
    return structuredClone(expectDefined(rows, "frozen additional check rows"));
  };
})();

function runRunnerProfileFixture(options: {
  authorAssociation?: string;
  configuredProfile?: string;
  eventName: "pull_request" | "push" | "workflow_dispatch";
  headRepository?: string;
  repository?: string;
  runAttempt?: number;
  targetSupportsContract: boolean;
}) {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-ci-runner-profile-"));
  try {
    const workflowPath = path.join(root, ".github", "workflows", "ci.yml");
    mkdirSync(path.dirname(workflowPath), { recursive: true });
    writeFileSync(
      workflowPath,
      options.targetSupportsContract ? "hosted-runner-profile-contract-v1\n" : "name: legacy\n",
      "utf8",
    );
    const outputPath = path.join(root, "profile.out");
    writeFileSync(outputPath, "", "utf8");
    const step = expectDefined(
      readCiWorkflow().jobs.preflight.steps.find(
        (candidate: WorkflowStep) => candidate.name === "Resolve logical runner profile",
      ),
      "logical runner profile preflight step",
    );
    const result = runWorkflowShellScript(expectDefined(step.run, "runner profile script"), {
      cwd: root,
      env: {
        ...process.env,
        AUTHOR_ASSOCIATION: options.authorAssociation ?? "",
        CONFIGURED_RUNNER_PROFILE: options.configuredProfile ?? "",
        GITHUB_EVENT_NAME: options.eventName,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: options.repository ?? "openclaw/openclaw",
        HEAD_REPOSITORY: options.headRepository ?? options.repository ?? "openclaw/openclaw",
        GITHUB_RUN_ATTEMPT: String(options.runAttempt ?? 1),
      },
    });
    const outputs = Object.fromEntries(
      readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    return { output: `${result.stdout}${result.stderr}`, outputs, status: result.status };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function runCiReleaseRefValidation(options: {
  kind?: "context" | "historical" | "candidate";
  ref: string;
  targetSha: string;
  resolvedSha?: string;
  comparisonStatus?: string;
  apiError?: "ref" | "comparison";
}) {
  const root = tempDirs.make("openclaw-ci-target-context-");
  const outputPath = path.join(root, "github-output");
  const binPath = path.join(root, "bin");
  const resolvedSha = options.resolvedSha ?? "b".repeat(40);
  const kind = options.kind ?? "context";
  const ref = `refs/${kind === "historical" ? "tags" : "heads"}/${options.ref}`;
  mkdirSync(binPath);
  writeFileSync(
    path.join(root, "ci-git-owner.py"),
    readFileSync(".github/actions/git-owner/owner.py"),
  );
  writeFileSync(outputPath, "", "utf8");
  writeFileSync(
    path.join(binPath, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "-C" ]]; then shift 2; fi
if [[ "$*" == "remote get-url origin" ]]; then
  printf '%s\\n' 'https://github.com/openclaw/openclaw.git'
else
  echo 'fatal: could not read Username for https://github.com: terminal prompts disabled' >&2
  exit 128
fi
`,
    "utf8",
  );
  writeFileSync(
    path.join(binPath, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "\${GH_TOKEN:-}" == "test-token" ]] || exit 4
[[ "$1" == "api" ]] || exit 64
shift
if [[ "$1" == "--method" && "$2" == "GET" ]]; then shift 2; fi
[[ "$#" == 3 && "$2" == "--jq" ]] || exit 64
case "$1" in
  "$MOCK_REF_ENDPOINT") kind=ref; value="$MOCK_REF_SHA"; query=.sha ;;
  "$MOCK_COMPARE_ENDPOINT") kind=comparison; value="$MOCK_COMPARE_STATUS"; query=.status ;;
  *) echo "Unexpected GitHub API endpoint: $1" >&2; exit 64 ;;
esac
[[ "$3" == "$query" ]] || exit 64
# Valid-looking partial output must not authorize a failed request.
printf '%s\\n' "$value"
if [[ "$MOCK_API_ERROR" == "$kind" ]]; then
  echo 'gh: Service Unavailable (HTTP 503)' >&2
  exit 1
fi
`,
    "utf8",
  );
  chmodSync(path.join(binPath, "git"), 0o755);
  chmodSync(path.join(binPath, "gh"), 0o755);
  const stepName = {
    context: "Validate target context",
    historical: "Validate historical release target",
    candidate: "Validate release candidate target",
  }[kind];
  const step = expectDefined(
    readCiWorkflow().jobs.preflight.steps.find(
      (candidate: WorkflowStep) => candidate.name === stepName,
    ),
    stepName,
  );
  const run = spawnSync(
    "bash",
    ["-c", expectDefined(step.run, "target context validation script")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GH_TOKEN: step.env?.GH_TOKEN === "${{ github.token }}" ? "test-token" : "",
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_OUTPUT: outputPath,
        MOCK_REF_ENDPOINT: `repos/openclaw/openclaw/commits/${encodeURIComponent(ref)}`,
        MOCK_REF_SHA: resolvedSha,
        MOCK_COMPARE_ENDPOINT: `repos/openclaw/openclaw/compare/${options.targetSha}...${resolvedSha}`,
        MOCK_COMPARE_STATUS: options.comparisonStatus ?? "ahead",
        MOCK_API_ERROR: options.apiError ?? "",
        RUNNER_TEMP: root,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        TARGET_CONTEXT_REF: options.ref,
        TARGET_REF: options.targetSha,
        EXPECTED_SHA: options.targetSha,
        HISTORICAL_TARGET_TAG: options.ref,
        RELEASE_CANDIDATE_REF: options.ref,
      },
    },
  );
  return {
    output: `${run.stdout}${run.stderr}`,
    outputs: readWorkflowOutputs(outputPath),
    status: run.status,
  };
}

function runCandidateTrustClassification(options: {
  checkoutRevision: string;
  defaultRevision?: string;
  eventName: "pull_request" | "push" | "workflow_dispatch";
  historicalTarget?: boolean;
  ref?: string;
  releaseCandidateTarget?: boolean;
  releaseGate?: boolean;
  targetContextTarget?: boolean;
  targetRef?: string;
  workflowRevision?: string;
}) {
  const root = tempDirs.make("openclaw-ci-candidate-trust-");
  const outputPath = path.join(root, "github-output");
  const binPath = path.join(root, "bin");
  const defaultRevision = options.defaultRevision ?? "b".repeat(40);
  mkdirSync(binPath);
  writeFileSync(outputPath, "", "utf8");
  for (const command of ["git", "gh"]) {
    writeExecutable(path.join(binPath, command), [
      "#!/bin/sh",
      "echo 'Cache trust must consume the resolved default SHA without another lookup' >&2",
      "exit 128",
    ]);
  }
  const step = expectDefined(
    readCiWorkflow().jobs.preflight.steps.find(
      (candidate: WorkflowStep) => candidate.name === "Classify candidate cache trust",
    ),
    "candidate cache trust step",
  );
  const script = expectDefined(step.run, "candidate cache trust script");
  const run = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      CHECKOUT_REVISION: options.checkoutRevision,
      DEFAULT_SHA: defaultRevision,
      GITHUB_EVENT_NAME: options.eventName,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REF: options.ref ?? "",
      HISTORICAL_TARGET: String(options.historicalTarget ?? false),
      RUNNER_TEMP: root,
      PATH: `${binPath}:${process.env.PATH ?? ""}`,
      RELEASE_CANDIDATE_TARGET: String(options.releaseCandidateTarget ?? false),
      RELEASE_GATE: String(options.releaseGate ?? false),
      TARGET_CONTEXT_TARGET: String(options.targetContextTarget ?? false),
      TARGET_REF: options.targetRef ?? "",
      WORKFLOW_REVISION: options.workflowRevision ?? "a".repeat(40),
    },
  });
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
    if (timeoutVersion.status !== 0) {
      throw new Error(
        `QA timeout fixture requires timeout --version: ${timeoutVersion.stdout}${timeoutVersion.stderr}`,
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
      timeoutVersion: `${timeoutVersion.stdout}${timeoutVersion.stderr}`.trim(),
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

function runDiffBaseFixture(options: {
  commitCount: 1 | 2 | 3;
  eventBaseSha: string;
  defaultBranch?: string;
  manual?: boolean;
  apiError?: "ref" | "comparison";
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
  const defaultBranch = options.defaultBranch ?? "main";
  const fixtureEnv: NodeJS.ProcessEnv = {};
  if (options.manual) {
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      path.join(root, "ci-git-owner.py"),
      readFileSync(".github/actions/git-owner/owner.py"),
    );
    writeExecutable(path.join(bin, "git"), [
      "#!/bin/sh",
      'if [ "$1" = -C ]; then shift 2; fi',
      `[ "$*" = 'rev-parse HEAD' ] || { echo 'Anonymous Git transport is unavailable' >&2; exit 128; }`,
      `printf '%s\\n' '${headSha}'`,
    ]);
    writeExecutable(path.join(bin, "gh"), [
      "#!/bin/sh",
      '[ "$GH_TOKEN" = test-token ] || exit 4',
      '[ "$1" = api ] || exit 64',
      "shift",
      'if [ "$1" = --method ]; then [ "$2" = GET ] || exit 64; shift 2; fi',
      'case "$*" in',
      `  'repos/openclaw/openclaw/commits/${encodeURIComponent(`refs/heads/${defaultBranch}`)} --jq .sha') kind=ref ;;`,
      `  'repos/openclaw/openclaw/compare/${parentSha}...${headSha} --jq .merge_base_commit.sha') kind=comparison ;;`,
      "  *) exit 64 ;;",
      "esac",
      `printf '%s\\n' '${parentSha}'`,
      'if [ "$MOCK_API_ERROR" = "$kind" ]; then echo "gh: Service Unavailable (HTTP 503)" >&2; exit 1; fi',
    ]);
    fixtureEnv.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
    fixtureEnv.GH_TOKEN = evaluateWorkflowExpression(diffBaseStep.env.GH_TOKEN, {
      eventName: "workflow_dispatch",
      repository: "openclaw/openclaw",
      runAttempt: 1,
      workflowToken: "test-token",
    });
    fixtureEnv.RUNNER_TEMP = root;
    fixtureEnv.MOCK_API_ERROR = options.apiError ?? "";
  }
  const run = runWorkflowShellScript(diffBaseStep.run, {
    cwd: root,
    env: {
      ...process.env,
      DEFAULT_BRANCH: defaultBranch,
      EVENT_BASE_SHA: eventBaseSha,
      GITHUB_EVENT_NAME: options.manual ? "workflow_dispatch" : "push",
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: "openclaw/openclaw",
      PULL_REQUEST_NUMBER: "",
      RELEASE_GATE: "false",
      ...fixtureEnv,
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
  const gitOwner = path.join(root, "ci-git-owner.py");
  writeFileSync(gitOwner, readFileSync(".github/actions/git-owner/owner.py"));

  return {
    checkout,
    compatibilityHead,
    gitOwner,
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
      CI_GIT_OWNER: topology.gitOwner,
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
  return runWorkflowShellScript(
    `${quoteShell(process.execPath)} --import ${quoteShell(TSX_IMPORT)} scripts/check-protocol-since.mts`,
    {
      cwd: checkout,
      env: { ...process.env, PROTOCOL_SINCE_BASE_SHA: baseSha },
    },
  );
}

function runCheckShardFixture(options: {
  frozenTarget: boolean;
  scripts: string[];
  task?: "guards" | "npm-lock" | "test-types";
  checkoutBase?: string;
  types?: {
    compose?: boolean;
    profile?: "blacksmith" | "github" | "hybrid";
    eventName?: "pull_request" | "push" | "workflow_dispatch";
    stripeSupport?: boolean;
    hostedContract?: boolean;
    failStripe?: string;
    changedPathsJson?: string;
    boundary?: boolean;
  };
}): {
  calls: string[];
  output: string;
  status: number | null;
  typeCalls: { row: string; command: string; localCheck: string | null }[];
  rows: { name: string; status: number | null }[];
} {
  const root = tempDirs.make("openclaw-ci-guards-");
  const fakeBin = path.join(root, "bin");
  const callsPath = path.join(root, "pnpm-calls.txt");
  const typeCallsPath = path.join(root, "type-calls.txt");
  const typeCheck = options.task === "test-types";
  mkdirSync(fakeBin);
  if (typeCheck) {
    mkdirSync(path.join(root, "scripts"));
    writeFileSync(
      path.join(root, "scripts/run-tsgo-core-test-shards.mts"),
      options.types?.stripeSupport === false ? "// legacy runner\n" : "// --stripe\n",
    );
    writeFileSync(
      path.join(root, "scripts/run-tsgo-core-test-shards.mjs"),
      `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.TYPE_CALLS, [process.env.TYPE_ROW, process.env.OPENCLAW_LOCAL_CHECK ?? "<unset>", "node " + args.join(" ")].join("\\t") + "\\n");
if (args[args.indexOf("--stripe") + 1] === process.env.FAIL_TYPE_STRIPE) process.exit(17);
`,
    );
  }
  if (options.types?.boundary) {
    writeFileSync(
      path.join(root, "scripts/run-additional-boundary-checks.mts"),
      readFileSync("scripts/run-additional-boundary-checks.mts"),
    );
    for (const directory of ["scripts/lib", "packages", "node_modules"]) {
      symlinkSync(path.resolve(directory), path.join(root, directory), "dir");
    }
    writeFileSync(
      path.join(root, "scripts/check-native-state-schema-version.mjs"),
      `
import { appendFileSync } from "node:fs";
appendFileSync(process.env.TYPE_CALLS, [process.env.TYPE_ROW, process.env.OPENCLAW_LOCAL_CHECK ?? "<unset>", "node scripts/check-native-state-schema-version.mjs"].join("\\t") + "\\n");
`,
    );
  }
  const scripts = Object.fromEntries(options.scripts.map((name) => [name, "true"]));
  if (options.types?.compose) {
    // The full-path root-coverage probe must see the actual package alias.
    scripts["tsgo:test"] = (
      JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }
    ).scripts["tsgo:test"]!;
  }
  writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ scripts })}\n`);
  writeExecutable(path.join(fakeBin, "pnpm"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'if [ "$*" = "run --silent" ]; then exit 1; fi',
    'printf "%s\\n" "$*" >> "$PNPM_CALLS"',
    ...(typeCheck
      ? [
          'printf "%s\\t%s\\tpnpm %s\\n" "$TYPE_ROW" "${OPENCLAW_LOCAL_CHECK-<unset>}" "$*" >> "$TYPE_CALLS"',
        ]
      : []),
  ]);
  const workflow = readCiWorkflow();
  const checkShardStep = workflow.jobs["check-shard"].steps.find(
    (step: WorkflowStep) => step.name === "Run check shard",
  );
  const context: Parameters<typeof evaluateWorkflowExpression>[1] = {
    eventName:
      options.types?.eventName ?? (options.frozenTarget ? "workflow_dispatch" : "pull_request"),
    repository: "openclaw/openclaw",
    runAttempt: 1,
    frozenTarget: options.frozenTarget,
    hostedRunnerProfileContract: options.types?.hostedContract ?? true,
    runnerProfile: options.types?.profile ?? "hybrid",
    preflightOutputs: {
      compatibility_target: String(options.frozenTarget),
      run_format_check: "false",
      changed_core_test_paths_json: options.types?.changedPathsJson ?? "",
    },
  };
  const rows: { name: string; step: WorkflowStep; matrix: Record<string, unknown> }[] = [];
  const coreJob = workflow.jobs["check-test-types-hosted-core-shard"];
  if (options.types?.compose && evaluateWorkflowExpression(coreJob.if, context)) {
    for (const stripe of coreJob.strategy.matrix.stripe) {
      rows.push({
        name: `core-${stripe}`,
        step: coreJob.steps.find(
          (step: WorkflowStep) => step.name === "Run hosted core test-types stripe",
        ),
        matrix: { stripe },
      });
    }
  }
  rows.push({ name: "central", step: checkShardStep, matrix: { task: options.task ?? "guards" } });
  if (options.types?.boundary) {
    rows.push({
      name: "boundary",
      step: workflow.jobs["check-additional-shard"].steps.find(
        (step: WorkflowStep) => step.name === "Run additional check shard",
      ),
      matrix: { group: "boundaries" },
    });
  }
  // Rows are independent (matrix fail-fast:false); each real Bash body owns its halt.
  const runs = rows.map((row) => {
    const resolveValue = (value: unknown) =>
      typeof value === "string" && value.startsWith("${{")
        ? evaluateWorkflowExpression(value, { ...context, matrix: row.matrix })
        : value;
    const command = typeCheck
      ? row.step.run!.replace(/\$\{\{[\s\S]*?\}\}/gu, (expression) =>
          String(resolveValue(expression)),
        )
      : row.step.run!;
    return Object.assign(
      spawnSync("bash", ["-c", command], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          FROZEN_TARGET: options.frozenTarget ? "true" : "false",
          FORMAT_CHECK: "false",
          HISTORICAL_TARGET: options.frozenTarget ? "true" : "false",
          HOSTED_RUNNER_STRIPES: "true",
          CHECKOUT_BASE_SHA: options.checkoutBase ?? "",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          PNPM_CALLS: callsPath,
          TASK: options.task ?? "guards",
          ...(typeCheck
            ? {
                OPENCLAW_LOCAL_CHECK: undefined,
                TYPE_ROW: row.name,
                TYPE_CALLS: typeCallsPath,
                FAIL_TYPE_STRIPE: options.types?.failStripe,
                ...Object.fromEntries(
                  Object.entries(row.step.env ?? {}).map(([key, value]) => [
                    key,
                    String(resolveValue(value)),
                  ]),
                ),
              }
            : {}),
        },
      }),
      { name: row.name },
    );
  });
  const failed = runs.find((run) => run.status !== 0);
  return {
    calls: existsSync(callsPath)
      ? readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean)
      : [],
    output: runs.map((run) => `${run.stdout}${run.stderr}`).join("\n"),
    status: failed ? failed.status : 0,
    typeCalls: existsSync(typeCallsPath)
      ? readFileSync(typeCallsPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [row, localCheck, command] = line.split("\t");
            return {
              row: row!,
              command: command!,
              localCheck: localCheck === "<unset>" ? null : localCheck!,
            };
          })
      : [],
    rows: runs.map(({ name, status }) => ({ name, status })),
  };
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

describe("ci workflow guards", () => {
  it("isolates mutations between workflow fixtures", () => {
    const workflow = readCiWorkflow();
    const expected = structuredClone(workflow);

    workflow.jobs.preflight.steps[0].name = "mutated fixture";
    workflow.jobs.preflight.steps.pop();
    delete workflow.jobs["ci-gate"];

    expect(readCiWorkflow()).toEqual(expected);
  });

  it.each([
    ["artifact", 1],
    ["source", 0],
    ["published", 0],
  ] as const)(
    "fetches the required release preparation history for %s mode",
    (packageMode, depth) => {
      const prepare = readReleaseChecksWorkflow().jobs.prepare_release_package;
      const checkout = prepare.steps.find(
        (step: WorkflowStep) => step.name === "Checkout trusted workflow ref",
      );
      expect(checkout.with.ref).toBe("${{ github.sha }}");
      expect(checkout.with["persist-credentials"]).toBe(false);
      expect(checkout.with.filter).toBe("blob:none");
      const fetchDepth = checkout.with["fetch-depth"];
      expect(
        typeof fetchDepth === "string"
          ? evaluateWorkflowExpression(fetchDepth, {
              eventName: "workflow_dispatch",
              repository: "openclaw/openclaw",
              runAttempt: 1,
              resolveTargetOutputs: { package_mode: packageMode },
            })
          : fetchDepth,
      ).toBe(depth);
    },
  );

  it("gates frozen runtime-pair compatibility on the trusted suite outcome", () => {
    const workflow = readReleaseChecksWorkflow();
    const laneJob = workflow.jobs.qa_lab_runtime_pair_lane_release_checks;
    const suiteValidation = laneJob.steps.find(
      (step: WorkflowStep) => step.name === "Validate runtime-pair lane",
    );
    const reportValidation = laneJob.steps.find(
      (step: WorkflowStep) => step.name === "Validate runtime-pair lane report",
    );

    for (const step of [suiteValidation, reportValidation]) {
      expect(step?.env?.CANDIDATE_SUITE_OUTCOME).toBe(
        "${{ steps.candidate_runtime_pair.outcome }}",
      );
      expect(step?.run).toContain('--candidate-suite-outcome "$CANDIDATE_SUITE_OUTCOME"');
      expect(step?.run).toContain('--target-sha "$RELEASE_CHECK_TARGET_SHA"');
      expect(step?.run).toContain('--lane "$RUNTIME_PAIR_LANE"');
    }
  });

  it("separates release QA lanes without weakening their resource locks", () => {
    const workflowPath = ".github/workflows/qa-live-transports-convex.yml";
    const workflowSource = readFileSync(workflowPath, "utf8");
    const workflow = parse(workflowSource);
    const releaseWorkflow = readReleaseChecksWorkflow();

    expect(workflow.on.workflow_call.inputs.lock_scope).toEqual({
      description: "Concurrency scope for a trusted single-lane reusable call",
      required: false,
      default: "all",
      type: "string",
    });
    expect(workflow.concurrency).toEqual({
      group:
        "qa-lab-${{ inputs.lock_scope || 'all' }}-${{ github.event_name != 'schedule' && inputs.ref || github.sha }}",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(workflow.jobs.run_live_matrix.concurrency).toEqual({
      group: "qa-live-matrix-${{ needs.validate_selected_ref.outputs.selected_revision }}",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(workflow.jobs.run_live_buzz.concurrency).toEqual({
      group: "qa-live-buzz-shared",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(releaseWorkflow.jobs.qa_live_release_checks.with.lock_scope).toBe("matrix");
    expect(releaseWorkflow.jobs.qa_live_buzz_release_checks.with.lock_scope).toBe("buzz");
  });

  it("runs full-access restart proof as a failing nightly gate", () => {
    const workflow = readWorkflow(".github/workflows/qa-live-transports-convex.yml");
    const job = workflow.jobs.run_live_runtime_token_efficiency;
    const step = job.steps.find((candidate: WorkflowStep) =>
      candidate.run?.includes("--scenario gateway-restart-full-access-live"),
    );

    expect(workflow.on.schedule.length).toBeGreaterThan(0);
    expect(job.if).toBe("github.event_name == 'schedule'");
    expect(step).toBeDefined();
    expect(step?.env?.OPENAI_API_KEY).toBe("${{ secrets.OPENAI_API_KEY }}");
    expect(step?.["continue-on-error"]).toBeUndefined();
    expect(step?.if).toBeUndefined();
    expect(step?.run).toContain("--provider-mode live-frontier");
    expect(step?.run).toContain("--model openai/gpt-5.6-luna");
    expect(step?.run).toContain("--alt-model openai/gpt-5.6-luna");
    expect(step?.run).toContain("--concurrency 1");
    expect(step?.run).not.toContain("--allow-failures");
    expect(step?.run).toContain(
      '--output-dir "${{ steps.run_lane.outputs.output_dir }}/gateway-restart-full-access"',
    );
  });

  it("preserves module heredocs and cleans child temporary artifacts", () => {
    const parentTempDir = tmpdir();
    const run = runWorkflowShellScript(
      `node --input-type=module <<'NODE'
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
NODE_prefix: for (const value of ["heredoc-body-preserved"]) {
  console.log(value);
  break NODE_prefix;
}
console.log(mkdtempSync(join(tmpdir(), 'openclaw-workflow-child-')));
NODE
`,
      {},
    );

    expect(run.status, run.stderr).toBe(0);
    const [body, temporaryDirectory] = run.stdout.trim().split("\n");
    const childDirectory = expectDefined(temporaryDirectory, "child temporary directory");
    try {
      expect(body).toBe("heredoc-body-preserved");
      expect(tmpdir()).toBe(parentTempDir);
      expect(existsSync(childDirectory)).toBe(false);
    } finally {
      rmSync(childDirectory, { force: true, recursive: true });
    }
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
    expect(workflow.on.workflow_dispatch.inputs.release_scope).toMatchObject({
      default: "full",
      type: "choice",
      options: ["full", "npm-beta", "npm-stable"],
    });
    expect(workflow.jobs.preflight.outputs.release_scope).toBe(
      "${{ steps.manifest.outputs.release_scope }}",
    );
    expect(readFileSync(".github/workflows/ci.yml", "utf8")).toContain(
      "run-name: ${{ github.event_name == 'workflow_dispatch' && inputs.dispatch_id != '' && format('CI {0}', inputs.dispatch_id) || (github.event_name == 'workflow_dispatch' && inputs.release_gate && format('CI release gate {0}', inputs.target_ref) || 'CI') }}",
    );
    const preflightSteps = workflow.jobs.preflight.steps;
    expect(
      preflightSteps.find((step: WorkflowStep) => step.name === "Build CI manifest").env,
    ).toMatchObject({
      OPENCLAW_CI_RELEASE_SCOPE: "${{ inputs.release_scope || 'full' }}",
      OPENCLAW_CI_PULL_REQUEST_NUMBER: "${{ inputs.pull_request_number }}",
      OPENCLAW_CI_TARGET_REF: "${{ inputs.target_ref }}",
      OPENCLAW_CI_TARGET_CONTEXT_REF: "${{ inputs.target_context_ref }}",
      OPENCLAW_CI_HISTORICAL_TARGET_TAG: "${{ inputs.historical_target_tag }}",
    });
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
      expect(
        evaluateWorkflowExpression(runsOn, {
          eventName: "workflow_dispatch",
          releaseGate: true,
          repository: "openclaw/openclaw",
          runAttempt: 1,
          runnerBackend: "hybrid",
        }),
        `${jobName} must use GitHub-hosted capacity for release gates`,
      ).toMatch(/^(?:ubuntu|windows|macos)-/u);
    }

    expect(
      workflow.jobs["macos-node"]["runs-on"],
      "macOS Node retries must escape stalled Blacksmith capacity",
    ).toContain("github.run_attempt > 1");
  });

  it.each([
    ["macos-swift", false, "workflow_dispatch", false, ["release", "tests"]],
    ["ios-build", false, "workflow_dispatch", false, ["release", "tests"]],
    ["ios-build", true, "workflow_dispatch", false, ["tests"]],
    ["ios-build", false, "pull_request", false, ["smoke"]],
    ["ios-build", false, "push", false, ["smoke"]],
    ["ios-build", false, "workflow_dispatch", true, ["smoke"]],
    ["ios-build", true, "workflow_dispatch", true, ["smoke"]],
  ] as const)(
    "runs %s native phases (historical=%s, event=%s, release_gate=%s)",
    (jobName, historical, eventName, releaseGate, phases) => {
      const workflow = readCiWorkflow();
      const job = workflow.jobs[jobName];
      const context = {
        eventName,
        releaseGate,
        repository: "openclaw/openclaw",
        runAttempt: 1,
        env: { HISTORICAL_TARGET: String(historical), MACOS_PRIMARY_PHASE: "release" },
        fileHashes: { "apps/shared/OpenClawWatchRTC/Cargo.toml": "present" },
        preflightOutputs: {
          compatibility_target: String(historical),
          run_openclawkit_tests: "true",
          release_scope: "full",
        },
      };
      const matrixPhases = job.strategy.matrix.phase;
      expect(
        Array.isArray(matrixPhases)
          ? matrixPhases
          : evaluateWorkflowExpression(matrixPhases, context),
      ).toEqual(phases);
      expect(job.strategy["fail-fast"]).toBe(false);
      expect(job.strategy["max-parallel"]).toBe(2);
      expect(job["continue-on-error"]).not.toBe(true);
      expect(job.needs).toEqual(["preflight"]);
      const workloads =
        jobName === "macos-swift"
          ? {
              smoke: [],
              release: [
                "Native state schema version contract",
                "Swift lint",
                "Swift build (release)",
              ],
              tests: [
                "OpenClawKit Talk-trait opt-out (no ElevenLabsKit when default traits disabled)",
                "OpenClawKit tests",
                "Swabble tests",
                "Swift test",
              ],
            }
          : {
              smoke: ["Swift lint", "Build iOS app"],
              release: ["Build iOS app (Release)"],
              tests: [
                "Test Watch RTC engine",
                "Swift lint",
                "Build iOS app",
                "Run focused iOS lifecycle simulator tests",
                "Run focused Apple Watch operation simulator tests",
              ],
            };
      const names = [];
      for (const phase of phases) {
        const phaseContext = { ...context, matrix: { phase } };
        const expected =
          historical && phase === "tests"
            ? ["Test Watch RTC engine", "Swift lint", "Build iOS app"]
            : workloads[phase];
        names.push(evaluateWorkflowExpression(job.name, phaseContext));
        const selected = job.steps
          .filter((step: WorkflowStep) =>
            Object.values(workloads)
              .flat()
              .includes(step.name ?? ""),
          )
          .filter(
            (step: WorkflowStep) =>
              !step.if || evaluateWorkflowExpression(`\${{ ${step.if} }}`, phaseContext),
          )
          .map((step: WorkflowStep) => step.name);
        expect(selected, phase).toEqual(expected);
        if (jobName === "ios-build") {
          for (const name of [
            "Select Xcode 26",
            "Setup Node environment",
            "Install Watch Rust toolchain",
            "Install iOS Swift tooling",
          ]) {
            const setup = expectDefined(
              job.steps.find((step: WorkflowStep) => step.name === name),
              name,
            );
            expect(
              !setup.if || evaluateWorkflowExpression(`\${{ ${setup.if} }}`, phaseContext),
            ).toBe(true);
          }
        }
      }
      // The release collector keys retained/rerun evidence by the displayed job name.
      expect(new Set(names).size).toBe(phases.length);
      expect(workflow.jobs["ci-gate"].needs).toContain(jobName);
      const gateStep = workflow.jobs["ci-gate"].steps.find(
        (step: WorkflowStep) => step.name === "Verify selected CI lanes",
      );
      expect(gateStep.env.JOB_RESULTS).toContain(`${jobName}=\${{ needs.${jobName}.result }}`);
      for (const conclusion of ["failure", "cancelled", "skipped"]) {
        expect(
          runCiGateFixture(`preflight=success|true\n${jobName}=${conclusion}|true`).status,
        ).toBe(1);
      }
    },
  );

  it.each([
    { eventName: "pull_request", releaseGate: false, full: false },
    { eventName: "push", releaseGate: false, full: false },
    { eventName: "workflow_dispatch", releaseGate: true, full: false },
    { eventName: "workflow_dispatch", releaseGate: false, full: true },
    { eventName: "workflow_dispatch", releaseGate: false, full: true, historical: true },
  ] as const)(
    "retains macOS tests and one guard/cache owner for %j",
    ({ eventName, releaseGate, full, ...target }) => {
      const historical = "historical" in target && target.historical;
      const job = readCiWorkflow().jobs["macos-swift"];
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        eventName,
        releaseGate,
        runNode: false,
        historicalCompatibility: historical,
      });
      expect(manifest.status, manifest.output).toBe(0);
      expect(manifest.outputs.release_scope).toBe("full");
      const context: Parameters<typeof evaluateWorkflowExpression>[1] = {
        eventName,
        releaseGate,
        releaseScope: "",
        repository: "openclaw/openclaw",
        runAttempt: 1,
        preflightOutputs: {
          ...manifest.outputs,
          cache_write_allowed: "true",
        },
        fileHashes: { "scripts/test-macos-health-render.sh": "present" },
      };
      const phases: string[] = Array.isArray(job.strategy.matrix.phase)
        ? job.strategy.matrix.phase
        : evaluateWorkflowExpression(job.strategy.matrix.phase, context);
      expect(phases).toEqual(full ? ["release", "tests"] : ["tests"]);
      const env = Object.fromEntries(
        Object.entries(job.env).map(([key, value]) => [
          key,
          String(evaluateWorkflowExpression(value, context)),
        ]),
      );
      const selectedPhases = (name: string, overrides: Partial<typeof context> = {}) => {
        const step: WorkflowStep = expectDefined(
          job.steps.find((candidate: WorkflowStep) => candidate.name === name),
          name,
        );
        expect(step["continue-on-error"], name).not.toBe(true);
        return phases.filter((phase) =>
          evaluateWorkflowExpression(
            step.if?.startsWith("${{") ? step.if : `\${{ ${step.if ?? "true"} }}`,
            {
              ...context,
              env,
              matrix: { phase },
              steps: {
                "swift-test": {
                  outputs: { "debug-tests-built": phase === "tests" ? "true" : "" },
                },
                "swiftpm-cache": { outputs: { "cache-hit": "false" } },
              },
              ...overrides,
            },
          ),
        );
      };
      for (const name of [
        "Install XcodeGen / SwiftLint / SwiftFormat",
        "Native state schema version contract",
        "Swift lint",
        "Save SwiftPM cache",
      ]) {
        expect(selectedPhases(name), name).toEqual([full ? "release" : "tests"]);
      }
      for (const name of [
        "OpenClawKit Talk-trait opt-out (no ElevenLabsKit when default traits disabled)",
        "OpenClawKit tests",
        "Swift test",
      ]) {
        expect(selectedPhases(name), name).toEqual(["tests"]);
      }
      expect(selectedPhases("Swabble tests")).toEqual(historical ? [] : ["tests"]);
      expect(selectedPhases("Swift build (release)")).toEqual(full ? ["release"] : []);
      expect(selectedPhases("Render isolated macOS health fixtures")).toEqual(
        full ? ["tests"] : [],
      );
      expect(selectedPhases("Render isolated macOS health fixtures", { cancelled: true })).toEqual(
        [],
      );
      expect(
        selectedPhases("Save SwiftPM cache", {
          preflightOutputs: { ...context.preflightOutputs, cache_write_allowed: "false" },
        }),
      ).toEqual([]);
      expect(
        selectedPhases("Save SwiftPM cache", {
          steps: { "swiftpm-cache": { outputs: { "cache-hit": "true" } } },
        }),
      ).toEqual([]);
      for (const result of ["failure", "cancelled", "skipped"]) {
        expect(
          runCiGateFixture(renderCiGateEnvironment(context, { "macos-swift": result })).status,
        ).toBe(1);
      }
    },
  );

  it("starts Apple builds and screenshots directly on hosted capacity", () => {
    const workflow = readCiWorkflow();
    for (const jobName of ["macos-swift", "ios-build", "ios-screenshot-shard"]) {
      expect(workflow.jobs[jobName]["runs-on"], jobName).toBe("macos-26");
    }
    expect(workflow.jobs["macos-swift"]["timeout-minutes"]).toBe(30);
  });

  it("serializes the shared Swift package suite on hosted macOS retries", () => {
    const macosSwift = readCiWorkflow().jobs["macos-swift"];

    expect(macosSwift.env.OPENCLAWKIT_TEST_EXECUTION).toContain("github.run_attempt > 1");
    const openClawKitTests = macosSwift.steps.find(
      (candidate: WorkflowStep) => candidate.name === "OpenClawKit tests",
    );
    expect(openClawKitTests?.run).toContain('if [[ "$OPENCLAWKIT_TEST_EXECUTION" == "parallel" ]]');
    expect(openClawKitTests?.run).toContain("--parallel");
    expect(openClawKitTests?.run).toContain("--no-parallel");
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
    expect(publish.permissions).toEqual({
      actions: "read",
      attestations: "read",
      contents: "read",
      packages: "write",
    });
    expect(releaseWorkflow.jobs.publish.environment).toBe("docker-release");
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
      (step: { name?: string }) => step.name === "Refresh locale translations",
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
      (step: { name?: string }) => step.name === "Refresh locale translations",
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
    expect(controlUiResolveBase.outputs.locales).toBe("${{ steps.base.outputs.locales }}");
    expect(controlUiWorkflow.jobs.refresh.if).toBe(
      "needs.resolve-base.result == 'success' && needs.publisher-preflight.result == 'success' && !(github.event_name == 'workflow_dispatch' && inputs.token_preflight_only)",
    );
    expect(controlUiWorkflow.jobs.refresh.strategy.matrix.locale).toBe(
      "${{ fromJSON(needs.resolve-base.outputs.locales) }}",
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
    for (const owner of [workflow, controlUiWorkflow]) {
      expect(owner.on.workflow_dispatch.inputs.full_refresh).toMatchObject({
        default: false,
        type: "boolean",
      });
    }
    expect(workflow.on.push.paths).toContain("ui/src/i18n/.i18n/glossary.*.json");
    expect(workflow.on.push.paths).toContain("apps/.i18n/native/**");
    expect(workflow.on.push.paths).toContain("apps/.i18n/native-source.json");
    expect(workflow.on.push.paths).toContain("apps/android/app/src/play/**");
    expect(workflow.on.push.paths).toContain("apps/android/app/src/thirdParty/**");
    expect(workflow.on.push.paths).toContain("apps/android/wear/src/main/**");
    for (const generatorInput of [
      "scripts/android-app-i18n.ts",
      "scripts/apple-app-i18n.ts",
      "scripts/native-app-i18n.ts",
      "scripts/native-i18n-locales.ts",
    ]) {
      expect(workflow.on.push.paths).toContain(generatorInput);
      expect(nativePublishStep.with["invalidation-paths"].trim().split("\n")).toContain(
        generatorInput,
      );
    }
    expect(refreshStep.env.OPENAI_API_KEY).toBe(
      "${{ secrets.OPENCLAW_DOCS_I18N_OPENAI_API_KEY || secrets.OPENAI_API_KEY }}",
    );
    expect(refreshStep.env.OPENCLAW_CONTROL_UI_I18N_MODEL).toBe(
      "${{ secrets.OPENCLAW_I18N_MODEL }}",
    );
    expect(refreshStep.env.OPENCLAW_I18N_FALLBACK_MODEL).toBe(
      "${{ secrets.OPENCLAW_I18N_FALLBACK_MODEL }}",
    );
    expect(refreshStep.env.FULL_REFRESH).toBe("${{ inputs.full_refresh || false }}");
    expect(refreshStep.run).toContain("args+=(--force)");
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
    expect(nativePublishStep.with["invalidation-paths"]).toContain("apps/.i18n/native-source.json");
    expect(nativePublishStep.with["invalidation-paths"]).toContain("apps/android/app/src/play");
    expect(nativePublishStep.with["invalidation-paths"]).toContain(
      "apps/android/app/src/thirdParty",
    );
    expect(nativePublishStep.with["auto-merge"]).toBe("true");
    expect(controlUiRefreshStep.env.OPENAI_API_KEY).toBe(
      "${{ secrets.OPENCLAW_DOCS_I18N_OPENAI_API_KEY || secrets.OPENAI_API_KEY }}",
    );
    expect(controlUiRefreshStep.env.OPENCLAW_CONTROL_UI_I18N_MODEL).toBe(
      "${{ secrets.OPENCLAW_I18N_MODEL }}",
    );
    expect(controlUiRefreshStep.env.OPENCLAW_I18N_FALLBACK_MODEL).toBe(
      "${{ secrets.OPENCLAW_I18N_FALLBACK_MODEL }}",
    );
    expect(controlUiRefreshStep.env.FULL_REFRESH).toBe("${{ inputs.full_refresh || false }}");
    expect(controlUiRefreshStep.run).toContain("args+=(--force)");
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
      if (ownerWorkflow === controlUiWorkflow) {
        expect(resolveStep.run.match(/gh api/gu)).toHaveLength(1);
        expect(resolveStep.run).toContain("gh api graphql");
      } else {
        expect(resolveStep.run).toContain(
          'gh api --method GET "repos/${REPOSITORY}/commits/${DEFAULT_BRANCH}" --jq .sha',
        );
      }
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
    expect(controlUiResolveStep.run).toContain('source_ref="${WORKFLOW_SHA}"');
    expect(controlUiResolveStep.run).toContain(
      '-F configRef="${source_ref}:scripts/lib/control-ui-i18n-config.json"',
    );
    expect(controlUiResolveStep.run).toContain(
      "jq -ce '.data.repository.config.text | fromjson | [.[].locale]",
    );

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
    expect(publishAction.inputs["invalidation-paths"]).toEqual({
      description: "Newline-delimited generator input paths that make an older run stale.",
      required: false,
      default: "",
    });
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
    const publishPolicy = readFileSync(".github/actions/publish-generated-pr/policy.py", "utf8");
    expect(actionPublishStep.run).toContain('case "${OVERLAP_POLICY}" in');
    expect(actionPublishStep.run).toContain("defer | fail");
    expect(actionPublishStep.run).toContain("GIT_TERMINAL_PROMPT=0");
    expect(
      actionPublishStep.run.match(/timeout --signal=TERM --kill-after=10s 60s/gu),
    ).toHaveLength(6);
    expect(actionPublishStep.env.PUBLISH_ACTION_PATH).toBe("${{ github.action_path }}");
    expect(actionPublishStep.run).toContain(
      'exec python3 -I -S "$CI_GIT_OWNER" --policy "$PUBLISH_ACTION_PATH/policy.py"',
    );
    expect(actionPublishStep.run).not.toMatch(
      /(?:^|[\s;])git (?:config|fetch|push|diff|ls-tree|ls-remote|rev-parse|merge-base|add|commit|switch|restore|rm)\b/mu,
    );
    expect(publishPolicy).not.toMatch(
      /except (?:Exception|BaseException|SystemExit|RuntimeError)|backoff\(|subprocess\.(?:run|Popen)\([^\n]*["']git/u,
    );
    expect(publishPolicy.match(/timeout=\d+/gu)).toEqual([
      "timeout=60",
      "timeout=120",
      "timeout=60",
    ]);
    for (const contract of [
      'auth_key = "http.https://github.com/.extraheader"',
      'f"AUTHORIZATION: basic {git_auth}"',
      'print(f"::add-mask::{git_auth}"',
      'git("config", "--local", "--unset-all", auth_key)',
      "except GitFailure:",
      "except PublicationFailure as error:",
      "finally:\n    cleanup_git_auth()",
      "--force-with-lease=refs/heads/{head_branch}:{expected_head}",
      "GH013|repository rule violations|required status check",
      "bool(remote_head) and not current_remote_head",
      'push_generated_branch("")',
    ]) {
      expect(publishPolicy).toContain(contract);
    }
    // The real repository scenarios below own overlap, invalidation, tree/lease,
    // reconciliation and auto-merge behavior; spelling is no longer Bash policy.
    for (const contract of [
      'gh api --method GET "repos/${GITHUB_REPOSITORY}/pulls"',
      '-f "head=${GITHUB_REPOSITORY_OWNER}:${HEAD_BRANCH}"',
      ".head.repo.full_name == env.GITHUB_REPOSITORY",
      ".head.ref == env.HEAD_BRANCH",
      ".head.sha",
      "gh pr edit",
      "gh pr create",
      '--base "${BASE_BRANCH}"',
      '--head "${HEAD_BRANCH}"',
      '--body-file "${body_file}"',
      "--json autoMergeRequest",
      '--auto --squash --match-head-commit "${published_commit}"',
    ]) {
      expect(actionPublishStep.run).toContain(contract);
    }
    for (const forbidden of [
      "gh auth setup-git",
      "gh pr list",
      "gh pr close",
      'GH_TOKEN="${CONTENTS_TOKEN}"',
      'HEAD:"${BASE_BRANCH}"',
    ]) {
      expect(actionPublishStep.run).not.toContain(forbidden);
    }
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
    "defers stale generator inputs and preserves an existing pull request and disarms auto-merge",
    () => {
      const result = runGeneratedPublisherScenario(null, {
        existingPr: true,
        autoMerge: true,
        existingAutoMergeMethod: "SQUASH",
        updateSource: true,
      });

      expect(result.branchHead).not.toBe(result.mainHead);
      expect(result.generatedA).toBe("stale-pr-a");
      expect(result.summary).toContain(
        "Deferred stale generated output because generator inputs changed on main.",
      );
      expect(result.mergeCalls).toContain("--disable-auto");
      expect(result.summary).toContain("Preserved stale generated pull request");
    },
  );

  it.skipIf(process.platform === "win32")(
    "publishes after unrelated source changes when input invalidation is disabled",
    () => {
      const result = runGeneratedPublisherScenario(null, {
        invalidationPaths: "",
        overlapPolicy: "fail",
        updateSource: true,
      });

      expect(result.branchExists).toBe(true);
      expect(result.generatedA).toBe("desired-a");
      expect(result.publishOutput).not.toContain("Refusing stale generated output");
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves an existing pull request when a no-change run becomes stale",
    () => {
      const result = runGeneratedPublisherScenario("b", {
        existingPr: true,
        noGeneratedChange: true,
      });

      expect(result.branchHead).toBe(result.initialBranch);
      expect(result.generatedA).toBe("stale-pr-a");
      expect(result.generatedB).toBe("old-b");
      expect(result.summary).toContain(
        "Deferred stale generated output because owned generated paths changed on main.",
      );
      expect(result.summary).toContain("Preserved stale generated pull request");
    },
  );

  it.skipIf(process.platform === "win32").each([false, true])(
    "disarms stale output when inputs advance during PR publication (inherited=%s)",
    (inherited) => {
      const result = runGeneratedPublisherScenario(null, {
        autoMerge: true,
        existingPr: inherited,
        existingAutoMergeMethod: inherited ? "SQUASH" : undefined,
        updateSourceBeforeAutoMerge: true,
      });
      expect(result.generatedA).toBe("desired-a");
      expect(result.branchHead).not.toBe(result.mainHead);
      expect(result.mergeCalls).not.toContain("--auto --squash");
      expect(result.mergeCalls.includes("--disable-auto")).toBe(inherited);
      expect(result.summary).toContain("Deferred stale generated output");
    },
  );

  it.skipIf(process.platform === "win32")(
    "leaves a current no-change run's existing pull request and auto-merge unchanged",
    () => {
      const result = runGeneratedPublisherScenario(null, {
        existingPr: true,
        noGeneratedChange: true,
        autoMerge: true,
        existingAutoMergeMethod: "SQUASH",
      });
      expect(result.branchHead).toBe(result.initialBranch);
      expect(result.generatedA).toBe("stale-pr-a");
      expect(result.mergeCalls).toBe("");
      expect(result.summary).toBe("");
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not overwrite a successor that moves while stale auto-merge is disabled",
    () => {
      const result = runGeneratedPublisherScenario(null, {
        existingPr: true,
        updateSource: true,
        existingAutoMergeMethod: "SQUASH",
        autoMerge: true,
        disarmRace: true,
        expectFailure: true,
      });
      expect(result.branchHead).not.toBe(result.initialBranch);
      expect(result.generatedA).toBe("old-a");
      expect(result.mergeCalls).toContain("--disable-auto");
      expect(result.mergeCalls).not.toContain("--auto --squash");
      expect(result.summary).not.toContain("Preserved stale");
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
      expect(stalePr.branchHead).toBe(stalePr.initialBranch);
      expect(stalePr.summary).toContain("Preserved stale generated pull request");
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
        OPENGREP_VERSION: "v1.27.1",
        OPENGREP_LINUX_X64_SHA256:
          "58053da76672bbeb5b0a5441021c58338707052e10f81d777140ca879bd491ce",
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
      'CHANGED=$(git diff --no-renames --name-only "$BASE" HEAD 2>/dev/null || echo "UNKNOWN")',
    );
    expect(action).toContain('if [ "$CHANGED" = "UNKNOWN" ] || [ -z "$CHANGED" ]; then');
    expect(action).toContain("docs_only=false");
    expect(action).toContain("docs_changed=false");
    expect(action).toContain("test/fixtures/*)");
    expect(action).toContain("docs/* | *.md | *.mdx | config/markdownlint*.jsonc)");

    const run = parse(action).runs.steps[0].run as string;
    for (const [source, destination, docsChanged, docsOnly] of [
      ["src/old.ts", "docs/new.md", "true", "false"],
      ["docs/old.md", "src/new.ts", "true", "false"],
      ["docs/old.md", "docs/new.md", "true", "true"],
      ["docs/old.md", "docs/.generated/config-baseline.counts.json", "true", "true"],
      ["docs/old.md", "docs/plugins/plugin-inventory.md", "true", "true"],
      ["src/old.ts", "src/new.ts", "false", "false"],
      ["test/fixtures/old.md", "docs/new.md", "true", "false"],
      ["docs/removed.md", null, "true", "true"],
    ] as const) {
      const root = tempDirs.make("openclaw-docs-diff-");
      const origin = path.join(root, "origin");
      const checkout = path.join(root, "checkout");
      mkdirSync(path.dirname(path.join(origin, source)), { recursive: true });
      const content = Array.from({ length: 100 }, (_, index) => `line ${index}\n`).join("");
      writeFileSync(path.join(origin, source), content);
      runGit(origin, ["init", "-q", "-b", "main"]);
      for (const [name, value] of [
        ["user.name", "CI Fixture"],
        ["user.email", "ci-fixture@example.invalid"],
        ["commit.gpgsign", "false"],
        ["uploadpack.allowFilter", "true"],
      ] as const) {
        runGit(origin, ["config", name, value]);
      }
      runGit(origin, ["add", "."]);
      runGit(origin, ["commit", "-qm", "base"]);
      const base = runGit(origin, ["rev-parse", "HEAD"]);
      const sourceBlob = runGit(origin, ["rev-parse", `HEAD:${source}`]);
      rmSync(path.join(origin, source));
      if (destination) {
        mkdirSync(path.dirname(path.join(origin, destination)), { recursive: true });
        writeFileSync(path.join(origin, destination), `${content}edited after rename\n`);
      }
      runGit(origin, ["add", "-A"]);
      runGit(origin, ["commit", "-qm", "change"]);
      runGit(root, [
        "clone",
        "-q",
        "--no-local",
        "--filter=blob:none",
        "--depth=2",
        origin,
        checkout,
      ]);
      runGit(checkout, ["config", "diff.renames", "true"]);
      const localObjects = () =>
        runGit(checkout, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]);
      expect(localObjects()).toContain(base);
      expect(localObjects()).not.toContain(sourceBlob);
      const output = path.join(root, "output");
      const trace = path.join(root, "trace");
      const result = runWorkflowShellScript(run, {
        cwd: checkout,
        env: { ...process.env, BASE_SHA: base, GITHUB_OUTPUT: output, GIT_TRACE2_EVENT: trace },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readWorkflowOutputs(output), `${source} -> ${destination}`).toEqual({
        docs_changed: docsChanged,
        docs_only: docsOnly,
      });
      expect(readFileSync(trace, "utf8")).not.toContain('"fetch"');
      expect(localObjects()).not.toContain(sourceBlob);
    }
  });

  it("runs generated docs checks in the docs-only job", () => {
    const job = readCiWorkflow().jobs["check-docs"];
    const configDocsCheck = job.steps.find(
      (step: WorkflowStep) => step.name === "Check config docs baseline",
    );
    const pluginInventoryCheck = job.steps.find(
      (step: WorkflowStep) => step.name === "Check plugin inventory",
    );

    expect(job.if).toBe("needs.preflight.outputs.run_check_docs == 'true'");
    expect(configDocsCheck?.run).toBe("pnpm config:docs:check");
    expect(pluginInventoryCheck?.run).toBe("pnpm plugins:inventory:check");
  });

  it("bounds matrix fan-out for runner-registration pressure", () => {
    const workflow = readCiWorkflow();

    expect(workflow.concurrency.group).toContain("github.event.pull_request.number");
    expect(workflow.concurrency["cancel-in-progress"]).toContain(
      "github.event_name == 'pull_request'",
    );
    expect(workflow.jobs["checks-fast-core"].strategy["max-parallel"]).toBe(12);
    expect(workflow.jobs["checks-node-core-test-nondist-shard"].strategy["max-parallel"]).toBe(96);
    expect(workflow.jobs["checks-fast-plugin-contracts-shard"].strategy["max-parallel"]).toBe(12);
    expect(workflow.jobs["checks-fast-channel-contracts-shard"].strategy["max-parallel"]).toBe(12);
    expect(workflow.jobs["check-shard"].strategy["max-parallel"]).toBe(12);
    expect(workflow.jobs["check-additional-shard"].strategy["max-parallel"]).toBe(12);
    expect(workflow.jobs["checks-windows"].strategy["max-parallel"]).toBe(2);
    expect(workflow.jobs.android.strategy["max-parallel"]).toBe(2);
  });

  it("runs changed Docker seed owners in one gated scheduler job", () => {
    const source = readFileSync(".github/workflows/ci.yml", "utf8");
    const jobs = readCiWorkflow().jobs;
    const job = jobs["docker-seed-e2e"];
    expect(source).toContain("docker-seed-e2e-contract-v1");
    expect(source).toContain(
      'typeof changedNodeTestPlan.resolveChangedDockerSeedLanes === "function"',
    );
    expect(jobs.preflight.outputs).toMatchObject({
      docker_seed_lanes: "${{ steps.manifest.outputs.docker_seed_lanes }}",
      run_docker_seed_e2e: "${{ steps.manifest.outputs.run_docker_seed_e2e }}",
    });
    expect(job.if).toBe("needs.preflight.outputs.run_docker_seed_e2e == 'true'");
    expect(job.needs).toEqual(["preflight"]);
    expect(job["timeout-minutes"]).toBe(60);
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.strategy).toBeUndefined();
    expect(job.steps[0]).toEqual(jobs["pnpm-store-warmup"].steps[0]);
    expect(job.steps[1].uses).toBe("./.ci-harness/.github/actions/setup-node-env");
    expect(job.steps[1].with).toMatchObject({
      "build-all-cache-scope": "full",
      "cache-mode": "${{ needs.preflight.outputs.cache_mode }}",
    });
    const run = job.steps.find(
      (step: WorkflowStep) => step.name === "Run changed Docker seed owner lanes",
    ) as WorkflowStep;
    const parallelism = run.env?.OPENCLAW_DOCKER_ALL_PARALLELISM;
    expect(run).toMatchObject({
      run: "pnpm test:docker:all",
      env: {
        OPENCLAW_DOCKER_ALL_LANES: "${{ needs.preflight.outputs.docker_seed_lanes }}",
        OPENCLAW_DOCKER_ALL_LIVE_MODE: "skip",
        OPENCLAW_DOCKER_E2E_ALLOW_UNRELEASED_CHANGELOG: "1",
        OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: "openclaw@latest",
        OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS: "legacy-operator-state",
        OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE: "auto-auth",
        OPENCLAW_DOCKER_ALL_TAIL_PARALLELISM: parallelism,
      },
    });
    expect(parallelism).toContain("&& 3 || 1");
  });

  it.each([
    { repository: "openclaw/openclaw", ref: "refs/heads/main", expected: true },
    { repository: "openclaw/openclaw", ref: "refs/heads/feature", expected: false },
    { repository: "fork/openclaw", ref: "refs/heads/main", expected: false },
  ])(
    "gates only canonical main pushes admitted by CI ($repository $ref)",
    ({ repository, ref, expected }) => {
      const push = readCiWorkflow().on.push;
      expect(push.branches).toEqual(["main"]);
      expect(push).not.toHaveProperty("paths");
      expect(push["paths-ignore"]).toEqual(["**/*.md", "docs/**"]);
      const result = runCiManifestFixture({
        bundledPlanner: true,
        eventName: "push",
        repository,
        changedPaths: ["assets/logo.svg"],
        scopeEnv: { GITHUB_REF: ref },
      });
      expect(result.status, result.output).toBe(0);
      expect(result.outputs.run_docker_seed_e2e).toBe(String(expected));
      expect(result.outputs.docker_seed_lanes).toBe(expected ? "published-upgrade-survivor" : "");
    },
  );

  it.each([
    { paths: ["README.md"], admitted: false },
    { paths: [".agents/skills/example/SKILL.md"], admitted: false },
    { paths: ["docs/ci.md", "docs/images/diagram.svg"], admitted: false },
    { paths: ["docs/reference/schema.json"], admitted: false },
    { paths: ["src/ordinary.ts"], admitted: true },
    { paths: ["assets/logo.svg"], admitted: true },
    { paths: ["README.md", "src/ordinary.ts"], admitted: true },
    { paths: ["docs/ci.md", "assets/logo.svg"], admitted: true },
  ])("admits main push paths $paths to CI: $admitted", ({ paths, admitted }) => {
    const ignored: string[] = readCiWorkflow().on.push["paths-ignore"] ?? [];
    // GitHub skips paths-ignore only when every changed path matches a pattern.
    const runsCi = paths.some(
      (changedPath) => !ignored.some((pattern) => minimatch(changedPath, pattern, { dot: true })),
    );
    expect(runsCi).toBe(admitted);
    if (!runsCi) {
      return;
    }
    const result = runCiManifestFixture({
      bundledPlanner: true,
      eventName: "push",
      repository: "openclaw/openclaw",
      changedPaths: paths,
      scopeEnv: { GITHUB_REF: "refs/heads/main" },
    });
    expect(result.status, result.output).toBe(0);
    expect(result.outputs.run_docker_seed_e2e).toBe("true");
    expect(result.outputs.docker_seed_lanes).toBe("published-upgrade-survivor");
  });

  it("splits Windows tests two ways on every runner backend", () => {
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
    // Blacksmith's Windows class admits exactly 2 concurrent jobs (run
    // 31865243804), so every backend uses the same 2-part split: a 3rd part
    // queues behind a finished one and a single lane serializes the whole body.
    const expectedWindowsMatrix = [
      { check_name: "checks-windows-node-test-1", runtime: "node", task: "test-1" },
      { check_name: "checks-windows-node-test-2", runtime: "node", task: "test-2" },
    ];
    for (const [label, manifest] of [
      ["Blacksmith", blacksmith],
      ["GitHub", github],
      ["hybrid", hybrid],
      ["hybrid dispatch", hybridDispatch],
    ] as const) {
      expect(
        JSON.parse(expectDefined(manifest.outputs.checks_windows_matrix, `${label} Windows matrix`))
          .include,
        label,
      ).toEqual(expectedWindowsMatrix);
    }
    expect(runStep.run).toContain('scripts?.["test:windows:ci:1"]');
    expect(runStep.run).toContain('scripts?.["test:windows:ci:2"]');
    expect(runStep.run).toContain("pnpm test:windows:ci");
    expect(runStep.run).toContain("target's combined Windows suite ran in test-1");
    expect(runStep.run).not.toContain("pnpm test:windows:ci:3");
  });

  it.skipIf(process.platform === "win32").for(["blacksmith", "github", "hybrid"] as const)(
    "executes each Mac partition once and keeps historical coverage on %s",
    (runnerBackend) => {
      const workflow = readCiWorkflow();
      const job = workflow.jobs["macos-node"];
      const runStep = job.steps.find((step: WorkflowStep) => step.name === "TS tests (macOS)");
      const cwd = tempDirs.make("macos-partition-routing-");
      const bin = path.join(cwd, "bin");
      mkdirSync(bin);
      writeFileSync(path.join(bin, "pnpm"), '#!/bin/sh\nprintf "selected=%s\\n" "$*"\n');
      chmodSync(path.join(bin, "pnpm"), 0o755);
      for (const partsSupported of [true, false]) {
        const manifest = runCiManifestFixture({
          bundledPlanner: true,
          eventName: "workflow_dispatch",
          historicalCompatibility: !partsSupported,
          macosNodeParts: partsSupported,
          runnerBackend,
        });
        expect(manifest.status, manifest.output).toBe(0);
        const rows = JSON.parse(
          expectDefined(manifest.outputs.macos_node_matrix, "Mac Node matrix"),
        ).include as Array<{ task: string }>;
        expect(rows.map(({ task }) => task)).toEqual(
          partsSupported ? ["test-1", "test-2", "test-3"] : ["test"],
        );
        const commands = rows.map(({ task }) => {
          const result = runWorkflowShellScript(runStep.run, {
            cwd,
            env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TASK: task },
          });
          expect(result.status, result.stdout + result.stderr).toBe(0);
          return result.stdout.match(/^selected=(.*)$/m)?.[1];
        });
        expect(commands).toEqual(
          partsSupported
            ? ["test:macos:ci:1", "test:macos:ci:2", "test:macos:ci:3"]
            : ["test:macos:ci"],
        );
      }
      expect(job.strategy["max-parallel"]).toBe(3);
      expect(runStep.env.OPENCLAW_VITEST_MAX_WORKERS).toBe(2);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps Windows projects serial on each runner while both jobs remain parallel",
    () => {
      const workflow = readCiWorkflow();
      const job = workflow.jobs["checks-windows"];
      const runStep = job.steps.find(
        (step: WorkflowStep) => step.name === "Run ${{ matrix.task }} (${{ matrix.runtime }})",
      );
      const cwd = tempDirs.make("windows-project-budget-");
      const bin = path.join(cwd, "bin");
      mkdirSync(bin);
      writeFileSync(
        path.join(cwd, "package.json"),
        JSON.stringify({
          scripts: { "test:windows:ci:1": "fixture", "test:windows:ci:2": "fixture" },
        }),
      );
      const pnpm = path.join(bin, "pnpm");
      writeFileSync(
        pnpm,
        '#!/bin/sh\nprintf "project_parallelism=%s\\n" "${OPENCLAW_TEST_PROJECTS_PARALLEL:-1}"\n',
      );
      chmodSync(pnpm, 0o755);
      for (const task of ["test-1", "test-2"]) {
        for (const runner of ["github-hosted", "self-hosted"]) {
          const result = runWorkflowShellScript(runStep.run, {
            cwd,
            env: {
              ...process.env,
              PATH: `${bin}${path.delimiter}${process.env.PATH}`,
              TASK: task,
              RUNNER_ENVIRONMENT: runner,
              OPENCLAW_TEST_PROJECTS_PARALLEL: undefined,
            },
          });
          expect(result.status, result.stdout + result.stderr).toBe(0);
          expect(result.stdout).toContain("project_parallelism=1");
        }
      }
      expect(job.strategy["max-parallel"]).toBe(2);
      expect(job.env.OPENCLAW_VITEST_MAX_WORKERS).toBe(1);
    },
  );

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
          step.uses === "./.ci-harness/.github/actions/setup-android-toolchain",
      ),
    ).toHaveLength(1);
    expect(
      releaseWorkflow.jobs.publish_signed_android_apk.steps.filter(
        (step: WorkflowStep) => step.uses === "./.github/actions/setup-android-toolchain",
      ),
    ).toHaveLength(1);

    const sdkRestoreStep = expectDefined(
      action.runs.steps.find((step: WorkflowStep) => step.name === "Restore Android SDK cache"),
      "Android SDK cache restore step",
    );
    const sdkSaveStep = expectDefined(
      action.runs.steps.find((step: WorkflowStep) => step.name === "Save Android SDK cache"),
      "Android SDK cache save step",
    );
    const gradleCacheStep = expectDefined(
      action.runs.steps.find((step: WorkflowStep) => step.name === "Setup Gradle cache"),
      "Gradle cache setup step",
    );
    const javaStep = expectDefined(
      action.runs.steps.find((step: WorkflowStep) => step.name === "Setup Java"),
      "Android Java setup step",
    );
    const installStep = expectDefined(
      action.runs.steps.find((step: WorkflowStep) => step.name === "Install Android SDK packages"),
      "Android SDK package install step",
    );

    expect(javaStep.uses).toBe("actions/setup-java@b6effb05e454b25005698d916606bdc6ffcbf961");
    expect(javaStep.with).toMatchObject({
      distribution: "temurin",
      "java-version": 17,
    });
    expect(action.inputs["cache-mode"].default).toBe("off");
    expect(sdkRestoreStep.if).toBe("inputs.cache-mode != 'off'");
    expect(sdkRestoreStep.uses).toBe(CACHE_V5);
    expect(sdkRestoreStep.with?.key).toContain(`platform-${appCompileSdk}.0-`);
    expect(sdkSaveStep.if).toContain("inputs.cache-mode == 'read-write'");
    expect(sdkSaveStep.uses).toBe(CACHE_SAVE_V5);
    expect(sdkSaveStep.with?.key).toBe("${{ steps.android-sdk-cache.outputs.cache-primary-key }}");
    expect(gradleCacheStep).toMatchObject({
      if: "inputs.cache-mode != 'off'",
      uses: SETUP_GRADLE_V6,
      with: {
        "add-job-summary": "never",
        "cache-provider": "basic",
        "cache-read-only": "${{ inputs.cache-mode != 'read-write' }}",
      },
    });
    expect(installStep.run).toContain(`"${packageId}"`);
    expect(installStep.run).toContain(
      'yes | sdkmanager --sdk_root="${ANDROID_SDK_ROOT}" --licenses >/dev/null || [[ "${PIPESTATUS[1]}" -eq 0 ]]',
    );
  });

  it("binds frozen target context to the declared live release branch", () => {
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

    for (const contextRef of [
      "release/2026.8.1",
      "release/2026.8.1-1",
      "extended-stable/2026.8.33",
    ]) {
      for (const comparisonStatus of ["ahead", "identical"]) {
        const result = runCiReleaseRefValidation({
          ref: contextRef,
          targetSha,
          resolvedSha: comparisonStatus === "identical" ? targetSha : "b".repeat(40),
          comparisonStatus,
        });
        expect(result.status, `${contextRef}: ${result.output}`).toBe(0);
        expect(result.outputs.eligible).toBe("true");
      }
    }

    for (const contextRef of [
      "v2026.8.1",
      "main",
      "release-ci/2026.8.1-beta.2-frozen",
      "release/2026.8",
      "refs/heads/release/2026.8.1",
    ]) {
      const result = runCiReleaseRefValidation({ ref: contextRef, targetSha });
      expect(result.status, contextRef).toBe(1);
      expect(result.output).toContain(
        "target_context_ref must be a canonical OpenClaw release branch.",
      );
    }

    for (const targetRef of ["main", "a".repeat(39)]) {
      const result = runCiReleaseRefValidation({ ref: "release/2026.8.1", targetSha: targetRef });
      expect(result.status, targetRef).toBe(1);
      expect(result.output).toContain(
        "target_context_ref requires target_ref to be a full commit SHA.",
      );
    }

    for (const comparisonStatus of ["behind", "diverged"]) {
      const result = runCiReleaseRefValidation({
        ref: "release/2026.8.1",
        targetSha,
        comparisonStatus,
      });
      expect(result.status, comparisonStatus).toBe(1);
      expect(result.output).toContain(
        "target_ref must be the declared release branch head or one of its ancestors.",
      );
    }
  });

  it.each([
    { kind: "historical", ref: "v2026.8.1" },
    { kind: "historical", ref: "v2026.8.1-beta.2" },
    { kind: "historical", ref: "v2026.8.1-1" },
    { kind: "candidate", ref: "release/2026.8.1" },
    { kind: "candidate", ref: "release/2026.8.1-1" },
    { kind: "candidate", ref: "extended-stable/2026.8.33" },
  ] as const)("binds authenticated $kind ref $ref to its exact commit", (identity) => {
    const targetSha = "a".repeat(40);
    const accepted = runCiReleaseRefValidation({ ...identity, targetSha, resolvedSha: targetSha });
    expect(accepted.status, accepted.output).toBe(0);
    expect(accepted.outputs.eligible).toBe("true");

    const mismatched = runCiReleaseRefValidation({ ...identity, targetSha });
    expect(mismatched.status).not.toBe(0);
    expect(mismatched.output).toContain(`does not resolve to ${targetSha}`);
    expect(mismatched.outputs).not.toHaveProperty("eligible");
  });

  it.each([
    { kind: "context", ref: "release/2026.8.1", apiError: "ref" },
    { kind: "context", ref: "release/2026.8.1", apiError: "comparison" },
    { kind: "historical", ref: "v2026.8.1", apiError: "ref" },
    { kind: "candidate", ref: "release/2026.8.1", apiError: "ref" },
  ] as const)("rejects unavailable authenticated $kind $apiError evidence", (identity) => {
    const targetSha = "a".repeat(40);
    const result = runCiReleaseRefValidation({
      ...identity,
      targetSha,
      resolvedSha: targetSha,
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("HTTP 503");
    expect(result.outputs).not.toHaveProperty("eligible");
  });

  it.each([
    { kind: "historical", ref: "refs/heads/v2026.8.1" },
    { kind: "historical", ref: "release/2026.8.1" },
    { kind: "candidate", ref: "refs/tags/release/2026.8.1" },
    { kind: "candidate", ref: "v2026.8.1" },
  ] as const)("rejects wrong-namespace $kind ref $ref before remote admission", (identity) => {
    const result = runCiReleaseRefValidation({ ...identity, targetSha: "a".repeat(40) });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("must be a canonical OpenClaw release");
    expect(result.outputs).not.toHaveProperty("eligible");
  });

  // Native Windows Node cannot execute this fixture's POSIX gh child shim.
  it.skipIf(process.platform === "win32")("protects correction credentials", () => {
    const root = tempDirs.make("openclaw-ci-correction-order-");
    const trusted = path.join(root, ".ci-harness/scripts/lib");
    const eventsPath = path.join(root, "events");
    const outputPath = path.join(root, "output");
    const bin = path.join(root, "bin");
    mkdirSync(trusted, { recursive: true });
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(bin);
    writeFileSync(eventsPath, "");
    writeFileSync(outputPath, "");
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.1" }));
    for (const name of ["release-context.mjs", "release-version.mjs"]) {
      writeFileSync(path.join(trusted, name), readFileSync(`scripts/lib/${name}`));
    }
    writeFileSync(
      path.join(trusted, "release-context-original.mjs"),
      readFileSync("scripts/lib/release-context.mjs"),
    );
    const poisonedHelper = `
      import { appendFileSync } from 'node:fs';
      if (process.env.GH_TOKEN) appendFileSync(${JSON.stringify(eventsPath)}, 'token-exposed\\n');
      export { resolveReleaseContextIdentity } from './release-context-original.mjs';
    `;
    writeFileSync(
      path.join(root, "scripts/ci-changed-scope.mjs"),
      `import { appendFileSync, writeFileSync } from 'node:fs';
       appendFileSync(${JSON.stringify(eventsPath)}, 'candidate\\n');
       writeFileSync(${JSON.stringify(path.join(trusted, "release-context.mjs"))}, ${JSON.stringify(poisonedHelper)});`,
    );
    writeExecutable(path.join(bin, "gh"), [
      "#!/bin/sh",
      '[ "$GH_TOKEN" = test-token ] || exit 4',
      `[ "$*" = 'api repos/openclaw/openclaw/commits/refs%2Ftags%2Fv2026.9.1 --jq .sha' ] || exit 64`,
      `printf 'lookup\\n' >> ${quoteShell(eventsPath)}`,
      `printf '%s\\n' '${"a".repeat(40)}'`,
    ]);
    const context = {
      eventName: "workflow_dispatch" as const,
      releaseGate: true,
      releaseScope: "npm-stable",
      repository: "openclaw/openclaw",
      runAttempt: 1,
      targetContextRef: "release/2026.9.1-1",
      workflowToken: "test-token",
      steps: {
        diff_base: { outputs: { sha: "b".repeat(40), head_sha: "a".repeat(40) } },
        target_context_target: { outputs: { eligible: "true" } },
      },
    };
    const steps = readCiWorkflow().jobs.preflight.steps.filter((step: WorkflowStep) =>
      ["Resolve release correction base", "Detect changed scopes"].includes(step.name ?? ""),
    );
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      const evaluate = (expression: string) => evaluateWorkflowExpression(expression, context);
      expect(evaluate(`\${{ ${step.if} }}`), step.name).toBe(true);
      const run = runWorkflowShellScript(
        step.run.replace(/\$\{\{[\s\S]*?\}\}/gu, (expression: string) =>
          String(evaluate(expression)),
        ),
        {
          cwd: root,
          env: {
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            GITHUB_REPOSITORY: context.repository,
            GITHUB_OUTPUT: outputPath,
            ...Object.fromEntries(
              Object.entries(step.env ?? {}).map(([name, value]) => [
                name,
                String(evaluate(String(value))),
              ]),
            ),
          },
        },
      );
      expect(run.status, `${step.name}: ${run.stdout}${run.stderr}`).toBe(0);
    }
    expect(readFileSync(eventsPath, "utf8").trim().split("\n")).toEqual(["lookup", "candidate"]);
    expect(readWorkflowOutputs(outputPath).sha).toBe("a".repeat(40));
  });

  it("pins Swift 6.3 workflow jobs to Xcode 26.6-capable runners", () => {
    const codeql = parse(
      readFileSync(".github/workflows/codeql-macos-critical-security.yml", "utf8"),
    );
    const codeqlJob = codeql.jobs.macos;
    const codeqlSelect = expectDefined(
      codeqlJob.steps.find((step: WorkflowStep) => step.name === "Select Xcode"),
      "CodeQL macOS Xcode selection",
    );

    expect(codeqlJob["runs-on"]).toBe("macos-26");
    expect(codeqlSelect.run).toContain("/Applications/Xcode_26.6.app/Contents/Developer");
    expect(codeqlSelect.run).toContain('if [[ "$xcode_version" != 26.6* ]]; then');

    for (const [workflowPath, selectorCount] of [
      [".github/workflows/ci.yml", 2],
      [".github/workflows/ios-periphery.yml", 1],
      [".github/workflows/macos-periphery.yml", 1],
      [".github/workflows/shared-openclawkit-periphery.yml", 2],
    ] as const) {
      const source = readFileSync(workflowPath, "utf8");
      expect(source.match(/\/Applications\/Xcode_26\.6\.app/gu), workflowPath).toHaveLength(
        selectorCount,
      );
      expect(source.match(/expected Xcode 26\.6/gu), workflowPath).toHaveLength(selectorCount);
      expect(source, workflowPath).not.toContain("Xcode_26.5.app");
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
      path: ".ci-harness",
      "persist-credentials": false,
      ref: "${{ github.workflow_sha }}",
      "sparse-checkout": ".github/actions",
    });
    expect(checkoutIndex).toBeLessThan(actionCheckoutIndex);
    expect(actionCheckoutIndex).toBeLessThan(setupIndex);
  });

  it("bounds Android SDK command-line tools downloads", () => {
    const action = readAndroidToolchainAction();
    const restoreStep = expectDefined(
      action.runs.steps.find((step: WorkflowStep) => step.name === "Restore Android SDK cache"),
      "Android SDK cache restore step",
    );
    const setupStep = expectDefined(
      action.runs.steps.find((step: WorkflowStep) =>
        step.run?.includes("commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip"),
      ),
      "Android SDK setup step",
    );

    expect(restoreStep.with?.key).toBe(
      "${{ runner.os }}-android-sdk-v1-cmdline-15859902-platform-37.0-build-tools-36.0.0",
    );
    expect(String(restoreStep.with?.["restore-keys"]).trim()).toBe(
      "${{ runner.os }}-android-sdk-v1-cmdline-15859902-",
    );
    expect(setupStep.run).toContain('CMDLINE_TOOLS_VERSION="15859902"');
    expect(setupStep.run).toContain(
      'CMDLINE_TOOLS_SHA256="4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583"',
    );
    expect(setupStep.run).toContain("curl -fsSL --connect-timeout 10 --max-time 300");
    expect(setupStep.run).toContain("sha256sum --check -");
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
    expect(source).toContain('task: "test-third-party"');
    expect(source.match(/check_name: "android-build-play"/gu)).toHaveLength(1);
    expect(source).toContain('task: useCompatibleAndroidCi ? "build-play-compat" : "build-play"');
    expect(androidJob.name).toBe("${{ matrix.check_name || 'android' }}");
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
    expect(nativeResourcesSetup.uses).toBe("./.ci-harness/.github/actions/setup-node-env");
    expect(nativeResourcesSetup.if).toBe(
      "needs.preflight.outputs.use_compatible_android_ci != 'true'",
    );
    expect(nativeResourcesSetup.with).toMatchObject({ "install-bun": "false" });
  });

  describe("Android validation tiers", () => {
    function runAndroidTask(
      row: Record<string, unknown>,
      context: Parameters<typeof evaluateWorkflowExpression>[1],
      failTask = "",
    ) {
      const step: WorkflowStep = expectDefined(
        readCiWorkflow().jobs.android.steps.find(
          (candidate: WorkflowStep) => candidate.name === "Run Android ${{ matrix.task }}",
        ),
        "Android task runner",
      );
      const root = tempDirs.make("openclaw-android-tier-");
      const callsPath = path.join(root, "gradle-calls.jsonl");
      writeExecutable(path.join(root, "gradlew"), [
        "#!/usr/bin/env node",
        'require("node:fs").appendFileSync(process.env.GRADLE_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");',
        "if (process.argv.includes(process.env.FAIL_GRADLE_TASK)) process.exit(23);",
      ]);
      const result = runWorkflowShellScript(expectDefined(step.run, "Android commands"), {
        cwd: root,
        env: {
          ...process.env,
          ...Object.fromEntries(
            Object.entries(step.env ?? {}).map(([key, value]) => [
              key,
              String(evaluateWorkflowExpression(value, { ...context, matrix: row })),
            ]),
          ),
          GITHUB_EVENT_NAME: context.eventName,
          OPENCLAW_ROBOLECTRIC_INIT: "robolectric.gradle",
          GRADLE_CALLS: callsPath,
          FAIL_GRADLE_TASK: failTask,
        },
      });
      const calls: string[][] = existsSync(callsPath)
        ? readFileSync(callsPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
      return { ...result, calls, tasks: calls.flat().filter((arg) => arg.startsWith(":")) };
    }

    it.each([
      { eventName: "pull_request", releaseGate: false, full: false, legacy: false },
      { eventName: "push", releaseGate: false, full: false, legacy: false },
      { eventName: "workflow_dispatch", releaseGate: true, full: false, legacy: false },
      { eventName: "workflow_dispatch", releaseGate: false, full: true, legacy: false },
      { eventName: "workflow_dispatch", releaseGate: false, full: true, legacy: true },
    ] as const)(
      "executes Android test/lint and retained full-tier commands for %j",
      ({ eventName, releaseGate, full, legacy }) => {
        const manifest = runCiManifestFixture({
          bundledPlanner: !legacy,
          eventName,
          releaseGate,
          historicalCompatibility: true,
          changedPaths: ["apps/android/app/src/main/java/ai/openclaw/app/Example.kt"],
        });
        expect(manifest.status, manifest.output).toBe(0);
        const rows: Record<string, unknown>[] = JSON.parse(
          expectDefined(manifest.outputs.android_matrix, "Android matrix"),
        ).include;
        expect(rows.map(({ task }) => task)).toEqual(
          legacy
            ? ["test-play-compat", "test-third-party", "build-play-compat"]
            : [
                "test-play",
                "test-third-party",
                "test-wear",
                ...(full ? ["build-play", "build-wear"] : []),
                "ktlint",
              ],
        );
        const context = {
          eventName,
          releaseGate,
          repository: "openclaw/openclaw",
          runAttempt: 1,
          preflightOutputs: manifest.outputs,
        };
        const tasks = rows.flatMap((row) => {
          const result = runAndroidTask(row, context);
          expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
          for (const call of result.calls) {
            expect(call).toContain("--no-daemon");
            expect(call).toContain("--build-cache");
            const testCall = call.some((arg) => arg.endsWith("UnitTest"));
            expect(call.includes("--init-script")).toBe(testCall);
          }
          if (row.task === "build-play") {
            expect(result.calls.map((call) => call.filter((arg) => arg.startsWith(":")))).toEqual([
              [":app:assemblePlayDebug", ":app:lintPlayDebug"],
              [":app:assembleThirdPartyDebug", ":app:lintThirdPartyDebug"],
              [":benchmark:assembleDebug", ":wear-shared:assembleDebug", ":wear-shared:lintDebug"],
            ]);
          }
          return result.tasks;
        });
        expect(tasks.toSorted()).toEqual(
          (legacy
            ? [
                ":app:testPlayDebugUnitTest",
                ":app:testThirdPartyDebugUnitTest",
                ":app:assemblePlayDebug",
              ]
            : [
                ":app:testPlayDebugUnitTest",
                ":wear-shared:testDebugUnitTest",
                ":app:testThirdPartyDebugUnitTest",
                ":wear:testDebugUnitTest",
                ":app:lintPlayDebug",
                ":app:lintThirdPartyDebug",
                ":wear-shared:lintDebug",
                ":wear:lintDebug",
                ":app:ktlintCheck",
                ":benchmark:ktlintCheck",
                ":wear:ktlintCheck",
                ":wear-shared:ktlintCheck",
                ...(full
                  ? [
                      ":app:assemblePlayDebug",
                      ":app:assembleThirdPartyDebug",
                      ":benchmark:assembleDebug",
                      ":wear-shared:assembleDebug",
                      ":wear:assembleDebug",
                    ]
                  : []),
              ]
          ).toSorted(),
        );
        expect(new Set(tasks).size, "no duplicate lint or build invocations").toBe(tasks.length);
        for (const result of ["failure", "cancelled", "skipped"]) {
          expect(
            runCiGateFixture(renderCiGateEnvironment(context, { android: result })).status,
          ).toBe(1);
        }
      },
    );

    it.each([
      { paths: ["apps/android/benchmark/src/main/Example.kt"], build: true },
      { paths: ["apps/android/build.gradle.kts"], build: true },
      { paths: ["apps/android/app/build.gradle.kts"], build: true },
      { paths: ["apps/android/settings.gradle.kts"], build: true },
      { paths: ["apps/android/gradle.properties"], build: true },
      { paths: ["apps/android/gradle/libs.versions.toml"], build: true },
      { paths: ["apps/android/gradle/wrapper/gradle-wrapper.properties"], build: true },
      { paths: ["apps/android/gradlew"], build: true },
      { paths: ["apps/android/Config/Version.properties"], build: true },
      { paths: ["apps/android/app/src/main/java/ai/openclaw/app/Example.kt"], build: false },
      { paths: ["apps/android/wear/src/main/Example.kt"], build: false },
      { paths: ["docs/ci.md"], build: false },
      { paths: [], build: true },
      { paths: [""], build: true },
      { paths: null, build: true },
      { paths: undefined, build: true },
      { paths: undefined, json: "{", build: true },
      { paths: undefined, json: "[42]", build: true },
    ])("retains benchmark assembly for changed or unknown inputs: %j", ({ paths, json, build }) => {
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        eventName: "pull_request",
        runNode: false,
        changedPaths: paths,
        ...(json ? { scopeEnv: { OPENCLAW_CI_CHANGED_PATHS_JSON: json } } : {}),
      });
      expect(manifest.status, manifest.output).toBe(0);
      const rows: Record<string, unknown>[] = JSON.parse(
        expectDefined(manifest.outputs.android_matrix, "Android matrix"),
      ).include;
      expect(rows).toHaveLength(4);
      const result = runAndroidTask(
        expectDefined(
          rows.find(({ task }) => task === "ktlint"),
          "Kotlin lint row",
        ),
        {
          eventName: "pull_request",
          repository: "openclaw/openclaw",
          runAttempt: 1,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.tasks.includes(":benchmark:assembleDebug")).toBe(build);
    });

    it.each([
      ["test-play", ":app:testPlayDebugUnitTest"],
      ["test-play", ":app:lintPlayDebug"],
      ["test-third-party", ":app:lintThirdPartyDebug"],
      ["test-wear", ":wear:lintDebug"],
      ["ktlint", ":benchmark:assembleDebug"],
    ])("propagates %s failure from %s", (task, failTask) => {
      const result = runAndroidTask(
        { task, lint: true, build_benchmark: true },
        { eventName: "pull_request", repository: "openclaw/openclaw", runAttempt: 1 },
        failTask,
      );
      expect(result.status).toBe(23);
      if (failTask.endsWith("UnitTest")) {
        expect(result.calls).toHaveLength(1);
      }
    });
  });

  describe("CI workflow admission", () => {
    type EventContext = Parameters<typeof evaluateWorkflowExpression>[1];
    type AdmissionRun = {
      context: EventContext;
      group: string;
      state: "pending" | "running" | "cancelling" | "cancelled" | "completed" | "skipped";
      eligibleJobs?: string[];
    };
    const guardedJobs = ["preflight", "security-fast", "ci-gate"];
    const event = (runId: number, overrides: Partial<EventContext> = {}): EventContext => ({
      eventName: "pull_request",
      action: "ready_for_review",
      draft: false,
      pullRequestNumber: 7,
      headSha: "a".repeat(40),
      sha: "b".repeat(40),
      ref: "refs/pull/7/merge",
      repository: "openclaw/openclaw",
      workflow: "CI",
      runAttempt: 1,
      runId,
      runNumber: runId,
      ...overrides,
    });

    function admissionDriver() {
      const workflow = readCiWorkflow();
      const runs: AdmissionRun[] = [];
      const active = (run: AdmissionRun) => run.state === "running" || run.state === "cancelling";
      return {
        admit(context: EventContext): AdmissionRun {
          if (context.eventName === "pull_request") {
            expect(workflow.on.pull_request.types).toContain(context.action);
          }
          const group: string = evaluateWorkflowExpression(workflow.concurrency.group, context);
          const cancel = evaluateWorkflowExpression(
            workflow.concurrency["cancel-in-progress"],
            context,
          );
          // GitHub replaces pending work even without active cancellation:
          // https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency
          for (const previous of runs.filter(
            (run) => run.group.toLowerCase() === group.toLowerCase(),
          )) {
            if (previous.state === "pending") {
              previous.state = "cancelled";
            }
            if (active(previous) && cancel) {
              previous.state = "cancelling";
            }
          }
          const run: AdmissionRun = { context, group, state: "pending" };
          runs.push(run);
          return run;
        },
        start(run: AdmissionRun) {
          if (
            run.state !== "pending" ||
            runs.some((other) => other.group === run.group && active(other))
          ) {
            return;
          }
          // Admission precedes job conditions. This probes eligibility, not the job DAG.
          run.eligibleJobs = guardedJobs.filter((job) => {
            const condition: string = workflow.jobs[job].if;
            return evaluateWorkflowExpression(
              condition.startsWith("${{") ? condition : `\${{ ${condition} }}`,
              run.context,
            );
          });
          run.state = run.eligibleJobs.length ? "running" : "skipped";
        },
        finish(run: AdmissionRun) {
          expect(active(run)).toBe(true);
          run.state = run.state === "cancelling" ? "cancelled" : "completed";
        },
        cancel(run: AdmissionRun) {
          run.state = "cancelled";
        },
      };
    }

    // Synthetic admission orders, not recovered webhook payloads.
    it.each(
      ["opened", "reopened", "synchronize"].flatMap((action) =>
        ["pending", "running"].map((state) => ({ action, state })),
      ),
    )("preserves $state ready CI after a delayed draft $action", ({ action, state }) => {
      const scheduler = admissionDriver();
      const predecessor = scheduler.admit(event(1, { action: "opened" }));
      scheduler.start(predecessor);
      const ready = scheduler.admit(event(2));
      if (state === "running") {
        scheduler.finish(predecessor);
        scheduler.start(ready);
      }
      expect(ready.state).toBe(state);
      const lateDraft = scheduler.admit(event(3, { action, draft: true }));
      expect(ready.state, "late draft displaced runnable ready CI").toBe(state);
      scheduler.start(lateDraft);
      expect(lateDraft.state).toBe("skipped");
      expect(lateDraft.eligibleJobs).toEqual([]);
      const anotherDraft = scheduler.admit(event(4, { action, draft: true }));
      expect(anotherDraft.group).not.toBe(lateDraft.group);
      expect(lateDraft.group).not.toBe(ready.group);
      if (state === "pending") {
        expect(ready.eligibleJobs).toBeUndefined();
        scheduler.start(ready);
        expect(ready.state).toBe("pending");
        scheduler.finish(predecessor);
        scheduler.start(ready);
      }
      expect(ready.state).toBe("running");
      expect(ready.eligibleJobs).toEqual(guardedJobs);
    });

    it("admits ready CI after the forward draft-to-ready sequence", () => {
      const scheduler = admissionDriver();
      const draft = scheduler.admit(event(1, { action: "opened", draft: true }));
      scheduler.start(draft);
      expect(draft.eligibleJobs).toEqual([]);
      expect(draft.state).toBe("skipped");
      const ready = scheduler.admit(event(2));
      scheduler.start(ready);
      expect(ready.group).toBe("CI-v7-7");
      expect(ready.eligibleJobs).toEqual(guardedJobs);
    });

    it.each(["pending", "running"])(
      "converted_to_draft cancels %s CI and skips its jobs",
      (state) => {
        const scheduler = admissionDriver();
        const previous = scheduler.admit(event(1));
        scheduler.start(previous);
        const ready = state === "pending" ? scheduler.admit(event(2)) : previous;
        const converted = scheduler.admit(event(3, { action: "converted_to_draft", draft: true }));
        expect(converted.group).toBe("CI-v7-7");
        expect(ready.state).toBe(state === "pending" ? "cancelled" : "cancelling");
        expect(previous.state).toBe("cancelling");
        scheduler.finish(previous);
        scheduler.start(converted);
        expect(converted.state).toBe("skipped");
        expect(converted.eligibleJobs).toEqual([]);
      },
    );

    it.each(["pending", "running"])(
      "a newer non-draft head supersedes %s CI only for its PR",
      (state) => {
        const scheduler = admissionDriver();
        const otherPr = scheduler.admit(
          event(1, { pullRequestNumber: 8, ref: "refs/pull/8/merge" }),
        );
        scheduler.start(otherPr);
        const old = scheduler.admit(event(2));
        if (state === "running") {
          scheduler.start(old);
        }
        const next = scheduler.admit(
          event(3, {
            action: "synchronize",
            headSha: "c".repeat(40),
            sha: "d".repeat(40),
          }),
        );
        expect(next.group).toBe(old.group);
        expect(old.state).toBe(state === "pending" ? "cancelled" : "cancelling");
        expect(otherPr.state).toBe("running");
        if (state === "running") {
          scheduler.finish(old);
        }
        scheduler.start(next);
        expect(next.eligibleJobs).toEqual(guardedJobs);
      },
    );

    it("isolates manual dispatches on the same target from each other and PR CI", () => {
      const scheduler = admissionDriver();
      const ready = scheduler.admit(event(1));
      scheduler.start(ready);
      const manual = [2, 3].map((runId) =>
        scheduler.admit(
          event(runId, {
            eventName: "workflow_dispatch",
            targetRef: "a".repeat(40),
          }),
        ),
      );
      for (const run of manual) {
        scheduler.start(run);
        expect(run.state).toBe("running");
        expect(run.eligibleJobs).toEqual(guardedJobs);
      }
      expect(manual.map((run) => run.group)).toEqual(["CI-manual-v1-2", "CI-manual-v1-3"]);
      expect(ready.state).toBe("running");
    });

    it.each(["pending", "running"])(
      "passive drafts do not resurrect explicitly cancelled %s CI",
      (state) => {
        const scheduler = admissionDriver();
        const ready = scheduler.admit(event(1));
        if (state === "running") {
          scheduler.start(ready);
        }
        scheduler.cancel(ready);
        const draft = scheduler.admit(event(2, { action: "synchronize", draft: true }));
        scheduler.start(draft);
        scheduler.start(ready);
        expect(ready.state).toBe("cancelled");
        expect(draft.state).toBe("skipped");
        expect(draft.eligibleJobs).toEqual([]);
        expect(
          evaluateWorkflowExpression(readCiWorkflow().jobs["ci-gate"].if, {
            ...ready.context,
            cancelled: ready.state === "cancelled",
          }),
        ).toBe(false);
      },
    );

    it("pipelines canonical main across two non-canceling slots with coalesced pending work", () => {
      const workflow = readCiWorkflow();
      const scheduler = admissionDriver();
      const push = (runId: number) =>
        event(runId, {
          eventName: "push",
          ref: "refs/heads/main",
          sha: runId.toString(16).padStart(40, "0"),
        });
      for (let digit = 0; digit < 10; digit++) {
        expect(evaluateWorkflowExpression(workflow.concurrency.group, push(100 + digit))).toBe(
          `CI-v8-refs/heads/main-${digit % 2 === 0 ? "a" : "b"}`,
        );
        expect(
          evaluateWorkflowExpression(workflow.concurrency["cancel-in-progress"], push(100 + digit)),
        ).toBe(false);
      }
      const active = [20, 21].map((id) => scheduler.admit(push(id)));
      active.forEach((run) => scheduler.start(run));
      const pending = [22, 23].map((id) => scheduler.admit(push(id)));
      const newest = [24, 25].map((id) => scheduler.admit(push(id)));
      expect(active.map((run) => run.state)).toEqual(["running", "running"]);
      expect(pending.map((run) => run.state)).toEqual(["cancelled", "cancelled"]);
      for (const run of newest) {
        scheduler.start(run);
        expect(run.state).toBe("pending");
        expect(run.eligibleJobs).toBeUndefined();
      }
      scheduler.finish(active[0]!);
      newest.forEach((run) => scheduler.start(run));
      expect(newest.map((run) => run.state)).toEqual(["running", "pending"]);
      scheduler.finish(active[1]!);
      scheduler.start(newest[1]!);
      expect(newest.map((run) => run.state)).toEqual(["running", "running"]);
      expect(workflow.jobs["runner-admission"]).toBeUndefined();
      expect(workflow.jobs.preflight.needs).toBeUndefined();
      expect(workflow.jobs["security-fast"].needs).toBeUndefined();
    });

    it.each([
      ["openclaw/openclaw", "refs/heads/topic", "CI-v7-refs/heads/topic"],
      ["contributor/fork", "refs/heads/main", `CI-v7-refs/heads/main-${"b".repeat(40)}`],
      ["contributor/fork", "refs/heads/topic", `CI-v7-refs/heads/topic-${"b".repeat(40)}`],
    ])("preserves push grouping for %s on %s", (repository, ref, group) => {
      const workflow = readCiWorkflow();
      const context = event(1, { eventName: "push", repository, ref });
      expect(evaluateWorkflowExpression(workflow.concurrency.group, context)).toBe(group);
      expect(evaluateWorkflowExpression(workflow.concurrency["cancel-in-progress"], context)).toBe(
        false,
      );
    });
  });

  it.each([
    { buildImpact: false, uiE2e: false },
    { buildImpact: true, uiE2e: true },
  ])(
    "composes dedicated suite coverage before precise planning (build=$buildImpact, UI=$uiE2e)",
    ({ buildImpact, uiE2e }) => {
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        eventName: "pull_request",
        changedPaths: [buildImpact ? "src/fixture.ts" : "src/plugins/contracts/fixture-a.test.ts"],
        scopeEnv: { OPENCLAW_CI_RUN_UI_TESTS: String(uiE2e) },
        changedPlannerSource: `
        export const createChangedNodeTestShards = (_paths, options = {}) => {
          console.log("dedicated-coverage:" + JSON.stringify(options));
          return ${
            buildImpact
              ? "[]"
              : `[{ checkName: "changed-boundary", shardName: "changed-boundary",
            configs: ["test/vitest/vitest.boundary.config.ts"], requiresDist: false,
            runner: "ubuntu-24.04" }]`
          };
        };
        export const createChangedExtensionFallbackShards = () => { throw new Error("Unexpected broad fallback"); };
        export const hasBuildArtifactAffectingChange = () => ${buildImpact};
        export const hasSqliteSessionLifecycleAffectingChange = () => false;
      `,
      });
      expect(manifest.status, manifest.output).toBe(0);
      const dedicated = ["plugin", "channel"].flatMap((family) => {
        expect(manifest.outputs[`run_${family}_contracts_shards`]).toBe("true");
        const rows = JSON.parse(
          expectDefined(manifest.outputs[`${family}_contracts_matrix`], family),
        ).include;
        expect(rows).toHaveLength(1);
        return rows.flatMap((row: { groups: unknown[] }) => row.groups);
      });
      expect(dedicated).toHaveLength(4);
      const coverage = expectDefined(
        manifest.output.split("\n").find((line) => line.startsWith("dedicated-coverage:")),
        "precise planner coverage input",
      );
      expect(JSON.parse(coverage.slice("dedicated-coverage:".length))).toEqual({
        dedicatedContractShards: dedicated,
        dedicatedUiE2e: uiE2e,
      });
      for (const job of ["checks-ui-e2e", "checks-ui-e2e-real-gateway"]) {
        expect(
          evaluateWorkflowExpression(`\${{ ${readCiWorkflow().jobs[job].if} }}`, {
            eventName: "pull_request",
            repository: "openclaw/openclaw",
            runAttempt: 1,
            preflightOutputs: manifest.outputs,
          }),
          job,
        ).toBe(uiE2e);
      }
      const nodeRows = JSON.parse(
        expectDefined(manifest.outputs.checks_node_core_nondist_matrix, "precise matrix"),
      ).include;
      expect(nodeRows).toEqual(
        buildImpact ? [] : [expect.objectContaining({ shard_name: "changed-boundary" })],
      );
      expect(manifest.outputs.run_build_artifacts).toBe(String(buildImpact));
      expect(manifest.outputs.run_checks_node_core_dist).toBe(String(buildImpact));
    },
  );

  it.each([
    ["push", "blacksmith", false],
    ["pull_request", "github", false],
    ["pull_request", "hybrid", false],
    ["workflow_dispatch", "blacksmith", false],
    ["workflow_dispatch", "blacksmith", true],
    ["workflow_dispatch", "github", true],
  ] as const)(
    "shares contract setup while retaining process envelopes (%s, %s, frozen=%s)",
    (eventName, runnerProfile, frozenTarget) => {
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        changedPaths: ["package.json"],
        eventName,
        runnerProfile,
        scopeEnv: {
          OPENCLAW_CI_WORKFLOW_REVISION: (frozenTarget ? "b" : "a").repeat(40),
        },
      });
      expect(manifest.status, manifest.output).toBe(0);
      for (const family of ["plugin", "channel"] as const) {
        const outputName = `${family}_contracts_matrix`;
        const rows = JSON.parse(expectDefined(manifest.outputs[outputName], outputName)).include;
        const expected = ["a", "b"].map((suffix) => ({
          checkName: `${family}-contracts-${suffix}`,
          includePatterns: [
            `${family === "plugin" ? "src/plugins" : "src/channels/plugins"}/contracts/fixture-${suffix}.test.ts`,
          ],
          runtime: "node",
          task: `contracts-${family}s`,
        }));
        expect(rows).toHaveLength(frozenTarget ? 2 : 1);
        expect(rows.flatMap((row: { groups: unknown[] }) => row.groups)).toEqual(expected);
        expect(rows.map((row: { checkName: string }) => row.checkName)).toEqual(
          frozenTarget
            ? expected.map((shard) => shard.checkName)
            : [`checks-fast-contracts-${family}s`],
        );
      }
    },
  );

  it.each(["plugin", "channel"] as const)(
    "joins %s contract envelopes and stops admission on any failure",
    (family) => {
      const workflow = readCiWorkflow();
      const job = workflow.jobs[`checks-fast-${family}-contracts-shard`];
      const step = job.steps.find(
        (candidate: WorkflowStep) => candidate.name === `Run ${family} contract shard`,
      );
      expect(step.env.OPENCLAW_CONTRACT_INCLUDE_PATTERNS_JSON).toBe("${{ toJson(matrix) }}");
      expect(step.env.OPENCLAW_TEST_PROJECTS_PARALLEL).toBe(family === "channel" ? "4" : undefined);
      const fixture = tempDirs.make("openclaw-contract-groups-");
      const binDir = path.join(fixture, "bin");
      mkdirSync(binDir);
      const commandLog = path.join(fixture, "commands.jsonl");
      const pnpm = path.join(binDir, "pnpm");
      writeFileSync(
        pnpm,
        String.raw`#!${process.execPath}
const fs = require("node:fs");
const files = JSON.parse(fs.readFileSync(process.env.OPENCLAW_VITEST_INCLUDE_FILE, "utf8"));
const record = { args: process.argv.slice(2), files, parallel: process.env.OPENCLAW_TEST_PROJECTS_PARALLEL ?? null };
fs.appendFileSync(process.env.CONTRACT_COMMAND_LOG, JSON.stringify({ ...record, phase: "start" }) + "\n");
setImmediate(() => {
  fs.appendFileSync(process.env.CONTRACT_COMMAND_LOG, JSON.stringify({ ...record, phase: "end" }) + "\n");
  process.exitCode = files[0] === "first.test.ts" ? Number(process.env.CONTRACT_FIRST_EXIT) : 0;
});

`,
      );
      chmodSync(pnpm, 0o755);
      for (const firstExit of [0, 7, 143]) {
        writeFileSync(commandLog, "");
        const run = runWorkflowShellScript(step.run, {
          cwd: fixture,
          env: {
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
            RUNNER_TEMP: fixture,
            CONTRACT_COMMAND_LOG: commandLog,
            CONTRACT_FIRST_EXIT: String(firstExit),
            OPENCLAW_TEST_PROJECTS_PARALLEL: step.env.OPENCLAW_TEST_PROJECTS_PARALLEL,
            OPENCLAW_CONTRACT_INCLUDE_PATTERNS_JSON: JSON.stringify({
              task: `contracts-${family}s`,
              groups: [
                { checkName: "first-envelope", includePatterns: ["first.test.ts"] },
                { checkName: "second-envelope", includePatterns: ["second.test.ts"] },
              ],
            }),
          },
        });
        expect(run.status, `${run.stdout}${run.stderr}`).toBe(firstExit);
        const files = firstExit === 0 ? ["first.test.ts", "second.test.ts"] : ["first.test.ts"];
        expect(
          readFileSync(commandLog, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual(
          files.flatMap((file) =>
            ["start", "end"].map((phase) => ({
              args: [`test:contracts:${family}s`],
              files: [file],
              parallel: family === "channel" ? "4" : null,
              phase,
            })),
          ),
        );
      }
    },
  );

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

  it("keeps hybrid preflight and the gate hosted while security uses Blacksmith", () => {
    const workflow = readCiWorkflow();
    expect(workflow.jobs["ci-gate"]["runs-on"]).toBe("ubuntu-24.04");
    const context = {
      eventName: "pull_request",
      repository: "openclaw/openclaw",
      runAttempt: 1,
      runnerBackend: "hybrid",
    } as const;

    for (const jobName of ["preflight", "security-fast"]) {
      const expression = workflow.jobs[jobName]["runs-on"];
      for (const eventName of ["pull_request", "push"] as const) {
        expect(evaluateWorkflowExpression(expression, { ...context, eventName }), jobName).toBe(
          jobName === "preflight" ? "ubuntu-24.04" : "blacksmith-4vcpu-ubuntu-2404",
        );
      }
      for (const override of [
        { runAttempt: 2 },
        { runnerBackend: "github" },
        { eventName: "workflow_dispatch" },
        { repository: "contributor/openclaw" },
        { authorAssociation: "NONE", headRepository: "contributor/openclaw" },
      ] as const) {
        expect(evaluateWorkflowExpression(expression, { ...context, ...override }), jobName).toBe(
          "ubuntu-24.04",
        );
      }
      for (const runnerBackend of ["", "blacksmith"] as const) {
        for (const eventName of ["pull_request", "push"] as const) {
          expect(
            evaluateWorkflowExpression(expression, { ...context, eventName, runnerBackend }),
            jobName,
          ).toBe(jobName === "security-fast" ? "ubuntu-24.04" : "blacksmith-4vcpu-ubuntu-2404");
        }
      }
    }
  });

  it.each(
    [
      {
        file: "full-release-validation.yml",
        runner: "blacksmith-4vcpu-ubuntu-2404",
        jobs: [
          "release_checks_independent",
          "release_checks_candidate",
          "performance",
          "release_execution_plan",
          "release_decision",
          "diagnostic_drain",
        ],
      },
      {
        file: "openclaw-npm-preflight.yml",
        runner: "blacksmith-32vcpu-ubuntu-2404",
        jobs: [
          "check_openclaw_npm",
          "prepare_openclaw_npm",
          "check_sdk_npm",
          "check_dependencies_npm",
          "check_contents_npm",
          "verify_openclaw_npm",
        ],
      },
      {
        file: "qa-live-transports-convex.yml",
        runner: "blacksmith-8vcpu-ubuntu-2404",
        jobs: ["authorize_actor", "validate_selected_ref"],
      },
      {
        file: "qa-live-transports-convex.yml",
        runner: "blacksmith-16vcpu-ubuntu-2404",
        jobs: [
          "run_mock_parity",
          "run_live_runtime_token_efficiency",
          "run_live_matrix",
          "run_live_buzz",
          "run_live_telegram",
          "run_live_discord",
          "run_live_whatsapp",
          "run_live_slack",
        ],
      },
      {
        file: "openclaw-performance.yml",
        runner: "blacksmith-16vcpu-ubuntu-2404",
        jobs: ["kova", "source_performance"],
      },
      {
        file: "npm-telegram-beta-e2e.yml",
        runner: "blacksmith-32vcpu-ubuntu-2404",
        jobs: ["run_package_telegram_e2e"],
      },
      {
        file: "openclaw-live-and-e2e-checks-reusable.yml",
        runner: "blacksmith-32vcpu-ubuntu-2404",
        jobs: ["validate_docker_openwebui"],
      },
      {
        file: "openclaw-release-checks.yml",
        runner: "blacksmith-8vcpu-ubuntu-2404",
        jobs: ["qa_lab_runtime_pair_lane_release_checks"],
      },
    ].flatMap(({ file, runner, jobs }) => jobs.map((job) => ({ file, runner, job }))),
  )("honors the global hosted runner override for $file/$job", ({ file, runner, job }) => {
    const workflow = parse(readFileSync(`.github/workflows/${file}`, "utf8"));
    const runsOn = workflow.jobs[job]["runs-on"];
    const supportsHostedInput =
      file === "openclaw-npm-preflight.yml" || file === "openclaw-live-and-e2e-checks-reusable.yml";

    for (const runnerBackend of ["github", "", "blacksmith", "hybrid"] as const) {
      for (const useGithubHostedRunners of [false, true]) {
        const expectedRunner =
          runnerBackend === "github" || (supportsHostedInput && useGithubHostedRunners)
            ? "ubuntu-24.04"
            : runner;
        const actualRunner =
          typeof runsOn === "string" && runsOn.startsWith("${{")
            ? evaluateWorkflowExpression(runsOn, {
                eventName: "workflow_dispatch",
                repository: "openclaw/openclaw",
                runAttempt: 1,
                runnerBackend,
                useGithubHostedRunners,
              })
            : runsOn;

        expect(
          actualRunner,
          `${runnerBackend || "unset"}, use_github_hosted_runners=${useGithubHostedRunners}`,
        ).toBe(expectedRunner);
      }
    }
  });

  it("resolves one event-aware logical runner profile without changing physical routing", () => {
    const scenarios = [
      {
        expected: "github",
        name: "current manual dispatch ignores configured Blacksmith",
        options: {
          configuredProfile: "blacksmith",
          eventName: "workflow_dispatch" as const,
          targetSupportsContract: true,
        },
      },
      {
        expected: "blacksmith",
        name: "canonical trusted push keeps the default",
        options: {
          eventName: "push" as const,
          targetSupportsContract: true,
        },
      },
      {
        expected: "github",
        name: "canonical trusted push keeps configured GitHub",
        options: {
          configuredProfile: "github",
          eventName: "push" as const,
          targetSupportsContract: true,
        },
      },
      {
        expected: "hybrid",
        name: "canonical trusted hybrid retry keeps the hybrid workload shape",
        options: {
          authorAssociation: "CONTRIBUTOR",
          configuredProfile: "hybrid",
          eventName: "pull_request" as const,
          runAttempt: 2,
          targetSupportsContract: true,
        },
      },
      {
        expected: "github",
        name: "fork pull request is hosted",
        options: {
          configuredProfile: "hybrid",
          eventName: "pull_request" as const,
          headRepository: "contributor/openclaw",
          targetSupportsContract: true,
        },
      },
      {
        expected: "github",
        name: "untrusted same-repository pull request is hosted",
        options: {
          authorAssociation: "NONE",
          configuredProfile: "blacksmith",
          eventName: "pull_request" as const,
          targetSupportsContract: true,
        },
      },
      {
        expected: "github",
        name: "noncanonical repository is hosted",
        options: {
          configuredProfile: "blacksmith",
          eventName: "push" as const,
          repository: "fork/openclaw",
          targetSupportsContract: true,
        },
      },
      {
        expected: "blacksmith",
        name: "frozen target without the marker keeps legacy dispatch behavior",
        options: {
          configuredProfile: "blacksmith",
          eventName: "workflow_dispatch" as const,
          targetSupportsContract: false,
        },
      },
      {
        expected: "github",
        name: "frozen target with the marker uses event-aware dispatch behavior",
        options: {
          configuredProfile: "blacksmith",
          eventName: "workflow_dispatch" as const,
          targetSupportsContract: true,
        },
      },
    ];

    for (const { expected, name, options } of scenarios) {
      const result = runRunnerProfileFixture(options);
      expect(result.status, `${name}: ${result.output}`).toBe(0);
      expect(result.outputs.runner_profile, name).toBe(expected);
      expect(result.outputs.hosted_runner_profile_contract, name).toBe(
        String(options.targetSupportsContract),
      );
    }

    const invalid = runRunnerProfileFixture({
      configuredProfile: "other",
      eventName: "push",
      targetSupportsContract: true,
    });
    expect(invalid.status).toBe(1);
    expect(invalid.output).toContain(
      "OPENCLAW_CI_RUNNER_BACKEND must be github, hybrid, or blacksmith",
    );

    const workflow = readCiWorkflow();
    expect(workflow.jobs.preflight.outputs.runner_profile).toBe(
      "${{ steps.runner_profile.outputs.runner_profile }}",
    );
    expect(workflow.jobs.preflight["runs-on"]).toContain("vars.OPENCLAW_CI_RUNNER_BACKEND");

    const dispatchManifest = runCiManifestFixture({
      bundledPlanner: true,
      eventName: "workflow_dispatch",
      historicalCompatibility: false,
      runnerBackend: "blacksmith",
      runnerProfile: "github",
    });
    expect(dispatchManifest.status, dispatchManifest.output).toBe(0);
    expect(
      JSON.parse(expectDefined(dispatchManifest.outputs.ui_e2e_matrix, "dispatch UI E2E matrix"))
        .include,
    ).toHaveLength(13);
    expect(
      JSON.parse(
        expectDefined(dispatchManifest.outputs.qa_smoke_ci_matrix, "dispatch QA smoke matrix"),
      ).include,
    ).toHaveLength(6);
  });

  it.each(["", "release/2026.9.1"])(
    "honors trusted dispatch runner selection for check shards with context %j",
    (targetContextRef) => {
      const runsOn = readCiWorkflow().jobs["check-shard"]["runs-on"];
      const lintMatrix = {
        runner: "blacksmith-32vcpu-ubuntu-2404",
        task: "lint",
      };
      const evaluateDispatch = (
        runnerBackend: "blacksmith" | "github" | "hybrid",
        overrides: {
          dispatchId?: string;
          frozenTarget?: boolean;
          matrix?: Record<string, unknown>;
          releaseGate?: boolean;
          repository?: string;
          targetContextRef?: string;
        } = {},
      ) =>
        evaluateWorkflowExpression(runsOn, {
          eventName: "workflow_dispatch",
          matrix: lintMatrix,
          repository: "openclaw/openclaw",
          runAttempt: 1,
          runnerBackend,
          ...overrides,
        });

      expect(evaluateDispatch("blacksmith")).toBe("blacksmith-32vcpu-ubuntu-2404");
      expect(evaluateDispatch("blacksmith", { releaseGate: true })).toBe("ubuntu-24.04");
      expect(evaluateDispatch("github")).toBe("ubuntu-24.04");
      expect(evaluateDispatch("hybrid")).toBe("ubuntu-24.04");

      const frozenFrv = {
        dispatchId: "full-release-validation-33128772779-ci",
        frozenTarget: true,
        targetContextRef,
      };
      expect(evaluateDispatch("hybrid", frozenFrv)).toBe("blacksmith-32vcpu-ubuntu-2404");
      expect(evaluateDispatch("github", frozenFrv)).toBe("ubuntu-24.04");
      expect(evaluateDispatch("hybrid", { ...frozenFrv, frozenTarget: false })).toBe(
        "ubuntu-24.04",
      );
      expect(evaluateDispatch("hybrid", { ...frozenFrv, dispatchId: "manual-ci-proof" })).toBe(
        "ubuntu-24.04",
      );
      expect(evaluateDispatch("hybrid", { ...frozenFrv, releaseGate: true })).toBe("ubuntu-24.04");
      expect(
        evaluateDispatch("hybrid", {
          ...frozenFrv,
          matrix: { runner: "blacksmith-16vcpu-ubuntu-2404", task: "test-types" },
        }),
      ).toBe("ubuntu-24.04");
      expect(evaluateDispatch("hybrid", { ...frozenFrv, repository: "fork/openclaw" })).toBe(
        "ubuntu-24.04",
      );
      expect(
        evaluateWorkflowExpression(runsOn, {
          authorAssociation: "NONE",
          eventName: "pull_request",
          headRepository: "openclaw/openclaw",
          matrix: lintMatrix,
          repository: "openclaw/openclaw",
          runAttempt: 1,
          runnerBackend: "blacksmith",
        }),
      ).toBe("ubuntu-24.04");
    },
  );

  it("encodes GitHub, Blacksmith, and hybrid runner-backend shapes", () => {
    const workflow = readCiWorkflow();
    const jobs = workflow.jobs as Record<string, { "runs-on": unknown }>;
    const expectedHostedRunners = {
      android: "ubuntu-24.04",
      "build-artifacts": "ubuntu-24.04",
      "check-additional-shard": "ubuntu-24.04",
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
      "control-ui-performance": "ubuntu-24.04",
      "docker-seed-e2e": "ubuntu-24.04",
      "macos-node": "macos-15",
      "native-i18n": "ubuntu-24.04",
      "pnpm-store-warmup": "ubuntu-24.04",
      preflight: "ubuntu-24.04",
      "security-fast": "ubuntu-24.04",
      "qa-smoke-ci-profile": "ubuntu-24.04",
      "skills-python": "ubuntu-24.04",
      "check-test-types-hosted-core-shard": "ubuntu-24.04",
      "checks-windows": "windows-2025",
    } as const;
    const expectedHybridFirstAttemptRunners = {
      ...expectedHostedRunners,
      "security-fast": "blacksmith-4vcpu-ubuntu-2404",
      android: "blacksmith-8vcpu-ubuntu-2404",
      "build-artifacts": "blacksmith-32vcpu-ubuntu-2404",
      "checks-node-core-test-nondist-shard": "blacksmith-32vcpu-ubuntu-2404",
      "checks-ui-e2e": "blacksmith-8vcpu-ubuntu-2404",
      // Same serial Chromium workload as checks-ui-e2e: hosted attempt 1 made it
      // the run's slowest job (205s mean vs a 150-190s plateau).
      "checks-ui-e2e-real-gateway": "blacksmith-16vcpu-ubuntu-2404",
      "docker-seed-e2e": "blacksmith-32vcpu-ubuntu-2404",
      "qa-smoke-ci-profile": "blacksmith-16vcpu-ubuntu-2404",
      "check-test-types-hosted-core-shard": "blacksmith-32vcpu-ubuntu-2404",
      "checks-ui": "blacksmith-8vcpu-ubuntu-2404",
      "checks-windows": "blacksmith-8vcpu-windows-2025",
    } as const;
    const expectedHybridForkRunners = {
      ...expectedHybridFirstAttemptRunners,
      "docker-seed-e2e": "ubuntu-24.04",
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
    // check-docs stays hosted in every mode: its ClawHub clone is unauthenticated by design.
    expect(jobs["check-docs"]?.["runs-on"]).toBe("ubuntu-24.04");
    for (const [jobName, hostedRunner] of Object.entries(expectedHostedRunners)) {
      const expression = jobs[jobName]?.["runs-on"];
      for (const [label, overrides, expectedRunner] of [
        ["github backend", { runnerBackend: "github" }, hostedRunner],
        [
          "hybrid first attempt",
          { runnerBackend: "hybrid" },
          expectedHybridFirstAttemptRunners[jobName as keyof typeof expectedHostedRunners],
        ],
        ["hybrid retry", { runnerBackend: "hybrid", runAttempt: 2 }, hostedRunner],
        [
          "explicit Blacksmith matches default",
          { runnerBackend: "blacksmith" },
          evaluateWorkflowExpression(expression, canonicalPullRequest),
        ],
        // New contributors stay hosted. GitHub can also report maintainers as
        // CONTRIBUTOR when organization membership is concealed.
        [
          "untrusted fork",
          {
            authorAssociation: "NONE",
            headRepository: "contributor/openclaw",
            runnerBackend: "hybrid",
          },
          hostedRunner,
        ],
        [
          "returning-contributor fork",
          {
            authorAssociation: "CONTRIBUTOR",
            headRepository: "contributor/openclaw",
            runnerBackend: "hybrid",
          },
          expectedHybridForkRunners[jobName as keyof typeof expectedHostedRunners],
        ],
      ] as const) {
        expect(
          evaluateWorkflowExpression(expression, { ...canonicalPullRequest, ...overrides }),
          `${jobName}: ${label}`,
        ).toBe(expectedRunner);
      }
      for (const runnerBackend of ["", "blacksmith", "hybrid"] as const) {
        expect(
          evaluateWorkflowExpression(expression, {
            ...canonicalPullRequest,
            authorAssociation: "CONTRIBUTOR",
            headRepository: "contributor/openclaw",
            runnerBackend,
            runAttempt: 2,
          }),
          `${jobName}: returning-contributor fork retry (${runnerBackend || "unset"})`,
        ).toBe(hostedRunner);
      }
    }

    const widenedHybridMatrixRows = [
      {
        jobName: "check-shard",
        matrix: { runner: "blacksmith-32vcpu-ubuntu-2404", task: "lint" },
        runner: "blacksmith-32vcpu-ubuntu-2404",
      },
      {
        jobName: "check-shard",
        matrix: { runner: "blacksmith-32vcpu-ubuntu-2404", task: "test-types" },
        runner: "blacksmith-32vcpu-ubuntu-2404",
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
          runner: "blacksmith-32vcpu-ubuntu-2404",
        },
        runner: "blacksmith-32vcpu-ubuntu-2404",
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
      for (const [label, overrides, expectedRunner] of [
        ["hybrid attempt 1", { runnerBackend: "hybrid" }, runner],
        ["hybrid retry", { runnerBackend: "hybrid", runAttempt: 2 }, "ubuntu-24.04"],
        ["github backend", { runnerBackend: "github" }, "ubuntu-24.04"],
        [
          "untrusted fork pull request",
          {
            authorAssociation: "NONE",
            headRepository: "contributor/openclaw",
            runnerBackend: "hybrid",
          },
          "ubuntu-24.04",
        ],
        [
          "workflow dispatch",
          { eventName: "workflow_dispatch", runnerBackend: "hybrid" },
          "ubuntu-24.04",
        ],
      ] as const) {
        expect(
          evaluateWorkflowExpression(expression, { ...canonicalPullRequest, matrix, ...overrides }),
          `${jobName}: ${label}`,
        ).toBe(expectedRunner);
      }
    }
  });

  it("gives breaker-routed hosted jobs their hosted timeout budgets", () => {
    const workflow = readCiWorkflow();
    const jobs = workflow.jobs as Record<string, { "timeout-minutes": unknown }>;
    const expectedHostedTimeouts = {
      android: 35,
      "build-artifacts": 35,
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
      matrix: { task: "build-play" },
      repository: "openclaw/openclaw",
      runAttempt: 1,
    } as const;
    const evaluateTimeout = (
      jobName: string,
      context: Parameters<typeof evaluateWorkflowExpression>[1],
    ) => {
      const value = jobs[jobName]?.["timeout-minutes"];
      return typeof value === "number" ? value : evaluateWorkflowExpression(value, context);
    };

    for (const [jobName, hostedTimeout] of Object.entries(expectedHostedTimeouts)) {
      for (const [overrides, expectedTimeout] of [
        [{ runnerBackend: "github" }, hostedTimeout],
        [{ runnerBackend: "blacksmith" }, 20],
        [{ runnerBackend: "hybrid" }, 20],
        [{ runnerBackend: "hybrid", runAttempt: 2 }, hostedTimeout],
      ] as const) {
        expect(evaluateTimeout(jobName, { ...canonicalPullRequest, ...overrides }), jobName).toBe(
          expectedTimeout,
        );
      }
      expect(jobs[jobName]?.["timeout-minutes"], jobName).toContain(
        "vars.OPENCLAW_CI_RUNNER_BACKEND == 'github'",
      );
    }
    expect(routeDependentTimeoutJobs).toEqual(Object.keys(expectedHostedTimeouts).toSorted());

    const androidRoutes = [
      ["GitHub override", { runnerBackend: "github" }, "ubuntu-24.04"],
      ["hybrid retry", { runnerBackend: "hybrid", runAttempt: 2 }, "ubuntu-24.04"],
      ["manual dispatch", { eventName: "workflow_dispatch" }, "ubuntu-24.04"],
      ["non-canonical repository", { repository: "contributor/openclaw" }, "ubuntu-24.04"],
      ["untrusted author", { authorAssociation: "NONE" }, "ubuntu-24.04"],
      [
        "untrusted fork",
        { authorAssociation: "FIRST_TIME_CONTRIBUTOR", headRepository: "contributor/openclaw" },
        "ubuntu-24.04",
      ],
      [
        "trusted fork first attempt",
        { headRepository: "contributor/openclaw" },
        "blacksmith-8vcpu-ubuntu-2404",
      ],
      [
        "trusted fork retry",
        { headRepository: "contributor/openclaw", runAttempt: 2 },
        "ubuntu-24.04",
      ],
      ["same-repository Blacksmith retry", { runAttempt: 2 }, "blacksmith-8vcpu-ubuntu-2404"],
    ] as const;
    for (const [label, overrides, runner] of androidRoutes) {
      const context = { ...canonicalPullRequest, ...overrides };
      expect(evaluateWorkflowExpression(workflow.jobs.android["runs-on"], context), label).toBe(
        runner,
      );
      for (const task of [
        "build-play",
        "build-play-compat",
        "build-wear",
        "ktlint",
        "test-play",
        "test-play-compat",
        "test-third-party",
        "test-wear",
      ]) {
        expect(
          evaluateTimeout("android", { ...context, matrix: { task } }),
          `${label}: ${task}`,
        ).toBe(task === "build-play" && runner === "ubuntu-24.04" ? 35 : 20);
      }
    }
  });

  it("fetches the complete pull request scan range before checkout removes credentials", () => {
    const securitySteps = readCiWorkflow().jobs["security-fast"].steps as WorkflowStep[];
    const checkoutIndex = securitySteps.findIndex((step) => step.name === "Checkout");
    const checkout = expectDefined(securitySteps[checkoutIndex], "security checkout");
    const prepare = securitySteps
      .slice(0, checkoutIndex)
      .find((step) => step.env?.PR_COMMIT_COUNT !== undefined);
    const root = tempDirs.make("openclaw-security-checkout-");
    let depth = checkout.with?.["fetch-depth"];
    if (prepare?.run) {
      const output = path.join(root, "depth-output");
      const result = spawnSync("bash", ["-e", "-c", prepare.run], {
        encoding: "utf8",
        timeout: 5_000,
        env: { ...process.env, PR_COMMIT_COUNT: "3", GITHUB_OUTPUT: output },
      });
      expect(result.status, result.stderr).toBe(0);
      const outputs = Object.fromEntries(
        readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
      depth = evaluateWorkflowExpression(depth, {
        eventName: "pull_request",
        repository: "openclaw/openclaw",
        runAttempt: 1,
        steps: { [expectDefined(prepare.id, "depth output step")]: { outputs } },
      });
    }
    expect(Number.isInteger(Number(depth)) && Number(depth) > 0).toBe(true);
    expect(checkout.with?.["persist-credentials"]).toBe(false);

    const source = path.join(root, "source");
    const selected = path.join(root, "selected");
    mkdirSync(source);
    mkdirSync(selected);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        "git",
        [
          "-C",
          cwd,
          "-c",
          "user.name=CI Fixture",
          "-c",
          "user.email=ci@example.invalid",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        {
          encoding: "utf8",
          timeout: 5_000,
          env: {
            ...process.env,
            GIT_ALLOW_PROTOCOL: "file",
            GIT_CONFIG_GLOBAL: devNull,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
          },
        },
      ).trim();
    git(source, "init", "--initial-branch=main");
    writeFileSync(path.join(source, "base.txt"), "base\n");
    git(source, "add", ".");
    git(source, "commit", "-m", "base");
    git(source, "checkout", "-b", "pull-request");
    const commits = [];
    for (let index = 0; index < 3; index++) {
      writeFileSync(path.join(source, "change.txt"), `change ${index}\n`);
      git(source, "add", ".");
      git(source, "commit", "-m", `change ${index}`);
      commits.push(git(source, "rev-parse", "HEAD"));
    }
    git(source, "checkout", "main");
    writeFileSync(path.join(source, "base.txt"), "advanced base\n");
    git(source, "commit", "-am", "advance main");
    const base = git(source, "rev-parse", "HEAD");
    git(source, "merge", "--no-ff", "pull-request", "-m", "synthetic merge");
    const merge = git(source, "rev-parse", "HEAD");
    git(selected, "init");
    git(
      selected,
      "fetch",
      "--no-tags",
      `--depth=${String(depth)}`,
      pathToFileURL(source).href,
      merge,
    );
    git(selected, "checkout", "--detach", "FETCH_HEAD");

    // The scanner clones locally after auth cleanup: no later fetch may supply missing commits.
    expect(git(selected, "rev-list", `${base}..HEAD`).split("\n").toSorted()).toEqual(
      [merge, ...commits].toSorted(),
    );
  });

  it("scans only the pull request commit range for leaked credentials", () => {
    const securitySteps = readCiWorkflow().jobs["security-fast"].steps as WorkflowStep[];
    const checkoutIndex = securitySteps.findIndex((step) => step.name === "Checkout");
    const depthIndex = securitySteps.findIndex((step) => step.id === "checkout_depth");
    const scanIndex = securitySteps.findIndex(
      (step) => step.name === "Scan pull request for leaked credentials",
    );
    const depthStep = expectDefined(securitySteps[depthIndex], "security checkout depth");
    const scanStep = expectDefined(securitySteps[scanIndex], "TruffleHog pull request scan step");

    expect(checkoutIndex).toBeGreaterThan(depthIndex);
    expect(scanIndex).toBeGreaterThan(checkoutIndex);
    expect(depthStep.if).toBe("github.event_name == 'pull_request'");
    expect(depthStep.env).toEqual({
      PR_COMMIT_COUNT: "${{ github.event.pull_request.commits }}",
    });
    expect(securitySteps.some((step) => step.name === "Fetch pull request scan history")).toBe(
      false,
    );
    expect(scanStep.if).toBe("github.event_name == 'pull_request'");
    expect(scanStep.uses).toBe(TRUFFLEHOG_V3_95_9);
    expect(scanStep.with).toEqual({
      base: "${{ steps.diff_base.outputs.sha }}",
      head: "${{ github.sha }}",
      version: "3.97.0@sha256:ff4c95e9df7d645daf2140e3ca1039031c63106268d5fbb25feb43ceca1bcc33",
      extra_args: "--results=verified,unknown --fail-on-scan-errors",
    });
  });

  it.each(["", "-1", "1.5"])("rejects invalid security checkout depth input %j", (count) => {
    const step = expectDefined(
      readCiWorkflow().jobs["security-fast"].steps.find(
        (entry: WorkflowStep) => entry.id === "checkout_depth",
      ),
      "security checkout depth",
    );
    const output = path.join(tempDirs.make("openclaw-security-depth-"), "output");
    const result = spawnSync("bash", ["-e", "-c", step.run], {
      encoding: "utf8",
      timeout: 5_000,
      env: { ...process.env, PR_COMMIT_COUNT: count, GITHUB_OUTPUT: output },
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("Invalid pull request commit count");
    expect(existsSync(output)).toBe(false);
  });

  it("keeps setup cache access explicit and isolates every cache write", () => {
    const setupActionPaths = [
      ".github/actions/setup-node-env/action.yml",
      ".github/actions/setup-pnpm-store-cache/action.yml",
    ];
    const legacyInputs = [
      "save-actions-cache",
      "save-dependency-cache",
      "save-node-compile-cache",
      "save-vitest-fs-cache",
      "use-actions-cache",
    ];
    for (const actionPath of setupActionPaths) {
      const action = parse(readFileSync(actionPath, "utf8"));
      const steps = action.runs.steps as WorkflowStep[];
      expect(action.inputs["cache-mode"].default, actionPath).toBe("off");
      for (const legacyInput of legacyInputs) {
        expect(action.inputs, `${actionPath}: ${legacyInput}`).not.toHaveProperty(legacyInput);
      }
      expect(
        steps.filter(
          (step) =>
            step.uses?.startsWith("actions/cache@") || step.uses?.startsWith("actions/cache/save@"),
        ),
        actionPath,
      ).toEqual([]);
      expect(
        steps.filter((step) => step.uses?.startsWith("actions/cache/restore@")).length,
        actionPath,
      ).toBeGreaterThan(0);
      const validation = expectDefined(
        steps.find((step) => step.run?.includes("off|restore|read-write")),
        `${actionPath} cache-mode validation`,
      );
      expect(validation.run).toContain("Invalid cache-mode input");
    }

    const callers: Array<{ file: string; mode: unknown; step: WorkflowStep }> = [];
    const directCaches: Array<{ file: string; step: WorkflowStep }> = [];
    const rubySetups: Array<{ file: string; step: WorkflowStep }> = [];
    for (const file of [
      ...findYamlFiles(".github/workflows"),
      ...findYamlFiles(".github/actions"),
    ]) {
      const parsed = parse(readFileSync(file, "utf8"));
      const stepLists = [
        ...Object.values(parsed?.jobs ?? {}).map(
          (job) => (job as { steps?: WorkflowStep[] }).steps ?? [],
        ),
        (parsed?.runs?.steps ?? []) as WorkflowStep[],
      ];
      for (const step of stepLists.flat()) {
        if (step.uses?.startsWith("actions/cache")) {
          directCaches.push({ file, step });
        }
        if (step.uses?.startsWith("ruby/setup-ruby@")) {
          rubySetups.push({ file, step });
        }
        if (
          step.uses === "./.github/actions/setup-node-env" ||
          step.uses?.endsWith("/.github/actions/setup-node-env") ||
          step.uses === "./.github/actions/setup-pnpm-store-cache" ||
          step.uses?.endsWith("/.github/actions/setup-pnpm-store-cache")
        ) {
          callers.push({ file, mode: step.with?.["cache-mode"], step });
        }
      }
    }
    expect(rubySetups.length).toBeGreaterThan(0);
    for (const { file, step } of rubySetups) {
      const bundlerCache = step.with?.["bundler-cache"] ?? false;
      expect([false, true, "false", "true"], `${file}: ${step.name}`).toContain(bundlerCache);
      if (bundlerCache === true || bundlerCache === "true") {
        expect(String(step.if), `${file}: ${step.name}`).toContain("cache_write_allowed == 'true'");
      }
    }
    expect(callers.length).toBeGreaterThan(0);
    for (const caller of callers) {
      const staticMode = ["off", "restore", "read-write"].includes(String(caller.mode));
      const conditionalMode =
        typeof caller.mode === "string" &&
        caller.mode.startsWith("${{") &&
        (caller.mode.includes("needs.preflight.outputs.cache_mode") ||
          caller.mode.includes("steps.candidate_trust.outputs.cache_mode") ||
          (caller.mode.includes("'restore'") &&
            (caller.mode.includes("'off'") || caller.mode.includes("'read-write'"))));
      expect(staticMode || conditionalMode, `${caller.file}: ${caller.step.name}`).toBe(true);
      for (const legacyInput of legacyInputs) {
        expect(caller.step.with, `${caller.file}: ${legacyInput}`).not.toHaveProperty(legacyInput);
      }
    }
    const writeAuthorizedCallers = callers.filter(
      (caller) =>
        caller.mode === "read-write" ||
        (typeof caller.mode === "string" && caller.mode.includes("'read-write'")),
    );
    expect(writeAuthorizedCallers).toHaveLength(3);
    expect(writeAuthorizedCallers).toEqual(
      expect.arrayContaining([
        {
          file: ".github/workflows/ci-build-artifacts-testbox.yml",
          mode: expect.stringContaining("'read-write'"),
          step: expect.objectContaining({ name: "Setup Node environment" }),
        },
        {
          file: ".github/workflows/openclaw-npm-preflight.yml",
          mode: "read-write",
          step: expect.objectContaining({ name: "Setup Node environment" }),
        },
        {
          file: ".github/workflows/vitest-cache-warm.yml",
          mode: "read-write",
          step: expect.objectContaining({ name: "Setup Node environment" }),
        },
      ]),
    );

    const nodeCachePathPattern =
      /(?:^|\n)\s*(?:\.artifacts\/build-all-cache|dist\/|dist-runtime\/|packages\/\*\/dist\/|extensions\/\*\/dist\/|~\/\.cache\/ms-playwright|~\/\.local\/share\/pnpm|~\/\.cache\/pnpm|node_modules)(?:\n|$)/u;
    for (const { file, step } of directCaches) {
      if (step.uses?.startsWith("actions/cache/save@")) {
        if (step.with?.path === ".cache/openclaw-cross-os-npm-cache/_cacache") {
          expect([
            ".github/workflows/openclaw-cross-os-release-checks-reusable.yml",
            ".github/workflows/release-npm-cache-warm.yml",
          ]).toContain(file);
          const workflow = parse(readFileSync(file, "utf8"));
          const owner = Object.values(workflow.jobs).find((candidate) =>
            (candidate as { steps?: WorkflowStep[] }).steps?.some(
              (entry) => entry.name === step.name,
            ),
          ) as { if?: string } | undefined;
          const authority = `${owner?.if ?? ""} ${step.if ?? ""}`;
          expect(authority).toContain("github.repository == 'openclaw/openclaw'");
          expect(authority).toContain("github.event_name == 'workflow_dispatch'");
          continue;
        }
        const condition = String(step.if);
        expect(
          condition.includes(".outputs.cache-mode == 'read-write'") ||
            condition.includes("inputs.cache-mode == 'read-write'") ||
            condition.includes("needs.preflight.outputs.cache_write_allowed == 'true'"),
          `${file}: ${step.name}`,
        ).toBe(true);
      }
      if (step.uses?.startsWith("actions/cache@")) {
        expect(nodeCachePathPattern.test(String(step.with?.path)), `${file}: ${step.name}`).toBe(
          false,
        );
      }
    }
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
    const installScript = readFileSync(
      ".github/actions/setup-node-env/install-dependencies.sh",
      "utf8",
    );
    const cachePaths =
      "node_modules\nui/node_modules\npackages/*/node_modules\nextensions/*/node_modules\nexamples/*/node_modules\n.cache/openclaw-pnpm-store\n";

    expect(action.inputs["cache-mode"].default).toBe("off");
    expect(action.inputs["dependency-cache"].default).toBe("false");
    expect(action.inputs).not.toHaveProperty("save-dependency-cache");
    expect(action.inputs).not.toHaveProperty("save-actions-cache");
    expect(action.inputs).not.toHaveProperty("use-actions-cache");
    expect(action.inputs).not.toHaveProperty("sticky-disk");
    expect(action.inputs).not.toHaveProperty("save-sticky-disk");
    expect(actionSource).not.toContain("useblacksmith/stickydisk");

    expect(configureStore.if).toBe(
      "inputs.cache-mode != 'off' && inputs.dependency-cache == 'true'",
    );
    expect(configureStore.run).toContain(
      'echo "PNPM_CONFIG_STORE_DIR=$GITHUB_WORKSPACE/.cache/openclaw-pnpm-store"',
    );
    expect(resolve.if).toBe("inputs.cache-mode != 'off' && inputs.dependency-cache == 'true'");
    expect(resolve.run).toContain('node "$GITHUB_ACTION_PATH/dependency-fingerprint.mjs"');
    expect(resolve.run).toContain("${GITHUB_REPOSITORY:?}-node-deps-v3");
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
      if: "inputs.cache-mode != 'off' && inputs.dependency-cache == 'true'",
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
    expect(setupPnpm.with?.["cache-mode"]).toContain(
      "steps.dependency-cache.outputs.cache-hit != 'true'",
    );
    expect(setupPnpm.with?.["cache-mode"]).toContain("inputs.cache-mode != 'off'");
    expect(setupPnpm.with?.["cache-mode"]).toContain("'restore' || 'off'");
    expect(actionSteps.indexOf(restore)).toBeLessThan(actionSteps.indexOf(setupPnpm));

    expect(install.run).toBe('bash "$GITHUB_ACTION_PATH/install-dependencies.sh"');
    expect(installScript).toContain("export PNPM_CONFIG_PACKAGE_IMPORT_METHOD=hardlink");
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
    expect(
      actionSteps.some(
        (candidate) =>
          candidate.uses?.startsWith("actions/cache@") ||
          candidate.uses?.startsWith("actions/cache/save@"),
      ),
    ).toBe(false);

    const dependencySetups = Object.entries(workflow.jobs).flatMap(([jobName, job]) =>
      ((job as { steps?: WorkflowStep[] }).steps ?? []).flatMap((candidate) =>
        candidate.uses?.endsWith("/.github/actions/setup-node-env") &&
        candidate.with?.["dependency-cache"] !== undefined
          ? [{ jobName, step: candidate }]
          : [],
      ),
    );
    const preflightRestore = dependencySetups.find(({ jobName }) => jobName === "preflight");
    expect(preflightRestore?.step).toMatchObject({
      if: expect.stringContaining("steps.manifest.outputs.run_node == 'true'"),
      with: {
        "cache-mode": "${{ steps.candidate_trust.outputs.cache_mode }}",
        "dependency-cache": "true",
        "install-bun": "false",
      },
    });
    expect(preflightRestore?.step.if).toContain("github.ref == 'refs/heads/main'");
    expect(preflightRestore?.step.if).toContain("github.event_name == 'pull_request'");
    expect(preflightRestore?.step.if).toContain("vars.OPENCLAW_CI_RUNNER_BACKEND != 'github'");
    expect(preflightRestore?.step.if).toContain("vars.OPENCLAW_CI_RUNNER_BACKEND != 'hybrid'");
    expect(workflow.jobs["pnpm-store-warmup"].if).toContain(
      "needs.preflight.outputs.runner_profile == 'github'",
    );
    expect(workflow.jobs["pnpm-store-warmup"].if).toContain(
      "needs.preflight.outputs.runner_profile == 'hybrid'",
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
      "control-ui-performance",
      "docker-seed-e2e",
      "native-i18n",
      "qa-smoke-ci-profile",
    ]);
    for (const { jobName, step: consumer } of consumers) {
      const needs = workflow.jobs[jobName].needs;
      expect(Array.isArray(needs) ? needs : [needs], jobName).toContain("preflight");
      expect(consumer.with, jobName).not.toHaveProperty("save-dependency-cache");
      expect(consumer.with?.["dependency-cache"], jobName).toContain("'true' || 'false'");
      expect(consumer.with?.["cache-mode"], jobName).toBe(
        "${{ needs.preflight.outputs.cache_mode }}",
      );
      const canonical = {
        eventName: "push",
        matrix: {
          group: "extension-package-boundary",
          node_version: "24.x",
          runner: "blacksmith-32vcpu-ubuntu-2404",
          task: "lint",
        },
        repository: "openclaw/openclaw",
        runAttempt: 1,
      } as const;
      const scenarios = [
        { eventName: "push", trusted: true },
        { eventName: "pull_request", headRepository: "openclaw/openclaw", trusted: true },
        { eventName: "pull_request", headRepository: "contributor/openclaw", trusted: false },
        {
          eventName: "pull_request",
          headRepository: "contributor/openclaw",
          authorAssociation: "NONE",
          trusted: false,
        },
        { eventName: "workflow_dispatch", trusted: false },
        { eventName: "push", repository: "contributor/openclaw", trusted: false },
      ] as const;
      for (const runnerBackend of ["", "blacksmith", "github", "hybrid"] as const) {
        for (const runAttempt of [1, 2]) {
          for (const { trusted, ...scenario } of scenarios) {
            const context = { ...canonical, ...scenario, runnerBackend, runAttempt };
            const runsOn = workflow.jobs[jobName]["runs-on"] as string;
            const routedRunner = runsOn.startsWith("${{")
              ? evaluateWorkflowExpression(runsOn, context)
              : runsOn;
            const selfHosted = String(routedRunner).startsWith("blacksmith-");
            expect(
              evaluateWorkflowExpression(consumer.with?.["dependency-cache"], {
                ...context,
                runnerEnvironment: selfHosted ? "self-hosted" : "github-hosted",
              }),
              `${jobName} ${JSON.stringify(context)} on ${routedRunner}`,
            ).toBe(trusted && selfHosted ? "true" : "false");
          }
        }
      }
      // The actual runner must fence restores even when the configured backend
      // still names Blacksmith or hybrid (including hosted retry routing).
      for (const runnerEnvironment of ["", "github-hosted"] as const) {
        expect(
          evaluateWorkflowExpression(consumer.with?.["dependency-cache"], {
            ...canonical,
            runnerBackend: "hybrid",
            runnerEnvironment,
          }),
          `${jobName} actual runner ${runnerEnvironment}`,
        ).toBe("false");
      }
      if (jobName === "checks-node-core-test-nondist-shard") {
        expect(
          evaluateWorkflowExpression(consumer.with?.["dependency-cache"], {
            ...canonical,
            matrix: { ...canonical.matrix, node_version: "22.x" },
            runnerBackend: "hybrid",
            runnerEnvironment: "self-hosted",
          }),
        ).toBe("false");
      }
    }
    for (const { jobName: setupJobName, step: setup } of Object.entries(workflow.jobs).flatMap(
      ([jobName, job]) =>
        ((job as { steps?: WorkflowStep[] }).steps ?? [])
          .filter((candidate) => candidate.uses?.endsWith("/.github/actions/setup-node-env"))
          .map((candidate) => ({ jobName, step: candidate })),
    )) {
      expect(setup.with, setupJobName).not.toHaveProperty("sticky-disk");
      expect(setup.with, setupJobName).not.toHaveProperty("save-sticky-disk");
      expect(
        [
          "off",
          "restore",
          "read-write",
          "${{ needs.preflight.outputs.cache_mode }}",
          "${{ steps.candidate_trust.outputs.cache_mode }}",
        ],
        setupJobName,
      ).toContain(setup.with?.["cache-mode"]);
    }

    const warmer = parse(readFileSync(".github/workflows/vitest-cache-warm.yml", "utf8"));
    const dependencySave = warmer.jobs.warm.steps.find(
      (candidate: WorkflowStep) => candidate.name === "Save exact dependency cache",
    );
    expect(dependencySave).toMatchObject({
      uses: "actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
      with: {
        key: "${{ steps.setup-node-env.outputs.dependency-cache-key }}",
        path: cachePaths,
      },
    });
    expect(dependencySave.if).toContain("steps.setup-node-env.outputs.cache-mode == 'read-write'");
  });

  it.skipIf(process.platform === "win32").each([
    {
      name: "uncached frozen",
      cache: false,
      frozen: "true",
      exits: [0],
      modes: ["--prefer-offline"],
      status: 0,
    },
    {
      name: "uncached mutable",
      cache: false,
      frozen: "false",
      exits: [0],
      modes: ["--prefer-offline"],
      status: 0,
    },
    {
      name: "invalid frozen policy",
      cache: false,
      frozen: "invalid",
      exits: [],
      modes: [],
      status: 2,
    },
    {
      name: "uncached failure",
      cache: false,
      frozen: "true",
      exits: [23],
      modes: ["--prefer-offline"],
      status: 23,
    },
    {
      name: "cached success",
      cache: true,
      frozen: "true",
      exits: [0],
      modes: ["--offline"],
      status: 0,
    },
    {
      name: "cached relink",
      cache: true,
      frozen: "true",
      exits: [23, 0],
      modes: ["--offline", "--offline"],
      status: 0,
    },
    {
      name: "cached store rebuild",
      cache: true,
      frozen: "true",
      exits: [23, 23, 0],
      modes: ["--offline", "--offline", "--prefer-offline"],
      status: 0,
    },
    {
      name: "cached terminal failure",
      cache: true,
      frozen: "true",
      exits: [23, 23, 23],
      modes: ["--offline", "--offline", "--prefer-offline"],
      status: 23,
    },
  ])("executes the dependency install recipe: $name", ({ cache, frozen, exits, modes, status }) => {
    const root = tempDirs.make("openclaw-install-recipe-");
    const workspace = path.join(root, "workspace");
    const bin = path.join(root, "bin");
    const store = path.join(root, "store");
    const log = path.join(root, "calls.jsonl");
    const githubEnv = path.join(root, "github.env");
    const payload = path.join(root, "payload");
    for (const directory of [
      bin,
      store,
      ...["", "ui", "packages", "extensions", "examples"].map((entry) =>
        path.join(workspace, entry),
      ),
    ]) {
      mkdirSync(directory, { recursive: true });
    }
    mkdirSync(path.join(workspace, "node_modules"));
    writeFileSync(path.join(workspace, "node_modules", "before"), "");
    writeFileSync(path.join(store, "before"), "");
    symlinkSync(process.execPath, path.join(bin, "node"));
    const pnpm = path.join(bin, "pnpm");
    writeFileSync(
      pnpm,
      "#!" +
        process.execPath +
        "\n" +
        String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "-v") { console.log("fixture"); process.exit(0); }
const log = process.env.RECIPE_LOG;
const count = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").length : 0;
fs.appendFileSync(log, JSON.stringify({ args, cwd: process.cwd(), importMethod: process.env.PNPM_CONFIG_PACKAGE_IMPORT_METHOD }) + "\n");
process.exit(JSON.parse(process.env.RECIPE_EXITS)[count] ?? 99);
`,
    );
    chmodSync(pnpm, 0o755);
    const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
    const step: WorkflowStep = expectDefined(
      action.runs.steps.find(
        (candidate: WorkflowStep) => candidate.name === "Install dependencies",
      ),
      "Install dependencies",
    );
    const run = expectDefined(step.run, "Install dependencies script");
    const config = {
      PNPM_CONFIG_CACHE_DIR: path.join(root, "metadata"),
      PNPM_CONFIG_CHILD_CONCURRENCY: "3",
      PNPM_CONFIG_NETWORK_CONCURRENCY: "4",
      PNPM_CONFIG_PACKAGE_IMPORT_METHOD: "copy",
      PNPM_CONFIG_STORE_DIR: store,
      PNPM_CONFIG_VIRTUAL_STORE_DIR: path.join(root, "virtual"),
    };
    const result = spawnSync(
      "bash",
      ["-c", run.trimEnd() + ' && printf reached > "$RECIPE_PAYLOAD"'],
      {
        cwd: workspace,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          NODE_BIN: bin,
          GITHUB_ACTION_PATH: path.resolve(".github/actions/setup-node-env"),
          GITHUB_WORKSPACE: workspace,
          GITHUB_ENV: githubEnv,
          CI: "true",
          DEPENDENCY_CACHE: String(cache),
          DEPENDENCY_CACHE_HIT: String(cache),
          FROZEN_LOCKFILE: frozen,
          RECIPE_LOG: log,
          RECIPE_PAYLOAD: payload,
          RECIPE_EXITS: JSON.stringify(exits),
          ...config,
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(status);
    expect(existsSync(payload)).toBe(status === 0);
    const calls: Array<{ args: string[]; cwd: string; importMethod: string }> = existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
    const expectedArgs = [
      "install",
      "--config.ignore-scripts=false",
      "--config.engine-strict=false",
      "--config.enable-pre-post-scripts=true",
      "--config.side-effects-cache=true",
      ...(frozen === "true" ? ["--frozen-lockfile"] : []),
      "--config.cache-dir=" + config.PNPM_CONFIG_CACHE_DIR,
      "--config.child-concurrency=3",
      "--config.network-concurrency=4",
      "--config.package-import-method=" + (cache ? "hardlink" : "copy"),
      "--config.store-dir=" + store,
      "--config.virtual-store-dir=" + config.PNPM_CONFIG_VIRTUAL_STORE_DIR,
    ];
    expect(calls).toEqual(
      modes.map((mode) => ({
        args: [...expectedArgs, mode],
        cwd: workspace,
        importMethod: cache ? "hardlink" : "copy",
      })),
    );
    expect(existsSync(path.join(workspace, "node_modules", "before"))).toBe(modes.length < 2);
    expect(existsSync(path.join(store, "before"))).toBe(modes.length < 3);
    expect(existsSync(githubEnv)).toBe(cache && status === 0);
    if (cache && status === 0) {
      expect(readFileSync(githubEnv, "utf8")).toBe(
        "OPENCLAW_BUILD_ALL_NO_PNPM=1\npnpm_config_verify_deps_before_run=false\n",
      );
    }
  });

  it.skipIf(process.platform === "win32")(
    "preserves pnpm hard links and validates cached importers and supply-chain policy offline",
    async ({ onTestFinished, signal }) => {
      const fixtureDirs = createTempDirTracker();
      // oxlint-disable-next-line prefer-const -- Failure cleanup can run before the registry is started.
      let stopRegistry: (() => Promise<void>) | undefined;
      let readyTimeout: NodeJS.Timeout | undefined;
      // Timeout does not join the test body. Keep close and deletion in one hook,
      // outside afterEach, so a failed join cannot release the registry's files.
      onTestFinished(async () => {
        clearTimeout(readyTimeout);
        await stopRegistry?.();
        fixtureDirs.cleanup();
      });
      const root = fixtureDirs.make("openclaw-dependency-cache-");
      const source = path.join(root, "source");
      const registry = path.join(root, "registry");
      const workspace = path.join(root, "workspace");
      const consumer = path.join(workspace, "packages", "consumer");
      const store = path.join(workspace, ".cache", "openclaw-pnpm-store");
      let userHome = path.join(root, "producer-home");
      mkdirSync(userHome, { recursive: true });
      mkdirSync(source, { recursive: true });
      mkdirSync(registry, { recursive: true });
      mkdirSync(consumer, { recursive: true });
      writeFileSync(
        path.join(source, "package.json"),
        JSON.stringify({
          files: ["index.js"],
          name: "cache-proof-dep",
          packageManager: rootPackageManager,
          scripts: { "pnpm-path": "node -p process.env.npm_execpath" },
          version: "1.0.0",
        }),
      );
      writeFileSync(path.join(source, "index.js"), 'module.exports = "cache-proof-v1";\n');
      // Both projects own the pinned environment before any command runs; otherwise
      // pnpm resolves its own metadata from the public registry during bootstrap.
      const { environment } = pnpmLockfileDocuments(readFileSync("pnpm-lock.yaml", "utf8"));
      if (environment !== null) {
        for (const directory of [source, workspace]) {
          writeFileSync(path.join(directory, "pnpm-lock.yaml"), `---\n${environment}\n---\n`);
        }
      }
      // Capture the pinned CLI before switching to the fixture-only registry/store.
      const bootstrap = resolvePnpmRunner();
      const npmExecPath = execFileSync(
        bootstrap.command,
        [...bootstrap.args, "--silent", "run", "pnpm-path"],
        { cwd: source, encoding: "utf8", env: { ...process.env, CI: "true" } },
      ).trim();
      const pnpm = resolvePnpmRunner({ npmExecPath });
      const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
      const configureCache = expectDefined(
        action.runs.steps.find(
          (step: WorkflowStep) => step.name === "Configure dependency cache store",
        )?.run,
        "Configure dependency cache store script",
      );
      const envFile = path.join(root, "dependency-cache.env");
      execFileSync("bash", ["-c", configureCache], {
        env: { ...process.env, GITHUB_WORKSPACE: workspace, GITHUB_ENV: envFile },
      });
      const dependencyEnvironment = Object.fromEntries(
        readFileSync(envFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
      const runPnpm = (args: string[], cwd: string) =>
        spawnSync(pnpm.command, [...pnpm.args, ...args], {
          cwd,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            HOME: userHome,
            XDG_CACHE_HOME: path.join(userHome, ".cache"),
            CI: "true",
            PNPM_CONFIG_PACKAGE_IMPORT_METHOD: "hardlink",
            ...dependencyEnvironment,
          },
        });
      const version = runPnpm(["--version"], source);
      expect(version.status, version.stderr).toBe(0);
      expect(`pnpm@${version.stdout.trim()}`).toBe(rootPackageManager.split("+")[0]);
      const packed = runPnpm(["pack", "--pack-destination", registry], source);
      expect(packed.status, `${packed.stdout}${packed.stderr}`).toBe(0);
      const tarball = path.join(registry, "cache-proof-dep-1.0.0.tgz");
      const registryScript = String.raw`
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { createServer } = require("node:http");
const tarballPath = process.argv[1];
const tarball = readFileSync(tarballPath);
const server = createServer((request, response) => {
  if (request.url === "/cache-proof-dep") {
    const port = server.address().port;
    const metadata = {
      name: "cache-proof-dep",
      "dist-tags": { latest: "1.0.0" },
      time: {
        "1.0.0": new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
        modified: new Date().toISOString(),
      },
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
    const abbreviated = request.headers.accept?.includes("application/vnd.npm.install-v1+json");
    if (abbreviated) {
      delete metadata.time;
    }
    response.setHeader("content-type", abbreviated ? "application/vnd.npm.install-v1+json" : "application/json");
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
server.listen(0, "127.0.0.1", () => {
  process.send(server.address().port);
});
`;
      const registryServer = spawn(process.execPath, ["-e", registryScript, tarball], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let registryDidClose = false;
      // Retain actual close from launch, including failed spawn; readiness must not own this join.
      const registryClosed = new Promise<void>((resolve) => {
        registryServer.once("close", () => {
          registryDidClose = true;
          resolve();
        });
      });
      const failures: unknown[] = [];
      registryServer.on("error", (error) => failures.push(error));
      stopRegistry = async () => {
        if (!registryDidClose) {
          registryServer.kill("SIGTERM");
        }
        await registryClosed;
      };
      try {
        const port = await new Promise<number>((resolve, reject) => {
          readyTimeout = setTimeout(() => reject(new Error("fixture registry not ready")), 2_000);
          registryServer.once("message", (message) => {
            if (typeof message !== "number") {
              reject(new Error("fixture registry sent an invalid port"));
              return;
            }
            resolve(message);
          });
          registryServer.once("error", reject);
          void registryClosed.then(() => reject(new Error("fixture registry closed before ready")));
        });
        clearTimeout(readyTimeout);
        signal.throwIfAborted();
        const registryUrl = `http://127.0.0.1:${port}`;
        writeFileSync(
          path.join(workspace, "package.json"),
          JSON.stringify({
            dependencies: { "cache-proof-dep": "1.0.0" },
            name: "cache-proof-root",
            packageManager: rootPackageManager,
            private: true,
          }),
        );
        const workspaceConfig =
          "packages:\n  - packages/*\nminimumReleaseAge: 10080\nminimumReleaseAgeStrict: true\n";
        writeFileSync(path.join(workspace, "pnpm-workspace.yaml"), workspaceConfig);
        const writeConsumerManifest = (dependencyVersion: string) =>
          writeFileSync(
            path.join(consumer, "package.json"),
            JSON.stringify({
              dependencies: { "cache-proof-dep": dependencyVersion },
              name: "cache-proof-consumer",
              private: true,
            }),
          );
        writeConsumerManifest("1.0.0");
        // The fixture registry serves only its test package, not the preserved project pnpm pin.
        const installArgs = [
          "install",
          "--ignore-scripts",
          "--config.engine-strict=false",
          "--pm-on-fail=ignore",
        ];
        const onlineArgs = [...installArgs, `--registry=${registryUrl}`];
        const seeded = runPnpm([...onlineArgs, "--lockfile-only"], workspace);
        expect(seeded.status, `${seeded.stdout}${seeded.stderr}`).toBe(0);
        // CI publishes a frozen install, without the lockfile generator's caches.
        rmSync(userHome, { force: true, recursive: true });
        rmSync(store, { force: true, recursive: true });
        mkdirSync(userHome, { recursive: true });
        const installed = runPnpm([...onlineArgs, "--frozen-lockfile"], workspace);
        expect(installed.status, `${installed.stdout}${installed.stderr}`).toBe(0);

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
        rmSync(userHome, { force: true, recursive: true });
        userHome = path.join(root, "consumer-home");
        mkdirSync(userHome, { recursive: true });
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

        await stopRegistry();
        signal.throwIfAborted();
        expect(registryDidClose, "registry closed before source deletion/offline install").toBe(
          true,
        );
        await expect(
          new Promise<void>((resolve, reject) => {
            const socket = connect({ host: "127.0.0.1", port, signal });
            socket.once("error", reject);
            socket.once("connect", () => {
              socket.destroy();
              resolve();
            });
          }),
        ).rejects.toMatchObject({ code: "ECONNREFUSED" });
        signal.throwIfAborted();
        rmSync(registry, { force: true, recursive: true });
        const cachedIdentity = statSync(restoredPackageFile);
        const cachedLockfile = readFileSync(path.join(workspace, "pnpm-lock.yaml"), "utf8");
        const offlineArgs = [...onlineArgs, "--offline", "--frozen-lockfile"];
        const reconciliation = runPnpm(offlineArgs, workspace);
        expect(reconciliation.status, `${reconciliation.stdout}${reconciliation.stderr}`).toBe(0);
        expect(statSync(restoredPackageFile)).toMatchObject({
          dev: cachedIdentity.dev,
          ino: cachedIdentity.ino,
        });
        expect(readFileSync(path.join(workspace, "pnpm-lock.yaml"), "utf8")).toBe(cachedLockfile);
        expect(
          readFileSync(path.join(consumer, "node_modules", "cache-proof-dep", "index.js"), "utf8"),
        ).toBe('module.exports = "cache-proof-v1";\n');
        // A stricter policy invalidates pnpm's saved verification and reads the
        // restored registry metadata. A 14-day-old release fails a 21-day gate.
        writeFileSync(
          path.join(workspace, "pnpm-workspace.yaml"),
          workspaceConfig.replace("minimumReleaseAge: 10080", "minimumReleaseAge: 30240"),
        );
        const stricterPolicy = runPnpm(offlineArgs, workspace);
        expect(stricterPolicy.status).toBe(1);
        expect(`${stricterPolicy.stdout}${stricterPolicy.stderr}`).toContain(
          "ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION",
        );
        writeFileSync(path.join(workspace, "pnpm-workspace.yaml"), workspaceConfig);
        writeConsumerManifest("2.0.0");
        const drift = runPnpm(offlineArgs, workspace);
        expect(drift.status).toBe(1);
        expect(`${drift.stdout}${drift.stderr}`).toContain('Cannot install with "frozen-lockfile"');
        expect(`${drift.stdout}${drift.stderr}`).toContain('in importers["packages/consumer"]');
        expect(`${drift.stdout}${drift.stderr}`).toContain(
          "cache-proof-dep (lockfile: 1.0.0, manifest: 2.0.0)",
        );
      } catch (error) {
        if (failures[0] !== error) {
          failures.unshift(error);
        }
      } finally {
        clearTimeout(readyTimeout);
        try {
          await stopRegistry();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "dependency cache fixture failed");
      }
    },
  );

  it("persists content-validated public full-build declarations", () => {
    const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
    const installStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Install dependencies",
    );
    const cacheStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Restore build-all cache",
    );

    expect(action.inputs["build-all-cache-scope"].default).toBe("");
    expect(cacheStep).toMatchObject({
      if: "inputs.cache-mode != 'off' && inputs.build-all-cache-scope != ''",
      uses: CACHE_V5,
      with: { path: ".artifacts/build-all-cache" },
    });
    expect(cacheStep.with.key).toContain("build-all-v1-${{ inputs.build-all-cache-scope }}");
    expect(cacheStep.with.key).toContain("${{ runner.os }}-${{ runner.arch }}");
    const renderCacheKey = (template: string, runId: number, runAttempt: number) =>
      template.replace(/\$\{\{([\s\S]*?)\}\}/gu, (_, expression: string) =>
        String(
          runInNewContext(expression.replace(/inputs\.([a-z-]+)/gu, 'inputs["$1"]'), {
            github: { repository: "openclaw/openclaw", run_id: runId, run_attempt: runAttempt },
            inputs: { "build-all-cache-scope": "full", "node-version": "24.x" },
            runner: { os: "Linux", arch: "X64" },
            hashFiles: () => "unchanged-source",
          }),
        ),
      );
    // A new warmer or rerun must publish rebuilt groups even when an outer input
    // fingerprint would be unchanged; per-group signatures own content validity.
    const keys = (
      [
        [10, 1],
        [11, 1],
        [11, 2],
      ] as const
    ).map(([runId, runAttempt]) => renderCacheKey(cacheStep.with.key, runId, runAttempt));
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) {
      expect(key.startsWith(renderCacheKey(cacheStep.with["restore-keys"], 11, 2).trim())).toBe(
        true,
      );
    }
    expect(cacheStep.with["restore-keys"]).not.toContain("hashFiles");
    expect(action.runs.steps.indexOf(installStep)).toBeLessThan(
      action.runs.steps.indexOf(cacheStep),
    );
    const warmer = parse(readFileSync(".github/workflows/vitest-cache-warm.yml", "utf8"));
    const buildSave = warmer.jobs.warm.steps.find(
      (step: WorkflowStep) => step.name === "Save build-all cache",
    );
    expect(buildSave).toMatchObject({
      uses: "actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
      with: {
        key: "${{ steps.setup-node-env.outputs.build-all-cache-key }}",
        path: ".artifacts/build-all-cache",
      },
    });
    expect(buildSave.if).toContain("steps.setup-node-env.outputs.cache-mode == 'read-write'");

    const privateQaWorkflows = [
      ".github/workflows/mantis-discord-smoke.yml",
      ".github/workflows/mantis-discord-status-reactions.yml",
      ".github/workflows/mantis-discord-thread-attachment.yml",
      ".github/workflows/mantis-slack-desktop-smoke.yml",
      ".github/workflows/qa-live-transports-convex.yml",
    ];
    for (const workflowPath of privateQaWorkflows) {
      const source = readFileSync(workflowPath, "utf8");
      expect(source, workflowPath).not.toContain("build-all-cache-scope:");
    }

    const releaseChecks = parse(
      readFileSync(".github/workflows/openclaw-live-and-e2e-checks-reusable.yml", "utf8"),
    );
    const repoE2eWorkflow = readWorkflow(".github/workflows/openclaw-repo-e2e-reusable.yml");
    const pipelines = [
      releaseChecks.jobs.validate_repo_e2e_gateway,
      releaseChecks.jobs.validate_repo_e2e_runtime,
    ];
    expect(releaseChecks.jobs.validate_live_docker_provider_suites.env).toMatchObject({
      OPENCLAW_SELECTED_SHA: "${{ needs.validate_selected_ref.outputs.selected_sha }}",
      OPENCLAW_TOOLING_SHA: "${{ needs.validate_selected_ref.outputs.workflow_sha }}",
    });
    const repoE2eRows = pipelines.flatMap((pipeline) => JSON.parse(pipeline.with.suites)) as Array<{
      name: string;
      command: string;
      target_script?: string;
    }>;
    expect(pipelines.map((pipeline) => pipeline.with.build_profile)).toEqual([
      "full",
      "ciArtifacts",
    ]);
    for (const pipeline of pipelines) {
      // Each profile starts independently; a slow/full declaration build cannot hold up UI readers.
      expect(pipeline.needs).toBe("validate_selected_ref");
      expect(pipeline.if).toBe("inputs.include_repo_e2e && inputs.live_suite_filter == ''");
      expect(pipeline.uses).toBe("./.github/workflows/openclaw-repo-e2e-reusable.yml");
      expect(pipeline.with.ref).toBe("${{ needs.validate_selected_ref.outputs.selected_sha }}");
      expect(pipeline.with.advisory).toBe("${{ inputs.advisory }}");
      expect(pipeline.with.allow_frozen_target_scenario_omissions).toBe(
        "${{ inputs.allow_frozen_target_scenario_omissions }}",
      );
    }
    expect(repoE2eRows.map((row) => row.command)).toEqual([
      ...Array.from({ length: 4 }, (_, index) => `pnpm test:e2e:gateway --shard=${index + 1}/4`),
      ...Array.from({ length: 4 }, (_, index) => `pnpm test:ui:e2e --shard=${index + 1}/4`),
      "pnpm test:e2e:agent-plugin-gateway",
    ]);
    expect(new Set(repoE2eRows.map((row) => row.name)).size).toBe(9);
    expect(repoE2eRows.find((row) => row.name === "Agent plugin Gateway")).toMatchObject({
      target_script: "test:e2e:agent-plugin-gateway",
    });
    expect(repoE2eWorkflow.env).toMatchObject({
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
      OPENCLAW_VITEST_MAX_WORKERS: "2",
    });
    const producer = repoE2eWorkflow.jobs.build;
    const repoE2e = repoE2eWorkflow.jobs.test;
    expect(repoE2e.needs).toBe("build");
    expect(repoE2e.name).toBe("Repo E2E (${{ matrix.name }})");
    expect(repoE2e["timeout-minutes"]).toBe(90);
    expect(repoE2e.strategy).toMatchObject({ "fail-fast": false, "max-parallel": 4 });
    expect(repoE2e["continue-on-error"]).toBe("${{ inputs.advisory }}");
    const producerSteps = producer.steps as WorkflowStep[];
    expect(producerSteps.find((step) => step.name === "Build dist for repo E2E")?.run).toContain(
      "full) pnpm build",
    );
    expect(producerSteps.find((step) => step.name === "Build dist for repo E2E")?.run).toContain(
      "ciArtifacts) pnpm build:ci-artifacts",
    );
    expect(producerSteps.find((step) => step.uses === UPLOAD_ARTIFACT_V7)?.with?.name).toContain(
      "${{ github.run_attempt }}",
    );
    const repoE2eSteps = repoE2e.steps as WorkflowStep[];
    expect(repoE2eSteps.find((step) => step.name === "Checkout selected ref")?.with?.ref).toBe(
      "${{ inputs.ref }}",
    );
    expect(repoE2eSteps.find((step) => step.uses === DOWNLOAD_ARTIFACT_V8)?.with).toMatchObject({
      "artifact-ids": "${{ needs.build.outputs.artifact_id }}",
      "run-id": "${{ needs.build.outputs.artifact_run_id }}",
      "github-token": "${{ github.token }}",
    });
    expect(repoE2eSteps.some((step) => step.run?.includes("pnpm build"))).toBe(false);
    const restoreIndex = repoE2eSteps.findIndex((step) => step.name === "Restore repo E2E build");
    const sandboxSetupIndex = repoE2eSteps.findIndex(
      (step) => step.run === "scripts/sandbox-setup.sh",
    );
    const repoE2eIndex = repoE2eSteps.findIndex((step) => step.name === "Run repo E2E suite");
    expect(restoreIndex).toBeGreaterThanOrEqual(0);
    expect(sandboxSetupIndex).toBeGreaterThan(restoreIndex);
    expect(repoE2eIndex).toBeGreaterThan(sandboxSetupIndex);
    expect(repoE2eSteps[repoE2eIndex]).toMatchObject({
      env: {
        OPENCLAW_E2E_WORKERS: "2",
        OPENCLAW_E2E_USE_PREBUILT_DIST: "1",
        TARGET_REQUIRED_SCRIPT: "${{ matrix.target_script || '' }}",
      },
    });
    const repoE2eRun = repoE2eSteps[repoE2eIndex]?.run;
    expect(repoE2eRun).toContain("OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS");
    expect(repoE2eRun).toContain("Selected target does not provide required repo E2E capability");
    expect(repoE2eRun).toContain("selected target does not provide this newer repo E2E capability");
    expect(repoE2eRun).toContain("${{ matrix.command }}");
    const targetedGroupStep = releaseChecks.jobs.plan_docker_lane_groups.steps.find(
      (step: WorkflowStep) => step.name === "Build targeted Docker lane groups",
    );
    expect(targetedGroupStep.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS).toBe(
      "${{ inputs.published_upgrade_survivor_scenarios }}",
    );
    expect(releaseChecks.jobs.validate_docker_lanes["timeout-minutes"]).toBe(
      "${{ matrix.group.timeout_minutes || 60 }}",
    );
    expect(releaseChecks.jobs.validate_docker_lanes.strategy["max-parallel"]).toBe(32);
    expect(releaseChecks.jobs.validate_docker_lanes.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS).toBe(
      "${{ matrix.group.published_upgrade_survivor_scenarios || inputs.published_upgrade_survivor_scenarios }}",
    );
  });

  it("persists Node 26 minimum declarations through trusted bounded artifacts", () => {
    const workflow = parse(readFileSync(".github/workflows/node-runtime-compat.yml", "utf8"));
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
          "pnpm:devPreinstall": "node scripts/check-install-dependency-ownership.mjs",
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

      for (const relativePath of [
        "node-version.mjs",
        ".github/actions/setup-node-env/install-dependencies.sh",
        "scripts/check-install-dependency-ownership.mjs",
        "scripts/prepare-git-hooks.mjs",
        "scripts/lib/package-lifecycle-marker.mjs",
      ]) {
        const inputPath = path.join(root, relativePath);
        mkdirSync(path.dirname(inputPath), { recursive: true });
        writeFileSync(inputPath, "fixture\n");
        expect(fingerprint(), relativePath).not.toBe(baseline);
        rmSync(inputPath);
        expect(fingerprint(), relativePath).toBe(baseline);
      }

      // Formatting, key order, and scripts that pnpm install never executes
      // should keep the existing dependency snapshot warm.
      writeManifest({
        devDependencies: { vitest: "1.0.0" },
        scripts: {
          test: "vitest run --reporter=dot",
          prepare: "node scripts/prepare-git-hooks.mjs",
          "pnpm:devPreinstall": "node scripts/check-install-dependency-ownership.mjs",
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
          "pnpm:devPreinstall": "node scripts/check-install-dependency-ownership.mjs",
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
          "pnpm:devPreinstall": "node scripts/check-install-dependency-ownership.mjs",
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
          "pnpm:devPreinstall": "node scripts/check-install-dependency-ownership.mjs",
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
          "pnpm:devPreinstall": "node scripts/check-install-dependency-ownership.mjs",
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

  it("hashes transform inputs once per enabled setup and never for skipped caches", () => {
    const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
    const transformSteps = (action.runs.steps as WorkflowStep[]).filter((step) =>
      step.name?.includes("Vitest transform cache"),
    );
    const output = path.join(tempDirs.make("openclaw-transform-generation-"), "output");
    for (const os of ["Linux", "macOS", "Windows"]) {
      for (const mode of ["off", "restore", "read-write"]) {
        for (const flags of [
          ["false", "false"],
          ["true", "false"],
          ["false", "true"],
          ["true", "true"],
        ]) {
          for (const generation of ["a".repeat(64), "b".repeat(64)]) {
            const hashes: string[][] = [];
            const steps: Record<string, { outputs: Record<string, string> }> = {};
            const context = {
              github: { repository: "openclaw/openclaw", run_id: 10, run_attempt: 2 },
              inputs: {
                "cache-mode": mode,
                "vitest-fs-cache": flags[0],
                "restore-test-caches": flags[1],
                "node-version": "24.x",
              },
              runner: { os, arch: "X64" },
              steps,
              hashFiles: (...patterns: string[]) => {
                hashes.push(patterns);
                return generation;
              },
            };
            const evaluate = (expression: string): unknown =>
              runInNewContext(
                expression.replace(/(inputs|steps)\.([a-z-]+)/gu, '$1["$2"]'),
                context,
              );
            const render = (value: unknown) =>
              String(value).replace(/\$\{\{([\s\S]*?)\}\}/gu, (_, expression: string) => {
                const result = evaluate(expression);
                if (result == null) {
                  return "";
                }
                if (
                  typeof result === "string" ||
                  typeof result === "number" ||
                  typeof result === "boolean"
                ) {
                  return String(result);
                }
                throw new TypeError(`non-scalar workflow interpolation: ${expression}`);
              });
            let cacheInputs: Record<string, string> | undefined;
            let configuredGeneration: string | undefined;
            for (const step of transformSteps) {
              // Runner v2.336.0 evaluates embedded env before if; run/with inputs
              // are evaluated only after admission (CompositeActionHandler/ActionRunner).
              const env = Object.fromEntries(
                Object.entries(step.env ?? {}).map(([key, value]) => [key, render(value)]),
              );
              if (!evaluate(step.if ?? "true")) {
                if (step.id) {
                  steps[step.id] = { outputs: {} };
                }
                continue;
              }
              if (step.name === "Resolve Vitest transform cache generation") {
                writeFileSync(output, "");
                execFileSync("bash", ["-e", "-c", render(step.run)], {
                  env: { ...process.env, GITHUB_OUTPUT: output },
                });
                steps[expectDefined(step.id, "transform generation step id")] = {
                  outputs: Object.fromEntries(
                    readFileSync(output, "utf8")
                      .trim()
                      .split("\n")
                      .map((line) => line.split("=")),
                  ),
                };
              } else if (step.uses) {
                cacheInputs = Object.fromEntries(
                  Object.entries(step.with ?? {}).map(([key, value]) => [key, render(value)]),
                );
              } else {
                configuredGeneration = env.CACHE_GENERATION;
              }
            }
            const enabled = os !== "Windows" && mode !== "off" && flags.includes("true");
            expect(hashes, JSON.stringify({ os, mode, flags, generation })).toHaveLength(
              enabled ? 1 : 0,
            );
            if (enabled) {
              expect(hashes[0]).toEqual([
                "pnpm-lock.yaml",
                "pnpm-workspace.yaml",
                "**/package.json",
                "**/tsconfig*.json",
                "vitest.config.*",
                "test/vitest/**",
                "src/state/*.sql",
                "!**/node_modules/**",
              ]);
              const prefix = `openclaw/openclaw-vitest-fs-v3-protected-${os}-X64-node-24.x-${generation}-`;
              expect(cacheInputs).toEqual({
                path: "/var/tmp/openclaw-vitest-fs-cache",
                key: `${prefix}10-2`,
                "restore-keys": `${prefix}\n`,
              });
              expect(configuredGeneration).toBe(generation);
            } else {
              expect(cacheInputs).toBeUndefined();
              expect(configuredGeneration).toBeUndefined();
            }
          }
        }
      }
    }
  });

  it("persists isolated transform and compile caches through immutable protected archives", () => {
    const workflow = readCiWorkflow();
    const nodeTestJob = workflow.jobs["checks-node-core-test-nondist-shard"];
    const setupNodeStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Setup Node environment",
    );
    const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
    const readerStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Restore Vitest transform cache",
    );
    const configureStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Configure Vitest transform cache",
    );
    const compileEpochStep = action.runs.steps.find(
      (step: WorkflowStep) => step.name === "Select Node compile cache epoch",
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
    const hostedTestCacheInput =
      "${{ (needs.preflight.outputs.runner_profile == 'github' || needs.preflight.outputs.runner_profile == 'hybrid') && 'true' || 'false' }}";
    const hostedTestCacheJobs = [
      "checks-ui",
      "checks-ui-e2e",
      "checks-fast-plugin-contracts-shard",
      "checks-fast-channel-contracts-shard",
    ];
    const hostedFastCoreTestCacheInput =
      "${{ (needs.preflight.outputs.runner_profile == 'github' || needs.preflight.outputs.runner_profile == 'hybrid') && (matrix.task == 'bundled-protocol' || matrix.task == 'contracts-plugins-ci-routing' || matrix.task == 'ci-routing' || matrix.task == 'bun-launcher') && 'true' || 'false' }}";

    expect(setupNodeStep.with).toMatchObject({
      "cache-mode": "${{ needs.preflight.outputs.cache_mode }}",
      "node-compile-cache": "true",
      "node-compile-cache-scope": "test",
      "vitest-fs-cache": "true",
    });
    expect(setupNodeStep.with).not.toHaveProperty("save-node-compile-cache");
    expect(setupNodeStep.with).not.toHaveProperty("runtime-cache-sticky-disk");
    expect(action.inputs).not.toHaveProperty("runtime-cache-sticky-disk");
    expect(action.inputs["vitest-fs-cache"].default).toBe("false");
    expect(action.inputs["restore-test-caches"].default).toBe("false");
    expect(action.inputs).not.toHaveProperty("save-vitest-fs-cache");
    expect(action.inputs["node-compile-cache"].default).toBe("false");
    expect(action.inputs["node-compile-cache-scope"].default).toBe("test");
    expect(action.inputs).not.toHaveProperty("save-node-compile-cache");
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
    expect(readerStep.uses).toBe(CACHE_V5);
    expect(readerStep.if).toContain("inputs.cache-mode != 'off'");
    expect(readerStep.if).toContain("inputs.restore-test-caches == 'true'");
    expect(readerStep.if).toContain("runner.os != 'Windows'");
    expect(readerStep.if).not.toMatch(/runner\.(?:environment|labels|name)/u);
    expect(readerStep.with.key).toContain("vitest-fs-v3-protected-");
    expect(readerStep.with.key).toContain("github.run_id");
    expect(readerStep.with.key).toContain("github.run_attempt");
    expect(configureStep.if).toContain("inputs.restore-test-caches == 'true'");
    expect(configureStep.run).toContain("OPENCLAW_VITEST_FS_MODULE_CACHE_PATH=$cache_root");
    expect(configureStep.run).toContain(".openclaw-transform-generation");
    expect(configureStep.run).not.toContain("protected Vitest transform seed");
    expect(configureStep.env.CACHE_WRITER).toBe("0");
    expect(configureStep.run).toContain("OPENCLAW_VITEST_FS_MODULE_CACHE_WRITER=");
    expect(compileEpochStep.run).toContain('if [ "$CACHE_SCOPE" = "build" ]');
    expect(compileEpochStep.run).toContain("date -u +%Y%m%d");
    expect(compileEpochStep.run).toContain("GITHUB_RUN_ID");
    expect(compileReaderStep.with.key).toContain(
      "node-compile-v3-${{ inputs.node-compile-cache-scope }}-protected-",
    );
    expect(compileReaderStep.with.key).toContain("steps.node-compile-cache-epoch.outputs.value");
    expect(compileReaderStep.with.key).not.toContain("pull_request");
    expect(compileEpochStep.if).toContain("inputs.restore-test-caches == 'true'");
    expect(compileReaderStep.if).toContain("inputs.cache-mode != 'off'");
    expect(compileReaderStep.if).toContain("inputs.restore-test-caches == 'true'");
    expect(compileConfigureStep.if).toContain("inputs.restore-test-caches == 'true'");
    expect(compileConfigureStep.run).toContain("NODE_COMPILE_CACHE=$cache_root");
    expect(compileConfigureStep.run).toContain("NODE_COMPILE_CACHE_PORTABLE=1");
    expect(compileConfigureStep.run).toContain("OPENCLAW_NODE_COMPILE_CACHE_WRITER=0");
    expect(buildSetupNodeStep.with).toMatchObject({
      "cache-mode": "${{ needs.preflight.outputs.cache_mode }}",
      "node-compile-cache": "true",
      "node-compile-cache-scope": "build",
      "build-all-cache-scope": "full",
    });
    expect(buildSetupNodeStep.with["node-compile-cache-scope"]).not.toBe(
      setupNodeStep.with["node-compile-cache-scope"],
    );

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
    const warmerSteps = warmer.jobs.warm.steps as WorkflowStep[];
    const buildStep = expectDefined(
      warmerSteps.find((step) => step.name === "Warm build cache"),
      "cache warm build",
    );
    const boundaryRestoreStep = expectDefined(
      warmerSteps.find((step) => step.name === "Restore native SDK boundary cache"),
      "native SDK boundary cache restore",
    );
    const boundaryPrepareStep = expectDefined(
      warmerSteps.find((step) => step.name === "Prepare native SDK boundary cache"),
      "native SDK boundary cache preparation",
    );
    const boundarySaveStep = expectDefined(
      warmerSteps.find((step) => step.name === "Save native SDK boundary cache"),
      "native SDK boundary cache publication",
    );
    const boundaryCleanupStep = expectDefined(
      warmerSteps.find((step) => step.name === "Clear native SDK boundary output before build"),
      "native SDK boundary output cleanup",
    );
    const warmAssertionStep = expectDefined(
      warmerSteps.find((step) => step.name === "Assert cache warming succeeded"),
      "final cache warming assertion",
    );

    expect(warmer.concurrency["cancel-in-progress"]).toBe(false);
    expect(warmer.concurrency.group).toBe("vitest-cache-warm-${{ github.ref }}");
    // hosted-mode cache recovery needs a maintainer-operated fallback when the
    // scheduled seed is missing or stale.
    expect(warmer.on).toHaveProperty("workflow_dispatch");
    expect(warmer.on.push.branches).toEqual(["main"]);
    expect(warmer.on.repository_dispatch.types).toEqual(["vitest-cache-warm"]);
    expect(warmer.jobs.warm.if).toContain("github.repository == 'openclaw/openclaw'");
    expect(warmer.jobs.warm.strategy).toEqual({
      "fail-fast": false,
      matrix: { platform: ["linux", "macos"] },
    });
    expect(warmer.on).not.toHaveProperty("pull_request");
    expect(warmer.on).not.toHaveProperty("pull_request_target");
    for (const eventName of ["push", "workflow_dispatch"] as const) {
      for (const runnerBackend of ["blacksmith", "hybrid", "github"] as const) {
        for (const platform of warmer.jobs.warm.strategy.matrix.platform) {
          const context = {
            eventName,
            matrix: { platform },
            repository: "openclaw/openclaw",
            runAttempt: 1,
            runnerBackend,
          };
          const full = platform === "linux";
          const expectedRunner = full
            ? runnerBackend === "github"
              ? "ubuntu-24.04"
              : "blacksmith-8vcpu-ubuntu-2404"
            : "macos-15";
          expect(evaluateWorkflowExpression(warmer.jobs.warm["runs-on"], context)).toBe(
            expectedRunner,
          );
          const setupInputs = Object.fromEntries(
            Object.entries(warmerSetup.with).map(([key, value]) => [
              key,
              typeof value === "string" && value.startsWith("${{")
                ? evaluateWorkflowExpression(value, context)
                : value,
            ]),
          );
          expect(setupInputs).toMatchObject({
            "build-all-cache-scope": full ? "full" : "",
            "cache-mode": "read-write",
            "dependency-cache": String(full),
            "install-bun": "false",
            "node-compile-cache-scope": "test",
            "node-compile-cache": String(full),
            "vitest-fs-cache": String(full),
          });
          for (const step of [
            buildStep,
            boundaryPrepareStep,
            boundaryCleanupStep,
            seedStep,
            warmStep,
            warmAssertionStep,
          ]) {
            expect(evaluateWorkflowExpression(step.if, context), step.name).toBe(full);
          }
        }
      }
    }
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
    expect(seedStep.run).toContain('"OPENCLAW_NODE_TEST_PLAN_CONTINUE_ON_FAILURE=1"');
    expect(warmStep.id).toBe("warm-caches");
    expect(warmStep["continue-on-error"]).toBe(true);
    expect(warmStep.env).toMatchObject({
      OPENCLAW_VITEST_FS_MODULE_CACHE_WRITER: "1",
      OPENCLAW_NODE_COMPILE_CACHE_WRITER: "1",
    });
    expect(warmerSetup["continue-on-error"]).not.toBe(true);
    for (const legacyInput of [
      "save-actions-cache",
      "save-dependency-cache",
      "save-node-compile-cache",
      "save-vitest-fs-cache",
      "use-actions-cache",
    ]) {
      expect(warmerSetup.with).not.toHaveProperty(legacyInput);
    }
    const saveSteps = warmerSteps.filter((step) => step.uses?.startsWith("actions/cache/save@"));
    expect(saveSteps.map((step) => step.name)).toEqual([
      "Save Node toolchain cache",
      "Save exact dependency cache",
      "Save native SDK boundary cache",
      "Save build-all cache",
      "Save dist build cache",
      "Save pnpm store cache",
      "Save Vitest transform cache",
      "Save Node compile cache",
    ]);
    for (const saveStep of saveSteps) {
      expect(saveStep.if, saveStep.name).toContain(
        "steps.setup-node-env.outputs.cache-mode == 'read-write'",
      );
      expect(warmerSteps.indexOf(saveStep), saveStep.name).toBeGreaterThan(
        warmerSteps.indexOf(warmerSetup),
      );
      if (
        saveStep.name === "Save Node toolchain cache" ||
        saveStep.name === "Save exact dependency cache"
      ) {
        expect(warmerSteps.indexOf(saveStep), saveStep.name).toBeLessThan(
          warmerSteps.indexOf(buildStep),
        );
        // A normal step condition retains Actions' implicit success() gate,
        // so failed setup cannot publish even if it produced cache outputs.
        expect(saveStep.if, saveStep.name).not.toMatch(/\b(?:always|failure|cancelled)\(/u);
      } else if (
        saveStep.name === "Save build-all cache" ||
        saveStep.name === "Save dist build cache"
      ) {
        expect(warmerSteps.indexOf(saveStep), saveStep.name).toBeGreaterThan(
          warmerSteps.findIndex((step) => step.name === "Warm build cache"),
        );
        expect(warmerSteps.indexOf(saveStep), saveStep.name).toBeLessThan(
          warmerSteps.indexOf(seedStep),
        );
        expect(saveStep.if).not.toMatch(/always\(|failure\(/u);
      } else if (saveStep.name === "Save native SDK boundary cache") {
        expect(saveStep.if).toContain(
          "steps.extension-package-boundary-cache.outputs.cache-hit != 'true'",
        );
        expect(saveStep.if).not.toMatch(/always\(|failure\(|cancelled\(/u);
      } else {
        expect(warmerSteps.indexOf(saveStep), saveStep.name).toBeGreaterThan(
          warmerSteps.indexOf(warmStep),
        );
      }
      expect(warmerSteps.indexOf(saveStep), saveStep.name).toBeLessThan(
        warmerSteps.indexOf(warmAssertionStep),
      );
    }
    expect(warmAssertionStep.if).toBe("${{ always() && matrix.platform == 'linux' }}");
    expect(warmAssertionStep.run).toContain("steps.warm-caches.outcome");
    expect(warmAssertionStep.run).toContain("exit 1");
    expect(warmerSteps.at(-1)).toBe(warmAssertionStep);
    // No close-time cleanup workflow is needed; Actions cache LRU/TTL expires
    // old hosted-writer and warmer generations.
    expect(existsSync(".github/workflows/pr-cache-cleanup.yml")).toBe(false);
    expect(seedStep.if).toBe("${{ matrix.platform == 'linux' }}");
    expect(warmStep.if).toBe("${{ matrix.platform == 'linux' }}");
    const distSave = expectDefined(
      saveSteps.find((step) => step.name === "Save dist build cache"),
      "Linux dist publication",
    );
    expect(distSave.if).toBe(
      "${{ matrix.platform == 'linux' && steps.setup-node-env.outputs.cache-mode == 'read-write' }}",
    );
    expect(boundaryRestoreStep.uses).toBe(CACHE_V5);
    expect(boundarySaveStep.uses).toBe(CACHE_SAVE_V5);
    const boundaryRestoreInputs = expectDefined(
      boundaryRestoreStep.with,
      "native SDK boundary cache inputs",
    );
    expect(boundaryRestoreInputs.key).toBe(
      "${{ runner.os }}-extension-package-boundary-v4-${{ github.sha }}",
    );
    expect(boundarySaveStep.with).toEqual({
      path: boundaryRestoreInputs.path,
      key: boundaryRestoreInputs.key,
    });
    expect(boundaryRestoreInputs["restore-keys"]).toBe(
      "${{ runner.os }}-extension-package-boundary-v4-\n",
    );
    expect(boundaryPrepareStep.run).toBe(
      "node --import ./scripts/tsx.mjs scripts/prepare-extension-package-boundary-artifacts.mts --mode=package-boundary",
    );
    expect(boundaryPrepareStep["continue-on-error"]).not.toBe(true);
    expect(warmerSteps.indexOf(boundaryRestoreStep)).toBeLessThan(warmerSteps.indexOf(buildStep));
    expect(warmerSteps.indexOf(boundaryPrepareStep)).toBeGreaterThan(
      warmerSteps.indexOf(boundaryRestoreStep),
    );
    expect(warmerSteps.indexOf(boundarySaveStep)).toBeGreaterThan(
      warmerSteps.indexOf(boundaryPrepareStep),
    );
    expect(warmerSteps.indexOf(boundarySaveStep)).toBeLessThan(warmerSteps.indexOf(buildStep));
    expect(warmerSteps.indexOf(boundaryCleanupStep)).toBeGreaterThan(
      warmerSteps.indexOf(boundarySaveStep),
    );
    expect(warmerSteps.indexOf(boundaryCleanupStep)).toBeLessThan(warmerSteps.indexOf(buildStep));
    const cleanupRoot = tempDirs.make("openclaw-native-sdk-cleanup-");
    const sdkOutput = path.join(cleanupRoot, "packages/plugin-sdk/dist/native.d.ts");
    const sdkSource = path.join(cleanupRoot, "packages/plugin-sdk/src/core.ts");
    const siblingOutput = path.join(cleanupRoot, "packages/normalization-core/dist/index.js");
    const boundaryReceipt = path.join(
      cleanupRoot,
      ".artifacts/extension-package-boundary/plugin-sdk.json",
    );
    for (const file of [sdkOutput, sdkSource, siblingOutput, boundaryReceipt]) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "sentinel\n");
    }
    const cleanupResult = runWorkflowShellScript(
      expectDefined(boundaryCleanupStep.run, "cleanup"),
      {
        cwd: cleanupRoot,
        env: process.env,
      },
    );
    expect(cleanupResult.status, `${cleanupResult.stdout}${cleanupResult.stderr}`).toBe(0);
    expect(existsSync(sdkOutput)).toBe(false);
    expect(existsSync(sdkSource)).toBe(true);
    expect(existsSync(siblingOutput)).toBe(true);
    expect(existsSync(boundaryReceipt)).toBe(true);
    const storeSave = expectDefined(
      saveSteps.find((step) => step.name === "Save pnpm store cache"),
      "platform pnpm store publication",
    );
    expect(storeSave.if).not.toContain("matrix.platform");
    expect(storeSave.if).toContain("steps.setup-node-env.outputs.pnpm-store-cache-hit != 'true'");
    expect(storeSave.if).not.toMatch(/\b(?:always|failure|cancelled)\(/u);
    expect(storeSave.with).toEqual({
      path: "${{ steps.setup-node-env.outputs.pnpm-store-cache-path }}",
      key: "${{ steps.setup-node-env.outputs.pnpm-store-cache-key }}",
    });
  });

  it("publishes a portable release npm seed without hooks or push-time downloads", () => {
    const warmer = parse(readFileSync(".github/workflows/release-npm-cache-warm.yml", "utf8"));
    expect(warmer.on).not.toHaveProperty("push");
    expect(warmer.on).toHaveProperty("schedule");
    expect(warmer.on).toHaveProperty("workflow_dispatch");
    expect(warmer.concurrency.group).not.toBe(
      parse(readFileSync(".github/workflows/vitest-cache-warm.yml", "utf8")).concurrency.group,
    );
    const seed = warmer.jobs["warm-release-npm"];
    for (const repository of ["openclaw/openclaw", "example/fork"]) {
      for (const eventName of [
        "push",
        "pull_request",
        "repository_dispatch",
        "schedule",
        "workflow_dispatch",
      ] as const) {
        expect(evaluateWorkflowExpression(seed.if, { repository, eventName, runAttempt: 1 })).toBe(
          repository === "openclaw/openclaw" &&
            (eventName === "schedule" || eventName === "workflow_dispatch"),
        );
      }
    }
    expect(seed["runs-on"]).toBe("ubuntu-24.04");
    const steps = seed.steps as WorkflowStep[];
    const install = expectDefined(
      steps.find((entry) => entry.run),
      "npm seed install",
    );
    expect(install.run).toContain("openclaw@latest --ignore-scripts --omit=dev");
    expect(install.env).toEqual({
      NPM_CONFIG_CACHE: "${{ github.workspace }}/.cache/openclaw-cross-os-npm-cache",
    });
    const save = expectDefined(
      steps.find((entry) => entry.uses?.startsWith("actions/cache/save@")),
      "npm seed publication",
    );
    expect(save.with).toMatchObject({
      path: ".cache/openclaw-cross-os-npm-cache/_cacache",
      enableCrossOsArchive: true,
    });
    expect(save.with?.key).toMatch(/^openclaw-cross-os-npm-v1-seed-/u);
    expect(save["continue-on-error"]).toBe(true);
    expect(save.if ?? "").not.toMatch(/always\(|failure\(|cancelled\(/u);
    expect(steps.indexOf(save)).toBeGreaterThan(steps.indexOf(install));
    expect(steps.some((entry) => entry.uses?.startsWith("actions/cache/restore@"))).toBe(false);
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
    for (const task of ["dependencies", "test-types"]) {
      expect(workflow.jobs["check-shard"].strategy.matrix.include).toContainEqual({
        check_name: `check-${task}`,
        task,
        runner: "blacksmith-32vcpu-ubuntu-2404",
      });
    }
    expect(workflow.jobs["check-additional-shard"]["runs-on"]).toContain("matrix.runner");
    expect(readFrozenAdditionalCheckRows()).toContainEqual({
      check_name: "check-additional-runtime-topology-architecture",
      group: "runtime-topology-architecture",
      runner: "blacksmith-32vcpu-ubuntu-2404",
    });
    expect(readFrozenAdditionalCheckRows()).toContainEqual({
      check_name: "check-session-accessor-boundary",
      group: "session-accessor-boundary",
      runner: "blacksmith-4vcpu-ubuntu-2404",
    });
    expect(readFrozenAdditionalCheckRows()).toContainEqual({
      check_name: "check-export-name-collisions",
      group: "export-name-collisions",
      runner: "blacksmith-4vcpu-ubuntu-2404",
    });
    expect(readFrozenAdditionalCheckRows()).toContainEqual({
      check_name: "check-sqlite-session-schema-baseline",
      group: "sqlite-session-schema-baseline",
      runner: "blacksmith-4vcpu-ubuntu-2404",
    });
    // The Windows matrix carries no per-row runner: both parts share one class.
    expect(workflow.jobs["checks-windows"]["runs-on"]).not.toContain("matrix.runner");
    expect(source).toContain("blacksmith-8vcpu-windows-2025");
  });

  it("keeps the extension boundary sticky disk on one protected key", () => {
    const workflow = readCiWorkflow();
    const warmer = parse(readFileSync(".github/workflows/vitest-cache-warm.yml", "utf8"));
    const additionalJob = workflow.jobs["check-additional-shard"];
    const checkShardJob = workflow.jobs["check-shard"];
    const hostedCoreJob = workflow.jobs["check-lint-hosted-core-shard"];

    // Cold SDK preparation and plugin compilation need CPU and memory headroom.
    expect(readFrozenAdditionalCheckRows()).toContainEqual({
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
    const hostedCoreCache = expectDefined(
      hostedCoreJob.steps.find(
        (step: WorkflowStep) =>
          step.name === "Cache extension package boundary artifacts for hosted core lint",
      ),
      "hosted core extension package boundary cache",
    );
    expect(boundaryMount.with.key).toBe("${{ github.repository }}-ext-boundary-v2");
    expect(lintMount.with.key).toBe(boundaryMount.with.key);
    for (const gate of [boundaryMount, lintMount]) {
      expect(gate.if).toContain("vars.OPENCLAW_CI_RUNNER_BACKEND != 'github'");
    }
    expect(hostedLintCache.if).toBe(
      "needs.preflight.outputs.cache_mode != 'off' && matrix.task == 'lint' && steps.extension-boundary-inputs.outputs.enabled == 'true' && (needs.preflight.outputs.runner_profile == 'github' || needs.preflight.outputs.runner_profile == 'hybrid')",
    );
    expect(boundaryCache.if).toBe(
      "needs.preflight.outputs.cache_mode != 'off' && matrix.group == 'extension-package-boundary' && steps.extension-boundary-inputs.outputs.enabled == 'true'",
    );
    expect(hostedCoreCache.if).toBe(
      "needs.preflight.outputs.cache_mode != 'off' && needs.preflight.outputs.runner_profile == 'github' && !inputs.release_gate && steps.extension-boundary-inputs.outputs.enabled == 'true'",
    );
    for (const cache of [hostedLintCache, hostedCoreCache]) {
      expect(cache.uses).toBe(CACHE_V5);
      expect(cache.with).toEqual(boundaryCache.with);
    }
    const fingerprintReference = "${{ steps.extension-boundary-inputs.outputs.fingerprint }}";
    expect(boundaryCache.with.key).toBe(
      "${{ runner.os }}-extension-package-boundary-v4-${{ steps.extension-boundary-inputs.outputs.fingerprint }}",
    );
    expect(boundaryCache.with.path.trim().split("\n")).toEqual([
      "packages/plugin-sdk/dist",
      ".artifacts/extension-package-boundary/plugins",
      ".artifacts/extension-package-boundary/*.json",
      ".artifacts/extension-package-boundary/compile",
    ]);
    const fingerprintSteps = [additionalJob, checkShardJob, hostedCoreJob].map((job) =>
      expectDefined(
        job.steps.find(
          (step: WorkflowStep) => step.name === "Compute extension boundary input fingerprint",
        ),
        "extension boundary input fingerprint step",
      ),
    );
    for (const step of fingerprintSteps) {
      expect(step.id).toBe("extension-boundary-inputs");
      expect(step.run).toContain('fingerprint="$(git rev-parse HEAD)"');
      expect(step.run).toContain('echo "enabled=false" >> "$GITHUB_OUTPUT"');
    }
    expect(fingerprintSteps[0]?.run).toBe(fingerprintSteps[1]?.run);
    expect(fingerprintSteps[1]?.run).toBe(fingerprintSteps[2]?.run);
    expect(fingerprintSteps[2]?.if).toBe(
      "needs.preflight.outputs.runner_profile == 'github' && !inputs.release_gate",
    );
    expect(hostedCoreJob.steps.indexOf(fingerprintSteps[2])).toBeLessThan(
      hostedCoreJob.steps.indexOf(hostedCoreCache),
    );
    expect(hostedCoreJob.steps.indexOf(hostedCoreCache)).toBeLessThan(
      hostedCoreJob.steps.findIndex(
        (step: WorkflowStep) => step.name === "Run hosted core lint stripe",
      ),
    );
    expect(
      hostedCoreJob.steps.some((step: WorkflowStep) =>
        step.uses?.startsWith("actions/cache/save@"),
      ),
    ).toBe(false);
    const warmerBoundaryRestore = expectDefined(
      warmer.jobs.warm.steps.find(
        (step: WorkflowStep) => step.name === "Restore native SDK boundary cache",
      ),
      "warmer boundary restore",
    );
    const warmerBoundarySave = expectDefined(
      warmer.jobs.warm.steps.find(
        (step: WorkflowStep) => step.name === "Save native SDK boundary cache",
      ),
      "warmer boundary save",
    );
    expect(warmerBoundaryRestore.with.path).toBe(boundaryCache.with.path);
    expect(warmerBoundaryRestore.with["restore-keys"]).toBe(boundaryCache.with["restore-keys"]);
    expect(warmerBoundarySave.with.path).toBe(boundaryCache.with.path);
    // Single semantic writer: protected pushes commit explicitly (not
    // on-change/if-missing, whose allocated-byte heuristic can strand a stale
    // marker); PR clones and the lint consumer stay read-only.
    expect(boundaryMount.with.commit).toBe(
      "${{ github.event_name != 'pull_request' && 'true' || 'false' }}",
    );
    expect(lintMount.with.commit).toBe("false");

    // Transport keys use the same commit; native owner records independently
    // validate source content and output integrity after restoration.
    const restoreStep = additionalJob.steps.find(
      (step: WorkflowStep) => step.name === "Restore extension boundary artifacts from sticky disk",
    );
    const lintRestoreStep = checkShardJob.steps.find(
      (step: WorkflowStep) => step.name === "Restore extension boundary artifacts from sticky disk",
    );
    const seedStep = additionalJob.steps.find(
      (step: WorkflowStep) => step.name === "Seed extension boundary sticky disk",
    );
    for (const gate of [restoreStep, lintRestoreStep, seedStep]) {
      expect(gate.run).toContain(fingerprintReference);
      expect(gate.run).toContain(".source-fingerprint");
      expect(gate.run).not.toContain("git rev-parse HEAD:");
      expect(gate.run).not.toContain("BOUNDARY_CONFIG_HASH");
      expect(gate.if).toContain("vars.OPENCLAW_CI_RUNNER_BACKEND != 'github'");
    }
    // Seeding is writer-only work: PR mounts never commit, so seeding there
    // would burn wall clock on a discarded clone.
    expect(seedStep.if).toContain("github.event_name != 'pull_request'");
    expect(seedStep.if).toContain("steps.boundary-sticky-restore.outputs.restored == 'false'");
    expect(seedStep.run).toContain(
      "rsync -aR --exclude='*.lock*' .artifacts/extension-package-boundary",
    );
    for (const step of [restoreStep, lintRestoreStep]) {
      expect(step.run).toContain("for payload in packages .artifacts;");
    }
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

  it("caches Robolectric SDK artifacts for Android test tasks only", () => {
    const workflowSource = readFileSync(".github/workflows/ci.yml", "utf8");
    const androidSteps = readCiWorkflow().jobs.android.steps as WorkflowStep[];
    const restoreIndex = androidSteps.findIndex(
      (step) => step.name === "Restore Robolectric Maven cache",
    );
    const configureIndex = androidSteps.findIndex(
      (step) => step.name === "Configure Robolectric Maven cache",
    );
    const runIndex = androidSteps.findIndex(
      (step) => step.name === "Run Android ${{ matrix.task }}",
    );
    const saveIndex = androidSteps.findIndex(
      (step) => step.name === "Save Robolectric Maven cache",
    );
    const restoreStep = expectDefined(androidSteps[restoreIndex], "Robolectric cache restore");
    const configureStep = expectDefined(
      androidSteps[configureIndex],
      "Robolectric cache configuration",
    );
    const runStep = expectDefined(androidSteps[runIndex], "Android task runner");
    const saveStep = expectDefined(androidSteps[saveIndex], "Robolectric cache save");

    expect([restoreIndex, configureIndex, runIndex, saveIndex]).toEqual(
      [restoreIndex, configureIndex, runIndex, saveIndex].toSorted((a, b) => a - b),
    );
    expect(restoreStep).toMatchObject({
      id: "robolectric-cache",
      if: "startsWith(matrix.task, 'test-') && needs.preflight.outputs.cache_mode != 'off'",
      uses: CACHE_V5,
      with: {
        path: "/var/tmp/openclaw-robolectric-m2",
      },
    });
    const cacheKey = String(restoreStep.with?.key);
    expect(cacheKey).toContain("${{ github.repository }}-robolectric-m2-v1-");
    expect(cacheKey).toContain("${{ runner.os }}-${{ runner.arch }}-${{ matrix.task }}-");
    expect(cacheKey).toContain("apps/android/**/*.gradle*");
    expect(cacheKey).toContain("apps/android/**/gradle-wrapper.properties");
    expect(cacheKey).toContain("apps/android/gradle/libs.versions.toml");
    expect(cacheKey).toContain("apps/android/**/src/test*/**");
    for (const forbiddenDimension of [
      "github.run_id",
      "github.sha",
      "github.ref",
      "github.event.pull_request.number",
    ]) {
      expect(cacheKey).not.toContain(forbiddenDimension);
    }
    expect(String(restoreStep.with?.["restore-keys"]).trim()).toBe(
      "${{ github.repository }}-robolectric-m2-v1-${{ runner.os }}-${{ runner.arch }}-${{ matrix.task }}-",
    );

    expect(configureStep.if).toBe("startsWith(matrix.task, 'test-')");
    expect(configureStep.run).toContain("OPENCLAW_ROBOLECTRIC_M2");
    expect(configureStep.run).toContain("OPENCLAW_ROBOLECTRIC_INIT");
    expect(configureStep.run).toContain(
      'systemProperty "maven.repo.local", System.getenv("OPENCLAW_ROBOLECTRIC_M2")',
    );
    expect(workflowSource).not.toContain("robolectric.dependency.repo.url");

    expect(saveStep).toMatchObject({
      if: "success() && startsWith(matrix.task, 'test-') && needs.preflight.outputs.cache_write_allowed == 'true' && steps.robolectric-cache.outputs.cache-hit != 'true'",
      uses: CACHE_SAVE_V5,
      with: {
        key: "${{ steps.robolectric-cache.outputs.cache-primary-key }}",
        path: "/var/tmp/openclaw-robolectric-m2",
      },
    });

    const taskCases = new Map(
      [...String(runStep.run).matchAll(/^\s{2}([a-z-]+)\)\n([\s\S]*?)^\s{4};;$/gmu)].map(
        (match) => [match[1], match[2]],
      ),
    );
    for (const task of ["test-play", "test-play-compat", "test-third-party", "test-wear"]) {
      expect(taskCases.get(task), task).toContain('--init-script "$OPENCLAW_ROBOLECTRIC_INIT"');
    }
    for (const task of ["build-play", "build-wear", "build-play-compat", "ktlint"]) {
      expect(taskCases.get(task), task).not.toContain("--init-script");
    }
    expect(runStep.run).not.toMatch(/\bsleep\b/u);
    expect(runStep.run).not.toMatch(/\bretry\b/iu);
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

  it("selects every supplemental boundary check exactly once across the CI matrix", () => {
    const job = readCiWorkflow().jobs["check-additional-shard"];
    const step = job.steps.find(
      (entry: WorkflowStep) => entry.name === "Run additional check shard",
    );
    const selector = String(step?.env?.OPENCLAW_ADDITIONAL_BOUNDARY_SHARD ?? "");
    const rows = readFrozenAdditionalCheckRows();
    const selected = rows
      .filter((row) => row.group === "boundaries")
      .flatMap(() => selectChecksForShard(BOUNDARY_CHECKS, selector));
    expect(selected.toSorted((left, right) => left.label.localeCompare(right.label))).toEqual(
      BOUNDARY_CHECKS.toSorted((left, right) => left.label.localeCompare(right.label)),
    );
  });

  it("runs all source checks serially and preserves individual failures", () => {
    const additionalJob = readCiWorkflow().jobs["check-additional-shard"];
    const runStep = additionalJob.steps.find(
      (step: WorkflowStep) => step.name === "Run additional check shard",
    );
    const sessionCommands = [
      "lint:tmp:session-accessor-boundary",
      "lint:tmp:sqlite-transaction-boundary",
      "lint:tmp:session-transcript-reader-boundary",
    ];
    const root = tempDirs.make("openclaw-session-boundary-workflow-");
    const binDir = path.join(root, "bin");
    const callsPath = path.join(root, "pnpm-calls.txt");
    mkdirSync(binDir);
    const pnpmPath = path.join(binDir, "pnpm");
    writeFileSync(
      pnpmPath,
      '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' "$*" >> "$PNPM_CALLS"\nif [[ "${2:-}" == "${PNPM_FAIL:-}" ]]; then exit 1; fi\n',
      "utf8",
    );
    chmodSync(pnpmPath, 0o755);
    const exportScript = path.join(root, "scripts/check-export-name-collisions.mts");
    mkdirSync(path.dirname(exportScript));
    for (const [group, commands] of [
      [
        "source-contracts",
        ["lint:tmp:export-name-collisions", ...sessionCommands, "sqlite:sessions-schema:check"],
      ],
      ["session-accessor-boundary", sessionCommands],
      ["export-name-collisions", ["lint:tmp:export-name-collisions"]],
      ["sqlite-session-schema-baseline", ["sqlite:sessions-schema:check"]],
    ] as const) {
      for (const scenario of [
        { failed: "", missing: "", missingFile: false },
        ...commands.map((failed) => ({ failed, missing: "", missingFile: false })),
        ...(group === "source-contracts"
          ? [
              ...commands.map((missing) => ({ failed: "", missing, missingFile: false })),
              { failed: "", missing: "", missingFile: true },
            ]
          : []),
      ]) {
        const present = commands.filter(
          (command) =>
            command !== scenario.missing &&
            !(scenario.missingFile && command === "lint:tmp:export-name-collisions"),
        );
        if (scenario.missingFile) {
          rmSync(exportScript, { force: true });
        } else {
          writeFileSync(exportScript, "");
        }
        writeFileSync(
          path.join(root, "package.json"),
          JSON.stringify({
            scripts: Object.fromEntries(
              commands
                .filter((command) => command !== scenario.missing)
                .map((command) => [command, "fixture"]),
            ),
          }),
        );
        writeFileSync(callsPath, "");
        const result = runWorkflowShellScript(runStep.run, {
          cwd: root,
          env: {
            ...process.env,
            ADDITIONAL_CHECK_GROUP: group,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
            PNPM_CALLS: callsPath,
            PNPM_FAIL: scenario.failed,
          },
        });
        const context = `${group} ${JSON.stringify(scenario)}\n${result.stdout}${result.stderr}`;
        expect(readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean), context).toEqual(
          present.map((command) => `run ${command}`),
        );
        expect(result.status, context).toBe(scenario.failed ? 1 : 0);
        expect(result.stdout.match(/^::error .+$/gmu) ?? [], context).toEqual(
          scenario.failed
            ? [`::error title=${scenario.failed} failed::${scenario.failed} failed`]
            : [],
        );
        for (const command of present.filter((entry) => entry !== scenario.failed)) {
          expect(result.stdout, context).toContain(`[ok] ${command}`);
        }
        expect(result.stdout.match(/^\[skip\].+$/gmu) ?? [], context).toHaveLength(
          scenario.missing || scenario.missingFile ? 1 : 0,
        );
      }
    }
  });

  it("groups current source checks and allocates SDK reports only for dispatch", () => {
    const workflow = readCiWorkflow();
    const additionalJob = workflow.jobs["check-additional-shard"];
    expect(additionalJob.strategy.matrix).toBe(
      "${{ fromJSON(needs.preflight.outputs.check_additional_matrix) }}",
    );
    expect(workflow.jobs.preflight.outputs.check_additional_matrix).toBe(
      "${{ steps.manifest.outputs.check_additional_matrix }}",
    );
    const frozenGroups = [
      "boundaries",
      "prompt-snapshots",
      "export-name-collisions",
      "session-accessor-boundary",
      "sqlite-session-schema-baseline",
      "plugin-sdk-api-diff",
      "extension-package-boundary",
      "runtime-topology-architecture",
    ];
    for (const [eventName, frozen] of [
      ["push", false],
      ["pull_request", false],
      ["workflow_dispatch", false],
      ["workflow_dispatch", true],
    ] as const) {
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        eventName,
        historicalCompatibility: frozen,
        changedPaths: [],
        scopeEnv: {
          OPENCLAW_CI_CHECKOUT_REVISION: "a".repeat(40),
          OPENCLAW_CI_WORKFLOW_REVISION: (frozen ? "b" : "a").repeat(40),
        },
      });
      expect(manifest.status, manifest.output).toBe(0);
      const rows = JSON.parse(
        expectDefined(manifest.outputs.check_additional_matrix, "additional check matrix"),
      ).include;
      const expectedGroups = frozen
        ? frozenGroups
        : [
            "boundaries",
            "prompt-snapshots",
            "source-contracts",
            ...(eventName === "workflow_dispatch" ? ["plugin-sdk-api-diff"] : []),
            "extension-package-boundary",
            "runtime-topology-architecture",
          ];
      expect(rows.map((row: { group: string }) => row.group)).toEqual(expectedGroups);
      expect(manifest.outputs.run_check_additional).toBe("true");
      for (const row of rows) {
        if (row.group === "source-contracts") {
          expect(row).toEqual({
            check_name: "check-source-contracts",
            group: "source-contracts",
            runner: "blacksmith-4vcpu-ubuntu-2404",
          });
        } else {
          expect(readFrozenAdditionalCheckRows()).toContainEqual(row);
        }
      }
    }
    for (const selection of [{ runNode: false }, { nodeFastOnly: true }]) {
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        eventName: "pull_request",
        changedPaths: [],
        ...selection,
      });
      expect(manifest.status, manifest.output).toBe(0);
      expect(manifest.outputs.run_check_additional).toBe("false");
      expect(
        JSON.parse(
          expectDefined(manifest.outputs.check_additional_matrix, "additional check matrix"),
        ).include,
      ).toEqual([]);
    }

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

    for (const revision of ["base", "head"]) {
      const ensureRevisionStep = additionalJob.steps.find(
        (step: WorkflowStep) => step.name === `Ensure Plugin SDK API diff ${revision} commit`,
      );
      for (const [eventName, group, eligible] of [
        ["pull_request", "plugin-sdk-api-diff", false],
        ["push", "plugin-sdk-api-diff", false],
        ["workflow_dispatch", "plugin-sdk-api-diff", true],
        ["workflow_dispatch", "boundaries", false],
      ] as const) {
        expect(
          evaluateWorkflowExpression(`\${{ ${ensureRevisionStep.if} }}`, {
            eventName,
            matrix: { group },
            repository: "openclaw/openclaw",
            runAttempt: 1,
          }),
          `${revision} preparation for ${eventName}/${group}`,
        ).toBe(eligible);
      }
    }

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
      fail = false,
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
        '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' "$*" >> "$PNPM_CALLS"\nexit "$PNPM_RESULT"\n',
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
          PNPM_RESULT: fail ? "1" : "0",
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
    for (const eventName of ["push", "pull_request"]) {
      const skipped = runCase({ "plugin-sdk:api:diff": "mock" }, false, eventName);
      expect(skipped.result.status, skipped.result.stderr).toBe(0);
      expect(skipped.calls).toEqual([]);
      expect(skipped.result.stdout).toContain("manual and release dispatches only");
    }

    const current = runCase({ "plugin-sdk:api:diff": "mock" }, false);
    expect(current.result.status, current.result.stderr).toBe(0);
    expect(current.calls).toEqual([
      "run plugin-sdk:api:diff -- --base base-sha --head synthetic-head-sha --json .artifacts/plugin-sdk-api-diff.json --summary " +
        current.summaryPath,
    ]);

    const failed = runCase({ "plugin-sdk:api:diff": "mock" }, false, "workflow_dispatch", true);
    expect(failed.result.status, failed.result.stderr).toBe(1);
    expect(failed.calls).toHaveLength(1);
    expect(failed.result.stdout).toContain(
      "::error title=plugin-sdk:api:diff failed::plugin-sdk:api:diff failed",
    );

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

  it("retains fetch deadlines in other standalone workflows", () => {
    const workflowPaths = [[".github/workflows/crabbox-hydrate.yml", "30s"]] as const;

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

  it("owns Docs Agent Git without changing cadence, deadlines, or action authority", () => {
    const source = readFileSync(".github/workflows/docs-agent.yml", "utf8");
    const workflow = parse(source);
    const job = workflow.jobs["update-docs"];
    const steps = job.steps as WorkflowStep[];
    expect(steps.map(({ name }) => name)).toEqual([
      "Checkout",
      "Prepare Git owner",
      "Gate trusted main activity and hourly cadence",
      "Setup Node environment",
      "Ensure docs agent key exists",
      "Run Codex docs agent",
      "Enforce existing-docs-only patch",
      "Restore Node 24 path",
      "Check docs",
      "Commit docs updates",
    ]);
    expect(steps[1]).toEqual({
      name: "Prepare Git owner",
      uses: "openclaw/openclaw/.github/actions/git-owner@dd4528b6393e7d00063067a080ca7241b48ce475",
    });
    expect(steps[0]).toMatchObject({
      uses: CHECKOUT_V6,
      with: {
        ref: "main",
        "fetch-depth": 0,
        "persist-credentials": false,
        submodules: false,
      },
    });
    expect(job["timeout-minutes"]).toBe(30);
    expect(workflow.permissions).toEqual({ actions: "read", contents: "write" });
    expect(workflow.concurrency).toEqual({ group: "docs-agent-main", "cancel-in-progress": false });
    expect(steps[5]).toEqual({
      name: "Run Codex docs agent",
      if: "steps.gate.outputs.run_agent == 'true'",
      uses: "openai/codex-action@52fe01ec70a42f454c9d2ebd47598f9fd6893d56",
      env: {
        DOCS_AGENT_BASE_SHA: "${{ steps.gate.outputs.review_base_sha }}",
        DOCS_AGENT_HEAD_SHA: "${{ steps.gate.outputs.review_head_sha }}",
      },
      with: {
        "openai-api-key":
          "${{ secrets.OPENCLAW_DOCS_AGENT_OPENAI_API_KEY || secrets.OPENAI_API_KEY }}",
        "prompt-file": ".github/codex/prompts/docs-agent.md",
        model: "${{ vars.OPENCLAW_CI_OPENAI_MODEL_BARE }}",
        effort: "medium",
        sandbox: "workspace-write",
        "safety-strategy": "drop-sudo",
        "codex-args": '["--full-auto"]',
      },
    });
    const gate = expectDefined(steps[2]?.run, "gate policy");
    const commit = expectDefined(steps[9]?.run, "commit policy");
    const enforce = expectDefined(steps[6]?.run, "enforcement producers");
    expect(gate.match(/python3 -I -S "\$CI_GIT_OWNER" --policy -/gu)).toHaveLength(2);
    expect(gate.indexOf("--policy -")).toBeLessThan(gate.indexOf("gh api"));
    expect(gate.lastIndexOf("--policy -")).toBeGreaterThan(gate.indexOf("gh api"));
    expect(commit).toContain('exec python3 -I -S "$CI_GIT_OWNER" --policy -');
    for (const policy of [gate, commit]) {
      expect(policy.match(/for attempt in range\(1, 6\):/gu)).toHaveLength(1);
      expect(policy).toContain("except (GitFailure, FetchTimeout):");
      expect(policy).not.toMatch(
        /except (?:Exception|BaseException)|except:|error\.code|\$\?|\|\| true/u,
      );
    }
    expect(gate).toContain(
      'if attempt == 5:\n            print("Failed to fetch main after retries.", file=sys.stderr)\n            raise SystemExit(1)',
    );
    expect(gate.match(/backoff\(attempt \* 2\)/gu)).toHaveLength(1);
    expect(commit.match(/backoff\(attempt \* 2\)/gu)).toHaveLength(2);
    const calls = [
      ...`${gate}\n${commit}`.matchAll(/(?:run_git|git_output)\(([\s\S]*?)\)(?=\.rstrip|\n|$)/gu),
    ].map((match) => match[1]!);
    const fetches = calls.filter((call) => call.startsWith('workspace, "fetch"'));
    expect(fetches).toEqual([
      'workspace, "fetch", "--no-tags", "origin", "main", timeout=120, reclaim_locks=True',
      'workspace, "fetch", "--no-tags", "origin", target, timeout=120, reclaim_locks=True',
    ]);
    expect(calls.filter((call) => call.includes("timeout="))).toEqual(fetches);
    expect(enforce.match(/--checkout-git 0 (?:ls-files|diff)/gu)).toHaveLength(3);
    expect(`${gate}\n${commit}\n${enforce}`).not.toMatch(
      /\btimeout --|\bgit (?:fetch|rev-parse|cat-file|diff|ls-files|config|add|commit|push)\b/u,
    );
    // The corrected REST cadence contract is deliberately byte-stable across Git migration.
    const cadence = source.slice(
      source.indexOf("          runs_json="),
      source.indexOf('          python3 -I -S "$CI_GIT_OWNER" --policy - "$remote_main"'),
    );
    expect(createHash("sha256").update(cadence).digest("hex")).toBe(
      "f130607e377acff6983fc2efaa015025ae2865d340dfad1fb865ee61e081f83e",
    );
  });

  it("owns docs mirror Git lifecycle without changing transport or stale-source policy", () => {
    const source = readFileSync(".github/workflows/docs-sync-publish.yml", "utf8");
    const workflow = parse(source);
    const steps = workflow.jobs["sync-publish-repo"].steps as WorkflowStep[];
    expect(steps.map(({ name }) => name)).toEqual([
      "Skip publish sync without token",
      "Checkout source repo",
      "Checkout ClawHub docs source",
      "Prepare Git owner",
      "Setup Node",
      "Clone publish repo",
      "Sync docs into publish repo",
      "Install docs MDX checker dependency",
      "Check publish docs MDX",
      "Commit publish repo sync",
    ]);
    expect(steps[3]).toEqual({
      name: "Prepare Git owner",
      if: "env.OPENCLAW_DOCS_SYNC_TOKEN != ''",
      uses: "openclaw/openclaw/.github/actions/git-owner@dd4528b6393e7d00063067a080ca7241b48ce475",
    });
    expect(steps[1]).toMatchObject({ with: { "fetch-depth": 0 } });
    expect(steps[2]).toMatchObject({
      with: {
        repository: "openclaw/clawhub",
        ref: "main",
        path: "clawhub-source",
        "fetch-depth": 1,
        "persist-credentials": false,
      },
    });
    expect(steps.slice(1).every((step) => step.if === "env.OPENCLAW_DOCS_SYNC_TOKEN != ''")).toBe(
      true,
    );
    expect(source).not.toContain("setup-python");
    expect(workflow.concurrency).toEqual({
      group:
        "docs-sync-publish-${{ github.event_name == 'workflow_dispatch' && format('manual-{0}', github.run_id) || github.ref }}",
      "cancel-in-progress": false,
    });
    const clone = expectDefined(steps[5]?.run, "clone policy");
    const sync = expectDefined(steps[6]?.run, "sync body");
    const publish = expectDefined(steps[9]?.run, "publication policy");
    expect(steps[9]?.["working-directory"]).toBe("publish");
    for (const policy of [clone, publish]) {
      expect(
        policy.startsWith(
          "set -euo pipefail\nexec python3 -I -S \"$CI_GIT_OWNER\" --policy - <<'PYTHON'\n",
        ),
      ).toBe(true);
      expect(policy.match(/for attempt in range\(1, 6\):/gu)).toHaveLength(1);
      expect(policy.match(/backoff\(attempt \* 2\)/gu)).toHaveLength(1);
      expect(policy).toContain("except (GitFailure, FetchTimeout):");
      expect(policy).not.toMatch(
        /except (?:Exception|BaseException)|except:|error\.code|\$\?|\|\| true/u,
      );
    }
    expect(clone).toContain('publish = os.path.join(workspace, "publish")');
    expect(clone).toContain('subprocess.run(["rm", "-rf", publish], check=True)');
    expect(clone).toContain(
      "https://x-access-token:{os.environ['OPENCLAW_DOCS_SYNC_TOKEN']}@github.com/openclaw/docs.git",
    );
    const calls = [...`${clone}\n${publish}`.matchAll(/run_git\(([\s\S]*?)\)(?=\n|$)/gu)].map(
      (match) => match[1]!,
    );
    const transports = calls.filter((call) => /^\w+, "(?:clone|fetch)"/u.test(call));
    expect(transports).toHaveLength(3);
    expect(transports.every((call) => call.includes("timeout=120"))).toBe(true);
    expect(transports.slice(1)).toEqual(
      Array(2).fill(
        'publish, "fetch", "origin", "main:refs/remotes/origin/main", timeout=120, reclaim_locks=True',
      ),
    );
    expect(calls.filter((call) => call.includes("timeout="))).toEqual(transports);
    expect(calls.filter((call) => /^publish, "(?:rebase|push)"/u.test(call))).toHaveLength(3);
    expect(
      calls
        .filter((call) => /^publish, "(?:config|add|commit|rebase|push)"/u.test(call))
        .every((call) => call.includes("reclaim_locks=True")),
    ).toBe(true);
    expect(publish).toContain("if not current_source_sha or current_source_sha == source_sha:");
    expect(publish).toContain(
      'run_git(workspace, "merge-base", "--is-ancestor", source_sha, current_source_sha)',
    );
    expect(publish).toContain("except (GitFailure, json.JSONDecodeError):");
    expect(sync.startsWith("set -euo pipefail\n")).toBe(true);
    expect(sync).toContain(
      'clawhub_sha="$(cd "$GITHUB_WORKSPACE/clawhub-source" && python3 -I -S "$CI_GIT_OWNER" --checkout-git 0 rev-parse HEAD)"\nnode scripts/docs-sync-publish.mjs',
    );
    expect([clone, sync, publish].join("\n")).not.toMatch(
      /\btimeout --|\bgit (?:clone|fetch|show|merge-base|diff|config|add|commit|rebase|push|rev-parse)\b|--depth|--no-tags/u,
    );
  });

  it("pins plugin publication owners before selected checkout and preserves Git deadlines", () => {
    const owner = {
      name: "Prepare Git owner",
      uses: "openclaw/openclaw/.github/actions/git-owner@dd4528b6393e7d00063067a080ca7241b48ce475",
    };
    const clawhub = parse(readFileSync(".github/workflows/plugin-clawhub-release.yml", "utf8"));
    const npm = parse(readFileSync(".github/workflows/plugin-npm-release.yml", "utf8"));
    for (const [workflow, jobName, checkoutName] of [
      [clawhub, "preview_plugins_clawhub", "Checkout"],
      [npm, "preview_plugins_npm", "Checkout"],
      [npm, "verify_plugin_npm_preflight", "Checkout trusted npm preflight tooling"],
      [npm, "publish_plugins_npm", "Checkout trusted publication tooling"],
    ] as const) {
      const steps = workflow.jobs[jobName].steps as WorkflowStep[];
      expect(steps[0], jobName).toEqual(owner);
      expect(steps[1]?.name, jobName).toBe(checkoutName);
      const body = steps
        .map(({ run }) => run ?? "")
        .join("\n")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
      const calls = [...body.matchAll(/(?:run_git|git_output)\(([\s\S]*?)\)(?=\.|\n|$)/gu)].map(
        (match) => match[1]!,
      );
      const transports = calls.filter((call) => /^\s*workspace,\s*"(?:fetch|show)",/u.test(call));
      expect(transports.length, jobName).toBeGreaterThan(0);
      for (const call of transports) {
        expect(call, jobName).toMatch(/\btimeout\s*=\s*120\b/u);
      }
      expect(body, jobName).not.toMatch(
        /timeout[^\n]*git|(?:^|\s)git (?:fetch|rev-parse|merge-base|for-each-ref|checkout|show)\b/mu,
      );
      expect(body, jobName).not.toMatch(/backoff\(|for attempt in range/u);
    }
    for (const stepName of [
      "Read exact npm preflight source package",
      "Read exact npm publication source package",
    ]) {
      const step = [
        ...npm.jobs.verify_plugin_npm_preflight.steps,
        ...npm.jobs.publish_plugins_npm.steps,
      ].find(({ name }: WorkflowStep) => name === stepName) as WorkflowStep;
      expect(step.run, stepName).toContain("git_output(");
      expect(step.run, stepName).toContain('errors="surrogateescape"');
    }
  });

  it("pins the Mantis Git owner and preserves distinct terminal ref-validation contracts", () => {
    const action = parse(
      readFileSync(".github/actions/mantis-validate-trusted-ref/action.yml", "utf8"),
    );
    const workflow = parse(readFileSync(".github/workflows/mantis-discord-smoke.yml", "utf8"));
    const owner = {
      name: "Prepare Git owner",
      uses: "openclaw/openclaw/.github/actions/git-owner@dd4528b6393e7d00063067a080ca7241b48ce475",
    };
    const actionSteps = action.runs.steps as WorkflowStep[];
    const discordSteps = workflow.jobs.validate_selected_ref.steps as WorkflowStep[];
    expect(actionSteps.map(({ name }) => name)).toEqual([
      "Prepare Git owner",
      "Validate refs are trusted",
    ]);
    expect(actionSteps[0]).toEqual(owner);
    expect(discordSteps.map(({ name }) => name)).toEqual([
      "Prepare Git owner",
      "Checkout selected ref",
      "Validate selected ref",
    ]);
    expect(discordSteps[0]).toEqual(owner);
    expect(discordSteps[1]).toMatchObject({
      uses: CHECKOUT_V6,
      with: { "persist-credentials": false, ref: "${{ inputs.ref }}", "fetch-depth": 0 },
    });
    expect(Object.keys(action.inputs)).toEqual(["candidate-ref", "baseline-ref"]);
    expect(Object.keys(action.outputs)).toEqual(["candidate-revision", "baseline-revision"]);
    for (const [steps, shared] of [
      [actionSteps, true],
      [discordSteps, false],
    ] as const) {
      const run = expectDefined(steps.at(-1)?.run, "Mantis validation body");
      const revision = shared ? "revision" : "selected_revision";
      const prefix = `python3 -I -S "$CI_GIT_OWNER" --checkout-git ${shared ? 0 : 120} fetch --no-tags origin `;
      expect(run.startsWith("set -euo pipefail\n")).toBe(true);
      expect(
        run
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => /\bfetch\b/u.test(line)),
      ).toEqual([
        `${prefix}+refs/heads/main:refs/remotes/origin/main`,
        ...(shared
          ? []
          : [`${prefix}"+refs/heads/\${INPUT_REF}:refs/remotes/origin/\${INPUT_REF}"`]),
      ]);
      expect(run).not.toMatch(/\bgit fetch\b|^\s*(?:timeout|for|while|until)\b|\$\?/mu);
      expect(
        run.match(
          /(?:reason|trusted_reason)="(?:main-ancestor|release-tag|release-branch-head|open-pr-head)"/gu,
        ),
      ).toEqual(
        [
          "main-ancestor",
          "release-tag",
          ...(shared ? [] : ["release-branch-head"]),
          "open-pr-head",
        ].map((reason) => `${shared ? "reason" : "trusted_reason"}="${reason}"`),
      );
      expect(run).toContain(`git tag --points-at "$${revision}" | grep -Eq '^v'`);
      expect(run).toContain("gh api \\\n");
      expect(run).toContain('-H "Accept: application/vnd.github+json"');
      expect(run).toContain(`"repos/\${GITHUB_REPOSITORY}/commits/\${${revision}}/pulls"`);
      expect(run).toContain(
        `select(.state == "open" and .head.repo.full_name == "'"\${GITHUB_REPOSITORY}"'" and .head.sha == "'"\${${revision}}"'")] | length`,
      );
      if (shared) {
        expect(run).toContain('echo "${label}_revision=${revision}" >> "$GITHUB_OUTPUT"');
        expect(run).toContain(
          'validate_ref baseline "$BASELINE_REF"\nfi\nvalidate_ref candidate "$CANDIDATE_REF"',
        );
      } else {
        expect(run).toContain(
          'elif [[ "$INPUT_REF" =~ ^release/[0-9]{4}\\.[0-9]+\\.[0-9]+$ ]]; then',
        );
        expect(run).toContain(
          'release_branch_sha="$(git rev-parse "refs/remotes/origin/${INPUT_REF}")"',
        );
        expect(run).toContain(
          'if [[ "$selected_revision" == "$release_branch_sha" ]]; then\n    trusted_reason="release-branch-head"\n  fi\nelse\n  pr_head_count=',
        );
        expect(run).toContain(
          'echo "selected_revision=$selected_revision" >> "$GITHUB_OUTPUT"\necho "trusted_reason=$trusted_reason" >> "$GITHUB_OUTPUT"',
        );
      }
    }
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

  it.each(MANTIS_MANUAL_ONLY_WORKFLOWS)(
    "keeps legacy Mantis scenarios on manual dispatch in %s",
    (workflowPath) => {
      const workflow = parse(readFileSync(workflowPath, "utf8"));

      expect(workflow.on.workflow_dispatch, workflowPath).toBeDefined();
      expect(workflow.on.issue_comment, workflowPath).toBeUndefined();
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

  it("checks the generated Git owner in the workflow guard lane", () => {
    const check = spawnSync(process.execPath, ["scripts/generate-ci-git-owner.mts", "--check"], {
      encoding: "utf8",
    });
    expect(check.status, check.stderr).toBe(0);
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
    expect(checkoutStep.with["persist-credentials"]).toBe(false);
    for (const eventName of ["push", "workflow_dispatch"] as const) {
      expect(
        evaluateWorkflowExpression(checkoutStep.with["fetch-depth"], {
          eventName,
          repository: "openclaw/openclaw",
          runAttempt: 1,
          steps: { checkout_depth: { outputs: {} } },
        }),
      ).toBe(2);
    }
    expect(manualCheckoutStep.if).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.target_ref != ''",
    );
    expect(manualCheckoutStep.run).toContain("workflow_dispatch target_ref");
  });

  it("uses native preflight tooling unless a dispatch selects a different revision", () => {
    const workflow = readCiWorkflow();
    const steps = workflow.jobs.preflight.steps as WorkflowStep[];
    const setupPnpm = expectDefined(
      steps.find((step) => step.name === "Setup manifest pnpm"),
      "manifest pnpm setup",
    );
    const installDependencies = expectDefined(
      steps.find((step) => step.name === "Install manifest dependencies"),
      "manifest dependency install",
    );
    const buildManifest = expectDefined(
      steps.find((step) => step.name === "Build CI manifest"),
      "manifest builder",
    );
    const checkProtocolCoverage = expectDefined(
      steps.find((step) => step.name === "Check mobile protocol event coverage"),
      "protocol coverage owner",
    );
    const workflowSha = "a".repeat(40);
    const otherSha = "b".repeat(40);
    const cases = [
      ["same-revision dispatch", "workflow_dispatch", workflowSha, "", false, false],
      [
        "same-revision explicit target dispatch",
        "workflow_dispatch",
        workflowSha,
        workflowSha,
        false,
        false,
      ],
      ["same-revision release gate", "workflow_dispatch", workflowSha, workflowSha, true, false],
      ["push", "push", otherSha, "", false, false],
      ["pull request", "pull_request", otherSha, "", false, false],
      ["different-revision dispatch", "workflow_dispatch", otherSha, otherSha, false, true],
      ["different-revision release gate", "workflow_dispatch", otherSha, otherSha, true, true],
    ] as const;

    for (const [
      label,
      eventName,
      checkoutRevision,
      targetRef,
      releaseGate,
      usesCompatibilityTooling,
    ] of cases) {
      const context = {
        eventName,
        releaseGate,
        repository: "openclaw/openclaw",
        runAttempt: 1,
        steps: { checkout_ref: { outputs: { sha: checkoutRevision } } },
        targetRef,
        workflowSha,
      };
      const evaluateStep = (step: WorkflowStep) =>
        evaluateWorkflowExpression(`\${{ ${step.if} }}`, context);
      expect([evaluateStep(setupPnpm), evaluateStep(installDependencies)], label).toEqual([
        usesCompatibilityTooling,
        usesCompatibilityTooling,
      ]);
      const invocationOptions = (step: WorkflowStep) => ({
        checkoutRevision: String(
          evaluateWorkflowExpression(step.env?.OPENCLAW_CI_CHECKOUT_REVISION, context),
        ),
        eventName,
        workflowRevision: String(
          evaluateWorkflowExpression(step.env?.OPENCLAW_CI_WORKFLOW_REVISION, context),
        ),
      });
      expect(
        runPreflightNodeInvocation(
          expectDefined(buildManifest.run, "manifest script"),
          invocationOptions(buildManifest),
        ),
        label,
      ).toEqual(
        usesCompatibilityTooling
          ? ["--import", "tsx", "--input-type=module"]
          : ["--input-type=module"],
      );
      expect(
        runPreflightNodeInvocation(
          expectDefined(checkProtocolCoverage.run, "protocol coverage script"),
          invocationOptions(checkProtocolCoverage),
        ),
        label,
      ).toEqual([
        usesCompatibilityTooling
          ? "scripts/check-protocol-event-coverage.mjs"
          : "scripts/check-protocol-event-coverage.mts",
      ]);
    }
  });

  it("keeps manual candidates separate from trusted cache authority", () => {
    const workflow = readCiWorkflow();
    const preflight = workflow.jobs.preflight;
    const checkoutStep = expectDefined(
      preflight.steps.find((step: WorkflowStep) => step.name === "Checkout"),
      "preflight checkout owner",
    );
    expect(checkoutStep.env?.WORKFLOW_SHA).toBe("${{ github.workflow_sha }}");
    const harnessSteps = preflight.steps.filter(
      (step: WorkflowStep) =>
        step.uses?.startsWith("actions/checkout@") && step.with?.path === ".ci-harness",
    );
    expect(harnessSteps).toHaveLength(1);
    const harnessStep = expectDefined(harnessSteps[0], "different-revision harness checkout");
    expect(harnessStep).toMatchObject({
      uses: CHECKOUT_V6,
      with: {
        ref: "${{ github.workflow_sha }}",
        path: ".ci-harness",
        "sparse-checkout":
          "/.github/actions/\n/scripts/lib/release-context.mjs\n/scripts/lib/release-version.mjs\n",
        "sparse-checkout-cone-mode": false,
        "persist-credentials": false,
      },
    });
    const resolvedIndex = preflight.steps.findIndex(
      (step: WorkflowStep) => step.id === "checkout_ref",
    );
    const harnessIndex = preflight.steps.indexOf(harnessStep);
    const consumerIndex = preflight.steps.findIndex((step: WorkflowStep) =>
      step.uses?.startsWith("./.ci-harness/"),
    );
    expect(preflight.steps.indexOf(checkoutStep)).toBeLessThan(resolvedIndex);
    expect(resolvedIndex).toBeLessThan(harnessIndex);
    expect(harnessIndex).toBeLessThan(consumerIndex);
    const workflowSha = "a".repeat(40);
    for (const eventName of ["push", "pull_request", "workflow_dispatch"] as const) {
      for (const headRepository of ["openclaw/openclaw", "contributor/openclaw"]) {
        for (const selectedSha of [workflowSha, "b".repeat(40)]) {
          expect(
            evaluateWorkflowExpression(harnessStep.if, {
              eventName,
              headRepository,
              repository: "openclaw/openclaw",
              runAttempt: 1,
              steps: { checkout_ref: { outputs: { sha: selectedSha } } },
              workflowSha,
            }),
          ).toBe(selectedSha !== workflowSha);
        }
      }
    }
    const trustStep = expectDefined(
      preflight.steps.find((step: WorkflowStep) => step.name === "Classify candidate cache trust"),
      "candidate cache trust step",
    );
    const nativeCheckout = expectDefined(
      workflow.jobs["native-i18n"].steps.find((step: WorkflowStep) => step.name === "Checkout"),
      "native i18n checkout",
    );

    expect(preflight.outputs).toMatchObject({
      candidate_trust: "${{ steps.candidate_trust.outputs.trust }}",
      cache_mode: "${{ steps.candidate_trust.outputs.cache_mode }}",
      cache_write_allowed: "${{ steps.candidate_trust.outputs.cache_write_allowed }}",
    });
    expect(trustStep.env).toMatchObject({
      CHECKOUT_REVISION: "${{ steps.checkout_ref.outputs.sha }}",
      DEFAULT_SHA: "${{ steps.diff_base.outputs.default_sha }}",
      TARGET_REF: "${{ inputs.target_ref }}",
      WORKFLOW_REVISION: "${{ github.workflow_sha }}",
    });
    expect(trustStep.run).toContain("trust=untrusted");
    expect(trustStep.run).toContain("cache_mode=off");
    expect(trustStep.run).toContain("cache_write_allowed=false");
    expect(trustStep.run).toContain('elif [[ "$GITHUB_EVENT_NAME" == "workflow_dispatch" ]]');
    expect(trustStep.run).toContain('"$RELEASE_GATE" == "true"');
    expect(trustStep.run).toContain('"$CHECKOUT_REVISION" == "$DEFAULT_SHA"');
    expect(trustStep.run).toContain('"$CHECKOUT_REVISION" == "$WORKFLOW_REVISION"');
    expect(trustStep.run).toContain("cache_write_allowed=true");

    const ciLocalActions = Object.values(workflow.jobs).flatMap(
      (job) =>
        (job as { steps?: WorkflowStep[] }).steps?.filter((step) =>
          step.uses?.includes("/.github/actions/"),
        ) ?? [],
    );
    expect(ciLocalActions.length).toBeGreaterThan(0);
    for (const step of ciLocalActions) {
      expect(step.uses, step.name).toContain("./.ci-harness/.github/actions/");
    }

    expect(nativeCheckout.uses).toBeUndefined();
    expect(nativeCheckout.env).toMatchObject({
      CHECKOUT_SHA: "${{ needs.preflight.outputs.checkout_revision }}",
      WORKFLOW_SHA: "${{ github.workflow_sha }}",
    });

    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      for (const step of (job as { steps?: WorkflowStep[] }).steps ?? []) {
        if (step.uses?.startsWith("actions/cache/restore@")) {
          expect(String(step.if), `${jobName}: ${step.name}`).toContain(
            "preflight.outputs.cache_mode != 'off'",
          );
        }
        if (step.uses?.startsWith("actions/cache/save@")) {
          expect(String(step.if), `${jobName}: ${step.name}`).toContain(
            "preflight.outputs.cache_write_allowed == 'true'",
          );
        }
      }
    }

    const goSetup = expectDefined(
      workflow.jobs["checks-node-core-test-nondist-shard"].steps.find(
        (step: WorkflowStep) => step.name === "Setup Go for docs i18n",
      ),
      "docs i18n Go setup",
    );
    expect(goSetup.with?.cache).toBe(false);
  });

  it("classifies cache write authority from proven candidate identity", () => {
    const workflowRevision = "a".repeat(40);
    const defaultRevision = "b".repeat(40);
    const arbitraryRevision = "c".repeat(40);
    const cases = [
      {
        expected: { cache_mode: "off", cache_write_allowed: "false", trust: "untrusted" },
        options: {
          checkoutRevision: arbitraryRevision,
          eventName: "workflow_dispatch" as const,
          targetRef: arbitraryRevision,
          workflowRevision,
        },
      },
      {
        expected: { cache_mode: "restore", cache_write_allowed: "false", trust: "workflow" },
        options: {
          checkoutRevision: workflowRevision,
          eventName: "workflow_dispatch" as const,
          workflowRevision,
        },
      },
      {
        expected: { cache_mode: "restore", cache_write_allowed: "true", trust: "main" },
        options: {
          checkoutRevision: defaultRevision,
          defaultRevision,
          eventName: "workflow_dispatch" as const,
          targetRef: defaultRevision,
          workflowRevision,
        },
      },
      {
        expected: { cache_mode: "restore", cache_write_allowed: "true", trust: "release" },
        options: {
          checkoutRevision: arbitraryRevision,
          eventName: "workflow_dispatch" as const,
          targetContextTarget: true,
          targetRef: arbitraryRevision,
          workflowRevision,
        },
      },
      {
        expected: {
          cache_mode: "restore",
          cache_write_allowed: "false",
          trust: "pull-request",
        },
        options: {
          checkoutRevision: arbitraryRevision,
          eventName: "workflow_dispatch" as const,
          releaseGate: true,
          targetRef: arbitraryRevision,
          workflowRevision,
        },
      },
      {
        expected: {
          cache_mode: "restore",
          cache_write_allowed: "false",
          trust: "pull-request",
        },
        options: {
          checkoutRevision: arbitraryRevision,
          eventName: "pull_request" as const,
          workflowRevision,
        },
      },
      {
        expected: { cache_mode: "restore", cache_write_allowed: "true", trust: "main" },
        options: {
          checkoutRevision: defaultRevision,
          eventName: "push" as const,
          ref: "refs/heads/main",
          workflowRevision,
        },
      },
    ];

    for (const testCase of cases) {
      const result = runCandidateTrustClassification(testCase.options);
      expect(result.status, result.output).toBe(0);
      expect(result.outputs).toMatchObject(testCase.expected);
    }
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

  it("pins workflow sanity's typed Git policy after Python setup", () => {
    const steps: WorkflowStep[] = readWorkflowSanityWorkflow().jobs.actionlint.steps;
    const python = expectDefined(
      steps.find((step) => step.name === "Setup Python"),
      "Python",
    );
    const owner = expectDefined(
      steps.find((step) => step.name === "Prepare Git owner"),
      "owner",
    );
    const policy = expectDefined(
      steps.find((step) => step.name === "Prepare trusted workflow audit configs"),
      "policy",
    );
    expect(python.with).toEqual({ "python-version": "3.12" });
    expect(owner.uses).toBe(
      "openclaw/openclaw/.github/actions/git-owner@dd4528b6393e7d00063067a080ca7241b48ce475",
    );
    expect(owner.with).toBeUndefined();
    expect(steps.indexOf(python)).toBeLessThan(steps.indexOf(owner));
    expect(steps.indexOf(owner)).toBeLessThan(steps.indexOf(policy));
    expect(policy.if).toBe("github.event_name == 'pull_request'");
    expect(policy.env).toEqual({
      BASE_REF: "${{ github.event.pull_request.base.ref }}",
      BASE_SHA: "${{ github.event.pull_request.base.sha }}",
    });
    expect(policy.run).toContain("exec python3 -I -S \"$CI_GIT_OWNER\" --policy - <<'PYTHON'");
    expect(policy.run).not.toMatch(
      /timeout --|fetch_status|fetch_base_ref|sleep 5|subprocess\.PIPE|except (?:Exception|BaseException|SystemExit|RuntimeError)/u,
    );
    expect(policy.run?.match(/timeout=\d+/gu)).toEqual(["timeout=30"]);
    expect(policy.run).toContain("range(1, 4)");
    expect(policy.run).toContain("backoff(5)");
    for (const contract of [
      "--no-tags",
      "--depth=1",
      "reclaim_locks=True",
      "refs/remotes/origin/security-base",
      "refs/heads/",
      ".pre-commit-config.yaml",
      ".github/zizmor.yml",
      "pre-commit-base.yaml",
      "zizmor-base.yml",
      "PRE_COMMIT_CONFIG_PATH=",
    ]) {
      expect(policy.run).toContain(contract);
    }
    const audit = expectDefined(
      steps.find((step) => step.name === "Audit all workflows with zizmor"),
      "audit",
    );
    expect(audit.run).toContain(
      'pre-commit run --config "${PRE_COMMIT_CONFIG_PATH:-.pre-commit-config.yaml}" zizmor',
    );
  });

  it("prepares Testbox checkouts with one maintained owner and scoped history", () => {
    const workflowPaths = [
      [
        ".github/workflows/ci-check-testbox.yml",
        "1",
        "${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || 'HEAD' }}",
        "1.27.0",
      ],
      [
        ".github/workflows/ci-check-arm-testbox.yml",
        "0",
        "${{ github.event.pull_request.base.sha || 'refs/remotes/origin/main' }}",
        "1.27.0",
      ],
      [
        ".github/workflows/ci-build-artifacts-testbox.yml",
        "0",
        "${{ github.event.pull_request.base.sha || 'refs/remotes/origin/main' }}",
        undefined,
      ],
    ] as const;

    for (const [workflowPath, dispatchFetchDepth, baseRef, goVersion] of workflowPaths) {
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
      expect(prepareStep?.with?.["go-version"], workflowPath).toBe(goVersion);
      const ensureBaseStep = job.steps.find(
        (step: WorkflowStep) => step.name === "Ensure Testbox base commit",
      );
      expect(ensureBaseStep, workflowPath).toBeUndefined();
      expect(JSON.stringify(job.steps), workflowPath).not.toContain(
        "+refs/heads/main:refs/remotes/origin/main",
      );
    }

    const action = parse(readFileSync(".github/actions/prepare-testbox-shell/action.yml", "utf8"));
    expect(action.inputs["go-version"]).toMatchObject({ required: false });
    const setupGo = expectDefined(
      action.runs.steps.find((step: WorkflowStep) => step.uses === SETUP_GO_V6),
      "Testbox Go setup",
    );
    expect(setupGo).toMatchObject({
      if: "inputs.go-version != ''",
      with: {
        cache: false,
        "go-version": "${{ inputs.go-version }}",
      },
    });
    const exposeGo = expectDefined(
      action.runs.steps.find((step: WorkflowStep) => step.name === "Expose Go tools"),
      "Testbox Go exposure",
    );
    expect(exposeGo.if).toBe("inputs.go-version != ''");
    expect(exposeGo.run).toContain('test "$(go env GOVERSION)" = "go${TESTBOX_GO_VERSION}"');
    expect(exposeGo.run).toContain('go_root="$(go env GOROOT)"');
    expect(exposeGo.run).toContain("for tool in go gofmt; do");
    expect(exposeGo.run).toContain('"/usr/local/bin/$tool"');
    const prepare = expectDefined(
      action.runs.steps.find(
        (step: WorkflowStep) => step.name === "Pin Testbox base and Node tools",
      ),
      "Testbox base preparation",
    );
    const run = prepare.run as string;
    expect(run).toContain('base_ref="${TESTBOX_BASE_REF:-HEAD}"');
    expect(run).toContain('git rev-parse --verify "${base_ref}^{commit}"');
    expect(run).toContain('git update-ref refs/remotes/origin/main "$base_sha"');
    expect(run).not.toContain("git fetch");
  });

  it("bounds the workflow sanity ShellCheck download", () => {
    const workflow = readWorkflowSanityWorkflow();
    const shellcheckStep = expectDefined(
      workflow.jobs.actionlint.steps.find(
        (step: WorkflowStep) => step.name === "Install ShellCheck",
      ),
      "ShellCheck install step",
    );
    expect(shellcheckStep.run).toContain("curl --connect-timeout 10 --max-time 120");
    expect(shellcheckStep.run).toContain("--retry 5 --retry-delay 2 --retry-all-errors");
  });

  it("pins workflow and pre-commit actionlint to the large-stdin deadlock fix", () => {
    const revision = "011a6d15e749bb3f2d771eed9c7aa0e7e3e10ee7";
    const steps: WorkflowStep[] = readWorkflowSanityWorkflow().jobs.actionlint.steps;
    const setupGo = expectDefined(
      steps.find((step) => step.uses === SETUP_GO_V6),
      "Go setup",
    );
    const install = expectDefined(
      steps.find((step) => step.name === "Install actionlint"),
      "actionlint install",
    );

    expect(setupGo.with).toEqual({ "go-version": "1.25.0", cache: false });
    expect(steps.indexOf(setupGo)).toBeLessThan(steps.indexOf(install));
    expect(install.run).toContain(`ACTIONLINT_REVISION="${revision}"`);
    expect(install.run).toContain('export GOBIN="$RUNNER_TEMP/actionlint-bin"');
    expect(install.run).toContain(
      'go install "github.com/rhysd/actionlint/cmd/actionlint@${ACTIONLINT_REVISION}"',
    );
    expect(install.run).toContain('"$GOBIN/actionlint" -version');
    expect(install.run).toContain("v1.7.13-0.20260419144658-${ACTIONLINT_REVISION:0:12}");
    expect(install.run).toContain('echo "$GOBIN" >> "$GITHUB_PATH"');
    const preCommit = parse(readFileSync(".pre-commit-config.yaml", "utf8"));
    expect(
      preCommit.repos.find(
        (repo: { repo: string }) => repo.repo === "https://github.com/rhysd/actionlint",
      ).rev,
    ).toBe(revision);
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

  it("shares checkout ownership across Linux and native platforms with their existing budgets", () => {
    const source = readFileSync(".github/workflows/ci.yml", "utf8");
    const workflow = readCiWorkflow();

    expect(source.match(/&platform_checkout_step/gu) ?? []).toHaveLength(1);
    expect(source.match(/\*platform_checkout_step/gu) ?? []).toHaveLength(4);
    expect(source.match(/&owned_checkout_run/gu) ?? []).toHaveLength(1);
    const linuxCheckout = workflow.jobs["checks-fast-core"].steps.find(
      (step: WorkflowStep) => step.name === "Checkout",
    );
    for (const runner of ["Linux", "macOS", "Windows"]) {
      const defaults = spawnSync(
        process.platform === "win32" ? "python" : "python3",
        [
          "-I",
          "-S",
          "-c",
          'import json,runpy; owner=runpy.run_path(".github/actions/git-owner/owner.py"); print(json.dumps([owner["fetch_timeout_seconds"], owner["cleanup_seconds"]]))',
        ],
        { encoding: "utf8", env: { ...process.env, RUNNER_OS: runner } },
      );
      expect(defaults.status, defaults.stderr).toBe(0);
      expect(JSON.parse(defaults.stdout)).toEqual([runner === "Linux" ? 120 : 90, 10]);
    }

    for (const jobName of [
      "checks-windows",
      "macos-node",
      "macos-swift",
      "ios-build",
      "ios-screenshot-shard",
    ]) {
      const checkoutStep = workflow.jobs[jobName].steps.find(
        (step: WorkflowStep) => step.name === "Checkout",
      );

      expect(checkoutStep.run, jobName).toBe(linuxCheckout.run);
      expect(checkoutStep.env, jobName).toEqual(linuxCheckout.env);
      // Bootstrap cannot load Python startup code from the candidate checkout.
      expect(checkoutStep.run, jobName).toContain('exec "$python_command" -I -S -');
    }

    const macosNodeSetup = workflow.jobs["macos-node"].steps.find(
      (step: WorkflowStep) => step.name === "Setup Node environment",
    );
    expect(macosNodeSetup.with).toMatchObject({
      "cache-mode": "${{ needs.preflight.outputs.cache_mode }}",
      "install-bun": "false",
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

  it("prepares offline Apple assets before CI opens a macOS SwiftPM graph", () => {
    for (const [workflowPath, jobName] of [
      [".github/workflows/ci.yml", "macos-swift"],
      [".github/workflows/codeql-macos-critical-security.yml", "macos"],
      [".github/workflows/macos-periphery.yml", "scan"],
      [".github/workflows/shared-openclawkit-periphery.yml", "scan-macos"],
    ] as const) {
      const workflow = parse(readFileSync(workflowPath, "utf8"));
      const steps = workflow.jobs[jobName].steps as WorkflowStep[];
      const setupIndex = steps.findIndex((step) => step.uses?.endsWith("/setup-node-env"));
      const prepareIndex = steps.findIndex((step) =>
        step.run?.includes("node scripts/prepare-apple-mermaid.mjs"),
      );
      const graphIndex = steps.findIndex((step) =>
        /swift (?:build|package)|periphery scan/u.test(step.run ?? ""),
      );

      const setupStep = expectDefined(steps[setupIndex], `${workflowPath}: dependency setup`);
      expect(setupStep.with?.["install-deps"]).not.toBe("false");
      expect(prepareIndex, `${workflowPath}: resource preparation`).toBeGreaterThan(setupIndex);
      expect(graphIndex, `${workflowPath}: SwiftPM graph`).toBeGreaterThan(prepareIndex);
    }
  });

  it.each([
    { historical: false, helperPresent: true, expectedStatus: 0 },
    { historical: true, helperPresent: false, expectedStatus: 0 },
    { historical: false, helperPresent: false, expectedStatus: 1 },
  ])(
    "preserves the Apple asset contract for $historical historical / $helperPresent helper",
    (testCase) => {
      const steps = readCiWorkflow().jobs["macos-swift"].steps as WorkflowStep[];
      const step = expectDefined(
        steps.find((candidate) =>
          candidate.run?.includes("node scripts/prepare-apple-mermaid.mjs"),
        ),
        "Apple asset preparation step",
      );
      const root = tempDirs.make("openclaw-apple-assets-workflow-");
      const marker = path.join(root, "prepared");
      if (testCase.helperPresent) {
        mkdirSync(path.join(root, "scripts"));
        writeFileSync(
          path.join(root, "scripts/prepare-apple-mermaid.mjs"),
          'import { writeFileSync } from "node:fs"; writeFileSync("prepared", "ready");',
        );
      }
      const result = runWorkflowShellScript(expectDefined(step.run, "asset preparation script"), {
        cwd: root,
        env: { ...process.env, HISTORICAL_TARGET: String(testCase.historical) },
      });

      expect(result.status, result.stderr).toBe(testCase.expectedStatus);
      expect(existsSync(marker)).toBe(testCase.helperPresent);
    },
  );

  it.each([
    { historical: false, hasWatchRtc: true, expected: true },
    { historical: false, hasWatchRtc: false, expected: true },
    { historical: true, hasWatchRtc: true, expected: true },
    { historical: true, hasWatchRtc: false, expected: false },
  ])("prepares Watch RTC by source capability: %j", ({ historical, hasWatchRtc, expected }) => {
    const workflow = readCiWorkflow();
    for (const jobName of ["ios-build", "ios-screenshot-shard"]) {
      const install = workflow.jobs[jobName].steps.find(
        (step: WorkflowStep) => step.name === "Install Watch Rust toolchain",
      );
      const engine = workflow.jobs["ios-build"].steps.find(
        (step: WorkflowStep) => step.name === "Test Watch RTC engine",
      );
      for (const phase of ["smoke", "tests", "release"]) {
        const context: Parameters<typeof evaluateWorkflowExpression>[1] = {
          eventName: "workflow_dispatch",
          repository: "openclaw/openclaw",
          runAttempt: 1,
          env: { HISTORICAL_TARGET: String(historical) },
          matrix: { phase },
          fileHashes: hasWatchRtc ? { "apps/shared/OpenClawWatchRTC/Cargo.toml": "present" } : {},
        };
        expect(evaluateWorkflowExpression(`\${{ ${install.if} }}`, context)).toBe(expected);
        expect(evaluateWorkflowExpression(`\${{ ${engine.if} }}`, context)).toBe(
          expected && phase === "tests",
        );
      }
    }
  });

  it("retries macOS release builds only when Sparkle metadata is incomplete", () => {
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
    const validateCacheStep = workflow.jobs["macos-swift"].steps.find(
      (step: WorkflowStep) => step.name === "Validate Swift build cache",
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

    const runCacheFixture = (artifactState: "no-build" | "absent" | "incomplete" | "complete") => {
      const root = tempDirs.make(`openclaw-swift-cache-${artifactState}-`);
      const binDir = path.join(root, "bin");
      const buildDir = path.join(root, "apps/macos/.build");
      const frameworkDir = path.join(
        root,
        "apps/macos/.build/artifacts/sparkle/Sparkle/Sparkle.xcframework",
      );
      const callsPath = path.join(root, "swift-calls");
      const outputPath = path.join(root, "github-output");
      mkdirSync(binDir, { recursive: true });
      if (artifactState === "absent") {
        mkdirSync(buildDir, { recursive: true });
      } else if (artifactState === "incomplete" || artifactState === "complete") {
        mkdirSync(frameworkDir, { recursive: true });
      }
      if (artifactState === "complete") {
        writeFileSync(path.join(frameworkDir, "Info.plist"), "complete\n", "utf8");
      }
      writeFileSync(
        path.join(binDir, "swift"),
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$SWIFT_CALLS"
`,
        "utf8",
      );
      chmodSync(path.join(binDir, "swift"), 0o755);
      const result = runWorkflowShellScript(validateCacheStep.run, {
        cwd: root,
        env: {
          ...process.env,
          GITHUB_OUTPUT: outputPath,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          SWIFT_CALLS: callsPath,
        },
      });
      const calls = existsSync(callsPath) ? readFileSync(callsPath, "utf8").trim().split("\n") : [];
      return {
        calls,
        output: readFileSync(outputPath, "utf8").trim(),
        status: result.status,
      };
    };

    for (const artifactState of ["no-build", "complete"] as const) {
      const result = runCacheFixture(artifactState);
      expect(result.status).toBe(0);
      expect(result.calls).toEqual([]);
      expect(result.output).toBe("cache-valid=true");
    }
    for (const artifactState of ["absent", "incomplete"] as const) {
      const result = runCacheFixture(artifactState);
      expect(result.status).toBe(0);
      expect(result.calls).toEqual(["package --package-path apps/macos reset"]);
      expect(result.output).toBe("cache-valid=false");
    }

    const runBuildFixture = (
      artifactState: "absent" | "incomplete" | "complete",
      buildOutcome: "recover" | "fail",
    ) => {
      const root = tempDirs.make(`openclaw-swift-build-${artifactState}-${buildOutcome}-`);
      const binDir = path.join(root, "bin");
      const frameworkDir = path.join(
        root,
        "apps/macos/.build/artifacts/sparkle/Sparkle/Sparkle.xcframework",
      );
      const callsPath = path.join(root, "swift-calls");
      mkdirSync(binDir, { recursive: true });
      if (artifactState === "incomplete" || artifactState === "complete") {
        mkdirSync(frameworkDir, { recursive: true });
      }
      if (artifactState === "complete") {
        writeFileSync(path.join(frameworkDir, "Info.plist"), "complete\n", "utf8");
      }
      writeFileSync(
        path.join(binDir, "swift"),
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$SWIFT_CALLS"
if [[ "\${1:-}" == "package" ]]; then
  exit 0
fi
build_count="$(grep -c '^build ' "$SWIFT_CALLS")"
if [[ "$BUILD_OUTCOME" == "recover" && "$build_count" -eq 2 ]]; then
  exit 0
fi
exit 1
`,
        "utf8",
      );
      chmodSync(path.join(binDir, "swift"), 0o755);
      const result = runWorkflowShellScript(buildStep.run, {
        cwd: root,
        env: {
          ...process.env,
          BUILD_OUTCOME: buildOutcome,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          SWIFT_CALLS: callsPath,
        },
      });
      return {
        calls: readFileSync(callsPath, "utf8").trim().split("\n"),
        output: `${result.stdout}${result.stderr}`,
        status: result.status,
      };
    };

    const releaseBuildCommand =
      "build --package-path apps/macos --product OpenClaw --configuration release";
    const packageResetCommand = "package --package-path apps/macos reset";

    const absentFramework = runBuildFixture("absent", "fail");
    expect(absentFramework.status).toBe(1);
    expect(absentFramework.calls).toEqual([releaseBuildCommand]);

    const recovered = runBuildFixture("incomplete", "recover");
    expect(recovered.status).toBe(0);
    expect(recovered.calls).toEqual([
      releaseBuildCommand,
      packageResetCommand,
      releaseBuildCommand,
    ]);
    expect(recovered.output).toContain("did not produce complete Sparkle metadata");

    const completeFramework = runBuildFixture("complete", "fail");
    expect(completeFramework.status).toBe(1);
    expect(completeFramework.calls).toEqual([releaseBuildCommand]);

    const secondFailure = runBuildFixture("incomplete", "fail");
    expect(secondFailure.status).toBe(1);
    expect(secondFailure.calls).toEqual([
      releaseBuildCommand,
      packageResetCommand,
      releaseBuildCommand,
    ]);
  });

  it("uses native macOS Swift tests and preserves the first failure", () => {
    const workflow = readCiWorkflow();
    const macosSwift = workflow.jobs["macos-swift"];
    const testStep = macosSwift.steps.find((step: WorkflowStep) => step.name === "Swift test");
    const buildCache = macosSwift.steps.find(
      (step: WorkflowStep) => step.id === "swift-build-cache",
    );
    const nativeCachePrefix =
      "${{ runner.os }}-swift-build-v6-${{ matrix.phase }}-${{ hashFiles('scripts/swift-build-cache-metadata.py') }}-graph-${{ steps.swift-toolchain.outputs.key }}-" +
      "${{ hashFiles('apps/macos/Package*.swift', 'apps/macos/Package.resolved', 'apps/shared/**/Package*.swift', 'apps/shared/**/Package.resolved', 'apps/swabble/Package*.swift', 'apps/swabble/Package.resolved') }}-";

    expect(buildCache.with).toMatchObject({
      key: expect.stringContaining(nativeCachePrefix),
      "restore-keys": `${nativeCachePrefix}\n`,
    });
    const restoreMetadata = macosSwift.steps.find(
      (step: WorkflowStep) => step.name === "Restore Swift build input timestamps",
    );
    const recordMetadata = macosSwift.steps.find(
      (step: WorkflowStep) => step.name === "Record Swift build input timestamps",
    );
    const saveBuildCache = macosSwift.steps.find(
      (step: WorkflowStep) => step.name === "Save Swift build directory cache",
    );
    expect(restoreMetadata.if).toBe(
      "steps.validate-swift-build-cache.outputs.cache-valid == 'true' && env.HISTORICAL_TARGET != 'true'",
    );
    expect(restoreMetadata.run).toBe("python3 -I -S scripts/swift-build-cache-metadata.py restore");
    expect(recordMetadata.run).toBe("python3 -I -S scripts/swift-build-cache-metadata.py record");
    expect(recordMetadata.if).toBe(`${saveBuildCache.if} && env.HISTORICAL_TARGET != 'true'`);
    expect(macosSwift.steps.indexOf(restoreMetadata)).toBeLessThan(
      macosSwift.steps.indexOf(testStep),
    );
    expect(macosSwift.steps.indexOf(recordMetadata)).toBeGreaterThan(
      macosSwift.steps.indexOf(testStep),
    );
    expect(macosSwift.steps.indexOf(recordMetadata) + 1).toBe(
      macosSwift.steps.indexOf(saveBuildCache),
    );
    expect(macosSwift.env).not.toHaveProperty("SWIFT_TEST_EXECUTION");
    expect(testStep.id).toBe("swift-test");
    const currentTargetBranch = testStep.run.split('elif [[ "$HISTORICAL_TARGET" == "true" ]]')[0];
    expect(currentTargetBranch).toContain('logical_cpu="$(sysctl -n hw.logicalcpu)"');
    expect(currentTargetBranch).toContain('[[ ! "$logical_cpu" =~ ^[1-9][0-9]*$ ]]');
    expect(currentTargetBranch).toContain(
      "swift_test_width=$(( logical_cpu < 12 ? logical_cpu : 12 ))",
    );
    expect(currentTargetBranch).toContain(
      'swift_test_args+=(--experimental-maximum-parallelization-width "$swift_test_width")',
    );
    expect(currentTargetBranch).not.toContain("swift_test_args+=(--parallel)");
    expect(currentTargetBranch).not.toContain("--no-parallel");
    expect(testStep.run).toContain("swift_test_args+=(--no-parallel)");

    for (const buildExitCode of [0, 23]) {
      const root = tempDirs.make(`openclaw-swift-test-${buildExitCode}-`);
      const binDir = path.join(root, "bin");
      const callsPath = path.join(root, "swift-calls");
      const outputPath = path.join(root, "github-output");
      mkdirSync(binDir, { recursive: true });
      symlinkSync(path.resolve("scripts"), path.join(root, "scripts"), "dir");
      writeFileSync(
        path.join(binDir, "swift"),
        `#!/usr/bin/env bash
set -euo pipefail
SWIFT_CALLS=${JSON.stringify(callsPath)}
GITHUB_OUTPUT=${JSON.stringify(outputPath)}
BUILD_EXIT_CODE=${buildExitCode}
printf '%s\\n' "$*" >> "$SWIFT_CALLS"
if [[ "\${1:-}" == "build" ]]; then
  [[ ! -s "$GITHUB_OUTPUT" ]] || exit 24
  exit "$BUILD_EXIT_CODE"
fi
test_count="$(grep -c '^test ' "$SWIFT_CALLS")"
[[ "$test_count" -gt 1 ]]
`,
        "utf8",
      );
      chmodSync(path.join(binDir, "swift"), 0o755);
      writeFileSync(path.join(binDir, "sysctl"), "#!/usr/bin/env bash\nprintf '4\\n'\n", {
        mode: 0o755,
      });
      // This fixture executes the real launcher: never fall through to host Security.
      writeFileSync(
        path.join(binDir, "security"),
        `#!${process.execPath}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
assert.notEqual(process.env.HOME, ${JSON.stringify(root)});
assert.equal(path.dirname(args.at(-1)), path.join(process.env.HOME, 'Library/Keychains'));
if (args[0] === 'create-keychain') fs.writeFileSync(args.at(-1), 'inert keychain');
if (args[0] === 'delete-keychain') fs.unlinkSync(args.at(-1));
`,
        { mode: 0o755 },
      );
      const result = runWorkflowShellScript(testStep.run, {
        cwd: root,
        env: {
          ...process.env,
          CI: "true",
          GITHUB_ACTIONS: "true",
          RUNNER_OS: "macOS",
          RUNNER_TEMP: root,
          HOME: root,
          GITHUB_OUTPUT: outputPath,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          SWIFT_TEST_EXECUTION: "serial",
        },
      });
      const calls = readFileSync(callsPath, "utf8").trim().split("\n");
      expect(result.status).toBe(buildExitCode || 1);
      expect(calls).toEqual([
        "build --package-path apps/macos --build-system native --enable-code-coverage --build-tests",
        ...(buildExitCode === 0
          ? [
              "test --package-path apps/macos --build-system native --enable-code-coverage --skip-build --experimental-maximum-parallelization-width 4 --skip AppStateIsolationTests",
            ]
          : []),
      ]);
      const output = existsSync(outputPath) ? readFileSync(outputPath, "utf8").trim() : "";
      expect(output).toBe(buildExitCode === 0 ? "debug-tests-built=true" : "");
    }
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
    const job = parse(workflow).jobs.windows;
    const prepare = job.steps.find((step: WorkflowStep) => step.name === "Prepare Windows SSH");
    const finalize = job.steps.find((step: WorkflowStep) => step.name === "Run Testbox").run;

    // Windows administrators use the effective ProgramData file and native ACLs.
    // The native handshake is the behavioral proof; this guards workflow wiring.
    expect(prepare?.env).toEqual({
      TESTBOX_PUBLIC_KEY_PATH: "${{ steps.begin_testbox.outputs.public_key_path }}",
    });
    const nativeSetup = prepare?.run ?? "";
    expect(nativeSetup).toContain("WindowsPrincipal");
    expect(nativeSetup).toContain("System32\\OpenSSH\\sshd.exe");
    expect(nativeSetup).toContain('-T -C "user=$nativeUser"');
    expect(nativeSetup).toContain(
      "authorizedkeysfile __PROGRAMDATA__/ssh/administrators_authorized_keys",
    );
    expect(nativeSetup).toContain("System32\\OpenSSH\\ssh-keygen.exe");
    expect(nativeSetup).toContain("-E sha256 -lf $env:TESTBOX_PUBLIC_KEY_PATH");
    expect(nativeSetup).toContain("[IO.File]::AppendAllText($authorizedKeys,");
    expect(nativeSetup).toContain("S-1-5-18");
    expect(nativeSetup).toContain("S-1-5-32-544");
    expect(nativeSetup).toContain("SetAccessRuleProtection($true, $false)");
    expect(nativeSetup).toContain('"FullControl", "Allow"');
    expect(nativeSetup).toContain("Set-Acl -LiteralPath $authorizedKeys");
    expect(workflow).not.toContain(">> ~/.ssh/authorized_keys");

    expect(finalize).toMatch(
      /if \[ "\$JOB_STATUS" != "success" \]; then\s+phone_home_status="hydration_failed"/u,
    );
    expect(finalize).toContain('--arg status "$phone_home_status"');
    expect(finalize.match(/\/api\/testbox\/phone-home/gu)).toHaveLength(1);
    expect(finalize.slice(0, finalize.indexOf('echo "Testbox ready!"'))).toMatch(
      /if \[ "\$phone_home_status" != "ready" \]; then[^]*?exit 1\s+fi/u,
    );

    expect(workflow.match(/--connect-timeout 10 --max-time 30/gu)).toHaveLength(2);
    expect(workflow).toContain('echo "phone_home_hydrating_curl=${hydrating_curl_status}"');
    expect(workflow).toContain('echo "phone_home_hydrating_http=${hydrating_http_code}"');
    expect(workflow).toContain('echo "phone_home_${phone_home_status}_curl=${final_curl_status}"');
    expect(workflow).toContain('echo "phone_home_${phone_home_status}_http=${http_code}"');
    expect(workflow).toContain('jq -e \'type == "number"\' <<<"$installation_model_id"');
    expect(workflow).toContain('--arg testbox_id "$TESTBOX_ID"');
    expect(workflow).toContain('--arg testbox_id "$testbox_id"');
    expect(workflow).toContain('--argjson installation_model_id "$installation_model_id"');
    expect(workflow).toContain('--data-binary @"$hydrating_body"');
    expect(workflow).toContain('--data-binary @"$final_body"');
    const hydratingFailureBlock = workflow.slice(
      workflow.indexOf(
        'if (( hydrating_curl_status != 0 )) || [[ ! "$hydrating_http_code" =~ ^2 ]]; then',
      ),
      workflow.indexOf('response="$(cat "$hydrating_response")"'),
    );
    const missingSshKeyFailureBlock = workflow.slice(
      workflow.indexOf('if [ -z "$ssh_public_key" ]; then'),
      workflow.indexOf('public_key_path="$(cygpath'),
    );
    const finalFailureBlock = workflow.slice(
      workflow.indexOf('if (( final_curl_status != 0 )) || [[ ! "$http_code" =~ ^2 ]]; then'),
      workflow.indexOf('echo "============================================"'),
    );

    expect(workflow).toContain(')" || hydrating_curl_status=$?');
    expect(workflow).toContain(')" || final_curl_status=$?');
    expect(hydratingFailureBlock).toContain("exit 1");
    expect(missingSshKeyFailureBlock).toContain("exit 1");
    expect(finalFailureBlock).toContain("exit 1");
    expect(workflow).toContain(
      "Blacksmith phone-home did not return an SSH public key; testbox cannot accept native SSH connections.",
    );
    expect(workflow).not.toContain(
      'phone_home_${phone_home_status}_http=${http_code}"\n\n          echo "============================================"',
    );
    expect(workflow).not.toContain('\\"testbox_id\\": \\"${TESTBOX_ID}\\"');
    expect(workflow).not.toContain('cat > "$final_body" <<JSON');
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
    expect(checkShardStep.run).not.toContain("--checkout-git");
    expect(checkShardStep.run).toContain(
      'test "$(git rev-parse refs/remotes/origin/ci-ratchet-base^{commit})" = "$CHECKOUT_BASE_SHA"',
    );
  });

  it.each([
    { job: "check-shard", task: "prod-types", events: [] },
    {
      job: "checks-fast-core",
      task: "baseline-ratchets",
      events: ["pull_request", "push", "workflow_dispatch"],
    },
    {
      job: "checks-fast-core",
      task: "release-lint-core-1",
      events: ["pull_request", "push", "workflow_dispatch"],
    },
    { job: "checks-fast-core", task: "ci-routing", events: [] },
  ])("prepares the frozen diff base for $job/$task at checkout", ({ job, task, events }) => {
    const expression = readCiWorkflow().jobs[job].env?.CHECKOUT_BASE_SHA;
    const base = "c".repeat(40);
    expect(typeof expression).toBe("string");
    for (const eventName of ["pull_request", "push", "workflow_dispatch"] as const) {
      expect(
        evaluateWorkflowExpression(expression, {
          eventName,
          repository: "openclaw/openclaw",
          runAttempt: 1,
          matrix: { task },
          preflightOutputs: { diff_base_revision: base },
        }),
        eventName,
      ).toBe(events.includes(eventName) ? base : "");
    }
  });

  it.each([
    { label: "manual run", checkoutBase: "", changedScript: true },
    { label: "target without changed checks", checkoutBase: "c".repeat(40), changedScript: false },
  ])("keeps the full npm-lock sweep for $label", ({ checkoutBase, changedScript }) => {
    const result = runCheckShardFixture({
      task: "npm-lock",
      frozenTarget: false,
      checkoutBase,
      scripts: ["deps:npm-lock:check", ...(changedScript ? ["deps:npm-lock:check:changed"] : [])],
    });
    expect(result.status, result.output).toBe(0);
    expect(result.calls).toEqual(["deps:npm-lock:check"]);
  });

  it.each([false, true])(
    "preserves absent npm-lock capability handling (historical=%s)",
    (historical) => {
      const result = runCheckShardFixture({
        task: "npm-lock",
        frozenTarget: historical,
        scripts: [],
      });
      expect(result.status, result.output).toBe(historical ? 0 : 1);
      expect(result.calls).toEqual([]);
      expect(result.output).toContain(
        historical
          ? "[skip] historical target predates the transient npm lock contract"
          : "Current CI targets must provide the deps:npm-lock:check package script.",
      );
    },
  );

  it("runs temp path guardrails in the hosted guard shard", () => {
    const requiredScripts = [
      "check:doctor-deprecation-registry",
      "check:browser-inspect-script:swift",
      "check:coercion-helpers",
    ];
    const current = runCheckShardFixture({
      frozenTarget: false,
      scripts: [...requiredScripts, "check:temp-path-guardrails"],
    });
    expect(current.status, current.output).toBe(0);
    expect(current.calls).toContain("check:temp-path-guardrails");
    expect(current.calls.indexOf("check:temp-path-guardrails")).toBeLessThan(
      current.calls.indexOf("dup:check"),
    );

    const frozenMissing = runCheckShardFixture({
      frozenTarget: true,
      scripts: requiredScripts,
    });
    expect(frozenMissing.status, frozenMissing.output).toBe(0);
    expect(frozenMissing.calls).not.toContain("check:temp-path-guardrails");
    expect(frozenMissing.calls).toContain("dup:check:coverage");
    expect(frozenMissing.output).toContain(
      "[skip] frozen target predates the temp path guardrails",
    );

    const currentMissing = runCheckShardFixture({
      frozenTarget: false,
      scripts: requiredScripts,
    });
    expect(currentMissing.status).toBe(1);
    expect(currentMissing.calls).not.toContain("check:temp-path-guardrails");
    expect(currentMissing.calls).not.toContain("dup:check");
    expect(currentMissing.output).toContain(
      "Current CI targets must provide the check:temp-path-guardrails package script.",
    );

    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const preflightGuards = workflow.slice(
      workflow.indexOf("guards)"),
      workflow.indexOf("npm-lock)"),
    );
    expect(preflightGuards.indexOf("pnpm check:temp-path-guardrails")).toBeLessThan(
      preflightGuards.indexOf("pnpm dup:check"),
    );
  });

  it.each([
    {
      scripts: ["tsgo:scripts", "tsgo:test:root"],
      frozenTarget: false,
      status: 0,
      calls: ["tsgo:extensions:test", "tsgo:scripts", "tsgo:test:root"],
    },
    {
      scripts: ["tsgo:scripts"],
      frozenTarget: false,
      status: 1,
      calls: ["tsgo:extensions:test", "tsgo:scripts"],
    },
    {
      scripts: [],
      frozenTarget: false,
      status: 1,
      calls: ["tsgo:extensions:test"],
    },
    {
      scripts: [],
      frozenTarget: true,
      status: 0,
      calls: ["tsgo:extensions:test"],
    },
    {
      scripts: ["tsgo:test:root"],
      frozenTarget: true,
      status: 0,
      calls: ["tsgo:extensions:test", "tsgo:test:root"],
    },
  ])(
    "runs declared typechecks for scripts=$scripts frozen=$frozenTarget",
    ({ scripts, frozenTarget, status, calls }) => {
      const result = runCheckShardFixture({ scripts, frozenTarget, task: "test-types" });
      expect(result.status, result.output).toBe(status);
      expect(result.calls).toEqual(calls);
    },
  );

  it("routes eligible core test leaves to one type owner before runner allocation", () => {
    const changedPaths = [
      "src/commands/doctor-config-preflight.plugin-persistence.test.ts",
      "docs/ci.md",
    ];
    const manifest = runCiManifestFixture({
      bundledPlanner: true,
      changedCoreTestSupport: true,
      eventName: "pull_request",
      changedPaths,
    });
    expect(manifest.status, manifest.output).toBe(0);
    expect(manifest.outputs.changed_core_test_paths_json).toBe(
      JSON.stringify(changedPaths.slice(0, 1)),
    );
    const result = runCheckShardFixture({
      frozenTarget: false,
      task: "test-types",
      scripts: ["tsgo:scripts", "tsgo:test:root"],
      types: {
        compose: true,
        changedPathsJson: manifest.outputs.changed_core_test_paths_json,
        boundary: true,
      },
    });
    expect(result.status, result.output).toBe(0);
    expect(result.rows).toEqual([
      { name: "central", status: 0 },
      { name: "boundary", status: 0 },
    ]);
    expect(result.typeCalls.filter((call) => call.row === "central")).toEqual([
      {
        row: "central",
        localCheck: null,
        command: `node --changed-paths-json ${JSON.stringify(changedPaths.slice(0, 1))} --concurrency 2`,
      },
      ...["tsgo:extensions:test", "tsgo:scripts", "tsgo:test:root"].map((command) => ({
        row: "central",
        localCheck: "0",
        command: `pnpm ${command}`,
      })),
    ]);
    expect(
      result.typeCalls
        .filter((call) => call.row === "boundary")
        .map((call) => call.command)
        .toSorted(),
    ).toEqual(
      BOUNDARY_CHECKS.filter((check) => check.label !== "lint:tmp:tsgo-core-boundary")
        .map((check) => [check.command, ...check.args].join(" "))
        .toSorted(),
    );
    const workflow = readCiWorkflow();
    expect(
      evaluateWorkflowExpression(workflow.jobs["check-test-types-hosted-core-shard"].if, {
        eventName: "pull_request",
        repository: "openclaw/openclaw",
        runAttempt: 1,
        runnerProfile: "hybrid",
        preflightOutputs: manifest.outputs,
      }),
    ).toBe(false);
  });

  it.each([
    { changedPaths: null, invalid: true },
    { changedPaths: [] },
    { changedPaths: ["docs/ci.md"] },
    { changedPaths: ["src/commands/doctor.test.ts", "package.json"] },
    { changedPaths: ["src/commands/doctor.test.ts", "src/shared.test-support.ts"] },
    { changedPaths: ["packages/mermaid-renderer/src/render.test.ts"] },
    { changedPaths: ["src/gateway/gateway-acp-bind.live.test.ts"] },
    { changedPaths: ["src/commands/doctor.test.ts"], changedCoreTestSupport: false },
    { changedPaths: ["src/commands/doctor.test.ts"], eventName: "push" as const },
    { changedPaths: ["src/commands/doctor.test.ts"], eventName: "workflow_dispatch" as const },
    {
      changedPaths: ["src/commands/doctor.test.ts"],
      scopeEnv: { OPENCLAW_CI_CHANGED_PATHS_JSON: "invalid" },
      invalid: true,
    },
  ])("retains full type owners for ineligible manifest inputs %j", (options) => {
    const manifest = runCiManifestFixture({
      bundledPlanner: true,
      changedCoreTestSupport: true,
      eventName: "pull_request",
      ...options,
    });
    if ("invalid" in options) {
      expect(manifest.status).not.toBe(0);
      expect(manifest.output).toContain("Current PR CI requires complete changed paths");
      expect(manifest.outputs.changed_core_test_paths_json).toBeUndefined();
    } else {
      expect(manifest.status, manifest.output).toBe(0);
      expect(manifest.outputs.changed_core_test_paths_json).toBe("");
    }
  });

  it.each([
    ["hybrid", "pull_request", false, true, true, true],
    ["github", "workflow_dispatch", false, true, true, true],
    ["blacksmith", "push", false, true, true, false],
    ["hybrid", "workflow_dispatch", true, false, true, false],
    ["hybrid", "workflow_dispatch", true, true, false, false],
    ["hybrid", "workflow_dispatch", true, true, true, true],
  ] as const)(
    "preserves type workload for %s %s frozen=%s hosted-contract=%s stripe-support=%s",
    (profile, eventName, frozenTarget, hostedContract, stripeSupport, striped) => {
      const result = runCheckShardFixture({
        task: "test-types",
        scripts: ["tsgo:scripts", "tsgo:test:root"],
        frozenTarget,
        types: { compose: true, profile, eventName, hostedContract, stripeSupport },
      });
      expect(result.status, result.output).toBe(0);
      const stripes = result.typeCalls.filter((call) => call.command.startsWith("node "));
      const packages = result.typeCalls.filter((call) => call.command.startsWith("pnpm "));
      expect(packages.map((call) => call.localCheck)).toEqual(packages.map(() => "0"));
      if (striped) {
        expect(result.rows).toHaveLength(3);
        expect(
          result.rows.map((row) =>
            stripes
              .filter((call) => call.row === row.name)
              .map((call) => call.command.split(" ")[2]),
          ),
        ).toEqual([["1/5", "2/5"], ["3/5", "4/5"], ["5/5"]]);
        for (const call of stripes) {
          const args = call.command.split(" ").slice(1);
          expect(args).toEqual(["--stripe", expect.any(String), "--concurrency", "2"]);
          expect(call.localCheck).toBeNull();
        }
        expect(result.calls).toEqual(["tsgo:extensions:test", "tsgo:scripts", "tsgo:test:root"]);
      } else {
        expect(stripes).toEqual([]);
        expect(result.calls).toEqual(["check:test-types", "tsgo:scripts"]);
      }
    },
  );

  it.each(["1/5", "5/5"])("halts only the type row whose first stripe %s fails", (failStripe) => {
    const result = runCheckShardFixture({
      task: "test-types",
      scripts: ["tsgo:scripts", "tsgo:test:root"],
      frozenTarget: false,
      types: { compose: true, failStripe },
    });
    expect(result.status, result.output).toBe(17);
    expect(readCiWorkflow().jobs["check-test-types-hosted-core-shard"].strategy["fail-fast"]).toBe(
      false,
    );
    const failed = result.rows.filter((row) => row.status !== 0);
    expect(failed).toHaveLength(1);
    expect(result.rows.filter((row) => row.status === 0)).toHaveLength(2);
    expect(
      result.typeCalls.filter((call) => call.row === failed[0]!.name).map((call) => call.command),
    ).toEqual([`node --stripe ${failStripe} --concurrency 2`]);
  });

  it.each(["main", "trunk/release"])(
    "resolves manual diff and cache bases from authenticated %s when anonymous Git is unavailable",
    (defaultBranch) => {
      const result = runDiffBaseFixture({
        commitCount: 2,
        eventBaseSha: "",
        defaultBranch,
        manual: true,
      });
      expect(result.status, result.output).toBe(0);
      expect(result.outputs).toEqual({
        default_sha: result.parentSha,
        sha: result.parentSha,
        head_sha: result.headSha,
      });
      expect(result.emittedBaseIsCommit).toBe(true);
    },
  );

  it.each(["ref", "comparison"] as const)(
    "rejects unavailable authenticated manual diff-base %s evidence",
    (apiError) => {
      const result = runDiffBaseFixture({
        commitCount: 2,
        eventBaseSha: "",
        manual: true,
        apiError,
      });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("HTTP 503");
      expect(result.outputs).not.toHaveProperty("sha");
    },
  );

  it("rejects ambiguous zero-before main pushes and preserves concrete bases", () => {
    const zeroSha = "0".repeat(40);
    const threeCommit = runDiffBaseFixture({ commitCount: 3, eventBaseSha: zeroSha });
    expect(threeCommit.status, threeCommit.output).toBe(1);
    expect(threeCommit.output).toContain(AMBIGUOUS_MAIN_PUSH_DIAGNOSTIC);
    expect(threeCommit.outputs).not.toHaveProperty("sha");
    expect(threeCommit.emittedBaseIsCommit).toBe(false);

    const rootCommit = runDiffBaseFixture({ commitCount: 1, eventBaseSha: zeroSha });
    expect(rootCommit.status, rootCommit.output).toBe(1);
    expect(rootCommit.output).toContain(AMBIGUOUS_MAIN_PUSH_DIAGNOSTIC);
    expect(rootCommit.outputs).not.toHaveProperty("sha");
    expect(rootCommit.emittedBaseIsCommit).toBe(false);

    const concreteBase = runDiffBaseFixture({
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

  it("keeps the preflight manifest import closure dependency-free", () => {
    const manifestStep = readCiWorkflow().jobs.preflight.steps.find(
      (step: WorkflowStep) => step.name === "Build CI manifest",
    );
    const manifestRun = expectDefined(manifestStep?.run, "Build CI manifest script");
    const manifestSource = expectDefined(
      manifestRun.match(/--input-type=module <<'([A-Z][A-Z0-9_]*)'\n([\s\S]*?)\n\1(?=\n|$)/u)?.[2],
      "Build CI manifest Node source",
    );
    const repoRoot = process.cwd();
    const pending = new Set<string>();

    function inspectImports(file: string, source: string, workflow = false) {
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const specifiers = new Set<string>();
      const constants = new Map<string, string>();
      for (const statement of sourceFile.statements) {
        if (
          !ts.isVariableStatement(statement) ||
          !(statement.declarationList.flags & ts.NodeFlags.Const)
        ) {
          continue;
        }
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.initializer &&
            ts.isStringLiteralLike(declaration.initializer)
          ) {
            constants.set(declaration.name.text, declaration.initializer.text);
          }
        }
      }
      visitModuleSpecifiers(
        ts,
        sourceFile,
        ({ specifier }: { specifier: string }) => specifiers.add(specifier),
        { includeCommonJs: true, includeImportTypes: true },
      );
      function visit(node: ts.Node) {
        // The workflow selects current .mts or historical .mjs candidates before
        // importing them through variables/helpers. Follow its existing module paths.
        if (
          workflow &&
          ts.isStringLiteralLike(node) &&
          /^\.\.?\/.*\.[cm]?[jt]s$/u.test(node.text) &&
          existsSync(node.text)
        ) {
          specifiers.add(node.text);
        }
        if (
          !workflow &&
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === "require"))
        ) {
          const argument = node.arguments[0];
          if (!argument || !ts.isStringLiteralLike(argument)) {
            const specifier =
              argument && ts.isIdentifier(argument) ? constants.get(argument.text) : undefined;
            expect(
              specifier,
              `${file}: cannot statically resolve module specifier ${argument?.getText(sourceFile) ?? "<missing>"}`,
            ).toBeDefined();
            specifiers.add(expectDefined(specifier, "resolved module specifier"));
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(sourceFile);
      for (const specifier of specifiers) {
        const diagnostic = `${file}: preflight import ${JSON.stringify(specifier)} must resolve without node_modules`;
        if (specifier.startsWith("node:")) {
          expect(isBuiltin(specifier), diagnostic).toBe(true);
          continue;
        }
        expect(specifier, diagnostic).toMatch(/^\.\.?\//u);
        const importedFile = path.relative(
          repoRoot,
          path.resolve(
            workflow ? repoRoot : path.dirname(file),
            // CI materializes trusted actions under the harness checkout prefix.
            workflow ? specifier.replace(/^\.\/\.ci-harness\//u, "./") : specifier,
          ),
        );
        expect(importedFile, diagnostic).not.toMatch(/^(?:\.\.(?:[\\/]|$)|[\\/])/u);
        expect(importedFile.split(path.sep), diagnostic).not.toContain("node_modules");
        expect(existsSync(importedFile), `${diagnostic}; missing ${importedFile}`).toBe(true);
        pending.add(importedFile);
      }
    }

    inspectImports(".github/workflows/ci.yml (Build CI manifest)", manifestSource, true);
    expect(pending.size, "workflow must declare preflight module entry points").toBeGreaterThan(0);
    // Set iteration visits newly discovered modules once, including cycles.
    for (const file of pending) {
      expect(
        pending.size,
        "preflight import closure exceeded 256 repository files",
      ).toBeLessThanOrEqual(256);
      inspectImports(file, readFileSync(file, "utf8"));
    }
  });

  it("runs mobile protocol coverage for Node and native-only changes", () => {
    const workflow = readCiWorkflow();
    const coverageStep = workflow.jobs.preflight.steps.find(
      (step: WorkflowStep) => step.name === "Check mobile protocol event coverage",
    );
    const checkShardRun = workflow.jobs["check-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run check shard",
    ).run;

    // Current-source preflight runs the .mts natively; dispatches selecting
    // another revision retain that target's tsx shim.
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
    const checkShardStep = workflow.jobs["check-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run check shard",
    );
    const checkShardRun = checkShardStep.run;
    const hostedCoreLint = workflow.jobs["check-lint-hosted-core-shard"];
    const hostedCoreTypes = workflow.jobs["check-test-types-hosted-core-shard"];
    expect(manifestStep.env.OPENCLAW_CI_RUNNER_PROFILE).toBe(
      "${{ steps.runner_profile.outputs.runner_profile }}",
    );
    expect(manifestStep.run).toContain("runnerBackend: runnerProfile");
    expect(checkShardStep.env.RUNNER_PROFILE).toBe("${{ needs.preflight.outputs.runner_profile }}");
    expect(checkShardStep.env.HOSTED_RUNNER_STRIPES).toContain(
      "needs.preflight.outputs.hosted_runner_profile_contract == 'true'",
    );
    expect(checkShardRun).toContain('if [ "$HOSTED_RUNNER_STRIPES" = "true" ]; then');
    expect(checkShardStep.env.RELEASE_GATE).toBe("${{ inputs.release_gate && 'true' || 'false' }}");
    expect(checkShardRun).toContain("lint_args=(--only=extensions --only=scripts --threads=1)");
    expect(checkShardRun).toContain('if [ "$RELEASE_GATE" = "true" ]; then');
    expect(checkShardRun).toContain("lint_args=(--only=scripts --threads=1)");
    expect(checkShardRun).toContain('elif [ "$(nproc)" -lt 8 ]; then');
    expect(checkShardRun).toContain("lint_args=(--threads=1)");
    expect(checkShardRun).not.toContain("lint_args=(--split-core --threads=1)");
    expect(checkShardRun).toContain('pnpm lint "${lint_args[@]}"');
    expect(checkShardRun).toContain(
      'node --import tsx scripts/run-oxlint-shards.mts "${lint_args[@]}"',
    );
    for (const job of [hostedCoreLint, hostedCoreTypes]) {
      expect(job.if).toContain("needs.preflight.outputs.runner_profile == 'github'");
      expect(job.if).toContain("needs.preflight.outputs.runner_profile == 'hybrid'");
      expect(job.if).toContain("needs.preflight.outputs.hosted_runner_profile_contract == 'true'");
      expect(
        evaluateWorkflowExpression(job.if, {
          eventName: "workflow_dispatch",
          frozenTarget: true,
          hostedRunnerProfileContract: false,
          repository: "openclaw/openclaw",
          runnerProfile: "blacksmith",
          runAttempt: 1,
        }),
      ).toBe(false);
      expect(
        evaluateWorkflowExpression(job.if, {
          eventName: "workflow_dispatch",
          frozenTarget: true,
          hostedRunnerProfileContract: true,
          repository: "openclaw/openclaw",
          runnerProfile: "github",
          runAttempt: 1,
        }),
      ).toBe(true);
      for (const [runnerProfile, expected] of [
        ["blacksmith", false],
        ["github", true],
        ["hybrid", true],
      ] as const) {
        expect(
          evaluateWorkflowExpression(job.if, {
            eventName: "pull_request",
            frozenTarget: false,
            hostedRunnerProfileContract: true,
            repository: "openclaw/openclaw",
            runnerProfile,
            runAttempt: 1,
          }),
        ).toBe(expected);
      }
    }
    expect(hostedCoreLint["runs-on"]).toBe("ubuntu-24.04");
    expect(hostedCoreLint.strategy["fail-fast"]).toBe(false);
    expect(hostedCoreLint.strategy["max-parallel"]).toBe(5);
    const coreLintStep = hostedCoreLint.steps.find(
      (step: WorkflowStep) => step.name === "Run hosted core lint stripe",
    );
    expect(coreLintStep.env.CORE_STRIPE).toBe("${{ matrix.stripe }}");
    type GoEnv = Partial<Pick<NodeJS.ProcessEnv, "GOMAXPROCS" | "GOGC" | "GOMEMLIMIT">>;
    const goEnvKeys = ["GOMAXPROCS", "GOGC", "GOMEMLIMIT"] as const;
    const runLintOwner = ({
      capability,
      cpuCount = 32,
      eventName = "workflow_dispatch",
      failStripe,
      frozenTarget = !capability,
      goEnv = {},
      expectedGoEnv = goEnv,
      lane,
      profile,
      releaseGate = false,
      stripe = 1,
    }: {
      capability: boolean;
      cpuCount?: number;
      eventName?: "pull_request" | "push" | "workflow_dispatch";
      failStripe?: number;
      frozenTarget?: boolean;
      goEnv?: GoEnv;
      expectedGoEnv?: GoEnv;
      lane: "check" | "core";
      profile: "blacksmith" | "github" | "hybrid";
      releaseGate?: boolean;
      stripe?: number;
    }) => {
      const root = tempDirs.make("openclaw-hosted-lint-owner-");
      const binDir = path.join(root, "bin");
      const callsPath = path.join(root, "calls.txt");
      const goEnvPath = path.join(root, "go-env.txt");
      mkdirSync(path.join(root, "scripts"), { recursive: true });
      mkdirSync(binDir);
      writeFileSync(
        path.join(root, "scripts/run-oxlint-shards.mts"),
        capability ? "// --extension-stripe\n" : "// legacy runner\n",
      );
      for (const command of ["node", "pnpm"]) {
        writeExecutable(path.join(binDir, command), [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `printf '${command} %s\\n' "$*" >> "$LINT_CALLS"`,
          'printf \'%s\\t%s\\t%s\\n\' "${GOMAXPROCS-}" "${GOGC-}" "${GOMEMLIMIT-}" >> "$LINT_GO_ENV"',
          ...(failStripe === undefined
            ? []
            : [`if [[ " $* " == *" --core-stripe=${failStripe}/5 "* ]]; then exit 23; fi`]),
        ]);
      }
      writeExecutable(path.join(binDir, "nproc"), [
        "#!/usr/bin/env bash",
        `printf '${cpuCount}\\n'`,
      ]);
      const coreRun = coreLintStep.run.replace(/\$\{\{[\s\S]*?\}\}/gu, (expression: string) =>
        String(
          evaluateWorkflowExpression(expression, {
            eventName,
            frozenTarget,
            matrix: { stripe },
            releaseGate,
            repository: "openclaw/openclaw",
            runnerProfile: profile,
            runAttempt: 1,
          }),
        ),
      );
      const stepEnv = lane === "check" ? checkShardStep.env : coreLintStep.env;
      const result = spawnSync("bash", ["-c", lane === "check" ? checkShardRun : coreRun], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GOMAXPROCS: undefined,
          GOGC: undefined,
          GOMEMLIMIT: undefined,
          ...goEnv,
          ...Object.fromEntries(
            goEnvKeys.flatMap((key) => (stepEnv[key] === undefined ? [] : [[key, stepEnv[key]]])),
          ),
          FORMAT_CHECK: "false",
          CORE_STRIPE: String(stripe),
          FROZEN_TARGET: frozenTarget ? "true" : "false",
          HISTORICAL_TARGET: capability ? "false" : "true",
          HOSTED_RUNNER_STRIPES: profile === "blacksmith" ? "false" : "true",
          LINT_CALLS: callsPath,
          LINT_GO_ENV: goEnvPath,
          OPENCLAW_LOCAL_CHECK: "0",
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          RELEASE_GATE: releaseGate ? "true" : "false",
          RUN_CONTROL_UI_I18N: "false",
          RUNNER_PROFILE: profile,
          RUN_UI_TESTS: "false",
          TASK: "lint",
        },
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(
        failStripe === undefined ? 0 : 23,
      );
      const calls = existsSync(callsPath)
        ? readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean)
        : [];
      expect(calls.length).toBeGreaterThan(0);
      expect(readFileSync(goEnvPath, "utf8").split("\n").filter(Boolean)).toEqual(
        calls.map(() => goEnvKeys.map((key) => expectedGoEnv[key] ?? "").join("\t")),
      );
      return calls;
    };

    const coreLintRows = (
      context: Partial<Parameters<typeof evaluateWorkflowExpression>[1]>,
    ): number[] => {
      const stripes = hostedCoreLint.strategy.matrix.stripe;
      return Array.isArray(stripes)
        ? stripes
        : evaluateWorkflowExpression(stripes, {
            eventName: "pull_request",
            repository: "openclaw/openclaw",
            runnerProfile: "hybrid",
            runAttempt: 1,
            ...context,
          });
    };
    for (const eventName of ["pull_request", "push"] as const) {
      const rows = coreLintRows({ eventName });
      expect(rows).toEqual([1, 2]);
      expect(
        rows.map((stripe) =>
          runLintOwner({ capability: true, eventName, lane: "core", profile: "hybrid", stripe }),
        ),
      ).toEqual(
        [
          [1, 2],
          [3, 4, 5],
        ].map((stripes) =>
          stripes.map(
            (stripe) =>
              `node --import tsx scripts/run-oxlint-shards.mts --only=core --split-core --core-stripe=${stripe}/5 --threads=1`,
          ),
        ),
      );
    }
    for (const context of [
      { runnerProfile: "github" as const },
      { eventName: "workflow_dispatch" as const },
      { frozenTarget: true },
      { releaseGate: true },
    ]) {
      expect(coreLintRows(context)).toEqual([1, 2, 3, 4, 5]);
    }
    expect(
      runLintOwner({
        capability: true,
        eventName: "pull_request",
        failStripe: 1,
        lane: "core",
        profile: "hybrid",
      }),
    ).toEqual([
      "node --import tsx scripts/run-oxlint-shards.mts --only=core --split-core --core-stripe=1/5 --threads=1",
    ]);
    expect(
      runLintOwner({
        capability: true,
        eventName: "pull_request",
        failStripe: 4,
        lane: "core",
        profile: "hybrid",
        stripe: 2,
      }),
    ).toEqual([
      "node --import tsx scripts/run-oxlint-shards.mts --only=core --split-core --core-stripe=3/5 --threads=1",
      "node --import tsx scripts/run-oxlint-shards.mts --only=core --split-core --core-stripe=4/5 --threads=1",
    ]);

    expect(runLintOwner({ capability: true, lane: "check", profile: "github" })).toEqual([
      "node --import tsx scripts/run-oxlint-shards.mts --only=extensions --extension-stripe=6/6 --threads=1",
      "node --import tsx scripts/run-oxlint-shards.mts --only=scripts --threads=1",
    ]);
    expect(
      runLintOwner({
        capability: true,
        eventName: "pull_request",
        lane: "core",
        profile: "github",
      }),
    ).toEqual([
      "node --import tsx scripts/run-oxlint-shards.mts --only=core --split-core --core-stripe=1/5 --threads=1",
      "node --import tsx scripts/run-oxlint-shards.mts --only=extensions --extension-stripe=1/6 --threads=1",
    ]);
    for (const scenario of [
      {
        capability: false,
        lane: "check" as const,
        profile: "github" as const,
        expectedGoEnv: { GOMAXPROCS: "2", GOGC: "30", GOMEMLIMIT: "3GiB" },
      },
      { capability: true, lane: "check" as const, profile: "hybrid" as const },
    ]) {
      expect(runLintOwner(scenario)).toEqual([
        "node --import tsx scripts/run-oxlint-shards.mts --only=extensions --only=scripts --threads=1",
      ]);
    }
    expect(runLintOwner({ capability: true, lane: "check", profile: "blacksmith" })).toEqual([
      "node --import tsx scripts/run-oxlint-shards.mts --threads=8",
    ]);
    expect(
      runLintOwner({ capability: true, lane: "check", profile: "github", releaseGate: true }),
    ).toEqual(["node --import tsx scripts/run-oxlint-shards.mts --only=scripts --threads=1"]);
    for (const scenario of [
      {
        capability: false,
        lane: "core" as const,
        profile: "github" as const,
        expectedGoEnv: { GOMAXPROCS: "2" },
      },
      { capability: true, lane: "core" as const, profile: "hybrid" as const },
      {
        capability: true,
        lane: "core" as const,
        profile: "github" as const,
        releaseGate: true,
      },
    ]) {
      expect(runLintOwner(scenario)).toEqual([
        "node --import tsx scripts/run-oxlint-shards.mts --only=core --split-core --core-stripe=1/5 --threads=1",
      ]);
    }

    for (const lane of ["check", "core"] as const) {
      runLintOwner({ capability: true, cpuCount: 4, lane, profile: "hybrid" });
      runLintOwner({
        capability: true,
        lane,
        profile: "github",
        goEnv: { GOMAXPROCS: "3", GOGC: "80", GOMEMLIMIT: "5GiB" },
      });
    }
    runLintOwner({ capability: true, cpuCount: 4, lane: "check", profile: "blacksmith" });
    for (const [profile, cpuCount] of [
      ["hybrid", 32],
      ["blacksmith", 4],
    ] as const) {
      runLintOwner({
        capability: true,
        cpuCount,
        frozenTarget: true,
        lane: "check",
        profile,
        expectedGoEnv: { GOMAXPROCS: "2", GOGC: "30", GOMEMLIMIT: "3GiB" },
      });
    }
    runLintOwner({
      capability: true,
      frozenTarget: true,
      lane: "check",
      profile: "blacksmith",
    });
    expect(coreLintStep.env.FROZEN_TARGET).toBe("${{ needs.preflight.outputs.frozen_target }}");
  });

  it.skipIf(process.platform === "win32").each(
    (["bundled-protocol", "guards", "npm-lock"] as const).flatMap((task) =>
      (["pull_request", "push", "workflow_dispatch"] as const).map((eventName) => ({
        task,
        eventName,
      })),
    ),
  )(
    "uses prefetched CI base without later network access ($task, $eventName)",
    async ({ task, eventName }) => {
      const base = "c".repeat(40);
      const baseRef = "refs/remotes/origin/ci-ratchet-base";
      const jobName = task === "bundled-protocol" ? "checks-fast-core" : "check-shard";
      const job = readCiWorkflow().jobs[jobName];
      const needsBase =
        task === "bundled-protocol" ||
        (task === "guards" ? eventName === "pull_request" : eventName !== "workflow_dispatch");
      const checkoutBase = evaluateWorkflowExpression(job.env?.CHECKOUT_BASE_SHA ?? "${{ '' }}", {
        eventName,
        repository: "fixture/checkout",
        runAttempt: 1,
        matrix: { task },
        preflightOutputs: { diff_base_revision: base },
      });
      const report = await runCiGitStep({
        job: jobName,
        step:
          task === "bundled-protocol"
            ? "Run ${{ matrix.task }} (${{ matrix.runtime }})"
            : "Run check shard",
        checkoutBeforeStep: true,
        // The authenticated checkout and trusted harness fetch succeed. Network
        // access is unavailable afterward, even though the base is already local.
        fetchResults: [0, 0, 128],
        baseAvailableAfter: 0,
        revisions: { [`${baseRef}^{commit}`]: base },
        env: {
          TASK: task,
          GITHUB_EVENT_NAME: eventName,
          CHECKOUT_KIND: "linux-node",
          CHECKOUT_BASE_SHA: String(checkoutBase),
          CHECKOUT_TOKEN: "fixture-checkout-token",
        },
      });
      expect(report.code, report.output).toBe(0);
      expect(report.fetches).toHaveLength(2);
      const sourceFetch = report.fetches.find(({ cwd }) => cwd === report.workspace);
      expect(sourceFetch?.args.includes(`+${base}:refs/remotes/origin/ci-ratchet-base`)).toBe(
        needsBase,
      );
      const consumers = report.commands.filter(({ tool }) => tool === "node" || tool === "pnpm");
      if (task === "bundled-protocol") {
        expect(consumers.map(({ args }) => args)).toEqual([["test:bundled"], ["protocol:check"]]);
      } else if (task === "guards") {
        const tempReport = consumers.find(
          ({ args }) => args[0] === "scripts/report-test-temp-creations.mjs",
        );
        expect(tempReport?.args).toEqual(
          needsBase
            ? [
                "scripts/report-test-temp-creations.mjs",
                "--base",
                base,
                "--head",
                "HEAD",
                "--no-merge-base",
              ]
            : undefined,
        );
      } else {
        expect(consumers.filter(({ tool }) => tool === "pnpm").map(({ args }) => args)).toEqual([
          needsBase
            ? ["deps:npm-lock:check:changed", "--base", base, "--head", "HEAD"]
            : ["deps:npm-lock:check"],
        ]);
      }
    },
    55_000,
  );

  it("runs all baseline ratchets against the exact tested tree", () => {
    const workflow = readCiWorkflow();
    const maxLinesRatchet = readFileSync("scripts/check-max-lines-ratchet.mts", "utf8");
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
    expect(checkout.env.CHECKOUT_SHA).toBe("${{ needs.preflight.outputs.checkout_revision }}");
    expect(releaseGateMerge.if).toBe(
      "(matrix.task == 'baseline-ratchets' || startsWith(matrix.task, 'release-lint-')) && github.event_name == 'workflow_dispatch' && inputs.release_gate",
    );
    expect(checksFastRun.run).toContain("baseline-ratchets)");
    expect(checksFastRun.run).toContain("coercion-helpers)");
    expect(checksFastRun.run).toContain("pnpm check:coercion-helpers");
    expect(checksFastRun.run).toContain("bun-launcher)");
    expect(checksFastRun.run).toContain(
      "OPENCLAW_E2E_SKIP_BUILD=1 OPENCLAW_TEST_BUN_LAUNCHER=1 pnpm test test/openclaw-launcher.e2e.test.ts",
    );
    expect(checksFastRun.run).toContain(
      "for required_script in check:max-lines-ratchet check:assertion-safety config:docs:check plugins:inventory:check; do",
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
      "Freeze GitHub's canonical merge snapshot once it contains the exact head",
    );
    expect(releaseGateMerge.run).toContain(
      "Base freshness belongs to the landing gate; chasing moving main here can never converge",
    );
    expect(releaseGateMerge.run).toContain(
      "release-gate merge tree did not refresh to the target head",
    );
    expect(releaseGateMerge.run).not.toContain(".base.sha");
    expect(releaseGateMerge.run).toContain('--git 0 checkout --detach "$merge_sha"');
    expect(releaseGateMerge.run).toContain(
      'echo "RATCHET_BASE_REF=${frozen_base_sha}" >> "$GITHUB_ENV"',
    );
    expect(checksFastRun.run).not.toContain("PROTOCOL_MANUAL_BASE_SHA");
    expect(checksFastRun.run).not.toContain("protocol-since-base");
    expect(checksFastRun.run).toContain(
      'test "$(git rev-parse refs/remotes/origin/ci-ratchet-base^{commit})" = "$PROTOCOL_SINCE_BASE_SHA"',
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
    expect(checksFastRun.run).toContain("pnpm config:docs:check");
    expect(checksFastRun.run).toContain("pnpm plugins:inventory:check");
    expect(maxLinesRatchet).toContain(
      'import { main as checkEnvVarCount } from "./check-env-var-count.mts";',
    );
    expect(maxLinesRatchet).toContain("checkEnvVarCount(envVarCountArgs(argv), root);");
    expect(checksFastRun.run).toContain(
      '--only=core --split-core --core-stripe="${stripe}/5" --threads=1',
    );
    expect(checksFastRun.run).toContain(
      "node --import tsx scripts/run-oxlint-shards.mts --only=extensions --threads=1",
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

    const releaseGate = runCiManifestFixture({
      bundledPlanner: true,
      eventName: "workflow_dispatch",
      historicalCompatibility: false,
      releaseGate: true,
      runnerProfile: "github",
    });
    expect(releaseGate.status, releaseGate.output).toBe(0);
    expect(
      JSON.parse(
        expectDefined(releaseGate.outputs.checks_fast_core_matrix, "release-gate checks matrix"),
      ).include.filter((entry: { task: string }) => entry.task.startsWith("release-lint-")),
    ).toEqual([
      ...Array.from({ length: 5 }, (_, index) => {
        const stripe = index + 1;
        return {
          check_name: `checks-fast-release-lint-core-${stripe}`,
          runtime: "node",
          stripe,
          task: `release-lint-core-${stripe}`,
        };
      }),
      {
        check_name: "checks-fast-release-lint-extensions",
        runtime: "node",
        task: "release-lint-extensions",
      },
    ]);
  });

  it.each([
    {
      label: "test-only routing",
      changedPath: "test/scripts/changed-path-facts.test.ts",
      taskOverride: null,
    },
    {
      label: "source-only routing",
      changedPath: "scripts/lib/changed-path-facts.mjs",
      taskOverride: null,
    },
    {
      label: "legacy combined contract and routing task",
      changedPath: "test/scripts/changed-path-facts.test.ts",
      taskOverride: "contracts-plugins-ci-routing",
    },
  ])(
    "executes standalone changed-path-facts coverage for $label",
    ({ changedPath, taskOverride }) => {
      const root = tempDirs.make("openclaw-fast-ci-routing-");
      const changedPaths = [changedPath];
      const scopeEnv = Object.fromEntries(
        Object.entries(runCiChangedScopeFixture(changedPaths)).map(([key, value]) => [
          `OPENCLAW_CI_${key.toUpperCase()}`,
          value,
        ]),
      );
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        eventName: "pull_request",
        historicalCompatibility: false,
        changedPaths,
        scopeEnv: { ...scopeEnv, OPENCLAW_CI_DOCS_CHANGED: "false" },
      });
      expect(manifest.status, manifest.output).toBe(0);
      expect(
        Object.entries(manifest.outputs)
          .filter(([key, value]) => key.startsWith("run_") && value === "true")
          .map(([key]) => key)
          .toSorted(),
      ).toEqual([
        "run_checks_fast_core",
        "run_format_check",
        "run_node",
        "run_protocol_event_coverage",
      ]);
      for (const matrix of [
        "checks_node_core_nondist_matrix",
        "plugin_contracts_matrix",
        "channel_contracts_matrix",
        "checks_windows_matrix",
        "macos_node_matrix",
        "android_matrix",
      ]) {
        expect(JSON.parse(expectDefined(manifest.outputs[matrix], matrix)).include, matrix).toEqual(
          [],
        );
      }
      const fastTasks = JSON.parse(
        expectDefined(manifest.outputs.checks_fast_core_matrix, "fast checks matrix"),
      ).include as Array<{ task: string }>;
      expect(fastTasks.map(({ task }) => task)).toEqual([
        "baseline-ratchets",
        "coercion-helpers",
        "ci-routing",
      ]);
      const routingTask = expectDefined(
        fastTasks.find(({ task }) => task === "ci-routing"),
        "CI routing task",
      );
      const runStep = readCiWorkflow().jobs["checks-fast-core"].steps.find(
        (step: WorkflowStep) => step.name === "Run ${{ matrix.task }} (${{ matrix.runtime }})",
      );
      const fakeBin = path.join(root, "bin");
      const callsPath = path.join(root, "pnpm-calls.jsonl");
      mkdirSync(fakeBin);
      writeExecutable(path.join(fakeBin, "pnpm"), [
        "#!/usr/bin/env node",
        'require("node:fs").appendFileSync(process.env.PNPM_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");',
      ]);
      // The current manifest selects ci-routing; exercise the retained combined Bash case directly.
      const run = spawnSync("bash", ["-c", runStep.run], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          PNPM_CALLS: callsPath,
          TASK: taskOverride ?? routingTask.task,
        },
      });
      expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
      const calls = readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(calls.map(([command]) => command)).toEqual(
        taskOverride ? ["test:contracts:plugins", "test"] : ["test"],
      );
      expect(
        calls.find(([command]) => command === "test"),
        "executed routing test argv",
      ).toContain("test/scripts/changed-path-facts.test.ts");
    },
  );

  it.each<{
    label: string;
    changedPath: string;
    eventName?: "pull_request" | "push" | "workflow_dispatch";
    releaseGate?: boolean;
    legacyOutput?: boolean;
    selectedJobs: string[];
  }>([
    {
      label: "Git-owner action",
      changedPath: ".github/actions/git-owner/owner.py",
      selectedJobs: ["macos-node", "checks-windows"],
    },
    {
      label: "Docs Agent",
      changedPath: ".github/workflows/docs-agent.yml",
      selectedJobs: ["macos-node", "checks-windows"],
    },
    ...[
      ".github/workflows/openclaw-performance.yml",
      "test/scripts/openclaw-performance-workflow.test-support.ts",
      "test/scripts/openclaw-performance-git-lifecycle.test.ts",
      "test/scripts/openclaw-performance-workflow.test.ts",
    ].map((changedPath) => ({
      label: `Performance owner ${changedPath}`,
      changedPath,
      selectedJobs: ["macos-node", "checks-windows"],
    })),
    {
      label: "Git-owner fixture",
      changedPath: "test/scripts/fixtures/ci-platform-checkout.mjs",
      selectedJobs: ["macos-node", "checks-windows"],
    },
    {
      label: "Windows process census fixture",
      changedPath: "test/scripts/fixtures/ci-windows-process-census.py",
      selectedJobs: ["macos-node", "checks-windows"],
    },
    {
      label: "Mac app",
      changedPath: "apps/macos/Sources/Foo.swift",
      selectedJobs: ["macos-node", "macos-swift"],
    },
    {
      label: "Mac artifact proof",
      changedPath: "test/scripts/mac-elevation-artifact.test.ts",
      selectedJobs: ["macos-node", "macos-swift"],
    },
    {
      label: "iOS app pull request",
      changedPath: "apps/ios/Sources/Foo.swift",
      selectedJobs: ["ios-build"],
    },
    {
      label: "iOS app main push",
      changedPath: "apps/ios/Sources/Foo.swift",
      eventName: "push",
      selectedJobs: ["ios-build"],
    },
    {
      label: "iOS app exact-head release gate",
      changedPath: "apps/ios/Sources/Foo.swift",
      eventName: "workflow_dispatch",
      releaseGate: true,
      selectedJobs: ["checks-windows", "ios-build", "android"],
    },
    {
      label: "shared native",
      changedPath: "apps/shared/OpenClawKit/Sources/Foo.swift",
      selectedJobs: ["macos-node", "macos-swift", "ios-build", "android"],
    },
    { label: "docs", changedPath: "docs/ci.md", selectedJobs: [] },
    {
      label: "unrelated CI workflow",
      changedPath: ".github/workflows/ci.yml",
      selectedJobs: ["checks-windows"],
    },
    {
      label: "ordinary manual",
      changedPath: ".github/actions/git-owner/owner.py",
      eventName: "workflow_dispatch",
      selectedJobs: ["macos-node", "macos-swift", "checks-windows", "ios-build"],
    },
    {
      label: "historical Mac scope without native Node output",
      changedPath: "apps/macos/Sources/Foo.swift",
      eventName: "workflow_dispatch",
      releaseGate: true,
      legacyOutput: true,
      selectedJobs: ["macos-node", "macos-swift", "checks-windows", "android"],
    },
    {
      label: "historical non-Mac scope without native Node output",
      changedPath: "src/config/defaults.ts",
      eventName: "workflow_dispatch",
      releaseGate: true,
      legacyOutput: true,
      selectedJobs: ["checks-windows", "android"],
    },
  ])(
    "routes native CI jobs through scope output and manifest ($label)",
    ({
      changedPath,
      eventName = "pull_request",
      releaseGate = false,
      legacyOutput,
      selectedJobs,
    }) => {
      const workflow = readCiWorkflow();
      const manifestStep = workflow.jobs.preflight.steps.find(
        (step: WorkflowStep) => step.name === "Build CI manifest",
      );
      const changedPaths = [changedPath];
      const scopeOutputs = runCiChangedScopeFixture(changedPaths);
      if (legacyOutput) {
        delete scopeOutputs.run_macos_node;
      }
      const context = {
        eventName,
        releaseGate,
        repository: "openclaw/openclaw",
        runAttempt: 1,
        steps: { changed_scope: { outputs: scopeOutputs } },
      };
      const scopeEnv = Object.fromEntries(
        Object.entries(manifestStep.env)
          .filter(([key]) => key.startsWith("OPENCLAW_CI_RUN_"))
          .map(([key, expression]) => [
            key,
            String(evaluateWorkflowExpression(expression, context)),
          ]),
      );
      const manifest = runCiManifestFixture({
        bundledPlanner: !legacyOutput,
        changedPaths,
        eventName,
        releaseGate,
        scopeEnv,
      });
      expect(manifest.status, manifest.output).toBe(0);
      const preflightOutputs = Object.fromEntries(
        Object.entries(workflow.jobs.preflight.outputs)
          .filter(([, expression]) => String(expression).includes("steps.manifest.outputs."))
          .map(([key, expression]) => [
            key,
            String(
              evaluateWorkflowExpression(expression, {
                ...context,
                steps: { manifest: { outputs: manifest.outputs } },
              }),
            ),
          ]),
      );
      for (const jobName of [
        "macos-node",
        "macos-swift",
        "checks-windows",
        "ios-build",
        "android",
      ]) {
        const job = workflow.jobs[jobName];
        const expression = job.if.startsWith("${{") ? job.if : `\${{ ${job.if} }}`;
        expect(
          evaluateWorkflowExpression(expression, { ...context, preflightOutputs }),
          jobName,
        ).toBe(selectedJobs.includes(jobName));
      }
      expect(
        JSON.parse(expectDefined(manifest.outputs.macos_node_matrix, "Mac Node matrix")).include,
      ).toEqual(
        selectedJobs.includes("macos-node")
          ? legacyOutput
            ? [{ check_name: "macos-node", runtime: "node", task: "test" }]
            : [1, 2, 3].map((part) => ({
                check_name: `macos-node-${part}`,
                runtime: "node",
                task: `test-${part}`,
              }))
          : [],
      );
      expect(
        JSON.parse(expectDefined(manifest.outputs.checks_windows_matrix, "Windows matrix")).include,
      ).toHaveLength(selectedJobs.includes("checks-windows") ? 2 : 0);
    },
  );

  it.each(
    [
      { scope: "npm-beta", packageVersion: "2026.9.1-beta.1", branch: "release/2026.9.1" },
      { scope: "npm-stable", packageVersion: "2026.9.1", branch: "release/2026.9.1" },
      { scope: "npm-stable", packageVersion: "2026.9.1-1", branch: "release/2026.9.1-1" },
    ].flatMap(({ scope, packageVersion, branch }) =>
      ["release branch", "release tag"].map((context) => ({
        scope,
        packageVersion,
        branch,
        context,
      })),
    ),
  )(
    "qualifies $scope $packageVersion without native app jobs through a validated $context",
    ({ scope, packageVersion, branch, context }) => {
      const options = {
        bundledPlanner: true,
        packageVersion,
        scopeEnv: {
          OPENCLAW_CI_TARGET_REF: "a".repeat(40),
          OPENCLAW_CI_TARGET_CONTEXT_REF: context === "release branch" ? branch : "",
          OPENCLAW_CI_TARGET_CONTEXT_TARGET: String(context === "release branch"),
          OPENCLAW_CI_HISTORICAL_TARGET_TAG: context === "release tag" ? `v${packageVersion}` : "",
          OPENCLAW_CI_HISTORICAL_TARGET: String(context === "release tag"),
          OPENCLAW_CI_RUN_UI_TESTS: "true",
        },
      };
      const full = runCiManifestFixture(options);
      const qualification = runCiManifestFixture({
        ...options,
        scopeEnv: { ...options.scopeEnv, OPENCLAW_CI_RELEASE_SCOPE: scope },
      });
      expect(full.status, full.output).toBe(0);
      expect(qualification.status, qualification.output).toBe(0);
      expect(qualification.output).toContain(`CI release scope: ${scope}`);
      expect(qualification.summary).toContain(`Scope: \`${scope}\``);
      expect(qualification.summary).toContain("Native app qualification: deferred");
      expect(qualification.outputs).toEqual({
        ...full.outputs,
        release_scope: scope,
        run_macos_swift: "false",
        run_openclawkit_tests: "false",
        run_ios_build: "false",
        run_android: "false",
        run_android_job: "false",
        run_native_i18n: "false",
        android_matrix: JSON.stringify({ include: [] }),
      });
      for (const output of [
        "run_node",
        "run_macos_node",
        "run_checks_windows",
        "run_build_artifacts",
        "run_check_additional",
        "run_protocol_event_coverage",
        "run_ui_tests",
      ]) {
        expect(qualification.outputs[output], output).toBe("true");
      }
      for (const jobName of ["ios-screenshot-shard", "ios-screenshot-evidence"]) {
        expect(
          evaluateWorkflowExpression(readCiWorkflow().jobs[jobName].if, {
            eventName: "workflow_dispatch",
            repository: "openclaw/openclaw",
            runAttempt: 1,
            preflightOutputs: {
              ...qualification.outputs,
              compatibility_target: "false",
              run_ios_screenshots: "true",
            },
          }),
          jobName,
        ).toBe(false);
      }
    },
  );

  it.skipIf(process.platform === "win32").each([
    { label: "base branch correction", context: "branch", direct: "a", accepted: true },
    { label: "base tag correction", context: "tag", direct: "a", accepted: true },
    { label: "annotated base tag", context: "tag", direct: "c", peeled: "a", accepted: true },
    {
      label: "versioned correction without a base lookup",
      context: "branch",
      packageVersion: "2026.9.1-1",
      accepted: true,
    },
    { label: "missing base tag", context: "branch", accepted: false },
    { label: "different base source", context: "branch", direct: "c", accepted: false },
    { label: "different peeled source", context: "tag", direct: "a", peeled: "c", accepted: false },
  ])(
    "binds npm stable $label to the exact source",
    ({ context, direct, peeled, packageVersion, accepted }) => {
      const result = runCiManifestFixture({
        bundledPlanner: true,
        packageVersion: packageVersion ?? "2026.9.1",
        remoteTagRefs: {
          ...(direct ? { "refs/tags/v2026.9.1": direct.repeat(40) } : {}),
          ...(peeled ? { "refs/tags/v2026.9.1^{}": peeled.repeat(40) } : {}),
        },
        scopeEnv: {
          OPENCLAW_CI_RELEASE_SCOPE: "npm-stable",
          OPENCLAW_CI_TARGET_REF: "a".repeat(40),
          OPENCLAW_CI_TARGET_CONTEXT_REF: context === "branch" ? "release/2026.9.1-1" : "",
          OPENCLAW_CI_TARGET_CONTEXT_TARGET: String(context === "branch"),
          OPENCLAW_CI_HISTORICAL_TARGET_TAG: context === "tag" ? "v2026.9.1-1" : "",
          OPENCLAW_CI_HISTORICAL_TARGET: String(context === "tag"),
        },
      });
      expect(result.status === 0, result.output).toBe(accepted);
      if (accepted) {
        expect(result.outputs.run_ios_build).toBe("false");
        expect(result.outputs.run_node).toBe("true");
      } else {
        expect(result.output).toContain(
          direct ? "correction base v2026.9.1 does not resolve" : "HTTP 404",
        );
        expect(result.outputs).not.toHaveProperty("run_node");
      }
    },
  );

  it.each<{ label: string } & Omit<Parameters<typeof runCiManifestFixture>[0], "bundledPlanner">>([
    { label: "stable target", packageVersion: "2026.9.1" },
    { label: "alpha target", packageVersion: "2026.9.1-alpha.1" },
    { label: "PR event", eventName: "pull_request" as const },
    { label: "fork repository", repository: "example/openclaw" },
    { label: "PR release gate", releaseGate: true },
    { label: "PR number", scopeEnv: { OPENCLAW_CI_PULL_REQUEST_NUMBER: "123" } },
    { label: "mutable target", scopeEnv: { OPENCLAW_CI_TARGET_REF: "release/2026.9.1" } },
    { label: "wrong target", scopeEnv: { OPENCLAW_CI_TARGET_REF: "c".repeat(40) } },
    { label: "unvalidated branch", scopeEnv: { OPENCLAW_CI_TARGET_CONTEXT_TARGET: "false" } },
    {
      label: "wrong release train",
      scopeEnv: { OPENCLAW_CI_TARGET_CONTEXT_REF: "release/2026.9.2" },
    },
    {
      label: "wrong release tag",
      scopeEnv: {
        OPENCLAW_CI_TARGET_CONTEXT_TARGET: "false",
        OPENCLAW_CI_HISTORICAL_TARGET: "true",
        OPENCLAW_CI_HISTORICAL_TARGET_TAG: "v2026.9.2-beta.1",
      },
    },
    { label: "unknown scope", scopeEnv: { OPENCLAW_CI_RELEASE_SCOPE: "package" } },
    ...["2026.9.1-beta.1", "2026.9.1-alpha.1", "2026.9.33", "2026.9.33-1"].map(
      (packageVersion) => ({
        label: `npm-stable with ${packageVersion}`,
        packageVersion,
        scopeEnv: { OPENCLAW_CI_RELEASE_SCOPE: "npm-stable" },
      }),
    ),
    {
      label: "correction package in a different release context",
      packageVersion: "2026.9.1-1",
      scopeEnv: { OPENCLAW_CI_RELEASE_SCOPE: "npm-stable" },
    },
  ])(
    "rejects scoped npm CI qualification for $label",
    ({ label: _label, scopeEnv, ...options }) => {
      const result = runCiManifestFixture({
        bundledPlanner: true,
        historicalCompatibility: false,
        packageVersion: "2026.9.1-beta.1",
        ...options,
        scopeEnv: {
          OPENCLAW_CI_RELEASE_SCOPE: "npm-beta",
          OPENCLAW_CI_TARGET_REF: "a".repeat(40),
          OPENCLAW_CI_TARGET_CONTEXT_REF: "release/2026.9.1",
          OPENCLAW_CI_TARGET_CONTEXT_TARGET: "true",
          ...scopeEnv,
        },
      });
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain("release_scope");
      expect(result.outputs).not.toHaveProperty("run_node");
    },
  );

  it.each([
    ["pull_request", "openclaw/openclaw", true],
    ["pull_request", "example/openclaw", false],
    ["push", "openclaw/openclaw", false],
    ["workflow_dispatch", "openclaw/openclaw", false],
  ] as const)(
    "forwards changed paths only to canonical PR fallback (%s, %s)",
    (eventName, repository, forwardsChangedPaths) => {
      const changedPaths = [
        "src/plugins/manifest-tool-availability.ts",
        "src/plugins/tools.optional.test.ts",
      ];
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        changedPaths,
        eventName,
        repository,
      });
      expect(manifest.status, manifest.output).toBe(0);
      const rows = JSON.parse(
        expectDefined(manifest.outputs.checks_node_core_nondist_matrix, "fallback matrix"),
      ).include;
      expect(rows).toHaveLength(1);
      expect(rows[0].check_name).toBe("bundled-node-plan");
      expect(rows[0].includePatterns).toEqual(forwardsChangedPaths ? changedPaths : undefined);
    },
  );

  it.each([false, true])(
    "projects immutable reader history only when the selected target has the reader (present=%s)",
    (historicalReader) => {
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        changedPaths: ["src/audit/message-delivery-progress-store.test.ts"],
        eventName: "pull_request",
        historicalReader,
      });
      expect(manifest.status, manifest.output).toBe(0);
      const rows = JSON.parse(
        expectDefined(manifest.outputs.checks_node_core_nondist_matrix, "reader matrix"),
      ).include;
      expect(rows).toHaveLength(1);
      expect(rows[0].git_commits).toEqual(
        historicalReader ? ["5dc4cf602bc5e263e83cd16a12bb1e100544f4c3"] : [],
      );
    },
  );

  it.each([
    ["pull_request", "compact", "blacksmith", 120],
    ["pull_request", "precise", "github", 120],
    ["push", "compact", "hybrid", 64],
    ["workflow_dispatch", "compact", "blacksmith", null],
  ] as const)(
    "bounds the final Node matrix for %s %s plans",
    (eventName, selection, runnerProfile, limit) => {
      for (const count of [limit ?? 120, (limit ?? 120) + 1]) {
        const hasFallback = eventName === "pull_request" && selection === "compact";
        const nodeTestShards = Array.from({ length: count - Number(hasFallback) }, (_, index) => ({
          checkName: `node-admission-${index}`,
          shardName: `node-admission-${index}`,
          configs: ["test/vitest/vitest.infra.config.ts"],
          runner: "ubuntu-24.04",
          requiresDist: false,
        }));
        const result = runCiManifestFixture({
          bundledPlanner: true,
          changedPaths: ["extensions/matrix/src/channel.ts"],
          changedPlannerSource:
            selection === "precise"
              ? `export { createNodeTestShards as createChangedNodeTestShards } from "./ci-node-test-plan.mts";
                 export const createChangedExtensionFallbackShards = () => [];`
              : undefined,
          eventName,
          nodeTestShards: [
            ...nodeTestShards,
            {
              checkName: "node-admission-dist",
              shardName: "node-admission-dist",
              configs: ["test/vitest/vitest.infra.config.ts"],
              runner: "ubuntu-24.04",
              requiresDist: true,
            },
          ],
          runnerProfile,
        });
        if (limit !== null && count > limit) {
          expect(result.status, result.output).toBe(1);
          expect(result.output).toContain(
            `Canonical ${eventName} Node matrix has ${count} jobs, exceeding limit ${limit}`,
          );
          expect(result.outputs.checks_node_core_nondist_matrix).toBeUndefined();
          expect(result.outputs.run_checks_node_core_nondist).toBeUndefined();
        } else {
          expect(result.status, result.output).toBe(0);
          const rows = JSON.parse(
            expectDefined(result.outputs.checks_node_core_nondist_matrix, "bounded Node matrix"),
          ).include;
          expect(rows.map((row: { check_name: string }) => row.check_name)).toEqual([
            ...(hasFallback ? ["changed-extension-fallback-plan"] : []),
            ...nodeTestShards.map((shard) => shard.checkName),
          ]);
          expect(result.outputs.run_checks_node_core_dist).toBe("true");
        }
      }
    },
  );

  it("admits slow compact and plugin fallback rows before shorter work", () => {
    const result = runCiManifestFixture({
      bundledPlanner: true,
      changedPaths: ["extensions/matrix/src/channel.ts"],
      eventName: "pull_request",
      nodeTestShards: [30, 240, 240].map((predictedSeconds, index) => ({
        checkName: `compact-${index}`,
        shardName: `compact-${index}`,
        configs: ["test/vitest/vitest.infra.config.ts"],
        runner: "ubuntu-24.04",
        requiresDist: false,
        predictedSeconds,
      })),
    });
    expect(result.status, result.output).toBe(0);
    const rows = JSON.parse(
      expectDefined(result.outputs.checks_node_core_nondist_matrix, "Node matrix"),
    ).include;
    expect(rows.map((row: { check_name: string }) => row.check_name)).toEqual([
      "compact-1",
      "compact-2",
      "changed-extension-fallback-plan",
      "compact-0",
    ]);
    expect(rows.map((row: { predicted_seconds: number }) => row.predicted_seconds)).toEqual([
      240, 240, 120, 30,
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
    expect(legacy.outputs.run_docker_seed_e2e).toBe("false");
    expect(legacy.outputs.docker_seed_lanes).toBe("");
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
    expect(current.outputs.run_docker_seed_e2e).toBe("false");
    expect(current.outputs.docker_seed_lanes).toBe("");
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
      changedPaths: ["package.json"],
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
      { check_name: "android-test-play", task: "test-play", lint: true },
      { check_name: "android-test-third-party", task: "test-third-party", lint: true },
      { check_name: "android-test-wear", task: "test-wear", lint: true },
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
          OPENCLAW_CI_TEST_RUNNER_BACKEND: "blacksmith",
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
            OPENCLAW_CI_TEST_RUNNER_BACKEND: runnerBackend ?? "blacksmith",
          },
        }),
      );
    }

    const dockerSeedPath = "scripts/e2e/docker-openai-seed.ts";
    const changedPullRequest = runCiManifestFixture({
      bundledPlanner: true,
      changedPaths: ["src/focused.ts", "extensions/codex/src/focused.ts", dockerSeedPath],
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
    expect(changedPullRequest.outputs.run_docker_seed_e2e).toBe("true");
    expect(changedPullRequest.outputs.docker_seed_lanes).toBe("mcp-channels cron-mcp-cleanup");

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
            OPENCLAW_CI_TEST_RUNNER_BACKEND: "blacksmith",
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

    const emptyPullRequest = runCiManifestFixture({
      bundledPlanner: true,
      changedPaths: [],
      eventName: "pull_request",
    });
    expect(emptyPullRequest.status, emptyPullRequest.output).toBe(0);
    expect(
      JSON.parse(
        expectDefined(emptyPullRequest.outputs.checks_node_core_nondist_matrix, "empty PR matrix"),
      ).include,
    ).toEqual([expect.objectContaining({ check_name: "bundled-node-plan", includePatterns: [] })]);

    for (const [changedPlannerSource, error] of [
      [null, "Current CI target does not provide ./scripts/lib/ci-changed-node-test-plan.mjs"],
      ['throw new Error("planner import failure");', "planner import failure"],
      [
        "export const createChangedExtensionFallbackShards = () => [];",
        "Current PR CI target does not export createChangedNodeTestShards",
      ],
      [
        "export const createChangedNodeTestShards = () => [];",
        "Current PR CI target does not export createChangedExtensionFallbackShards",
      ],
      [
        `export const createChangedNodeTestShards = () => { throw new Error("precise planning failure"); };
         export const createChangedExtensionFallbackShards = () => [];`,
        "precise planning failure",
      ],
      [
        `export const createChangedNodeTestShards = () => null;
         export const createChangedExtensionFallbackShards = () => { throw new Error("fallback planning failure"); };`,
        "fallback planning failure",
      ],
    ] as const) {
      const failure = runCiManifestFixture({
        bundledPlanner: true,
        changedPaths: ["package.json", "extensions/codex/src/focused.ts"],
        changedPlannerSource,
        eventName: "pull_request",
      });
      expect(failure.status, failure.output).toBe(1);
      expect(failure.output).toContain(error);
      expect(failure.outputs.checks_node_core_nondist_matrix).toBeUndefined();
    }
    for (const changedPaths of [undefined, null]) {
      const failure = runCiManifestFixture({
        bundledPlanner: true,
        changedPaths,
        eventName: "pull_request",
      });
      expect(failure.status, failure.output).toBe(1);
      expect(failure.output).toContain(
        "Current PR CI requires complete changed paths for Node test planning",
      );
      expect(failure.outputs.checks_node_core_nondist_matrix).toBeUndefined();
    }

    const currentMissingIos = runCiManifestFixture({
      bundledPlanner: true,
      changedPaths: ["package.json"],
      eventName: "pull_request",
      iosCapabilities: false,
    });
    expect(currentMissingIos.status, currentMissingIos.output).toBe(0);
    expect(currentMissingIos.outputs.historical_target).toBe("false");
    expect(currentMissingIos.outputs.run_ios_build).toBe("true");
    expect(currentMissingIos.outputs.run_macos_swift).toBe("true");

    const currentMissingQaPlan = runCiManifestFixture({
      bundledPlanner: true,
      changedPaths: ["package.json"],
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
      changedPaths: ["package.json"],
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
    expect(historicalTargetStep.run).toContain('[[ "$tag_sha" != "$EXPECTED_SHA" ]]');
    const releaseCandidateStep = workflow.jobs.preflight.steps.find(
      (step: { name?: string }) => step.name === "Validate release candidate target",
    );
    expect(releaseCandidateStep.if).toBe("inputs.release_candidate_ref != ''");
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
    expect(openClawKitTests.if).toBe(
      "matrix.phase == 'tests' && needs.preflight.outputs.run_openclawkit_tests == 'true'",
    );

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
      if: "needs.preflight.outputs.cache_mode != 'off' && needs.preflight.outputs.compatibility_target != 'true'",
      uses: CACHE_V5,
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

  it.each([
    { label: "current", frozenTarget: false, compatibilityTarget: false, shards: [1, 2, 3] },
    { label: "frozen current", frozenTarget: true, compatibilityTarget: false, shards: [1] },
    { label: "frozen legacy", frozenTarget: true, compatibilityTarget: true, shards: [1] },
  ])("executes the $label standalone UI envelope", async (scenario) => {
    const workflow = readCiWorkflow();
    const ui = workflow.jobs["checks-ui"];
    const lint = ui.steps.find(
      (step: WorkflowStep) => step.name === "Lint Control UI window.open usage",
    );
    const test = ui.steps.find((step: WorkflowStep) => step.name === "Test Control UI");
    const context = {
      eventName: scenario.frozenTarget ? "workflow_dispatch" : "pull_request",
      frozenTarget: scenario.frozenTarget,
      preflightOutputs: { compatibility_target: String(scenario.compatibilityTarget) },
      repository: "openclaw/openclaw",
      runAttempt: 1,
      runnerBackend: "hybrid",
    } as const;
    // A workflow job without a matrix executes once.
    const shards = ui.strategy
      ? evaluateWorkflowExpression(ui.strategy.matrix.shard, context)
      : [1];
    expect(shards).toEqual(scenario.shards);
    if (!scenario.frozenTarget) {
      expect(ui.strategy).toMatchObject({ "fail-fast": false, "max-parallel": 3 });
    }
    expect(ui.needs).toEqual(["preflight"]);
    expect(ui.if).toBe("needs.preflight.outputs.run_ui_tests == 'true'");
    expect(ui.permissions).toEqual({ contents: "read" });
    expect(ui["timeout-minutes"]).toBe(20);
    expect(workflow.jobs["ci-gate"].needs).toContain("checks-ui");

    const root = tempDirs.make("openclaw-ui-workflow-");
    const bin = path.join(root, "bin");
    const callsPath = path.join(root, "calls.txt");
    const argsPath = path.join(root, "vitest-args.json");
    mkdirSync(bin);
    for (const command of ["node", "pnpm"]) {
      writeExecutable(path.join(bin, command), [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `printf '%s\\n' '${command} '"$*" >> "$UI_COMMAND_CALLS"`,
        ...(command === "node"
          ? ['printf "%s\\n" "$OPENCLAW_NODE_TEST_VITEST_ARGS_JSON" > "$UI_VITEST_ARGS"']
          : []),
      ]);
    }
    for (const shard of scenario.shards) {
      const rowContext = { ...context, matrix: { shard } };
      const resolveValue = (value: unknown): string =>
        typeof value === "string" && value.startsWith("${{")
          ? String(evaluateWorkflowExpression(value, rowContext))
          : String(value);
      expect(resolveValue(ui.name)).toBe(
        scenario.frozenTarget ? "checks-ui" : `checks-ui (${shard}/3)`,
      );
      expect(evaluateWorkflowExpression(ui["runs-on"], rowContext)).toBe(
        scenario.frozenTarget ? "ubuntu-24.04" : "blacksmith-8vcpu-ubuntu-2404",
      );
      const env = Object.fromEntries(
        Object.entries({ ...ui.env, ...test.env }).map(([key, value]) => [
          key,
          resolveValue(value),
        ]),
      );
      expect(env.OPENCLAW_NODE_TEST_PLAN_CONCURRENCY).toBe("1");
      const flags = [
        "--maxWorkers",
        "3",
        "--reporter=verbose",
        "--reporter=github-actions",
        "--reporter=./scripts/lib/vitest-resource-reporter.mts",
        ...(scenario.frozenTarget ? [] : [`--shard=${shard}/3`]),
      ];
      const steps = [
        ...(!lint.if || evaluateWorkflowExpression(lint.if, rowContext) ? [lint] : []),
        test,
      ];
      for (const step of steps) {
        const result = runWorkflowShellScript(step.run, {
          cwd: root,
          env: {
            ...process.env,
            ...env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            UI_COMMAND_CALLS: callsPath,
            UI_VITEST_ARGS: argsPath,
          },
        });
        expect(result.status, result.stdout + result.stderr).toBe(0);
      }
      if (!scenario.compatibilityTarget) {
        env.OPENCLAW_NODE_TEST_VITEST_ARGS_JSON = readFileSync(argsPath, "utf8");
        expect(JSON.parse(env.OPENCLAW_NODE_TEST_VITEST_ARGS_JSON)).toEqual(flags);
        const forwarded: string[][] = [];
        expect(
          await runShardPlans(resolveShardPlans(env), {
            concurrency: Number(env.OPENCLAW_NODE_TEST_PLAN_CONCURRENCY),
            env,
            scratchDir: root,
            runChild: async (args, childEnv) => {
              forwarded.push(args);
              expect(childEnv.OPENCLAW_TEST_PROJECTS_PARALLEL).toBe("1");
              return 0;
            },
          }),
        ).toBe(0);
        expect(forwarded).toEqual([["ui/vitest.config.ts", "--", ...flags]]);
      }
    }
    const calls = readFileSync(callsPath, "utf8").trim().split("\n");
    expect(calls.filter((call) => call === "pnpm lint:ui:no-raw-window-open")).toHaveLength(1);
    expect(calls.filter((call) => call !== "pnpm lint:ui:no-raw-window-open")).toEqual(
      scenario.compatibilityTarget
        ? ["pnpm --dir ui test --testTimeout=30000 --isolate"]
        : scenario.shards.map(() => "node --import tsx scripts/ci-run-node-test-shard.mts"),
    );
  });

  it("keeps private Control UI servers and resource-sensitive files under one serial owner", () => {
    const trackedUiE2eFiles = execFileSync(
      "git",
      [
        "ls-files",
        "--",
        ":(glob)ui/src/**/*.e2e.test.ts",
        ":(glob)extensions/*/browser/**/*.e2e.test.ts",
        "extensions/qa-lab/src/control-ui-media-transcript.real-gateway.e2e.test.ts",
        "extensions/qa-lab/src/session-host-command-state.real-gateway.e2e.test.ts",
        "extensions/qa-lab/src/control-ui-openclaw-delegation.real-gateway.e2e.test.ts",
        "extensions/qa-lab/src/control-ui-automation-management.real-gateway.e2e.test.ts",
      ],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .toSorted();
    const helperPrivateServerFiles = trackedUiE2eFiles.filter((file) => {
      const sourceFile = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      let ownsPrivateServer = false;
      const visit = (node: ts.Node, inSuiteServer = false) => {
        if (ownsPrivateServer) {
          return;
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          // A Gateway created by the suite's server factory supplies its own UI;
          // a separate backend in a test can still use the shared UI bundle.
          if (inSuiteServer && node.expression.text === "createOpenClawTestInstance") {
            ownsPrivateServer = true;
            return;
          }
          const options = node.arguments[0];
          if (
            node.expression.text === "createControlUiE2eSuite" &&
            options &&
            ts.isObjectLiteralExpression(options)
          ) {
            for (const property of options.properties) {
              if (
                (ts.isMethodDeclaration(property) || ts.isPropertyAssignment(property)) &&
                (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
                property.name.text === "startServer"
              ) {
                visit(property, true);
              }
            }
          }
          if (
            node.expression.text === "createSessionManagementE2eSuite" &&
            node.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword
          ) {
            ownsPrivateServer = true;
            return;
          }
          const buildInfo = node.arguments[1];
          if (
            node.expression.text === "createSidebarFooterProofSuite" &&
            buildInfo &&
            !(ts.isIdentifier(buildInfo) && buildInfo.text === "undefined")
          ) {
            ownsPrivateServer = true;
            return;
          }
        }
        ts.forEachChild(node, (child) => visit(child, inSuiteServer));
      };
      visit(sourceFile);
      return ownsPrivateServer;
    });
    const directPrivateServerFiles = trackedUiE2eFiles.filter((file) => {
      const source = readFileSync(file, "utf8");
      return /\bsource:\s*true\b/u.test(source) || /\bstartControlUiE2eServer\(\s*\{/u.test(source);
    });
    const privateServerFiles = [
      ...new Set([...directPrivateServerFiles, ...helperPrivateServerFiles]),
    ].toSorted();

    expect(privateServerFiles).toEqual(uiE2ePrivateServerTestFiles);
    expect(helperPrivateServerFiles.toSorted()).toEqual([
      "ui/src/e2e/agent-file-lifecycle.real-gateway.e2e.test.ts",
      "ui/src/e2e/chat-agent-avatar.real-gateway.e2e.test.ts",
      "ui/src/e2e/chat-loading-performance.real-gateway.e2e.test.ts",
      "ui/src/e2e/chat-project-media.real-gateway.e2e.test.ts",
      "ui/src/e2e/chat-widget-sandbox.real-gateway.e2e.test.ts",
      "ui/src/e2e/child-session-load-errors.e2e.test.ts",
      "ui/src/e2e/command-palette-catalog.real-gateway.e2e.test.ts",
      "ui/src/e2e/cron-duration-save.real-gateway.e2e.test.ts",
      "ui/src/e2e/mobile-chat-session-menu.e2e.test.ts",
      "ui/src/e2e/mobile-sidebar-session-menu.e2e.test.ts",
      "ui/src/e2e/session-management.delete.e2e.test.ts",
      "ui/src/e2e/sidebar-account-footer.e2e.test.ts",
    ]);
    expect(uiE2eRealGatewayTestFiles.every((file) => uiE2eSerialTestFiles.includes(file))).toBe(
      true,
    );
    expect(uiE2eSerialTestFiles).toContain(uiE2eRuntimeBudgetTestFile);

    const config = createUiE2eVitestConfig({}, []);
    const projects = config.test?.projects as Array<{
      cacheDir: string;
      test: {
        exclude: string[];
        fileParallelism: boolean;
        globalSetup?: string[];
        include: string[];
        maxWorkers?: number;
        name: string;
        sequence: { groupOrder: number };
      };
    }>;
    const selectedFiles = (test: { exclude: string[]; include: string[] }) =>
      globSync(test.include, { cwd: process.cwd(), exclude: test.exclude }).toSorted();
    const rootTest = config.test as { exclude: string[]; include: string[] };
    expect(config.test?.globalSetup).toEqual([]);
    expect(config.test?.include).toEqual([
      "ui/src/**/*.e2e.test.ts",
      "extensions/*/browser/**/*.e2e.test.ts",
      "extensions/qa-lab/src/control-ui-media-transcript.real-gateway.e2e.test.ts",
      "extensions/qa-lab/src/session-host-command-state.real-gateway.e2e.test.ts",
      "extensions/qa-lab/src/control-ui-openclaw-delegation.real-gateway.e2e.test.ts",
      "extensions/qa-lab/src/control-ui-automation-management.real-gateway.e2e.test.ts",
    ]);
    expect(projects.map((project) => project.test.name)).toEqual([
      "ui-e2e-bundled",
      "ui-e2e-standalone",
      "ui-e2e-serial",
      "ui-e2e-serial-standalone",
    ]);
    const chromiumSetup = "test/vitest/vitest.ui-e2e.global-setup.ts";
    const bundledSetup = "test/vitest/vitest.ui-e2e.bundled.global-setup.ts";
    expect(projects.map((project) => project.test.globalSetup)).toEqual([
      [chromiumSetup, bundledSetup],
      [chromiumSetup],
      [chromiumSetup, bundledSetup],
      [chromiumSetup],
    ]);
    expect(new Set(projects.map((project) => project.cacheDir)).size).toBe(projects.length);
    expect(config.test?.maxWorkers).toBe(Math.min(2, sharedVitestConfig.test.maxWorkers));
    expect(projects[0]?.test).toMatchObject({
      fileParallelism: sharedVitestConfig.test.fileParallelism,
      maxWorkers: undefined,
      sequence: { groupOrder: 0 },
    });
    expect(projects[1]?.test).toMatchObject({
      fileParallelism: sharedVitestConfig.test.fileParallelism,
      maxWorkers: undefined,
      sequence: { groupOrder: 0 },
    });
    for (const project of projects.slice(2)) {
      expect(project.test).toMatchObject({
        exclude: expect.not.arrayContaining(uiE2eRealGatewayTestFiles),
        fileParallelism: false,
        maxWorkers: 1,
        sequence: { groupOrder: 1 },
      });
    }
    expect(projects[0]?.test.exclude).toEqual(expect.arrayContaining(uiE2eSerialTestFiles));

    const realGateway = new Set(uiE2eRealGatewayTestFiles);
    const ordinary = trackedUiE2eFiles.filter((file) => !realGateway.has(file));
    const serial = new Set(uiE2eSerialTestFiles);
    const localSelected = projects.map((project) => selectedFiles(project.test));
    expect(selectedFiles(rootTest)).toEqual(trackedUiE2eFiles);
    expect(localSelected.slice(0, 2).flat().toSorted()).toEqual(
      trackedUiE2eFiles.filter((file) => !serial.has(file)),
    );
    expect(localSelected.slice(2).flat().toSorted()).toEqual(uiE2eSerialTestFiles);
    expect(localSelected[1]).toEqual([
      "ui/src/e2e/board-fixture.e2e.test.ts",
      "ui/src/e2e/control-ui-retained-assets.e2e.test.ts",
      "ui/src/e2e/service-worker-update.e2e.test.ts",
    ]);
    expect(localSelected[3]).toEqual(uiE2ePrivateServerTestFiles);
    expect(localSelected.flat().toSorted()).toEqual(trackedUiE2eFiles);
    expect(new Set(localSelected.flat()).size).toBe(trackedUiE2eFiles.length);

    const ordinaryConfig = createUiE2eVitestConfig({ OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY: "1" }, []);
    const ordinaryProjects = ordinaryConfig.test?.projects as typeof projects;
    const ordinarySelected = ordinaryProjects.map((project) => selectedFiles(project.test));
    expect(selectedFiles(ordinaryConfig.test as typeof rootTest)).toEqual(ordinary);
    expect(ordinarySelected.slice(0, 2).flat().toSorted()).toEqual(
      ordinary.filter((file) => !serial.has(file)),
    );
    expect(ordinarySelected.slice(2).flat().toSorted()).toEqual(
      ordinary.filter((file) => serial.has(file)),
    );
    expect(ordinarySelected.flat().toSorted()).toEqual(ordinary);
    expect(new Set(ordinarySelected.flat()).size).toBe(ordinary.length);

    const bundledFile = expectDefined(ordinarySelected[0]?.[0], "bundled Control UI E2E file");
    const serialFile = expectDefined(ordinarySelected[3]?.[0], "serial Control UI E2E file");
    const narrowedByArgv = createUiE2eVitestConfig({}, ["node", "vitest", serialFile]);
    const argvProjects = narrowedByArgv.test?.projects as typeof projects;
    expect(argvProjects.map((project) => selectedFiles(project.test))).toEqual([
      [],
      [],
      [],
      [serialFile],
    ]);

    const includeDir = tempDirs.make("openclaw-ui-e2e-project-includes-");
    const includeFile = path.join(includeDir, "include.json");
    writeFileSync(includeFile, JSON.stringify([bundledFile, serialFile]));
    const narrowedByFile = createUiE2eVitestConfig(
      { OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY: "1", OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
      [],
    );
    const includeProjects = narrowedByFile.test?.projects as typeof projects;
    expect(includeProjects.map((project) => selectedFiles(project.test))).toEqual([
      [bundledFile],
      [],
      [],
      [serialFile],
    ]);

    writeFileSync(includeFile, JSON.stringify(["ui/src/e2e/*.e2e.test.ts"]));
    const narrowedByGlob = createUiE2eVitestConfig(
      { OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY: "1", OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
      [],
    );
    const globProjects = narrowedByGlob.test?.projects as typeof projects;
    const expectedGlobFiles = ordinary.filter((file) =>
      path.matchesGlob(file, "ui/src/e2e/*.e2e.test.ts"),
    );
    expect(globProjects.flatMap((project) => selectedFiles(project.test)).toSorted()).toEqual(
      expectedGlobFiles,
    );
    expect(new Set(globProjects.flatMap((project) => selectedFiles(project.test))).size).toBe(
      expectedGlobFiles.length,
    );
  });

  it("retains shared worker limits and local throttling in the bundled UI project", () => {
    const original = sharedVitestConfig.test;
    try {
      for (const [maxWorkers, fileParallelism, expectedWorkers] of [
        [1, false, 1],
        [8, true, 2],
      ] as const) {
        sharedVitestConfig.test = { ...original, maxWorkers, fileParallelism };
        const config = createUiE2eVitestConfig({}, []);
        const projects = config.test?.projects as Array<{
          test: { maxWorkers?: number; fileParallelism: boolean };
        }>;
        expect(config.test?.maxWorkers).toBe(expectedWorkers);
        expect(projects.map((project) => project.test.maxWorkers)).toEqual([
          undefined,
          undefined,
          1,
          1,
        ]);
        expect(projects.map((project) => project.test.fileParallelism)).toEqual([
          fileParallelism,
          fileParallelism,
          false,
          false,
        ]);
      }
    } finally {
      sharedVitestConfig.test = original;
    }
  });

  it("uses the target-owned UI project capability for frozen manual matrices and commands", () => {
    for (const [runnerBackend, legacyJobCount] of [
      ["blacksmith", 4],
      ["github", 14],
      ["hybrid", 14],
    ] as const) {
      for (const uiE2eProjectsCapability of [false, true]) {
        const jobCount = uiE2eProjectsCapability ? 13 : legacyJobCount;
        const manifest = runCiManifestFixture({
          bundledPlanner: true,
          eventName: "workflow_dispatch",
          historicalCompatibility: false,
          runnerBackend,
          uiE2eProjectsCapability,
        });
        expect(manifest.status, manifest.output).toBe(0);
        expect(manifest.outputs.frozen_target).toBe("true");
        expect(manifest.outputs.compatibility_target).toBe("false");
        expect(
          JSON.parse(
            expectDefined(manifest.outputs.ui_e2e_matrix, `${runnerBackend} UI E2E matrix`),
          ),
        ).toEqual({
          include: Array.from({ length: jobCount }, (_, index) => {
            const shard = index + 1;
            return {
              shard,
              shard_count: jobCount,
              task: shard === jobCount ? "browser-extension" : "control-ui",
              vitest_shard_count: jobCount - 1,
            };
          }),
        });
      }
    }

    const uiE2E = readCiWorkflow().jobs["checks-ui-e2e"];
    const scenario = expectDefined(
      uiE2E.steps.find((step: WorkflowStep) => step.name === "Test Control UI end-to-end"),
      "Control UI E2E suite",
    );
    const commandRoot = tempDirs.make("openclaw-ui-e2e-project-command-");
    const commandBin = path.join(commandRoot, "bin");
    const commandArgs = path.join(commandRoot, "args");
    mkdirSync(commandBin);
    writeFileSync(
      path.join(commandBin, "node"),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$UI_E2E_COMMAND_ARGS"\n',
      { mode: 0o755 },
    );
    const runCommand = (env: Record<string, string>) => {
      const result = runWorkflowShellScript(expectDefined(scenario.run, "UI E2E command"), {
        cwd: commandRoot,
        env: {
          ...process.env,
          ...env,
          PATH: `${commandBin}:${process.env.PATH ?? ""}`,
          UI_E2E_COMMAND_ARGS: commandArgs,
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return readFileSync(commandArgs, "utf8").trim().split("\n");
    };
    expect(runCommand({ VITEST_SHARD_COUNT: "3", VITEST_SHARD_INDEX: "1" })).toEqual([
      "scripts/run-vitest.mjs",
      "run",
      "--config",
      "test/vitest/vitest.ui-e2e.config.ts",
      "--configLoader",
      "runner",
      "--shard",
      "1/3",
    ]);

    expect(
      evaluateWorkflowExpression(`\${{ ${uiE2E.if} }}`, {
        eventName: "workflow_dispatch",
        preflightOutputs: { compatibility_target: "true", run_ui_tests: "true" },
        repository: "openclaw/openclaw",
        runAttempt: 1,
      }),
    ).toBe(false);
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
    expect(uiE2e.strategy["max-parallel"]).toBe(14);
    expect(uiE2e.strategy.matrix).toBe("${{ fromJson(needs.preflight.outputs.ui_e2e_matrix) }}");
    const expectedUiE2eMatrices = [6, 12].map((vitestShardCount) => ({
      include: Array.from({ length: vitestShardCount + 1 }, (_, index) => {
        const shard = index + 1;
        return {
          shard,
          shard_count: vitestShardCount + 1,
          task: shard === vitestShardCount + 1 ? "browser-extension" : "control-ui",
          vitest_shard_count: vitestShardCount,
        };
      }),
    }));
    for (const runnerBackend of ["blacksmith", "github", "hybrid"] as const) {
      for (const eventName of ["push", "pull_request"] as const) {
        for (const runAttempt of ["1", "2", ""]) {
          const manifest = runCiManifestFixture({
            bundledPlanner: true,
            changedPaths: [],
            eventName,
            historicalCompatibility: false,
            runnerBackend,
            uiE2eProjectsCapability: true,
            scopeEnv: { GITHUB_RUN_ATTEMPT: runAttempt },
          });
          const assertionName = `${runnerBackend} ${eventName} attempt ${runAttempt || "missing"}`;
          expect(manifest.status, manifest.output).toBe(0);
          expect(
            JSON.parse(expectDefined(manifest.outputs.ui_e2e_matrix, assertionName)),
            assertionName,
          ).toEqual(
            expectedUiE2eMatrices[
              (runnerBackend === "blacksmith" || runnerBackend === "hybrid") && runAttempt === "1"
                ? 0
                : 1
            ],
          );
        }
      }
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
    expect(uiE2eSetup.uses).toBe("./.ci-harness/.github/actions/setup-node-env");
    const expectedSharedUiE2eSetup = {
      "cache-mode": "${{ needs.preflight.outputs.cache_mode }}",
      "node-version": "24.x",
      "install-bun": "false",
      "dependency-cache": expect.any(String),
    } as const;
    const expectedUiE2eSetup = {
      ...expectedSharedUiE2eSetup,
      "restore-test-caches":
        "${{ (needs.preflight.outputs.runner_profile == 'github' || needs.preflight.outputs.runner_profile == 'hybrid') && 'true' || 'false' }}",
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

    // Failed-job retries reuse the six-row matrix while live routing selects
    // hosted runners. Both widths must retain the cache and contributor boundaries.
    const routedUiE2eJobs = [
      ...expectedUiE2eMatrices
        .flatMap(({ include }) => include)
        .map((matrix) => ({
          job: uiE2e,
          name: `checks-ui-e2e (${matrix.shard}/${matrix.shard_count})`,
          setup: uiE2eSetup,
          matrix,
          blacksmithRunner:
            matrix.task === "control-ui"
              ? "blacksmith-32vcpu-ubuntu-2404"
              : "blacksmith-8vcpu-ubuntu-2404",
        })),
      {
        job: uiE2eRealGateway,
        name: "checks-ui-e2e-real-gateway",
        setup: realGatewaySetup,
        matrix: {},
        blacksmithRunner: "blacksmith-16vcpu-ubuntu-2404",
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
        expected: { blacksmith: true, dependencyCache: "true" },
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
        expected: { blacksmith: false, dependencyCache: "false" },
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
        expected: { blacksmith: true, dependencyCache: "true" },
      },
      {
        name: "same-repo pull request retry",
        context: {
          eventName: "pull_request",
          headRepository: "openclaw/openclaw",
          repository: "openclaw/openclaw",
          runAttempt: 2,
        },
        expected: { blacksmith: false, dependencyCache: "false" },
      },
      {
        name: "same-repo pull request with hybrid backend retry",
        context: {
          eventName: "pull_request",
          headRepository: "openclaw/openclaw",
          repository: "openclaw/openclaw",
          runnerBackend: "hybrid",
          runAttempt: 2,
        },
        expected: { blacksmith: false, dependencyCache: "false" },
      },
      {
        name: "canonical hybrid push retry",
        context: {
          eventName: "push",
          repository: "openclaw/openclaw",
          runnerBackend: "hybrid",
          runAttempt: 2,
        },
        expected: { blacksmith: false, dependencyCache: "false" },
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
        expected: { blacksmith: true, dependencyCache: "false" },
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
        expected: { blacksmith: false, dependencyCache: "false" },
      },
      {
        name: "workflow dispatch",
        context: {
          eventName: "workflow_dispatch",
          repository: "openclaw/openclaw",
          runAttempt: 1,
        },
        expected: { blacksmith: false, dependencyCache: "false" },
      },
      {
        name: "canonical push retry",
        context: {
          eventName: "push",
          repository: "openclaw/openclaw",
          runAttempt: 2,
        },
        expected: { blacksmith: true, dependencyCache: "true" },
      },
    ] as const;
    for (const { blacksmithRunner, job, matrix, name: jobName, setup } of routedUiE2eJobs) {
      for (const { context, expected, name: scenarioName } of routingScenarios) {
        const assertionName = `${jobName}: ${scenarioName}`;
        const expectedRunner = expected.blacksmith ? blacksmithRunner : "ubuntu-24.04";
        expect(
          evaluateWorkflowExpression(job["runs-on"], { ...context, matrix }),
          assertionName,
        ).toBe(expectedRunner);
        expect(
          evaluateWorkflowExpression(setup.with?.["dependency-cache"], {
            ...context,
            matrix,
            runnerEnvironment: expected.blacksmith ? "self-hosted" : "github-hosted",
          }),
          assertionName,
        ).toBe(expected.dependencyCache);
        expect(setup.with?.["cache-mode"], assertionName).toBe(
          "${{ needs.preflight.outputs.cache_mode }}",
        );
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
      VITEST_SHARD_INDEX: "${{ matrix.shard }}",
      VITEST_SHARD_COUNT: "${{ matrix.vitest_shard_count }}",
    });
    expect(scenario.run).not.toContain("--project");
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

    const realGatewaySteps = uiE2eRealGateway.steps.filter((step: WorkflowStep) =>
      step.name?.includes("with a real Gateway"),
    );
    expect(realGatewaySteps).toHaveLength(1);
    const realGatewayStep = expectDefined(
      realGatewaySteps[0],
      "combined real-Gateway Control UI E2E suite",
    );
    expect(realGatewayStep.run).not.toContain("--retry");
    expect(realGatewayStep.run).not.toContain("--hookTimeout");
    expect(realGatewayStep.run).not.toContain("--testTimeout");

    const proofUploadIndex = uiE2eRealGateway.steps.findIndex(
      (step: WorkflowStep) => step.name === "Upload sanitized Control UI real-Gateway proof",
    );
    const proofUpload = uiE2eRealGateway.steps[proofUploadIndex];
    const realGatewayIndex = uiE2eRealGateway.steps.indexOf(realGatewayStep);
    // Same-origin admission compares exact build IDs, including the build timestamp.
    // Include private QA so media bootstrap cannot rebuild runtime behind the UI.
    const realGatewayBuild = expectDefined(
      uiE2eRealGateway.steps.find((step: WorkflowStep) => step.run === "pnpm build:ci-artifacts"),
      "paired runtime and Control UI build",
    );
    expect(realGatewayBuild.if).toBeUndefined();
    expect(realGatewayBuild["continue-on-error"]).toBeUndefined();
    expect(realGatewayBuild.env).toEqual({ OPENCLAW_BUILD_PRIVATE_QA: "1" });
    const realGatewayBuildIndex = uiE2eRealGateway.steps.indexOf(realGatewayBuild);
    expect(realGatewayBuildIndex).toBeGreaterThan(uiE2eRealGateway.steps.indexOf(realGatewaySetup));
    expect(realGatewayBuildIndex).toBeLessThan(realGatewayIndex);
    expect(realGatewayStep.env).toEqual({
      FROZEN_TARGET: "${{ needs.preflight.outputs.frozen_target }}",
      OPENCLAW_CAPTURE_UI_PROOF:
        "${{ github.event_name == 'workflow_dispatch' && inputs.capture_ui_proof && '1' || '0' }}",
      OPENCLAW_UI_E2E_ARTIFACT_DIR: proofUpload.with.path,
    });
    expect(proofUploadIndex).toBeGreaterThan(realGatewayIndex);
  });

  it.each([
    { failed: false, captured: false },
    { failed: false, captured: true },
    { failed: true, captured: false },
    { failed: true, captured: true },
  ])("uploads only captured synthetic widget failures: %j", ({ failed, captured }) => {
    const artifactRoot = ".artifacts/control-ui-e2e/control-ui-authenticated-widget-sandbox-*";
    const timeline = `${artifactRoot}/widget-prompt-failure.json`;
    for (const job of [
      readCiWorkflow().jobs["checks-ui-e2e"],
      readWorkflow(".github/workflows/openclaw-repo-e2e-reusable.yml").jobs.test,
    ]) {
      const upload = expectDefined(
        job.steps.find(
          (step: WorkflowStep) => step.name === "Upload synthetic widget prompt failure evidence",
        ),
        "synthetic widget upload",
      );
      expect(
        evaluateWorkflowExpression(`\${{ ${upload.if} }}`, {
          eventName: "workflow_dispatch",
          repository: "openclaw/openclaw",
          runAttempt: 1,
          failed,
          fileHashes: captured ? { [timeline]: "present" } : {},
        }),
      ).toBe(failed && captured);
      expect(upload.uses).toBe(UPLOAD_ARTIFACT_V7);
      expect(upload.with.path.trim().split("\n")).toEqual([
        timeline,
        `${artifactRoot}/*.png`,
        `${artifactRoot}/*.webm`,
      ]);
      expect(upload.with["retention-days"]).toBe(7);
      expect(upload.with["if-no-files-found"]).toBe("error");
    }
  });

  it.each([
    { frozen: false, prebuilt: true, childExit: 0 },
    { frozen: true, prebuilt: true, childExit: 0 },
    { frozen: true, prebuilt: false, childExit: 0 },
    { frozen: false, prebuilt: false, childExit: 0 },
    { frozen: true, prebuilt: true, childExit: 42 },
  ])(
    "selects the complete real-Gateway command without retrying failures (frozen: $frozen, prebuilt: $prebuilt, exit: $childExit)",
    ({ frozen, prebuilt, childExit }) => {
      const step = expectDefined(
        readCiWorkflow().jobs["checks-ui-e2e-real-gateway"].steps.find(
          (candidate: WorkflowStep) =>
            candidate.name === "Test Control UI suites with a real Gateway",
        ),
        "real-Gateway command",
      );
      const directory = tempDirs.make("openclaw-real-gateway-command-");
      const bin = path.join(directory, "bin");
      const argsPath = path.join(directory, "args");
      const callsPath = path.join(directory, "calls");
      const prebuiltConfig = "test/vitest/vitest.ui-e2e-prebuilt.config.ts";
      const serialConfig = "test/vitest/vitest.ui-e2e.config.ts";
      mkdirSync(bin);
      mkdirSync(path.join(directory, "test/vitest"), { recursive: true });
      writeFileSync(path.join(directory, serialConfig), "export default {};\n");
      if (prebuilt) {
        writeFileSync(path.join(directory, prebuiltConfig), "export default {};\n");
      }
      writeFileSync(
        path.join(bin, "node"),
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$REAL_GATEWAY_COMMAND_ARGS"\nprintf "called\\n" >> "$REAL_GATEWAY_COMMAND_CALLS"\nexit "$REAL_GATEWAY_COMMAND_EXIT"\n',
        { mode: 0o755 },
      );
      const result = runWorkflowShellScript(expectDefined(step.run, "real-Gateway script"), {
        cwd: directory,
        env: {
          ...process.env,
          FROZEN_TARGET: String(frozen),
          REAL_GATEWAY_COMMAND_ARGS: argsPath,
          REAL_GATEWAY_COMMAND_CALLS: callsPath,
          REAL_GATEWAY_COMMAND_EXIT: String(childExit),
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      });
      const missingCurrentConfig = !prebuilt && !frozen;
      expect(result.status, result.stdout + result.stderr).toBe(
        missingCurrentConfig ? 1 : childExit,
      );
      if (missingCurrentConfig) {
        expect(result.stderr).toContain(`Current target is missing ${prebuiltConfig}`);
        expect(existsSync(callsPath)).toBe(false);
        return;
      }
      expect(readFileSync(callsPath, "utf8").trim().split("\n")).toEqual(["called"]);
      const args = readFileSync(argsPath, "utf8").trim().split("\n");
      expect(args.slice(0, 6)).toEqual([
        "scripts/run-vitest.mjs",
        "run",
        "--config",
        prebuilt ? prebuiltConfig : serialConfig,
        "--configLoader",
        "runner",
      ]);
      expect(args.slice(6).toSorted()).toEqual(uiE2eRealGatewayTestFiles.toSorted());
      expect(
        resolveRunVitestSpawnEnv(
          { CI: "true", OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "120000" },
          args.slice(1),
        ).OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS,
      ).toBe("300000");
    },
  );

  it("builds artifacts once and smoke-tests the built CLI with Node and Bun", () => {
    const workflow = readCiWorkflow();
    const buildArtifactSteps = workflow.jobs["build-artifacts"].steps;
    const setupStep = buildArtifactSteps.find(
      (step: WorkflowStep) => step.name === "Setup Node environment",
    );
    const buildDistStep = buildArtifactSteps.find(
      (step: WorkflowStep) => step.name === "Build dist",
    );
    const nodeHelpSmoke = buildArtifactSteps.find(
      (step: WorkflowStep) => step.name === "Smoke test CLI launcher help",
    );
    const nodeStatusSmoke = buildArtifactSteps.find(
      (step: WorkflowStep) => step.name === "Smoke test CLI launcher status json",
    );
    const bunSmoke = buildArtifactSteps.find(
      (step: WorkflowStep) => step.name === "Smoke test built CLI with Bun",
    );

    expect(
      buildArtifactSteps.some(
        (step: WorkflowStep) =>
          typeof step.uses === "string" && step.uses.endsWith("/ensure-base-commit"),
      ),
    ).toBe(false);
    expect(setupStep.with["install-bun"]).toBe("true");
    expect(buildDistStep.run).toBe("pnpm build:ci-artifacts");
    expect(buildArtifactSteps.map((step: WorkflowStep) => step.name)).not.toContain(
      "Build Control UI",
    );
    expect(buildArtifactSteps.some((step: WorkflowStep) => step.run === "pnpm ui:build")).toBe(
      false,
    );
    expect(nodeHelpSmoke.run).toBe("node openclaw.mjs --help");
    expect(nodeStatusSmoke.run).toBe("node openclaw.mjs status --json --timeout 1");
    expect(bunSmoke.run).toContain("bun openclaw.mjs --help");
    expect(bunSmoke.run).toContain("bun openclaw.mjs status --json --timeout 1");
  });

  it("keeps automatic source-only Control UI locale drift advisory and manual CI strict", () => {
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
    expect(workflow.jobs.preflight.outputs.strict_control_ui_i18n).toBe(
      "${{ github.event_name == 'workflow_dispatch' && !inputs.release_gate && 'true' || steps.changed_scope.outputs.strict_control_ui_i18n }}",
    );
    expect(
      evaluateWorkflowExpression(
        "${{ github.event_name == 'workflow_dispatch' && !inputs.release_gate && 'true' || 'false' }}",
        {
          eventName: "workflow_dispatch",
          releaseGate: false,
          repository: "openclaw/openclaw",
          runAttempt: 1,
        },
      ),
    ).toBe("true");
    expect(
      evaluateWorkflowExpression(
        "${{ github.event_name == 'workflow_dispatch' && !inputs.release_gate && 'true' || 'false' }}",
        {
          eventName: "workflow_dispatch",
          releaseGate: true,
          repository: "openclaw/openclaw",
          runAttempt: 1,
        },
      ),
    ).toBe("false");
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
      'dispatch_child ci.yml "$dispatch_run_name"',
    );
  });

  it("splits native source verification from generated locale parity", () => {
    const workflow = readCiWorkflow();
    const manifestStep = workflow.jobs.preflight.steps.find(
      (step: WorkflowStep) => step.name === "Build CI manifest",
    );
    const localeJob = workflow.jobs["native-i18n"];
    const sourceStep = localeJob.steps.find(
      (step: WorkflowStep) => step.name === "Verify native app i18n source",
    );
    const parityStep = localeJob.steps.find(
      (step: WorkflowStep) => step.name === "Check native app generated locale parity",
    );
    const packageScripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
    const fullReleaseSource = readFileSync(".github/workflows/full-release-validation.yml", "utf8");
    const fullReleaseCiCase = expectDefined(
      fullReleaseSource.match(/case "\$CHILD_WORKFLOW_KIND" in\n\s+ci\)([\s\S]*?)\n\s+;;/u)?.[1],
      "Full Release CI dispatch case",
    );

    expect(packageScripts["native:i18n:baseline"]).toContain("baseline --write");
    expect(packageScripts["native:i18n:verify"]).toContain(" verify");
    expect(workflow.jobs.preflight.outputs.strict_native_i18n).toBe(
      "${{ github.event_name == 'workflow_dispatch' && !inputs.release_gate && 'true' || steps.changed_scope.outputs.strict_native_i18n }}",
    );
    expect(manifestStep.env.OPENCLAW_CI_RUN_NATIVE_I18N).toBe(
      "${{ github.event_name == 'workflow_dispatch' && 'true' || steps.changed_scope.outputs.run_native_i18n || 'false' }}",
    );
    expect(sourceStep.run).toContain("pnpm native:i18n:verify");
    expect(sourceStep.run).toContain("Historical release targets");
    expect(parityStep.if).toBe("${{ needs.preflight.outputs.strict_native_i18n == 'true' }}");
    expect(parityStep.run).toContain("pnpm native:i18n:check");
    expect(parityStep.run).not.toContain("pnpm android:i18n:check");
    expect(parityStep.run).not.toContain("pnpm apple:i18n:check");
    expect(fullReleaseCiCase).toContain(
      'args=(-f target_ref="$TARGET_SHA" -f release_scope="$ci_release_scope" -f include_android="$include_android" -f dispatch_id="$dispatch_id")',
    );
    expect(fullReleaseCiCase).toContain('dispatch_child ci.yml "$dispatch_run_name"');
    expect(fullReleaseCiCase).not.toContain("release_gate");
  });

  it("measures startup memory before the built artifact-check wave", () => {
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
    // RSS measures an unloaded command on every runner, including Blacksmith.
    const startupMemory = verifierStep.run.indexOf('run_verifier "startup-memory"');
    const memoryBarrier = verifierStep.run.indexOf("\nwait_checks\n", startupMemory);
    expect(memoryBarrier).toBeGreaterThan(startupMemory);
    expect(memoryBarrier).toBeLessThan(
      verifierStep.run.indexOf('run_verifier "doctor-plugin-index"'),
    );
    expect(verifierStep.env.OPENCLAW_STARTUP_MEMORY_PLUGINS_LIST_MB).toBe(
      "${{ runner.environment == 'github-hosted' && '425' || '400' }}",
    );
    expect(verifierStep.env.PARALLEL_BUILT_VERIFIERS).toBe(
      "${{ runner.environment != 'github-hosted' && 'true' || 'false' }}",
    );
    expect(verifierStep.run).toContain(
      'OPENCLAW_VITEST_FS_MODULE_CACHE_PATH="${RUNNER_TEMP}/vitest-module-cache/${name}"',
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
    expect(verifierStep.env.RUN_CHANNELS).toBe("${{ needs.preflight.outputs.run_checks }}");
    expect(verifierStep.env.FROZEN_TARGET).toBe("${{ needs.preflight.outputs.frozen_target }}");
    const pluginSingleton = verifierStep.run.indexOf(
      'run_verifier "plugin-singleton" pnpm test:build:singleton',
    );
    const pluginWriterBarrier = verifierStep.run.indexOf("\nwait_checks\n", pluginSingleton);
    const parallelGatewayWatch = verifierStep.run.indexOf(
      'if [ "$RUN_GATEWAY_WATCH" = "true" ] && [ "$PARALLEL_GATEWAY_WATCH" = "true" ]; then',
    );
    const gatewayWriterBarrier = verifierStep.run.indexOf(
      "\n  wait_checks\n",
      parallelGatewayWatch,
    );
    const firstReader = verifierStep.run.indexOf(
      'run_verifier "doctor-plugin-index" run_doctor_plugin_index',
    );
    const parallelDiscord = verifierStep.run.indexOf(
      'if [ "$RUN_CHANNELS" = "true" ] && [ "$PARALLEL_BUILT_VERIFIERS" = "true" ]; then',
    );
    const readerWaveBarrier = verifierStep.run.indexOf("\nwait_checks\n", parallelDiscord);
    const hostedDiscord = verifierStep.run.indexOf(
      'if [ "$RUN_CHANNELS" = "true" ] && [ "$PARALLEL_BUILT_VERIFIERS" != "true" ]; then',
    );
    expect(pluginWriterBarrier).toBeGreaterThan(pluginSingleton);
    expect(parallelGatewayWatch).toBeGreaterThan(pluginWriterBarrier);
    expect(gatewayWriterBarrier).toBeGreaterThan(parallelGatewayWatch);
    expect(firstReader).toBeGreaterThan(gatewayWriterBarrier);
    expect(parallelDiscord).toBeGreaterThan(firstReader);
    expect(readerWaveBarrier).toBeGreaterThan(parallelDiscord);
    expect(hostedDiscord).toBeGreaterThan(readerWaveBarrier);
    expect(verifierStep.run.slice(parallelDiscord, readerWaveBarrier)).toContain(
      'start_check "discord-component-attachments" run_discord_component_attachments',
    );
    expect(verifierStep.run.slice(hostedDiscord)).toContain(
      'start_check "discord-component-attachments" run_discord_component_attachments',
    );
    expect(verifierStep.run).toContain('["discord-component-attachments"]="skipped"');
    expect(verifierStep.run).toContain("OPENCLAW_E2E_USE_PREBUILT_DIST=1 OPENCLAW_E2E_WORKERS=1");
    expect(verifierStep.run).toContain("OPENCLAW_E2E_VERBOSE=1 OPENCLAW_VITEST_MAX_WORKERS=1");
    const upload = steps.find(
      (entry: WorkflowStep) => entry.name === "Upload Discord component attachment proof",
    );
    expect(upload.if).toBe("always() && needs.preflight.outputs.run_checks == 'true'");
    expect(upload.with.path).toContain("${{ runner.temp }}/discord-component-attachments.json");
    expect(upload.with.path).toContain("${{ runner.temp }}/discord-component-attachments.log");
    // Every verifier reports through the shared results map so a failure can
    // never be swallowed by the wave.
    for (const name of [
      "doctor-plugin-index",
      "plugin-singleton",
      "sqlite-session-lifecycle",
      "startup-memory",
    ]) {
      expect(verifierStep.run).toContain(`run_verifier "${name}"`);
      expect(verifierStep.run).toContain(`["${name}"]="skipped"`);
    }
    expect(verifierStep.run).toContain(
      "for name in channels core-support-boundary discord-component-attachments doctor-plugin-index gateway-watch plugin-singleton sqlite-session-lifecycle startup-memory tui-pty; do",
    );
  });

  it.each([
    { label: "one passing named case", state: "passed", frozen: false, expected: 0 },
    { label: "a passing frozen case", state: "passed", frozen: true, expected: 0 },
    { label: "a failed named case", state: "failed", frozen: false, expected: 1 },
    { label: "a skipped current case", state: "skipped", frozen: false, expected: 1 },
    { label: "a skipped frozen case", state: "skipped", frozen: true, expected: 1 },
    { label: "a missing current case", state: "absent", frozen: false, expected: 1 },
    { label: "an unavailable historical case", state: "absent", frozen: true, expected: 0 },
    { label: "a failed suite", state: "suite-failed", frozen: false, expected: 1 },
    { label: "malformed JSON", state: "malformed", frozen: true, expected: 1 },
  ])("validates Discord built proof with $label", ({ state, frozen, expected }) => {
    const steps = readCiWorkflow().jobs["build-artifacts"].steps;
    const step = steps.find((entry: WorkflowStep) => entry.name === "Run built artifact checks");
    const validator = expectDefined(
      step.run.match(
        /node --input-type=module <<'DISCORD_PROOF_REPORT'\n([\s\S]*?)\nDISCORD_PROOF_REPORT/u,
      )?.[1],
      "Discord proof report validator",
    );
    const scratch = tempDirs.make("openclaw-discord-proof-report-");
    const fullName =
      "Discord show_widget contextual presenter process proof preserves component attachment filenames through the public Gateway message action";
    const report = {
      success: true,
      numFailedTestSuites: state === "suite-failed" ? 1 : 0,
      numFailedTests: state === "failed" ? 1 : 0,
      numPassedTests: state === "passed" ? 1 : 0,
      testResults: [
        {
          name: path.resolve(
            "test/e2e/qa-lab/plugins/discord-show-widget-contextual-presenter.e2e.test.ts",
          ),
          status: "passed",
          assertionResults: state === "absent" ? [] : [{ fullName, status: state }],
        },
      ],
    };
    writeFileSync(
      path.join(scratch, "discord-component-attachments.json"),
      state === "malformed" ? "{" : JSON.stringify(report),
    );
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", validator], {
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: scratch, FROZEN_TARGET: String(frozen) },
    });
    expect(result.status, result.stderr).toBe(expected);
    if (state === "absent" && frozen) {
      expect(result.stdout).toContain("[skip] Frozen target predates the named Discord");
    }
  });

  it.each([
    { frozen: false, present: true, expected: true },
    { frozen: false, present: false, expected: true },
    { frozen: true, present: true, expected: true },
    { frozen: true, present: false, expected: false },
  ])(
    "gates browser native-host proof (frozen=$frozen, present=$present)",
    ({ frozen, present, expected }) => {
      const step = readCiWorkflow().jobs["build-artifacts"].steps.find(
        (entry: WorkflowStep) => entry.name === "Verify built browser native host",
      );
      const file = "extensions/browser/src/browser/extension-install.native-host.e2e.test.ts";
      expect(
        step.if === undefined ||
          evaluateWorkflowExpression(step.if, {
            eventName: "workflow_dispatch",
            repository: "openclaw/openclaw",
            runAttempt: 1,
            frozenTarget: frozen,
            fileHashes: present ? { [file]: "fixture-hash" } : {},
          }),
      ).toBe(expected);
    },
  );

  it.each([
    "passed",
    "skipped",
    "pending",
    "todo",
    "absent",
    "wrong-name",
    "wrong-file",
    "failed",
    "suite-failed",
    "duplicate",
    "malformed",
    "missing-report",
  ])("validates browser native-host proof report: %s", (state) => {
    const steps = readCiWorkflow().jobs["build-artifacts"].steps;
    const step = steps.find(
      (entry: WorkflowStep) => entry.name === "Verify built browser native host",
    );
    expect(steps.indexOf(step)).toBeGreaterThan(
      steps.findIndex((entry: WorkflowStep) => entry.name === "Build dist"),
    );
    expect(step["continue-on-error"]).not.toBe(true);
    const root = tempDirs.make("openclaw-browser-proof-report-");
    const file = "extensions/browser/src/browser/extension-install.native-host.e2e.test.ts";
    const fullName =
      "native host registration launches with the exact custom installation context when Chrome has no selectors";
    const assertion = {
      fullName: state === "wrong-name" ? "another test" : fullName,
      status: ["skipped", "pending", "todo", "failed"].includes(state) ? state : "passed",
    };
    const assertions =
      state === "absent" ? [] : state === "duplicate" ? [assertion, assertion] : [assertion];
    const report = {
      success: state !== "failed" && state !== "suite-failed",
      numFailedTestSuites: state === "suite-failed" ? 1 : 0,
      numPendingTestSuites: 0,
      numTotalTests: assertions.length,
      numPassedTests: assertions.filter((entry) => entry.status === "passed").length,
      numFailedTests: state === "failed" ? 1 : 0,
      numPendingTests: ["skipped", "pending"].includes(state) ? 1 : 0,
      numTodoTests: state === "todo" ? 1 : 0,
      testResults: [
        {
          name: path.join(root, state === "wrong-file" ? "other.test.ts" : file),
          status: state === "suite-failed" ? "failed" : "passed",
          assertionResults: assertions,
        },
      ],
    };
    mkdirSync(path.join(root, "scripts"));
    // A previous successful report must not satisfy a run that emits no report.
    writeFileSync(path.join(root, "browser-native-host.json"), JSON.stringify(report));
    // Execute the workflow's shell and validator; replace only the expensive
    // Vitest process with a controlled reporter at its external boundary.
    writeFileSync(
      path.join(root, "scripts/run-vitest.mjs"),
      `
      import fs from 'node:fs';
      const args = process.argv.slice(2);
      fs.writeFileSync('invocation.json', JSON.stringify({ args, prebuilt: process.env.OPENCLAW_E2E_USE_PREBUILT_DIST }));
      const outputIndex = args.indexOf('--outputFile.json');
      if (outputIndex >= 0 && ${JSON.stringify(state)} !== 'missing-report') {
        fs.writeFileSync(args[outputIndex + 1], ${JSON.stringify(state === "malformed" ? "{" : JSON.stringify(report))});
      }
    `,
    );
    const result = runWorkflowShellScript(step.run, {
      cwd: root,
      env: { ...process.env, ...step.env, RUNNER_TEMP: root },
    });
    expect(result.status, result.stderr).toBe(state === "passed" ? 0 : 1);
    if (state === "passed") {
      expect(JSON.parse(readFileSync(path.join(root, "invocation.json"), "utf8"))).toEqual({
        prebuilt: "1",
        args: [
          "run",
          "--config",
          "test/vitest/vitest.e2e.config.ts",
          file,
          "--reporter=default",
          "--reporter=json",
          "--outputFile.json",
          path.join(root, "browser-native-host.json"),
        ],
      });
    }
  });

  it.each([
    { selected: false, exitCode: 0 },
    { selected: true, exitCode: 0 },
    { selected: true, exitCode: 1 },
    { selected: true, exitCode: 143 },
  ])(
    "runs the built SQLite verifier (selected=$selected, exit=$exitCode)",
    ({ selected, exitCode }) => {
      const workflow = readCiWorkflow();
      const additionalJob = workflow.jobs["check-additional-shard"];
      const additionalRunStep = additionalJob.steps.find(
        (step: WorkflowStep) => step.name === "Run additional check shard",
      );
      const verifier = workflow.jobs["build-artifacts"].steps.find(
        (step: WorkflowStep) => step.name === "Run built artifact checks",
      );
      const selection = expectDefined(
        verifier.run.match(
          /if \[ "\$RUN_SQLITE_SESSION_LIFECYCLE" = "true" \]; then\n[\s\S]*?\nfi/u,
        )?.[0],
        "scoped SQLite verifier invocation",
      );

      expect(readFrozenAdditionalCheckRows()).not.toContainEqual(
        expect.objectContaining({ group: "sqlite-session-flip-proof" }),
      );
      expect(additionalRunStep.run).not.toContain("sqlite-session-flip-proof)");
      expect(workflow.jobs["sqlite-session-lifecycle"]).toBeUndefined();
      expect(verifier.env.RUN_SQLITE_SESSION_LIFECYCLE).toBe(
        "${{ needs.preflight.outputs.run_sqlite_session_lifecycle }}",
      );
      expect(workflow.jobs["ci-gate"].needs).toContain("build-artifacts");
      expect(workflow.jobs["ci-gate"].needs).not.toContain("sqlite-session-lifecycle");
      const memoryBarrier = verifier.run.indexOf(
        "\nwait_checks\n",
        verifier.run.indexOf('run_verifier "startup-memory"'),
      );
      expect(verifier.run.indexOf(selection)).toBeGreaterThan(memoryBarrier);
      expect(verifier.run.indexOf(selection)).toBeLessThan(
        verifier.run.indexOf('start_check "channels"'),
      );
      const root = tempDirs.make("openclaw-sqlite-verifier-");
      mkdirSync(path.join(root, "scripts"));
      writeFileSync(
        path.join(root, "scripts/run-vitest.mjs"),
        `
      import { writeFileSync } from "node:fs";
      writeFileSync("invocation.json", JSON.stringify({
        args: process.argv.slice(2),
        prebuilt: process.env.OPENCLAW_E2E_USE_PREBUILT_DIST,
        watchdog: process.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS,
      }));
      process.exit(${exitCode});
    `,
      );
      // Exercise the selected command at the existing verifier boundary. The full
      // wave's associative-array scheduler needs native CI's Bash for execution.
      const result = runWorkflowShellScript(
        `
      run_verifier() {
        printf '%s\\n' "$1" > verifier-name
        shift
        "$@"
      }
      ${selection}
    `,
        { cwd: root, env: { ...process.env, RUN_SQLITE_SESSION_LIFECYCLE: String(selected) } },
      );
      expect(result.status, result.stderr).toBe(selected ? exitCode : 0);
      expect(existsSync(path.join(root, "invocation.json"))).toBe(selected);
      if (selected) {
        expect(readFileSync(path.join(root, "verifier-name"), "utf8").trim()).toBe(
          "sqlite-session-lifecycle",
        );
        expect(JSON.parse(readFileSync(path.join(root, "invocation.json"), "utf8"))).toEqual({
          args: [
            "run",
            "--config",
            "test/vitest/vitest.e2e.config.ts",
            "test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts",
          ],
          prebuilt: "1",
          watchdog: "660000",
        });
      }
    },
  );

  it("restores dist in PR CI and saves it only from the trusted warmer", () => {
    const workflow = readCiWorkflow();
    const buildArtifactSteps = workflow.jobs["build-artifacts"].steps;
    const stepNames = buildArtifactSteps.map((step: WorkflowStep) => step.name);
    const restoreStep = buildArtifactSteps.find(
      (step: WorkflowStep) => step.name === "Restore dist build cache",
    );
    const buildDistStep = buildArtifactSteps.find(
      (step: WorkflowStep) => step.name === "Build dist",
    );
    const warmer = parse(readFileSync(".github/workflows/vitest-cache-warm.yml", "utf8"));
    const warmerSteps = warmer.jobs.warm.steps as WorkflowStep[];
    const saveStep = expectDefined(
      warmerSteps.find((step) => step.name === "Save dist build cache"),
      "trusted dist cache save",
    );

    expect(stepNames.indexOf("Restore dist build cache")).toBeLessThan(
      stepNames.indexOf("Build dist"),
    );
    expect(stepNames.indexOf("Build dist")).toBeLessThan(
      stepNames.indexOf("Pack built runtime artifacts"),
    );
    expect(stepNames).not.toContain("Save dist build cache");
    expect(restoreStep.uses).toBe(CACHE_V5);
    expect(buildDistStep.if).toBe("steps.dist_build_cache.outputs.cache-hit != 'true'");
    expect(saveStep.uses).toBe("actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9");
    expect(saveStep.if).toContain("steps.setup-node-env.outputs.cache-mode == 'read-write'");
    expect(saveStep.with?.key).toBe("${{ runner.os }}-dist-build-v3-${{ github.sha }}");
    expect(restoreStep.with.path).toContain("dist/");
    expect(restoreStep.with.path).toContain("dist-runtime/");
    expect(restoreStep.with.path).toContain("packages/*/dist/");
    expect(saveStep.with?.path).toContain("packages/*/dist/");
    expect(restoreStep.with.key).toContain("dist-build-v3-");
    expect(
      buildArtifactSteps.find((step: WorkflowStep) => step.name === "Pack built runtime artifacts")
        .run,
    ).toContain("packages/*/dist");
    expect(restoreStep.with.path).toContain("extensions/*/src/host/**/.bundle.hash");
    expect(restoreStep.with.path).toContain("extensions/*/src/host/**/*.bundle.js");
    expect(warmerSteps.indexOf(saveStep)).toBeGreaterThan(
      warmerSteps.findIndex((step) => step.name === "Warm build cache"),
    );
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
    const setupStep = expectDefined(
      steps.find((step: WorkflowStep) => step.name === "Setup Node environment"),
      "Testbox Node setup",
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
    expect(setupStep.with["cache-mode"]).toContain("'read-write'");
    expect(saveStep.if).toContain("steps.setup-node-env.outputs.cache-mode == 'read-write'");
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
    const firstWait = run.indexOf(
      "\nwait_checks\n",
      run.indexOf('start_check "core-support-boundary"'),
    );
    const hostedGatewayWatch = run.indexOf(
      'if [ "$RUN_GATEWAY_WATCH" = "true" ] && [ "$PARALLEL_GATEWAY_WATCH" != "true" ]; then',
    );
    const tuiPty = run.indexOf('if [ "$RUN_TUI_PTY" = "true" ]; then');
    const hostedGatewayWait = run.indexOf("\n  wait_checks\n", hostedGatewayWatch);
    const parallelDiscord = run.indexOf(
      'if [ "$RUN_CHANNELS" = "true" ] && [ "$PARALLEL_BUILT_VERIFIERS" = "true" ]; then',
    );
    const hostedDiscord = run.indexOf(
      'if [ "$RUN_CHANNELS" = "true" ] && [ "$PARALLEL_BUILT_VERIFIERS" != "true" ]; then',
    );
    const hostedDiscordWait = run.indexOf("\n  wait_checks\n", hostedDiscord);
    const tuiPtyWait = run.indexOf("\n  wait_checks\n", tuiPty);
    expect(firstWait).toBeGreaterThan(run.indexOf('start_check "core-support-boundary"'));
    expect(hostedGatewayWatch).toBeGreaterThan(firstWait);
    expect(hostedGatewayWait).toBeGreaterThan(hostedGatewayWatch);
    expect(parallelDiscord).toBeLessThan(firstWait);
    expect(hostedDiscord).toBeGreaterThan(hostedGatewayWait);
    expect(hostedDiscordWait).toBeGreaterThan(hostedDiscord);
    expect(tuiPty).toBeGreaterThan(hostedDiscordWait);
    expect(tuiPtyWait).toBeGreaterThan(tuiPty);
    expect(run.slice(tuiPty, tuiPtyWait)).toContain("src/tui/tui-pty-local.e2e.test.ts");
    expect(run.slice(tuiPty, tuiPtyWait)).toContain("--testNamePattern");
    expect(run.slice(tuiPty, tuiPtyWait)).toContain(
      "launches openclaw (chat as local mode|tui against a real Gateway) through a real PTY",
    );
    expect(run).toContain("wait_checks()");
    // Startup memory, artifact writers, and TUI retain explicit barriers;
    // hosted runners also serialize the remaining verifiers inside run_verifier.
    expect(run.match(/wait_checks$/gmu)).toHaveLength(8);
  });

  it("keeps docs i18n CI on the workflow-owned Go toolchain", () => {
    const workflow = readCiWorkflow();
    const nodeTestJob = workflow.jobs["checks-node-core-test-nondist-shard"];
    const setupGoStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Setup Go for docs i18n",
    );
    const verifyGoStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Verify docs i18n Go toolchain",
    );
    const resolveGoCacheStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Resolve docs i18n Go cache",
    );
    const restoreGoCacheStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Restore docs i18n Go cache",
    );
    const saveGoCacheStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Save docs i18n Go cache",
    );
    expect(setupGoStep).toMatchObject({
      if: "matrix.requires_go == true",
      uses: SETUP_GO_V6,
      with: {
        cache: false,
        "go-version": "1.27.0",
      },
    });
    expect(setupGoStep.with).not.toHaveProperty("go-version-file");
    expect(resolveGoCacheStep).toMatchObject({
      if: "matrix.requires_go == true && needs.preflight.outputs.cache_mode != 'off'",
      env: {
        DEPENDENCY_HASH: "${{ hashFiles('scripts/docs-i18n/go.sum') }}",
      },
    });
    expect(resolveGoCacheStep.run).toContain(
      "key=setup-go-${RUNNER_OS}-${arch}-${image_prefix}go-${version#go}-${DEPENDENCY_HASH}",
    );
    expect(restoreGoCacheStep).toMatchObject({
      if: "matrix.requires_go == true && needs.preflight.outputs.cache_mode != 'off'",
      uses: CACHE_V5,
    });
    expect(saveGoCacheStep).toMatchObject({
      if: expect.stringContaining("needs.preflight.outputs.cache_write_allowed == 'true'"),
      uses: CACHE_SAVE_V5,
    });
    expect(verifyGoStep).toMatchObject({
      if: "matrix.requires_go == true",
      run: 'test "$(go env GOVERSION)" = "go1.27.0"',
    });

    const goMod = readTrackedText("scripts/docs-i18n/go.mod");
    expect(goMod).toMatch(/^go 1\.26\.0$/mu);
    expect(goMod).toMatch(/^toolchain go1\.27\.0$/mu);

    const tooling = {
      configs: ["test/vitest/vitest.tooling.config.ts"],
      shard_name: "core-tooling-1",
    };
    const goTest = "test/scripts/docs-i18n.test.ts";
    const otherTest = "test/scripts/ci-git-owner.test.ts";
    const selections = [
      { includePatterns: [goTest] },
      { includePatterns: [otherTest] },
      { includePatterns: ["test/scripts/docs-*.test.ts"] },
      { targets: [goTest] },
      { targets: [otherTest] },
      {},
      { groups: [{ ...tooling, includePatterns: [otherTest] }] },
      {
        groups: [
          { ...tooling, includePatterns: [otherTest] },
          { ...tooling, includePatterns: [goTest] },
        ],
      },
      { groups: [{ ...tooling, configs: ["test/vitest/legacy-tooling.config.ts"] }] },
      { groups: [{ ...tooling, configs: ["test/vitest/vitest.tooling-isolated.config.ts"] }] },
      { groups: [{ ...tooling, configs: ["test/vitest/vitest.tooling-docker.config.ts"] }] },
      {
        groups: [
          {
            ...tooling,
            configs: [
              "test/vitest/vitest.tooling-docker.config.ts",
              "test/vitest/vitest.tooling-isolated.config.ts",
            ],
          },
        ],
      },
      {
        groups: [
          {
            ...tooling,
            configs: [...tooling.configs, "test/vitest/vitest.tooling-isolated.config.ts"],
          },
        ],
      },
      {
        groups: [
          {
            ...tooling,
            configs: [
              "test/vitest/vitest.tooling-isolated.config.ts",
              "test/vitest/legacy-tooling.config.ts",
            ],
          },
        ],
      },
      { groups: [{ ...tooling, configs: undefined }] },
      {
        groups: [
          {
            ...tooling,
            configs: ["test/vitest/vitest.tooling-isolated.config.ts"],
            includePatterns: [goTest],
          },
        ],
      },
    ];
    const result = runCiManifestFixture({
      bundledPlanner: true,
      nodeTestShards: selections.map((selection, index) =>
        Object.assign(
          {
            checkName: `tooling-${index}`,
            configs: tooling.configs,
            requiresDist: false,
            runner: "ubuntu-24.04",
            shardName: "groups" in selection ? "compact-small-1" : "core-tooling-1",
          },
          selection,
        ),
      ),
    });
    expect(result.status, result.output).toBe(0);
    const matrix = JSON.parse(
      expectDefined(result.outputs.checks_node_core_nondist_matrix, "non-dist Node matrix"),
    ) as {
      include: { requires_go: boolean }[];
    };
    expect(matrix.include.map((row) => row.requires_go)).toEqual([
      true,
      false,
      true,
      true,
      false,
      true,
      false,
      true,
      true,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
    ]);
  });

  it("packs grouped Node matrix rows and unpacks them in the shard runner", () => {
    const groups = [
      {
        configs: ["test/vitest/vitest.unit-fast.config.ts"],
        env: undefined,
        includePatterns: ["src/a.test.ts", "src/b.test.ts"],
        requiresDist: false,
        runner: "ubuntu-24.04",
        shard_name: "core-unit-fast-1",
        timing_key: "core-unit-fast-1#include-2-abcd",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
        requiresDist: false,
        runner: "ubuntu-24.04",
        shard_name: "core-runtime-infra-misc",
      },
    ];
    const projectedGroups = groups.map(
      ({ configs, env, includePatterns, shard_name, timing_key }) => ({
        configs,
        env,
        includePatterns,
        shard_name,
        timing_key,
      }),
    );
    const manifest = runCiManifestFixture({
      bundledPlanner: true,
      nodeTestShards: [
        {
          checkName: "checks-node-compact-small-1",
          groups,
          requiresDist: false,
          runner: "ubuntu-24.04",
          shardName: "compact-small-1",
        },
      ],
    });
    expect(manifest.status, manifest.output).toBe(0);
    const [row] = JSON.parse(
      expectDefined(manifest.outputs.checks_node_core_nondist_matrix, "packed Node matrix"),
    ).include;
    expect(row).toMatchObject({
      check_name: "checks-node-compact-small-1",
      groups_gzip_base64: expect.any(String),
      requires_go: false,
    });
    expect(row).not.toHaveProperty("groups");
    const runStep = readCiWorkflow().jobs["checks-node-core-test-nondist-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run Node test shard",
    );
    const context = {
      eventName: "pull_request" as const,
      matrix: row,
      repository: "openclaw/openclaw",
      runAttempt: 1,
    };
    const packedEnv = evaluateWorkflowExpression(
      runStep.env.OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64,
      context,
    );
    const legacyEnv = evaluateWorkflowExpression(
      runStep.env.OPENCLAW_NODE_TEST_GROUPS_JSON,
      context,
    );
    expect(legacyEnv).toBe("");
    expect(
      resolveShardPlans({ OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: String(packedEnv) }).map((plan) =>
        plan.kind === "group" ? plan.plan : plan,
      ),
    ).toEqual(projectedGroups);
  });

  it.each(["github", "hybrid", "blacksmith"] as const)(
    "keeps the complete %s manifest output below the safety budget",
    (runnerProfile) => {
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        changedPaths: ["src/auto-reply/full-plan.ts"],
        eventName: "pull_request",
        nodeTestShards: createNodeTestShardBundles({
          compactMode: "pull-request",
          includeReleaseOnlyPluginShards: false,
          runnerBackend: runnerProfile,
        }),
        runnerProfile,
      });
      expect(manifest.status, manifest.output).toBe(0);
      expect(manifest.outputChars, runnerProfile).toBeLessThan(262_144);
    },
  );

  it("uses projected legacy groups for historical targets without the codec", () => {
    const groups = [
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        env: { OPENCLAW_CI_TEST_GROUP: "legacy" },
        includePatterns: ["src/legacy.test.ts"],
        requiresDist: false,
        runner: "ubuntu-24.04",
        shard_name: "core-legacy",
        timing_key: "core-legacy#include-1-abcd",
      },
    ];
    const ungrouped = runCiManifestFixture({
      bundledPlanner: true,
      historicalCompatibility: false,
      nodeTestGroupsCodec: false,
    });
    expect(ungrouped.status, ungrouped.output).toBe(0);
    expect(ungrouped.outputs.frozen_target).toBe("true");
    expect(ungrouped.outputs.compatibility_target).toBe("false");
    const rows = JSON.parse(
      expectDefined(ungrouped.outputs.checks_node_core_nondist_matrix, "manual target matrix"),
    ).include;
    expect(rows).toEqual([expect.objectContaining({ check_name: "bundled-node-plan" })]);
    expect(rows[0]).not.toHaveProperty("groups_gzip_base64");

    const grouped = runCiManifestFixture({
      bundledPlanner: true,
      historicalCompatibility: true,
      nodeTestGroupsCodec: false,
      nodeTestShards: [
        {
          checkName: "checks-node-compact-small-1",
          groups,
          requiresDist: false,
          runner: "ubuntu-24.04",
          shardName: "compact-small-1",
        },
      ],
    });
    expect(grouped.status, grouped.output).toBe(0);
    const [row] = JSON.parse(
      expectDefined(grouped.outputs.checks_node_core_nondist_matrix, "legacy Node matrix"),
    ).include;
    expect(row).not.toHaveProperty("groups_gzip_base64");
    expect(Object.keys(row.groups[0]).toSorted()).toEqual([
      "configs",
      "env",
      "includePatterns",
      "shard_name",
      "timing_key",
    ]);
    const runStep = readCiWorkflow().jobs["checks-node-core-test-nondist-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run Node test shard",
    );
    const context = {
      eventName: "workflow_dispatch" as const,
      matrix: row,
      repository: "openclaw/openclaw",
      runAttempt: 1,
    };
    const packedEnv = evaluateWorkflowExpression(
      runStep.env.OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64,
      context,
    );
    const legacyEnv = evaluateWorkflowExpression(
      runStep.env.OPENCLAW_NODE_TEST_GROUPS_JSON,
      context,
    );
    expect(packedEnv).toBe("");
    expect(
      resolveShardPlans({ OPENCLAW_NODE_TEST_GROUPS_JSON: String(legacyEnv) }).map((plan) =>
        plan.kind === "group" ? plan.plan : plan,
      ),
    ).toEqual(row.groups);
  });

  it("provisions ripgrep for real filesystem contract selections", () => {
    const contract = "src/agents/filesystem-tools-output-contract.test.ts";
    const nativeTools = "src/agents/sessions/tools/index.test.ts";
    const unrelated = "src/agents/run-wait.test.ts";
    const selections = [
      { targets: [contract] },
      { includePatterns: [contract] },
      { includePatterns: ["src/agents/filesystem-*.test.ts"] },
      { targets: [nativeTools] },
      { includePatterns: [unrelated] },
      { shardName: "agentic-agents-core-runtime" },
      { shardName: "agentic-agents-support" },
      { shardName: "agentic-agents-core-runtime", includePatterns: [unrelated] },
      { groups: [{ shard_name: "agentic-agents-core-runtime", includePatterns: [contract] }] },
      { groups: [{ shard_name: "agentic-agents-support", includePatterns: [nativeTools] }] },
      { groups: [{ shard_name: "agentic-agents-core-runtime", includePatterns: [unrelated] }] },
      { groups: [{ shard_name: "agentic-agents-core-runtime" }] },
    ];
    const result = runCiManifestFixture({
      bundledPlanner: true,
      nodeTestShards: selections.map((selection, index) =>
        Object.assign(
          {
            checkName: `grep-${index}`,
            configs: ["test/vitest/vitest.agents-core.config.ts"],
            requiresDist: false,
            runner: "ubuntu-24.04",
            shardName: "compact-small-1",
          },
          selection,
        ),
      ),
    });
    expect(result.status, result.output).toBe(0);
    const matrix = JSON.parse(
      expectDefined(result.outputs.checks_node_core_nondist_matrix, "non-dist Node matrix"),
    ) as { include: { requires_ripgrep?: boolean }[] };
    expect(matrix.include.map((row) => Boolean(row.requires_ripgrep))).toEqual([
      true,
      true,
      true,
      true,
      false,
      true,
      true,
      false,
      true,
      true,
      false,
      true,
    ]);
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
    const buildRuntimeStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Build Node test runtime",
    );
    const installRipgrepStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Install ripgrep for native grep tests",
    );

    expect(JSON.stringify(preflightJob.steps)).toContain("timeout_minutes: shard.timeoutMinutes");
    expect(manifestStep.run).toContain("pretest_build_mode: shard.pretestBuildMode");
    expect(manifestStep.run).toContain("requires_ripgrep:");
    expect(manifestStep.run).toContain("src/agents/sessions/tools/index.test.ts");
    expect(nodeTestJob["timeout-minutes"]).toBe("${{ matrix.timeout_minutes || 60 }}");
    expect(runStep.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBe(
      "${{ needs.preflight.outputs.compatibility_target == 'true' && '660000' || '300000' }}",
    );
    expect(runStep.env.OPENCLAW_VITEST_NO_OUTPUT_RETRY).toBe("1");
    expect(runStep.env.OPENCLAW_NODE_TEST_ENV_JSON).toBe("${{ toJson(matrix.env) }}");
    expect(runStep.env.OPENCLAW_NODE_TEST_TARGETS_JSON).toBe("${{ toJson(matrix.targets) }}");
    expect(runStep.env.OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64).toBe(
      "${{ matrix.groups_gzip_base64 || '' }}",
    );
    expect(runStep.env.OPENCLAW_NODE_TEST_GROUPS_JSON).toBe(
      "${{ matrix.groups && toJson(matrix.groups) || '' }}",
    );
    expect(runStep.env.OPENCLAW_NODE_TEST_VITEST_ARGS_JSON).toBe(
      "${{ needs.preflight.outputs.compatibility_target == 'true' && '[\"--hookTimeout=600000\"]' || '[]' }}",
    );
    expect(buildRuntimeStep).toMatchObject({
      if: "matrix.pretest_build_mode != null",
      env: {
        OPENCLAW_BUILD_PRIVATE_QA: "${{ matrix.pretest_build_mode == 'private-qa' && '1' || '0' }}",
        VITEST: "1",
      },
      run: "pnpm build qaRuntime",
    });
    expect(installRipgrepStep).toMatchObject({
      if: "matrix.requires_ripgrep == true && runner.os == 'Linux'",
      run: expect.stringContaining("apt-get install -y --no-install-recommends ripgrep"),
    });
    expect(nodeTestJob.steps.indexOf(buildRuntimeStep)).toBeLessThan(
      nodeTestJob.steps.indexOf(runStep),
    );
    expect(nodeTestJob.steps.indexOf(installRipgrepStep)).toBeLessThan(
      nodeTestJob.steps.indexOf(runStep),
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

  it("clamps Node test workers to the detected core count", () => {
    const workflow = readCiWorkflow();
    const nodeTestJob = workflow.jobs["checks-node-core-test-nondist-shard"];
    const resourceStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Configure Node test resources",
    );

    expect(resourceStep.run).toContain('if [ "$workers" -gt "$cores" ]; then');
    expect(resourceStep.run).toContain('workers="$cores"');
    expect(resourceStep.run.indexOf('workers="$cores"')).toBeLessThan(
      resourceStep.run.indexOf("OPENCLAW_VITEST_MAX_WORKERS"),
    );
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
    expect(buildChecks.run).toContain(
      "startup_builder=(node --import tsx scripts/ensure-cli-startup-build.mts)",
    );
    expect(buildChecks.run).toContain(
      "startup_builder=(node scripts/ensure-cli-startup-build.mjs)",
    );
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
    const checkLint = workflow.jobs["check-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run check shard",
    );
    const hostedCoreLint = workflow.jobs["check-lint-hosted-core-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run hosted core lint stripe",
    );
    const lintBoundaryFingerprint = workflow.jobs["check-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Compute extension boundary input fingerprint",
    );
    const additionalBoundaryFingerprint = workflow.jobs["check-additional-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Compute extension boundary input fingerprint",
    );

    // The frozen candidate owns the older full lint and boundary builders;
    // current-only stripe and cache mechanics must not replace that coverage.
    expect(checkLint.run).toContain("if [[ ! -f scripts/run-oxlint-shards.mts ]]; then");
    expect(checkLint.run).toContain("pnpm lint");
    expect(hostedCoreLint.run).toContain("target does not support core lint stripes");
    expect(lintBoundaryFingerprint.run).toContain("enabled=false");
    expect(additionalBoundaryFingerprint.run).toContain("enabled=false");
  });

  it.skipIf(process.platform === "win32")(
    "keeps missing performance coverage fatal outside historical targets",
    () => {
      const job = readCiWorkflow().jobs["control-ui-performance"];
      expect(job.needs).toEqual(["preflight"]);
      expect(job.env.CHECKOUT_BASE_SHA).toBe("${{ needs.preflight.outputs.diff_base_revision }}");
      const step = job.steps.find(
        (candidate: WorkflowStep) => candidate.name === "Check Control UI performance against base",
      );
      const root = tempDirs.make("openclaw-performance-workflow-");
      const summary = path.join(root, "summary.md");
      writeFileSync(path.join(root, "package.json"), "{}");
      for (const compatibility of ["true", "false"]) {
        const result = runWorkflowShellScript(step.run, {
          cwd: root,
          env: {
            ...process.env,
            COMPATIBILITY_TARGET: compatibility,
            GITHUB_STEP_SUMMARY: summary,
          },
        });
        expect(result.status, `${result.stdout}${result.stderr}`).toBe(
          compatibility === "true" ? 0 : 1,
        );
      }
      expect(readFileSync(summary, "utf8")).toContain(
        "unavailable on the selected compatibility target",
      );
    },
  );

  it("emits one final CI gate after every selected lane", () => {
    const workflow = readCiWorkflow();
    const gate = workflow.jobs["ci-gate"];
    const requiredJobs = ["preflight", "security-fast"];
    const selectedJobs = [
      "pnpm-store-warmup",
      "build-artifacts",
      "control-ui-performance",
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
      "ios-screenshot-shard",
      "ios-screenshot-evidence",
      "android",
      "docker-seed-e2e",
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
      "${{ !cancelled() && (github.event_name != 'pull_request' || !github.event.pull_request.draft) }}",
    );
    expect(gate.permissions).toEqual({ contents: "read" });

    const verifyStep = gate.steps.find(
      (step: WorkflowStep) => step.name === "Verify selected CI lanes",
    );
    expect(Object.keys(verifyStep.env)).toEqual(["JOB_RESULTS"]);
    const resultRows: string[] = verifyStep.env.JOB_RESULTS.trim().split("\n");
    expect(resultRows.slice(0, requiredJobs.length)).toEqual(
      requiredJobs.map((job) => `${job}=\${{ needs.${job}.result }}|true`),
    );
    for (const job of selectedJobs) {
      expect(verifyStep.env.JOB_RESULTS).toContain(`${job}=\${{ needs.${job}.result }}|`);
    }
    expect(resultRows).toHaveLength(gate.needs.length);
  });

  it("does not admit the final gate for cancelled workflows or draft pull requests", () => {
    const gate = readCiWorkflow().jobs["ci-gate"];
    for (const eventName of ["pull_request", "push", "workflow_dispatch"] as const) {
      for (const cancelled of [true, false]) {
        for (const draft of [true, false]) {
          expect(
            evaluateWorkflowExpression(gate.if, {
              cancelled,
              draft,
              eventName,
              repository: "openclaw/openclaw",
              runAttempt: 1,
            }),
            JSON.stringify({ cancelled, draft, eventName }),
          ).toBe(!cancelled && (eventName !== "pull_request" || !draft));
        }
      }
    }
  });

  it("ci-gate selection projections match their owning job predicates", () => {
    const workflow = readCiWorkflow();
    const step = workflow.jobs["ci-gate"].steps.find(
      (candidate: WorkflowStep) => candidate.name === "Verify selected CI lanes",
    );
    const rows: string[] = step.env.JOB_RESULTS.trim().split("\n").slice(2);
    for (const row of rows) {
      const match = expectDefined(
        row.match(/^([\w-]+)=\$\{\{ needs\.([\w-]+)\.result \}\}\|\$\{\{ (.+) \}\}$/u),
        row,
      );
      const job = expectDefined(match[1], row);
      const selection = expectDefined(match[3], row);
      expect(match[2], row).toBe(job);
      // Gate inputs duplicate eligibility, never dependency status or cancellation.
      // Bind that projection to its owner so a routing change cannot leave stale selection.
      const eligible = workflow.jobs[job].if
        .replace(/^\$\{\{\s*|\s*\}\}$/gu, "")
        .replace(/!cancelled\(\)\s*&&\s*always\(\)\s*&&\s*/gu, "")
        .replace(/\s+/gu, " ")
        .trim();
      const projected = /^needs\.preflight\.outputs\.\w+$/u.test(selection)
        ? `${selection} == 'true'`
        : selection;
      expect(projected, job).toBe(eligible);
    }
  });

  it.skipIf(process.platform === "win32").each<{
    label: string;
    context: Partial<Parameters<typeof evaluateWorkflowExpression>[1]>;
    expected: Record<string, boolean>;
  }>([
    {
      label: "same-repo Blacksmith PR",
      context: { eventName: "pull_request" },
      expected: {
        "pnpm-store-warmup": false,
        "checks-node-compat": false,
        "ios-build": true,
        "ios-screenshot-shard": false,
      },
    },
    {
      label: "fork PR",
      context: { eventName: "pull_request", headRepository: "contributor/fork" },
      expected: { "pnpm-store-warmup": true },
    },
    {
      label: "same-repo docs-only PR",
      context: { eventName: "pull_request", preflightOutputs: { run_node: "false" } },
      expected: { "pnpm-store-warmup": true },
    },
    {
      label: "no Node or docs scope",
      context: { preflightOutputs: { run_node: "false", run_check_docs: "false" } },
      expected: { "pnpm-store-warmup": false },
    },
    {
      label: "canonical Blacksmith push",
      context: { eventName: "push" },
      expected: {
        "pnpm-store-warmup": false,
        "checks-node-compat": false,
        "ios-build": true,
        "ios-screenshot-shard": false,
      },
    },
    {
      label: "non-main push",
      context: { eventName: "push", ref: "refs/heads/topic" },
      expected: { "pnpm-store-warmup": true },
    },
    {
      label: "fork repository push",
      context: { eventName: "push", repository: "contributor/fork" },
      expected: { "pnpm-store-warmup": true },
    },
    {
      label: "GitHub push",
      context: { eventName: "push", runnerProfile: "github" },
      expected: {
        "pnpm-store-warmup": true,
        "check-lint-hosted-core-shard": true,
        "check-test-types-hosted-core-shard": true,
      },
    },
    {
      label: "hybrid PR",
      context: { eventName: "pull_request", runnerProfile: "hybrid" },
      expected: { "pnpm-store-warmup": true, "check-lint-hosted-core-shard": true },
    },
    {
      label: "targeted core test PR",
      context: {
        eventName: "pull_request",
        runnerProfile: "hybrid",
        preflightOutputs: { changed_core_test_paths_json: '["src/commands/doctor.test.ts"]' },
      },
      expected: {
        "check-shard": true,
        "check-additional-shard": true,
        "check-lint-hosted-core-shard": true,
        "check-test-types-hosted-core-shard": false,
      },
    },
    {
      label: "Blacksmith has no hosted stripes",
      context: { frozenTarget: true },
      expected: {
        "check-lint-hosted-core-shard": false,
        "check-test-types-hosted-core-shard": false,
      },
    },
    {
      label: "frozen target without hosted capability",
      context: { frozenTarget: true, hostedRunnerProfileContract: false, runnerProfile: "github" },
      expected: {
        "check-lint-hosted-core-shard": false,
        "check-test-types-hosted-core-shard": false,
      },
    },
    {
      label: "frozen target with hosted capability",
      context: { frozenTarget: true, runnerProfile: "hybrid" },
      expected: {
        "check-lint-hosted-core-shard": true,
        "check-test-types-hosted-core-shard": true,
      },
    },
    {
      label: "current target needs no capability fallback",
      context: { hostedRunnerProfileContract: false, runnerProfile: "github" },
      expected: { "check-lint-hosted-core-shard": true },
    },
    {
      label: "hosted checks out of scope",
      context: { runnerProfile: "github", preflightOutputs: { run_check: "false" } },
      expected: {
        "check-shard": false,
        "check-lint-hosted-core-shard": false,
        "check-test-types-hosted-core-shard": false,
      },
    },
    {
      label: "compatibility target",
      context: { preflightOutputs: { compatibility_target: "true" } },
      expected: {
        "checks-ui": true,
        "checks-ui-e2e": false,
        "checks-ui-e2e-real-gateway": false,
        "ios-screenshot-shard": false,
      },
    },
    {
      label: "current target",
      context: {},
      expected: {
        "checks-ui-e2e": true,
        "checks-ui-e2e-real-gateway": true,
        "ios-screenshot-shard": true,
        "checks-node-compat": true,
      },
    },
    {
      label: "manual Node 22 without artifacts",
      context: { preflightOutputs: { run_build_artifacts: "false" } },
      expected: { "checks-node-compat": false },
    },
    {
      label: "UI performance without runtime artifact changes",
      context: { preflightOutputs: { run_build_artifacts: "false", run_ui_tests: "true" } },
      expected: { "control-ui-performance": true },
    },
    {
      label: "UI performance for shared runtime build changes",
      context: { preflightOutputs: { run_build_artifacts: "true", run_ui_tests: "false" } },
      expected: { "control-ui-performance": true },
    },
    {
      label: "UI performance outside build and UI scope",
      context: { preflightOutputs: { run_build_artifacts: "false", run_ui_tests: "false" } },
      expected: { "control-ui-performance": false },
    },
    {
      label: "ordinary manual screenshot override",
      context: { preflightOutputs: { run_ios_screenshots: "false" } },
      expected: { "ios-screenshot-shard": true },
    },
    {
      label: "release gate without screenshot scope",
      context: { releaseGate: true, preflightOutputs: { run_ios_screenshots: "false" } },
      expected: { "ios-screenshot-shard": false },
    },
    {
      label: "release gate keeps smoke without screenshots",
      context: { releaseGate: true },
      expected: { "ios-build": true, "ios-screenshot-shard": false },
    },
    {
      label: "npm-beta excludes manual screenshots",
      context: { preflightOutputs: { release_scope: "npm-beta" } },
      expected: { "ios-screenshot-shard": false },
    },
    {
      label: "npm-beta excludes PR screenshots",
      context: { eventName: "pull_request", preflightOutputs: { release_scope: "npm-beta" } },
      expected: { "ios-screenshot-shard": false },
    },
    {
      label: "npm-stable excludes manual screenshots",
      context: { preflightOutputs: { release_scope: "npm-stable" } },
      expected: { "ios-screenshot-shard": false },
    },
    {
      label: "npm-stable excludes PR screenshots",
      context: { eventName: "pull_request", preflightOutputs: { release_scope: "npm-stable" } },
      expected: { "ios-screenshot-shard": false },
    },
    {
      label: "PR screenshot scope off",
      context: { eventName: "pull_request", preflightOutputs: { run_ios_screenshots: "false" } },
      expected: { "ios-screenshot-shard": false },
    },
  ])("ci-gate preserves eligibility: $label", ({ context, expected }) => {
    const jobResults = renderCiGateEnvironment(context);
    const selections = Object.fromEntries(
      jobResults
        .trim()
        .split("\n")
        .map((row) => {
          const [job, , selected] = row.split(/[=|]/u);
          return [expectDefined(job, row), expectDefined(selected, row)];
        }),
    );
    for (const [job, selected] of Object.entries(expected)) {
      expect(selections[job], job).toBe(String(selected));
    }
    expect(selections["ios-screenshot-evidence"]).toBe(selections["ios-screenshot-shard"]);
    const results = Object.fromEntries(
      Object.entries(selections).map(([job, selected]) => [
        job,
        selected === "true" ? "success" : "skipped",
      ]),
    );
    const outcome = runCiGateFixture(renderCiGateEnvironment(context, results));
    expect(outcome.status, `${outcome.stdout}\n${outcome.stderr}`).toBe(0);
    if (expected["ios-build"]) {
      for (const terminal of ["failure", "cancelled", "skipped"]) {
        const missingSmoke = runCiGateFixture(
          renderCiGateEnvironment(context, { ...results, "ios-build": terminal }),
        );
        expect(missingSmoke.status, missingSmoke.stdout).toBe(1);
      }
    }
    if (context.preflightOutputs?.changed_core_test_paths_json) {
      for (const terminal of ["failure", "skipped"]) {
        const missingOwner = runCiGateFixture(
          renderCiGateEnvironment(context, { ...results, "check-shard": terminal }),
        );
        expect(missingOwner.status).not.toBe(0);
      }
    }
  });

  it("runs Node 24 minimum compatibility only from manual CI dispatches", () => {
    const workflow = readCiWorkflow();
    const compatibilityJob = workflow.jobs["checks-node-compat"];
    const fullReleaseWorkflow = readWorkflow(".github/workflows/full-release-validation.yml");
    const fullReleaseDispatch = fullReleaseWorkflow.jobs.normal_ci.steps.find(
      (step: WorkflowStep) => step.name === "Dispatch CI",
    );

    expect(compatibilityJob.name).toBe("checks-node-compat-node24");
    expect(compatibilityJob.if).toBe(
      "needs.preflight.outputs.run_build_artifacts == 'true' && github.event_name == 'workflow_dispatch'",
    );
    expect(fullReleaseDispatch.env.CHILD_WORKFLOW_KIND).toBe("ci");
    expect(fullReleaseDispatch.run).toContain('dispatch_child ci.yml "$dispatch_run_name"');
    expect(fullReleaseDispatch.run).toContain('-f target_ref="$TARGET_SHA"');
    expect(compatibilityJob.steps.at(-1)?.run).toContain(
      "src/config/sessions/session-accessor.test.ts",
    );
    expect(compatibilityJob.steps.at(-1)?.run).toContain(
      "src/config/sessions/store-writer.test.ts",
    );
    expect(compatibilityJob.steps.at(-1)?.run).toContain("src/config/sessions/sessions.test.ts");
  });

  it.skipIf(process.platform === "win32")("ci-gate rejects an unexpected selected skip", () => {
    const result = runCiGateFixture(renderCiGateEnvironment({}, { "checks-ui": "skipped" }));
    expect(result.stdout).toContain("checks-ui: skipped");
    expect(result.status, result.stdout).toBe(1);
  });

  it.skipIf(process.platform === "win32").each([
    [true, "success", 0],
    [true, "skipped", 1],
    [true, "failure", 1],
    [true, "cancelled", 1],
    [true, "", 1],
    [true, "unknown", 1],
    [false, "success", 0],
    [false, "skipped", 0],
    [false, "failure", 1],
    [false, "cancelled", 1],
    [false, "", 1],
    [false, "unknown", 1],
  ] as const)(
    "ci-gate checks all downstream lanes (selected=%s, result=%s)",
    (selected, result, exit) => {
      const workflow = readCiWorkflow();
      const jobs: string[] = workflow.jobs["ci-gate"].needs.slice(2);
      const jobResults = renderCiGateEnvironment(
        {
          eventName: selected ? "workflow_dispatch" : "pull_request",
          runnerProfile: "github",
          preflightOutputs: Object.fromEntries(
            Object.keys(workflow.jobs.preflight.outputs)
              .filter((key) => key.startsWith("run_"))
              .map((key) => [key, String(selected)]),
          ),
        },
        Object.fromEntries(jobs.map((job) => [job, result])),
      );
      const outcome = runCiGateFixture(jobResults);
      expect(outcome.status, `${outcome.stdout}\n${outcome.stderr}`).toBe(exit);
      for (const job of jobs) {
        expect(jobResults).toContain(`${job}=${result}|${selected}\n`);
        expect(outcome.stdout).toContain(`${job}: ${result} (selected=${selected})`);
        if (exit !== 0) {
          expect(outcome.stdout).toContain(`${job} finished with ${result} (selected=${selected})`);
        }
      }
    },
  );

  it
    .skipIf(process.platform === "win32")
    .each(["failure", "cancelled", "skipped", "", "unknown", "success="])(
    "ci-gate rejects required result %s independently of downstream success",
    (result) => {
      const outcome = runCiGateFixture(
        renderCiGateEnvironment({}, { preflight: result, "security-fast": result }),
      );
      expect(outcome.status, outcome.stdout).toBe(1);
      for (const job of ["preflight", "security-fast"]) {
        expect(outcome.stdout).toContain(`${job} finished with ${result} (selected=true)`);
      }
    },
  );

  it
    .skipIf(process.platform === "win32")
    .each(["", "unknown", "TRUE", "true|false", "true|", "false="])(
    "ci-gate rejects missing or malformed selection %s even after success",
    (selection) => {
      const outcome = runCiGateFixture(
        renderCiGateEnvironment({ preflightOutputs: { run_ui_tests: selection } }),
      );
      expect(outcome.status, outcome.stdout).toBe(1);
      expect(outcome.stdout).toContain(
        `checks-ui finished with success (selected=${selection || "missing"})`,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "ci-gate reports failed upstream and selected dependent skips",
    () => {
      const jobResults = renderCiGateEnvironment(
        {},
        {
          "ios-screenshot-shard": "failure",
          "ios-screenshot-evidence": "skipped",
        },
      );
      const outcome = runCiGateFixture(jobResults);
      expect(outcome.status, outcome.stdout).toBe(1);
      expect(outcome.stdout).toContain(
        "ios-screenshot-shard finished with failure (selected=true)",
      );
      expect(outcome.stdout).toContain(
        "ios-screenshot-evidence finished with skipped (selected=true)",
      );
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

      expect(qaWorkflow.env.OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB).toBe("8192");

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
        "Restore trusted QA harness revision",
        "Setup Node environment",
        "Checkout selected ref",
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
              CI_GIT_OWNER: topology.gitOwner,
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

  it("pins the QA Git owner before checkouts and preserves all ten terminal fetch contracts", () => {
    const workflow = readQaProfileEvidenceWorkflow();
    const gitJobs = [
      "validate_selected_ref",
      "plan_qa_profile",
      "run_qa_profile_shard",
      "aggregate_qa_profile",
    ];
    const calls: string[] = [];
    for (const job of gitJobs) {
      const steps = workflow.jobs[job].steps as WorkflowStep[];
      const ownerIndex = steps.findIndex((step) => step.name === "Prepare Git owner");
      expect(steps.filter((step) => step.name === "Prepare Git owner")).toHaveLength(1);
      expect(steps[ownerIndex]).toEqual({
        name: "Prepare Git owner",
        uses: "openclaw/openclaw/.github/actions/git-owner@dd4528b6393e7d00063067a080ca7241b48ce475",
      });
      expect(steps[ownerIndex - 1]?.name).toBe(
        job === "validate_selected_ref"
          ? "Resolve job workflow identity"
          : "Require authorized workflow actor",
      );
      expect(steps[ownerIndex + 1]?.name).toBe(
        job === "validate_selected_ref" ? "Checkout selected ref" : "Checkout trusted QA harness",
      );
      expect(steps.some((step) => step.uses?.startsWith("actions/setup-python@"))).toBe(false);
      for (const step of steps) {
        const run = (step.run ?? "").replace(/[ \t]*\\\n[ \t]*/gu, " ");
        const fetches = run
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => /\bfetch\b/u.test(line));
        if (fetches.length === 0) {
          continue;
        }
        expect(run.startsWith("set -euo pipefail\n")).toBe(true);
        for (const fetch of fetches) {
          expect(fetch).toMatch(/^python3 -I -S "\$CI_GIT_OWNER" --checkout-git (?:0|120) fetch /u);
          expect(fetch).not.toMatch(/\|\||&&|;|\$\?/u);
        }
        expect(run).not.toMatch(/^\s*(?:timeout|for|while|until)\b|\$\?/mu);
        calls.push(...fetches);
      }
    }
    expect(calls).toHaveLength(10);
    expect(calls.filter((call) => call.includes("--checkout-git 120 fetch"))).toHaveLength(4);
    expect(calls.filter((call) => call.includes("--checkout-git 0 fetch"))).toHaveLength(6);
    const validateSelectedRef = expectDefined(
      workflow.jobs.validate_selected_ref.steps.find(
        (step: WorkflowStep) => step.name === "Validate selected ref",
      ),
      "QA profile selected-ref validation step",
    );
    expect(validateSelectedRef["working-directory"]).toBeUndefined();
    expect(calls.slice(0, 3)).toEqual([
      'python3 -I -S "$CI_GIT_OWNER" --checkout-git 120 fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main',
      'python3 -I -S "$CI_GIT_OWNER" --checkout-git 120 fetch --no-tags origin "+refs/tags/${tag_candidate}:refs/tags/${tag_candidate}"',
      'python3 -I -S "$CI_GIT_OWNER" --checkout-git 120 fetch --no-tags origin "+refs/heads/${branch_candidate}:refs/remotes/origin/${branch_candidate}"',
    ]);
    expect(validateSelectedRef.run).toContain(
      'release_tag_sha="$(git rev-parse "refs/tags/${tag_candidate}^{commit}")"',
    );
    expect(validateSelectedRef.run).toContain(
      'release_branch_sha="$(git rev-parse "refs/remotes/origin/${branch_candidate}")"',
    );
    for (const name of ["Restore trusted QA harness revision", "Checkout selected ref"]) {
      const bodies = gitJobs
        .slice(1)
        .map(
          (job) => workflow.jobs[job].steps.find((step: WorkflowStep) => step.name === name)?.run,
        );
      expect(bodies[0]).toBeTypeOf("string");
      expect(new Set(bodies).size).toBe(1);
    }
    const protocolFetch = workflow.jobs.run_qa_profile_shard.steps.find(
      (step: WorkflowStep) => step.name === "Fetch protocol comparison base",
    );
    expect(protocolFetch["working-directory"]).toBe("selected");
    expect(calls[7]).toBe(
      'python3 -I -S "$CI_GIT_OWNER" --checkout-git 120 fetch --no-tags --no-recurse-submodules --depth=1 origin "+${PROTOCOL_SINCE_BASE_SHA}:refs/remotes/origin/qa-protocol-base"',
    );
    expect(protocolFetch.run).toContain(
      'test "$(git rev-parse refs/remotes/origin/qa-protocol-base^{commit})" = "$PROTOCOL_SINCE_BASE_SHA"',
    );
    expect(readFileSync(".github/workflows/qa-profile-evidence.yml", "utf8")).not.toMatch(
      /\bgit(?: -C selected)? fetch\b/u,
    );
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
        expect(result.timeoutVersion).not.toBe("");

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
    const qaAuthorizeJob = qaEvidenceWorkflow.jobs.authorize_actor;
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
    const qaAuthorizeStep = expectDefined(
      qaAuthorizeJob.steps.find(
        (step: WorkflowStep) => step.name === "Require maintainer-level repository access",
      ),
      "QA workflow actor authorization",
    );
    expect(qaAuthorizeStep.env).toEqual({
      CALLER_WORKFLOW_REF: "${{ github.workflow_ref }}",
      JOB_CONTEXT: "${{ toJSON(job) }}",
    });
    expect(qaAuthorizeStep.with?.script).toContain("callerWorkflowRef !== calledWorkflowRef");
    expect(qaAuthorizeStep.with?.script).toContain(
      'job.workflow_repository === "openclaw/openclaw"',
    );
    expect(qaAuthorizeStep.with?.script).toContain("job.workflow_ref === calledWorkflowRef");
    expect(qaAuthorizeStep.with?.script).toContain(
      'core.setOutput("authorized", trustedMainCaller ? "true" : "false")',
    );
    expect(qaValidateJob.outputs.workflow_sha).toBe("${{ steps.workflow.outputs.workflow_sha }}");
    expect(qaValidateJob.outputs).not.toHaveProperty("workflow_repository");
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
      const permissionStep = expectDefined(
        job.steps.find((step: WorkflowStep) => step.name === "Require authorized workflow actor"),
        "selected QA actor permission check",
      );
      const trustedCheckout = expectDefined(
        job.steps.find((step: WorkflowStep) => step.name === "Checkout trusted QA harness"),
        "trusted QA harness checkout",
      );
      const restoreTrusted = expectDefined(
        job.steps.find((step: WorkflowStep) => step.name === "Restore trusted QA harness revision"),
        "trusted QA harness revision restore",
      );
      const setupStep = expectDefined(
        job.steps.find((step: WorkflowStep) => step.name === "Setup Node environment"),
        "trusted QA harness Node setup",
      );
      const selectedCheckout = expectDefined(
        job.steps.find((step: WorkflowStep) => step.name === "Checkout selected ref"),
        "selected QA checkout",
      );
      const installSelected = expectDefined(
        job.steps.find((step: WorkflowStep) => step.name === "Install selected dependencies"),
        "selected QA dependency install",
      );

      expect(permissionStep).toMatchObject({
        uses: "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
        env: {
          CALLER_WORKFLOW_REF: "${{ github.workflow_ref }}",
          JOB_CONTEXT: "${{ toJSON(job) }}",
        },
      });
      expect(permissionStep.with?.script).toContain("getCollaboratorPermissionLevel");
      expect(permissionStep.with?.script).toContain('new Set(["admin", "maintain", "write"])');
      expect(permissionStep.with?.script).toContain("callerWorkflowRef !== calledWorkflowRef");
      expect(permissionStep.with?.script).toContain(
        'job.workflow_repository === "openclaw/openclaw"',
      );
      expect(permissionStep.with?.script).toContain("job.workflow_ref === calledWorkflowRef");
      expect(permissionStep.with?.script).toContain("if (!trustedMainCaller)");
      expect(trustedCheckout).toMatchObject({
        name: "Checkout trusted QA harness",
        uses: CHECKOUT_V6,
        with: {
          repository: "openclaw/openclaw",
          ref: "main",
          "fetch-depth": 1,
          "persist-credentials": false,
        },
      });
      const checkoutSteps = job.steps.filter((step: WorkflowStep) =>
        step.uses?.startsWith("actions/checkout@"),
      );
      expect(checkoutSteps).toHaveLength(1);
      expect(checkoutSteps[0]?.with).toMatchObject({
        repository: "openclaw/openclaw",
        ref: "main",
      });
      expect(restoreTrusted).toMatchObject({
        env: {
          EXPECTED_WORKFLOW_SHA: "${{ needs.validate_selected_ref.outputs.workflow_sha }}",
        },
        shell: "bash",
      });
      expect(restoreTrusted["working-directory"]).toBeUndefined();
      expect(restoreTrusted.run).toContain("^[0-9a-f]{40}$");
      expect(restoreTrusted.run).toContain(
        'python3 -I -S "$CI_GIT_OWNER" --checkout-git 0 fetch --no-tags --no-recurse-submodules --depth=1 origin "$EXPECTED_WORKFLOW_SHA"',
      );
      expect(restoreTrusted.run).toContain('git checkout --detach "$EXPECTED_WORKFLOW_SHA"');
      expect(restoreTrusted.run).toContain(
        'test "$(git rev-parse HEAD)" = "$EXPECTED_WORKFLOW_SHA"',
      );
      expect(job.steps.some((step: WorkflowStep) => step.uses?.startsWith("actions/cache/"))).toBe(
        false,
      );
      expect(setupStep.with?.["install-deps"]).toBe("false");
      expect(setupStep.with?.["cache-mode"]).toBe("off");
      expect(selectedCheckout).toMatchObject({
        env: {
          EXPECTED_SHA: "${{ needs.validate_selected_ref.outputs.selected_revision }}",
        },
        shell: "bash",
      });
      expect(selectedCheckout).not.toHaveProperty("uses");
      expect(selectedCheckout["working-directory"]).toBeUndefined();
      expect(selectedCheckout.run).toContain("^[0-9a-f]{40}$");
      expect(selectedCheckout.run).toContain("[[ ! -e selected ]]");
      expect(selectedCheckout.run).toContain("git init selected");
      expect(selectedCheckout.run).toContain(
        'git -C selected remote add origin "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"',
      );
      expect(selectedCheckout.run).toContain(
        'cd selected\npython3 -I -S "$CI_GIT_OWNER" --checkout-git 0 fetch --no-tags --no-recurse-submodules --depth=1 origin "$EXPECTED_SHA"',
      );
      expect(selectedCheckout.run).toContain("git checkout --detach FETCH_HEAD");
      expect(selectedCheckout.run).toContain('test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"');
      expect(
        job.steps.some((step: WorkflowStep) => step.name === "Verify selected checkout SHA"),
      ).toBe(false);
      expect(installSelected["working-directory"]).toBe("selected");
      expect(installSelected.run).toContain(
        '--store-dir "$RUNNER_TEMP/openclaw-qa-selected-pnpm-store"',
      );
      for (const installFlag of [
        "--frozen-lockfile",
        "--config.ignore-scripts=false",
        "--config.engine-strict=false",
        "--config.enable-pre-post-scripts=true",
        "--config.side-effects-cache=true",
      ]) {
        expect(installSelected.run).toContain(installFlag);
      }
      const securitySequence = [
        "Require authorized workflow actor",
        "Prepare Git owner",
        "Checkout trusted QA harness",
        "Restore trusted QA harness revision",
        "Setup Node environment",
        "Checkout selected ref",
        "Install selected dependencies",
      ];
      expect(
        job.steps.slice(0, securitySequence.length).map((step: WorkflowStep) => step.name),
      ).toEqual(securitySequence);
      const ordered = securitySequence.map(stepIndex);
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
    expect(runProfileStep.run).toContain('qa_output_dir=".artifacts/qa-e2e/');
    expect(runProfileStep.run).toContain(
      'published_output_dir="${GITHUB_WORKSPACE}/selected/${qa_output_dir}"',
    );
    expect(runProfileStep.run).toContain('mkdir -p "$qa_output_dir"');
    expect(runProfileStep.run).toContain('echo "output_dir=${published_output_dir}"');
    expect(runProfileStep.run).toContain('--output-dir "$qa_output_dir"');
    expect(runProfileStep.run).toContain('OUTPUT_DIR="$published_output_dir"');
    expect(runProfileStep.run.indexOf('mkdir -p "$qa_output_dir"')).toBeLessThan(
      runProfileStep.run.indexOf('echo "output_dir=${published_output_dir}"'),
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

    const maturityPermissionStep = expectDefined(
      maturityWorkflow.jobs.validate_selected_ref.steps.find(
        (step: WorkflowStep) => step.name === "Require authorized workflow actor",
      ),
      "maturity workflow actor authorization",
    );
    const workflowStep = maturityWorkflow.jobs.validate_selected_ref.steps.find(
      (step: WorkflowStep) => step.name === "Resolve job workflow identity",
    );
    const authorizeStep = maturityWorkflow.jobs.validate_selected_ref.steps.find(
      (step: WorkflowStep) => step.name === "Authorize workflow invocation",
    );
    const validateRefStep = maturityWorkflow.jobs.validate_selected_ref.steps.find(
      (step: WorkflowStep) => step.name === "Validate selected ref",
    );
    expect(maturityPermissionStep).toMatchObject({
      uses: "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
      env: {
        CALLER_WORKFLOW_REF: "${{ github.workflow_ref }}",
        JOB_CONTEXT: "${{ toJSON(job) }}",
      },
    });
    expect(maturityPermissionStep.with?.script).toContain("getCollaboratorPermissionLevel");
    expect(maturityPermissionStep.with?.script).toContain(
      "callerWorkflowRef !== calledWorkflowRef",
    );
    expect(maturityPermissionStep.with?.script).toContain(`"${MATURITY_SCORECARD_WORKFLOW_REF}"`);
    expect(maturityPermissionStep.with?.script).toContain(
      'job.workflow_repository === "openclaw/openclaw"',
    );
    expect(maturityPermissionStep.with?.script).toContain("job.workflow_ref === calledWorkflowRef");
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
      'input_ref.removeprefix("refs/heads/")',
      "floating_default_branch = False",
      'not expected_sha.replace(" ", "") and branch_candidate == default_branch',
      'selected_revision = revision("refs/remotes/origin/main")',
      "floating_default_branch and publication_base == default_branch",
      "if code != 2:",
      "Unable to determine whether '{input_ref}' is a remote branch",
      'probe("merge-base", "--is-ancestor", selected_revision',
      '":(exclude)qa/maturity-scores.yaml"',
      '":(exclude)docs/maturity/scorecard.md"',
      '":(exclude)docs/maturity/taxonomy.md"',
      "qa_evidence_run_id must be a numeric GitHub Actions run id",
      'publication_head = f"automation/maturity-scorecard-',
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
    expect(requireEvidenceStep.run).toContain(
      "Expected exactly one aggregate QA evidence manifest",
    );
    expect(requireEvidenceStep.run).toContain("qa-profile-evidence-manifest.json");
    expect(requireEvidenceStep.run).toContain(
      'evidence_path="$(dirname "${manifest_paths[0]}")/qa-evidence.json"',
    );
    expect(requireEvidenceStep.run).toContain('[[ ! -f "$evidence_path" || -L "$evidence_path" ]]');

    const validateManifestStep = publishJob.steps.find(
      (step: WorkflowStep) => step.name === "Validate QA evidence manifest",
    );
    expect(validateManifestStep.id).toBe("validate_evidence");
    expect(validateManifestStep.run).toContain("qa-profile-evidence-manifest.json");
    expect(validateManifestStep.run).toContain("qa-evidence.json profile must be all");
    expect(validateManifestStep.run).toContain("QA evidence manifest profile must be all");
    expect(validateManifestStep.run).toContain("manifest.targetSha !== targetSha");
    expect(validateManifestStep.run).toMatch(
      /qaProfileEvidencePlan\.attest\(\s*evidence\.profilePlan,\s*manifest\.qaPassed === true,?\s*\)/u,
    );
    expect(validateManifestStep.run).toContain("profilePlanSha256");
    expect(validateManifestStep.run).toContain("rerun the QA Profile Evidence workflow");
    expect(validateManifestStep.run).toContain("counts.fail === 0 && counts.blocked === 0");
    expect(validateManifestStep.run).toContain("scorecard_passed=");
    expect(validateManifestStep.run).toContain("### Maturity scorecard result");
    expect(publishJob.outputs).toEqual({
      scorecard_passed: "${{ steps.validate_evidence.outputs.scorecard_passed }}",
    });

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
      if: "${{ inputs.publish_pull_request && steps.validate_evidence.outputs.scorecard_passed == 'true' }}",
      uses: UPLOAD_ARTIFACT_V7,
      with: {
        name: "maturity-scorecard-pr-${{ github.run_id }}-${{ github.run_attempt }}",
        "retention-days": 1,
        "if-no-files-found": "error",
      },
    });
    expect(generatedPrUploadStep.with.path.trim().split("\n")).toEqual(MATURITY_GENERATED_PR_PATHS);

    const prepareRenderEvidenceStep = publishJob.steps.find(
      (step: WorkflowStep) => step.name === "Prepare aggregate QA evidence for rendering",
    );
    expect(prepareRenderEvidenceStep.env.QA_EVIDENCE_PATH).toBe(
      "${{ steps.evidence.outputs.qa_evidence_path }}",
    );
    expect(prepareRenderEvidenceStep.run).toContain(
      'render_evidence_dir=".artifacts/maturity-render-evidence"',
    );
    expect(prepareRenderEvidenceStep.run).toContain(
      'install -m 0644 "$QA_EVIDENCE_PATH" "$render_evidence_dir/qa-evidence.json"',
    );
    for (const stepName of ["Render artifact docs", "Render committed docs preview"]) {
      const renderStep = publishJob.steps.find((step: WorkflowStep) => step.name === stepName);
      expect(renderStep.env.ALLOW_FAILURES).toBe("${{ inputs.allow_failures }}");
      expect(renderStep.run).toContain('[[ "$ALLOW_FAILURES" == "true" ]]');
      expect(renderStep.run).toContain("allow_failures_args+=(--allow-failures)");
      expect(renderStep.run).toContain("--evidence-dir .artifacts/maturity-render-evidence");
      expect(renderStep.run).not.toContain("--evidence-dir .artifacts/maturity-evidence");
      expect(renderStep.run).toContain('"${allow_failures_args[@]}"');
    }
    const renderArtifactStep = publishJob.steps.find(
      (step: WorkflowStep) => step.name === "Render artifact docs",
    );
    expect(renderArtifactStep.run).toContain("QA failures allowed:");

    const resultGateStep = publishJob.steps.find(
      (step: WorkflowStep) => step.name === "Require zero failed or blocked scenarios",
    );
    expect(resultGateStep.env).toEqual({
      BLOCKED_COUNT: "${{ steps.validate_evidence.outputs.blocked_count }}",
      FAILED_COUNT: "${{ steps.validate_evidence.outputs.failed_count }}",
      SCORECARD_PASSED: "${{ steps.validate_evidence.outputs.scorecard_passed }}",
    });
    expect(resultGateStep.run).toContain('[[ "$SCORECARD_PASSED" != "true" ]]');
    expect(resultGateStep.run).toContain("Generated PR publication was blocked.");

    expect(publishPrJob.needs).toEqual(["validate_selected_ref", "publisher_preflight", "publish"]);
    expect(publishPrJob["runs-on"]).toBe("ubuntu-24.04");
    expect(publishPrJob.permissions).toEqual({ actions: "read", contents: "read" });
    for (const fragment of [
      "needs.publisher_preflight.result == 'success'",
      "needs.publish.result == 'success'",
      "needs.publish.outputs.scorecard_passed == 'true'",
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
      "invalidation-paths": "",
      "overlap-policy": "fail",
    });
    expect(openDocsPrStep.with["generated-paths"].trim().split("\n")).toEqual(
      MATURITY_GENERATED_PR_PATHS,
    );
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

      const writeEvidence = (status: "pass" | "fail" = "pass") => {
        writeFileSync(
          evidencePath,
          `${JSON.stringify({
            kind: "openclaw.qa.evidence-summary",
            schemaVersion: 2,
            generatedAt: "2026-08-05T00:00:00.000Z",
            evidenceMode: "full",
            entries: [
              {
                test: { kind: "scenario", id: "scenario-one", title: "Scenario one" },
                coverage: [],
                result: { status },
              },
            ],
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
            GITHUB_OUTPUT: path.join(root, "consumer-output"),
            GITHUB_STEP_SUMMARY: path.join(root, "consumer-summary"),
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
        const completeConsumer = runConsumer();
        expect(
          completeConsumer.status,
          `${completeConsumer.stdout}${completeConsumer.stderr}`,
        ).toBe(0);
        expect(readFileSync(path.join(root, "consumer-output"), "utf8")).toContain(
          "scorecard_passed=true",
        );

        writeEvidence("fail");
        writeFileSync(path.join(root, "consumer-output"), "", "utf8");
        const failedEvidenceConsumer = runConsumer();
        expect(
          failedEvidenceConsumer.status,
          `${failedEvidenceConsumer.stdout}${failedEvidenceConsumer.stderr}`,
        ).toBe(0);
        expect(readFileSync(path.join(root, "consumer-output"), "utf8")).toContain(
          "scorecard_passed=false",
        );
        expect(readFileSync(path.join(root, "consumer-output"), "utf8")).toContain(
          "failed_count=1",
        );

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
    "fails the maturity workflow result gate when evidence is not passing",
    () => {
      const maturityWorkflow = readMaturityScorecardWorkflow();
      const gateStep = maturityWorkflow.jobs.publish.steps.find(
        (step: WorkflowStep) => step.name === "Require zero failed or blocked scenarios",
      );
      const gateScript = expectDefined(gateStep?.run, "maturity result gate");
      const failed = runWorkflowShellScript(gateScript, {
        env: {
          ...process.env,
          BLOCKED_COUNT: "51",
          FAILED_COUNT: "28",
          SCORECARD_PASSED: "false",
        },
      });
      expect(failed.status).toBe(1);
      expect(`${failed.stdout}${failed.stderr}`).toContain(
        "28 failed and 51 blocked scenarios. Generated PR publication was blocked.",
      );

      const passed = runWorkflowShellScript(gateScript, {
        env: {
          ...process.env,
          BLOCKED_COUNT: "0",
          FAILED_COUNT: "0",
          SCORECARD_PASSED: "true",
        },
      });
      expect(passed.status).toBe(0);
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
    const fullReleaseDispatchStep = fullReleaseWorkflow.jobs.release_checks_candidate.steps.find(
      (step: WorkflowStep) => step.name === "Dispatch release checks candidate phase",
    );
    const dispatchStep = releaseWorkflow.jobs.qa_live_telegram_release_checks.steps.find(
      (step: WorkflowStep) => step.name === "Dispatch and await trusted Telegram QA",
    );
    const identityStep = telegramWorkflow.jobs.trusted_identity.steps.find(
      (step: WorkflowStep) => step.name === "Verify dispatched workflow identity",
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

  it("checks out the complete trusted Release Decision scripts tree", () => {
    const workflow = readWorkflow(".github/workflows/full-release-validation.yml");
    const checkout = workflow.jobs.release_decision.steps.find(
      (step: WorkflowStep) => step.name === "Checkout release decision tooling",
    );

    expect(checkout?.with).toMatchObject({
      ref: "${{ github.sha }}",
      "sparse-checkout": "scripts",
      "sparse-checkout-cone-mode": false,
      "persist-credentials": false,
    });
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
      "${{ (needs.preflight.outputs.runner_profile == 'github' || needs.preflight.outputs.runner_profile == 'hybrid') && 6 || 4 }}",
    );
    expect(smokeProfileJob.strategy.matrix).toBe(
      "${{ fromJson(needs.preflight.outputs.qa_smoke_ci_matrix) }}",
    );
    for (const [label, options, partCount] of [
      ["Blacksmith push", { runnerBackend: "blacksmith" }, 4],
      ["GitHub push", { runnerBackend: "github" }, 6],
      ["hybrid push", { runnerBackend: "hybrid" }, 4],
      ["hybrid PR", { runnerBackend: "hybrid", eventName: "pull_request" }, 4],
      ["hybrid retry", { runnerBackend: "hybrid", scopeEnv: { GITHUB_RUN_ATTEMPT: "2" } }, 6],
      ["missing attempt", { runnerBackend: "hybrid", scopeEnv: { GITHUB_RUN_ATTEMPT: "" } }, 6],
      ["other repository", { runnerBackend: "hybrid", repository: "example/openclaw" }, 6],
      [
        "current hybrid dispatch",
        {
          runnerBackend: "hybrid",
          eventName: "workflow_dispatch",
          scopeEnv: { OPENCLAW_CI_CHECKOUT_REVISION: "b".repeat(40) },
        },
        6,
      ],
      [
        "frozen hybrid dispatch",
        { runnerBackend: "hybrid", eventName: "workflow_dispatch", historicalCompatibility: true },
        6,
      ],
      [
        "frozen Blacksmith dispatch",
        {
          runnerBackend: "blacksmith",
          eventName: "workflow_dispatch",
          historicalCompatibility: true,
        },
        4,
      ],
    ] as const) {
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        changedPaths: [".github/workflows/ci.yml"],
        eventName: "push",
        historicalCompatibility: false,
        ...options,
      });
      expect(manifest.status, `${label}: ${manifest.output}`).toBe(0);
      const matrix = JSON.parse(
        expectDefined(manifest.outputs.qa_smoke_ci_matrix, `${label} QA smoke matrix`),
      );
      expect(matrix.include, label).toEqual(
        Array.from({ length: partCount }, (_, index) => ({
          name: `profile ${index + 1}/${partCount}`,
          lane: `profile-${index + 1}`,
          slug: `profile-${index + 1}-of-${partCount}`,
          part_count: partCount,
        })),
      );
    }
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
    expect(compatibilityScenarioBlock?.match(/^\s+"[^"]+",$/gmu)).toHaveLength(10);
    expect(compatibilityScenarioBlock).not.toContain('"dreaming-shadow-trial-report"');
    expect(compatibilityScenarioBlock).not.toContain('"control-ui-chat-flow-playwright"');
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
    expect(smokeRunStep.env.OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS).toBe(
      "${{ needs.preflight.outputs.runner_profile == 'blacksmith' && '0' || '1500' }}",
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
    expect(workflow).not.toContain('grep -Fv "$codex_transport: " "$added_lines"');
    expect(workflow).toContain("packages/net-policy/src/");
    expect(workflow).toContain(
      "grep -En 'HTTP_PROXY|HTTPS_PROXY|NO_PROXY|GLOBAL_AGENT_|OPENCLAW_PROXY_' \"$added_lines\"",
    );
    expect(workflow).toContain('echo "full_codeql=true" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain(
      "if: ${{ github.event_name != 'pull_request' || steps.network-diff-scan.outputs.full_codeql == 'true' }}",
    );
    expect(rawSocketQuery).toMatch(
      /allowedOwnerScope\(\s*call\s*,\s*"extensions\/codex\/src\/app-server\/transport-websocket\.ts"\s*,\s*"connectCodexAppServerUnixSocket"\s*\)/,
    );
    expect(rawSocketQuery).not.toContain(
      'call.getFile().getRelativePath() = "extensions/codex/src/app-server/transport-websocket.ts"',
    );
  });

  it("keeps the Crabbox gate publisher on protected main with minimal permissions", () => {
    const workflow = parse(readFileSync(".github/workflows/pr-crabbox-gate-publisher.yml", "utf8"));
    const publisher = readFileSync("scripts/pr-crabbox-gate-publisher.mjs", "utf8");
    const job = workflow.jobs.publish;
    expect(workflow.permissions).toEqual({});
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job.environment).toBe("qa-live-shared");
    expect(job["timeout-minutes"]).toBe(270);
    expect(job.permissions).toEqual({
      checks: "write",
      contents: "read",
      "pull-requests": "read",
    });
    expect(job.steps[0]).toMatchObject({
      uses: CHECKOUT_V6,
      with: {
        "fetch-depth": 0,
        "persist-credentials": false,
        ref: "${{ github.workflow_sha }}",
      },
    });
    expect(job.steps.at(-1)).toMatchObject({
      env: {
        CRABBOX_ACCESS_CLIENT_ID: "${{ secrets.CRABBOX_ACCESS_CLIENT_ID }}",
        CRABBOX_ACCESS_CLIENT_SECRET: "${{ secrets.CRABBOX_ACCESS_CLIENT_SECRET }}",
        CRABBOX_COORDINATOR:
          "${{ secrets.CRABBOX_COORDINATOR || secrets.OPENCLAW_QA_MANTIS_CRABBOX_COORDINATOR }}",
        CRABBOX_COORDINATOR_TOKEN:
          "${{ secrets.CRABBOX_COORDINATOR_TOKEN || secrets.OPENCLAW_QA_MANTIS_CRABBOX_COORDINATOR_TOKEN }}",
        GH_APP_TOKEN:
          "${{ steps.app-token.outputs.token || steps.app-token-fallback.outputs.token }}",
        GH_TOKEN: "${{ github.token }}",
      },
      run: "node scripts/pr-crabbox-gate-publisher.mjs",
    });
    expect(job.steps[2].run).toContain("crabbox_0.46.0_linux_amd64.tar.gz");
    expect(job.steps[2].run).toContain(
      "6a9341e810307356361dbed4c4b84be28a036b5cc291af1566d2ccd376570d90",
    );
    expect(job.steps.slice(3, 5)).toMatchObject([
      {
        id: "app-token",
        uses: CREATE_GITHUB_APP_TOKEN_V3,
        with: { "app-id": "2729701", "permission-members": "read" },
      },
      {
        id: "app-token-fallback",
        uses: CREATE_GITHUB_APP_TOKEN_V3,
        with: { "app-id": "2971289", "permission-members": "read" },
      },
    ]);
    expect(publisher).toContain("const CHECK_NAME = CRABBOX_GATE_CHECK_NAME");
    expect(readFileSync("scripts/pr-lib/crabbox-gate-contract.mjs", "utf8")).toContain(
      'CRABBOX_GATE_CHECK_NAME = "openclaw/crabbox-gate"',
    );
    expect(publisher).not.toContain('const CHECK_NAME = "openclaw/ci-gate"');
    expect(Object.keys(workflow.on.workflow_dispatch.inputs).toSorted()).toEqual([
      "base_sha",
      "head_sha",
      "pr_number",
    ]);
  });
});

it("pins generated publisher and maturity owners before credentials and selected checkout", () => {
  const pinned = {
    name: "Prepare Git owner",
    uses: "openclaw/openclaw/.github/actions/git-owner@dd4528b6393e7d00063067a080ca7241b48ce475",
  };
  const action = parse(readFileSync(PUBLISH_GENERATED_PR_ACTION, "utf8"));
  expect(action.runs.steps.map(({ name }: WorkflowStep) => name)).toEqual([
    "Prepare Git owner",
    "Create generated PR tokens",
    "Publish generated pull request",
  ]);
  expect(action.runs.steps[0]).toEqual(pinned);
  const steps: WorkflowStep[] = readMaturityScorecardWorkflow().jobs.validate_selected_ref.steps;
  const checkout = steps.findIndex(({ name }) => name === "Checkout selected ref");
  expect(steps[checkout - 1]).toEqual(pinned);
  expect(steps[checkout + 1]?.name).toBe("Validate selected ref");
  const policy = expectDefined(steps[checkout + 1]?.run, "validation body");
  expect(policy).toContain('exec python3 -I -S "$CI_GIT_OWNER" --policy -');
  expect(policy.match(/timeout=\d+/gu)).toEqual(["timeout=60"]);
  expect(policy).not.toMatch(
    /timeout --|(?:^|\s)git (?:fetch|ls-remote|rev-parse|diff|tag|merge-base|check-ref-format)\b|except (?:Exception|BaseException|RuntimeError|SystemExit)|backoff\(/mu,
  );
  for (const file of [
    CONTROL_UI_LOCALE_REFRESH_WORKFLOW,
    NATIVE_APP_LOCALE_REFRESH_WORKFLOW,
    ".github/workflows/ci-test-timings-refit.yml",
    MATURITY_SCORECARD_WORKFLOW,
  ]) {
    const workflow = parse(readFileSync(file, "utf8"));
    const publishers = Object.values(workflow.jobs).flatMap((job) => {
      const jobSteps = (job as { steps?: WorkflowStep[] }).steps ?? [];
      return jobSteps.flatMap((step, index) =>
        step.uses === "./.github/actions/publish-generated-pr"
          ? [{ index, length: jobSteps.length }]
          : [],
      );
    });
    expect(publishers, file).toHaveLength(1);
    expect(publishers[0]?.index, file).toBe(publishers[0]!.length - 1);
  }
});

describe("Linux App validation routing", () => {
  const workflow = parse(readFileSync(".github/workflows/linux-app.yml", "utf8"));
  const linuxSteps: WorkflowStep[] = workflow.jobs.build.steps;
  const macosSteps: WorkflowStep[] = workflow.jobs["test-macos"].steps;
  const packagingSteps = [
    "Stage AppImage GStreamer plugins",
    "Prepare pinned AppImage tools",
    "Build Linux companion bundles",
    "Finalize AppImage",
    "Test native first-run setup and failed Gateway startup",
    "Test packaged AppImage runtime",
    "Upload bundles",
  ];

  it.each(["pull_request", "workflow_dispatch"] as const)(
    "keeps native tests required and selects packaging only for manual validation: %s",
    (eventName) => {
      const selected = (steps: WorkflowStep[]) =>
        steps.filter(
          (step) =>
            !step.if ||
            evaluateWorkflowExpression(`\${{ ${step.if} }}`, {
              eventName,
              repository: "openclaw/openclaw",
              runAttempt: 1,
            }),
        );
      const linux = selected(linuxSteps);
      const macos = selected(macosSteps);
      expect(workflow.jobs.build.if).toBeUndefined();
      expect(workflow.jobs["test-macos"].if).toBeUndefined();
      expect(workflow.jobs.build["continue-on-error"]).toBeUndefined();
      expect(workflow.jobs["test-macos"]["continue-on-error"]).toBeUndefined();
      for (const step of [...linuxSteps, ...macosSteps]) {
        expect(step["continue-on-error"], step.name).toBeUndefined();
      }
      expect(linux.map((step) => step.run)).toContain("cargo +stable fmt --check");
      for (const steps of [linux, macos]) {
        expect(steps.map((step) => step.run)).toContain(
          "cargo +stable test --locked --all-targets",
        );
      }
      expect(
        linux.find((step) => step.name === "Test packaged runtime ABI scanner")?.run,
      ).toContain("-s apps/linux/tests -p 'test_packaged_runtime_smoke.py'");
      for (const name of packagingSteps) {
        expect(
          linuxSteps.some((step) => step.name === name),
          name,
        ).toBe(true);
        expect(
          linux.some((step) => step.name === name),
          name,
        ).toBe(eventName === "workflow_dispatch");
      }
      if (eventName === "pull_request") {
        expect(linux.some((step) => step.uses?.startsWith("actions/upload-artifact@"))).toBe(false);
      }
    },
  );

  it("retains both first-run cases and failure evidence for manual validation", () => {
    const firstRun = linuxSteps.find(
      (step) => step.name === "Test native first-run setup and failed Gateway startup",
    );
    expect(firstRun?.run?.match(/python3 apps\/linux\/tests\/first_run\.py/gu)).toHaveLength(2);
    expect(firstRun?.run).toContain("--local-start-failure");
    for (const [name, id] of [
      ["Upload first-run failure log", "first-run"],
      ["Upload packaged runtime failure evidence", "packaged-runtime"],
    ]) {
      expect(linuxSteps.find((step) => step.name === name)?.if).toBe(
        `github.event_name == 'workflow_dispatch' && failure() && steps.${id}.outcome == 'failure'`,
      );
    }
  });
});

it("reports stale Linux release requests before selected code runs", () => {
  const workflow = parse(readFileSync(".github/workflows/linux-app-release.yml", "utf8"));
  const job = workflow.jobs.validate_release;
  const requestStep = expectDefined((job.steps as WorkflowStep[])[0], "first request validation");
  const requestSha = "a".repeat(40);
  const requestRun = {
    repository: { full_name: "openclaw/openclaw" },
    event: "workflow_dispatch",
    name: "Linux App Release Request",
    head_branch: "main",
    head_sha: requestSha,
    conclusion: "success",
  };
  const github = {
    repository: "openclaw/openclaw",
    workflow_sha: requestSha,
    event: { workflow_run: requestRun },
  };
  const admitted = (context: typeof github) => runInNewContext(job.if, { github: context });
  expect(admitted({ ...github, repository: "untrusted/openclaw" })).toBe(false);
  for (const changedRun of [
    { repository: { full_name: "untrusted/openclaw" } },
    { event: "push" },
    { name: "Another workflow" },
    { head_branch: "topic" },
    { conclusion: "failure" },
  ]) {
    expect(admitted({ ...github, event: { workflow_run: { ...requestRun, ...changedRun } } })).toBe(
      false,
    );
  }
  for (const workflowSha of ["b".repeat(40), requestSha]) {
    expect(admitted({ ...github, workflow_sha: workflowSha })).toBe(true);
    expect(requestStep.name).toBe("Validate trusted release request");
    const output = path.join(tempDirs.make("openclaw-linux-request-"), "output");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-c", expectDefined(requestStep.run, "request validation")], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GITHUB_OUTPUT: output,
        REQUEST_TITLE: "Linux App Release Request [v2026.8.2] desktop=false",
        REQUEST_HEAD_SHA: requestSha,
        WORKFLOW_SHA: workflowSha,
      },
    });
    const matching = workflowSha === requestSha;
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(matching ? 0 : 1);
    expect(readFileSync(output, "utf8")).toBe(
      matching ? "release_tag=v2026.8.2\ndesktop_test_bundles=false\n" : "",
    );
    if (!matching) {
      expect(`${result.stdout}${result.stderr}`).toContain(
        "::error::Main advanced after this Linux release request. Dispatch a new Linux App Release Request",
      );
    }
  }
});

it("pins simple release admission owners before selected checkout and preserves Git contracts", () => {
  const pinned = {
    name: "Prepare Git owner",
    uses: "openclaw/openclaw/.github/actions/git-owner@dd4528b6393e7d00063067a080ca7241b48ce475",
  };
  const workflows = [
    {
      file: ".github/workflows/linux-app-release.yml",
      job: "validate_release",
      checkout: "Checkout selected tag",
      validation: "Ensure tag commit is reachable from its release branch",
    },
    {
      file: ".github/workflows/macos-release.yml",
      job: "validate_macos_release_request",
      checkout: "Checkout selected tag",
      validation: "Validate release tag and package metadata",
    },
    {
      file: ".github/workflows/npm-placeholder-bootstrap.yml",
      job: "plan",
      checkout: "Checkout selected source",
      validation: "Validate trusted workflow and target",
    },
  ] as const;
  for (const entry of workflows) {
    const workflow = parse(readFileSync(entry.file, "utf8"));
    const steps = workflow.jobs[entry.job].steps as WorkflowStep[];
    const checkout = steps.findIndex(({ name }) => name === entry.checkout);
    expect(steps[checkout - 1]).toEqual(pinned);
    const validation = steps.find(({ name }) => name === entry.validation);
    const body = expectDefined(validation?.run, `${entry.file} admission body`);
    expect(body).not.toMatch(/timeout --|(?:^|\s)git (?:fetch|rev-parse|merge-base)\b/mu);
    expect(body).not.toMatch(/backoff\(|for attempt in range/u);
  }

  const request = parse(readFileSync(".github/workflows/linux-app-release-request.yml", "utf8"));
  const linux = parse(readFileSync(workflows[0].file, "utf8"));
  expect(request["run-name"]).toBe(
    "Linux App Release Request [${{ inputs.tag }}] desktop=${{ inputs['desktop-test-bundles'] }}",
  );
  expect(request.permissions).toEqual({});
  expect(Object.keys(request.on.workflow_dispatch.inputs)).toEqual(["tag", "desktop-test-bundles"]);
  expect(request.jobs.validate_request.permissions).toBeUndefined();
  expect(JSON.stringify(request)).not.toContain("${{ secrets.");
  expect(linux.on).toEqual({
    workflow_run: {
      workflows: ["Linux App Release Request"],
      branches: ["main"],
      types: ["completed"],
    },
  });
  const releaseDocs = expectDefined(
    readFileSync("apps/linux/README.md", "utf8").split("## Releases\n")[1],
    "Linux release documentation",
  );
  expect(releaseDocs).toMatch(/dispatch `Linux App Release Request` from `main`/u);
  expect(releaseDocs).toContain("stable release tag in `tag`");
  expect(releaseDocs).toMatch(/optional\s+`desktop-test-bundles` input/u);
  expect(releaseDocs).toMatch(/successful request automatically triggers `Linux App Release`/u);
  expect(releaseDocs).not.toContain("release-publish/");
  expect(linux.permissions).toEqual({});
  expect(linux.jobs.validate_release.if).toContain(
    "github.event.workflow_run.repository.full_name == 'openclaw/openclaw'",
  );
  expect(linux.jobs.validate_release.if).toContain(
    "github.event.workflow_run.event == 'workflow_dispatch'",
  );
  expect(linux.jobs.validate_release.if).toContain(
    "github.event.workflow_run.head_branch == 'main'",
  );
  expect(linux.jobs.validate_release.if).toContain(
    "github.event.workflow_run.conclusion == 'success'",
  );
  const tauriSigningEnvNames = [
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PATH",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "TAURI_PRIVATE_KEY",
    "TAURI_PRIVATE_KEY_PATH",
    "TAURI_PRIVATE_KEY_PASSWORD",
    "TAURI_KEY_PASSWORD",
  ];
  const selectedTagJobs = ["validate_release", "build_linux", "build_macos", "build_windows"];
  for (const jobName of selectedTagJobs) {
    const job = linux.jobs[jobName];
    const checkout = expectDefined(
      (job.steps as WorkflowStep[]).find(({ name }) => name === "Checkout selected tag"),
      `${jobName} selected-tag checkout`,
    );
    expect(job.permissions, jobName).toEqual({ contents: "read" });
    expect(checkout.with?.["persist-credentials"], jobName).toBe(false);
    const jobJson = JSON.stringify(job);
    expect(jobJson, jobName).not.toContain("${{ secrets.");
    for (const envName of tauriSigningEnvNames) {
      expect(jobJson, jobName).not.toContain(envName);
    }
  }
  expect(
    Object.entries(linux.jobs)
      .filter(
        ([, job]) =>
          (job as { permissions?: { contents?: string } }).permissions?.contents === "write",
      )
      .map(([name]) => name),
  ).toEqual(["publish"]);
  expect(linux.jobs.publish.permissions).toEqual({ contents: "write" });
  expect(
    Object.entries(linux.jobs)
      .filter(([, job]) => JSON.stringify(job).includes("${{ secrets.TAURI_SIGNING_PRIVATE_KEY"))
      .map(([name]) => name),
  ).toEqual(["sign_linux", "sign_desktop"]);
  const linuxSteps = linux.jobs.validate_release.steps as WorkflowStep[];
  expect(
    linuxSteps.find(({ name }) => name === "Checkout trusted release tooling")?.with,
  ).toMatchObject({
    ref: "${{ github.workflow_sha }}",
    path: ".release-tooling",
    "persist-credentials": false,
    "sparse-checkout":
      "apps/linux/src-tauri/tauri.conf.json\nscripts/lib/record-shared.mjs\nscripts/release-tooling-identity.mjs\n",
  });
  const tooling = linuxSteps.find(({ name }) => name === "Verify trusted release tooling identity");
  expect(tooling?.env).toMatchObject({
    WORKFLOW_FULL_REF: "${{ github.ref }}",
    WORKFLOW_REF: "${{ github.ref_name }}",
    WORKFLOW_SHA: "${{ github.workflow_sha }}",
  });
  expect(tooling?.run).toContain(
    "node .release-tooling/scripts/release-tooling-identity.mjs verify",
  );
  expect(tooling?.run).not.toContain("--allow-prevalidated-ref");
  expect(linuxSteps.indexOf(tooling!)).toBeLessThan(
    linuxSteps.findIndex(({ id }) => id === "ancestry"),
  );
  expect(linux.jobs.validate_release.outputs).toEqual({
    desktop_test_bundles: "${{ steps.request.outputs.desktop_test_bundles }}",
    release_tag: "${{ steps.request.outputs.release_tag }}",
    tag_sha: "${{ steps.ancestry.outputs.tag_sha }}",
    updater_pubkey: "${{ steps.updater_trust.outputs.updater_pubkey }}",
  });
  const releaseRequest = expectDefined(
    linuxSteps.find(({ id }) => id === "request"),
    "trusted release request validation",
  );
  expect(releaseRequest.env).toEqual({
    REQUEST_TITLE: "${{ github.event.workflow_run.display_title }}",
    REQUEST_HEAD_SHA: "${{ github.event.workflow_run.head_sha }}",
    WORKFLOW_SHA: "${{ github.workflow_sha }}",
  });
  expect(releaseRequest.run).toContain("Release request title does not match");
  expect(releaseRequest.run).toContain('echo "release_tag=${BASH_REMATCH[1]}"');
  expect(releaseRequest.run).toContain('echo "desktop_test_bundles=${BASH_REMATCH[3]}"');
  const requestRoot = tempDirs.make("openclaw-linux-release-request-");
  const requestOutput = path.join(requestRoot, "output");
  const acceptedRequest = spawnSync("bash", ["-c", releaseRequest.run ?? ""], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: requestOutput,
      REQUEST_TITLE: "Linux App Release Request [v2026.8.2] desktop=true",
      REQUEST_HEAD_SHA: "a".repeat(40),
      WORKFLOW_SHA: "a".repeat(40),
    },
  });
  expect(acceptedRequest.status, `${acceptedRequest.stdout}${acceptedRequest.stderr}`).toBe(0);
  expect(readFileSync(requestOutput, "utf8")).toBe(
    "release_tag=v2026.8.2\ndesktop_test_bundles=true\n",
  );
  const rejectedRequest = spawnSync("bash", ["-c", releaseRequest.run ?? ""], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: requestOutput,
      REQUEST_TITLE: "Linux App Release Request [v2026.8.2] desktop=true extra",
      REQUEST_HEAD_SHA: "a".repeat(40),
      WORKFLOW_SHA: "a".repeat(40),
    },
  });
  expect(rejectedRequest.status).toBe(1);
  const updaterTrust = expectDefined(
    linuxSteps.find(({ id }) => id === "updater_trust"),
    "updater trust-root validation",
  );
  expect(updaterTrust.run).toContain("selected_config=apps/linux/src-tauri/tauri.conf.json");
  expect(updaterTrust.run).toContain(
    "trusted_config=.release-tooling/apps/linux/src-tauri/tauri.conf.json",
  );
  expect(updaterTrust.run).toContain('-L "$selected_config"');
  expect(updaterTrust.run).toContain('-L "$trusted_config"');
  expect(updaterTrust.run).toContain('"$selected_pubkey" != "$trusted_pubkey"');
  expect(updaterTrust.run).toContain('echo "updater_pubkey=$trusted_pubkey" >> "$GITHUB_OUTPUT"');
  for (const jobName of ["build_linux", "build_macos", "build_windows"]) {
    const steps = linux.jobs[jobName].steps as WorkflowStep[];
    const checkoutIndex = steps.findIndex(({ name }) => name === "Checkout selected tag");
    expect(steps[checkoutIndex]?.with?.ref).toBe("${{ needs.validate_release.outputs.tag_sha }}");
    expect(checkoutIndex, `${jobName} selected checkout order`).toBeGreaterThan(0);
    expect(
      steps.slice(0, checkoutIndex).some(({ uses }) => uses?.startsWith("./")),
      `${jobName} pre-checkout local action`,
    ).toBe(false);
    expect(
      steps.slice(checkoutIndex + 1).some(({ uses }) => uses?.startsWith("./")),
      `${jobName} selected-tag local action`,
    ).toBe(false);
    expect(JSON.stringify(steps), `${jobName} Actions cache usage`).not.toContain("actions/cache");
    const install = expectDefined(
      steps.find(({ name }) => name === "Install selected-tag dependencies"),
      `${jobName} dependency install`,
    );
    expect(steps.indexOf(install), `${jobName} install order`).toBeGreaterThan(checkoutIndex);
    expect(install.run).toContain("corepack enable");
    expect(install.run).toContain("pnpm install --frozen-lockfile");
  }
  const linuxBuildSteps = linux.jobs.build_linux.steps as WorkflowStep[];
  const selectedTagCheckout = linuxBuildSteps.findIndex(
    ({ name }) => name === "Checkout selected tag",
  );
  const trustedToolingCheckout = linuxBuildSteps.findIndex(
    ({ name }) => name === "Checkout trusted Linux packaging tooling",
  );
  const selectedTagInstall = linuxBuildSteps.findIndex(
    ({ name }) => name === "Install selected-tag dependencies",
  );
  expect(selectedTagCheckout).toBeGreaterThan(0);
  expect(selectedTagInstall).toBeGreaterThan(selectedTagCheckout);
  expect(trustedToolingCheckout).toBe(selectedTagInstall + 1);
  const trustedToolingOptions = linuxBuildSteps[trustedToolingCheckout]?.with;
  expect(trustedToolingOptions).toMatchObject({
    ref: "${{ github.workflow_sha }}",
    path: ".release-tooling",
    "fetch-depth": 1,
    "persist-credentials": false,
    "sparse-checkout-cone-mode": false,
  });
  const trustedToolingFiles = [
    "apps/linux/scripts/stage-appimage-gstreamer.sh",
    "apps/linux/scripts/tauri-appimage-tools.sh",
    "apps/linux/scripts/tauri-appimage-tools-x86_64.tsv",
    "apps/linux/scripts/finalize-appimage.sh",
    "apps/linux/tests/packaged_runtime_smoke.py",
    "apps/linux/tests/first_run.py",
  ];
  expect(String(trustedToolingOptions?.["sparse-checkout"]).trim().split("\n")).toEqual(
    trustedToolingFiles,
  );
  const packagedRuntimeSmoke = "apps/linux/tests/packaged_runtime_smoke.py";
  const firstRunDriver = path.posix.join(path.posix.dirname(packagedRuntimeSmoke), "first_run.py");
  expect(readFileSync(packagedRuntimeSmoke, "utf8")).toContain(
    'Path(__file__).with_name("first_run.py")',
  );
  expect(firstRunDriver).toBe("apps/linux/tests/first_run.py");
  expect(trustedToolingFiles).toContain(firstRunDriver);
  expect(
    path.posix.join(path.posix.dirname(`.release-tooling/${packagedRuntimeSmoke}`), "first_run.py"),
  ).toBe(".release-tooling/apps/linux/tests/first_run.py");
  const buildLinuxBundles = expectDefined(
    linuxBuildSteps.find(({ name }) => name === "Build Linux companion bundles"),
    "Linux bundle build step",
  );
  expect(buildLinuxBundles["working-directory"]).toBe("apps/linux/src-tauri");
  expect(buildLinuxBundles.env?.LDAI_RUNTIME_FILE).toBe(
    "${{ runner.temp }}/openclaw-tauri-cache/tauri/.appimage-runtime-x86_64",
  );
  expect(buildLinuxBundles.run).toContain('\\"createUpdaterArtifacts\\":false');
  expect(buildLinuxBundles.run).toContain('\\"useLocalToolsDir\\":false');
  const stageLinuxBundles = expectDefined(
    linuxBuildSteps.find(({ name }) => name === "Verify and stage unsigned Linux bundles"),
    "Linux unsigned bundle staging",
  );
  expect(stageLinuxBundles.run).toContain(
    'cp "${debs[0]}" "dist/linux-app/release/OpenClaw-${version}-amd64.deb"',
  );
  expect(stageLinuxBundles.run).toContain(
    'cp "${appimages[0]}" "dist/linux-app/unsigned/OpenClaw-${version}-amd64.AppImage"',
  );
  const buildLinuxJson = JSON.stringify(linux.jobs.build_linux);
  expect(buildLinuxJson).not.toContain("${{ secrets.");
  for (const name of tauriSigningEnvNames) {
    expect(buildLinuxJson).not.toContain(name);
  }
  const finalizeAppImage = expectDefined(
    linuxBuildSteps.find(({ name }) => name === "Finalize AppImage"),
    "Linux AppImage finalizer step",
  );
  for (const name of tauriSigningEnvNames) {
    expect(finalizeAppImage.env ?? {}).not.toHaveProperty(name);
  }
  expect(finalizeAppImage.run).not.toContain("signer sign");
  expect(linuxBuildSteps.find(({ name }) => name === "Sign finalized AppImage")).toBeUndefined();
  expect(linux.jobs.build_linux.outputs).toEqual({
    deb_artifact_id: "${{ steps.upload_deb.outputs.artifact-id }}",
    unsigned_appimage_artifact_id: "${{ steps.upload_appimage.outputs.artifact-id }}",
  });
  expect(linuxBuildSteps.find(({ id }) => id === "upload_deb")?.with).toMatchObject({
    name: "linux-app-release-deb",
    path: "dist/linux-app/release/*.deb",
  });
  expect(linuxBuildSteps.find(({ id }) => id === "upload_appimage")?.with).toMatchObject({
    name: "linux-app-release-unsigned-appimage",
    path: "dist/linux-app/unsigned/*.AppImage",
  });
  const signingJob = linux.jobs.sign_linux;
  const signingSteps = signingJob.steps as WorkflowStep[];
  expect(signingJob.needs).toEqual(["validate_release", "build_linux"]);
  expect(signingJob.permissions).toEqual({});
  expect(signingJob.outputs).toEqual({
    signed_appimage_artifact_id: "${{ steps.upload_signed_appimage.outputs.artifact-id }}",
  });
  expect(
    signingSteps.map(({ uses }) => uses).filter((uses): uses is string => uses !== undefined),
  ).toEqual([DOWNLOAD_ARTIFACT_V8, UPLOAD_ARTIFACT_V7]);
  expect(signingSteps.some((step) => step["working-directory"] !== undefined)).toBe(false);
  const signingBodies = signingSteps.map(({ run }) => run ?? "").join("\n");
  expect(signingBodies).not.toMatch(/(?:^|\s)(?:git|cargo)\s|\.release-tooling|apps\/linux\//mu);
  expect(signingBodies).not.toMatch(/\b(?:npm|pnpm|npx|corepack)\b/u);
  expect(
    signingSteps.find(({ name }) => name === "Download finalized unsigned AppImage")?.with,
  ).toEqual({
    "artifact-ids": "${{ needs.build_linux.outputs.unsigned_appimage_artifact_id }}",
    path: "dist/signing-input",
  });
  const signAppImage = expectDefined(
    signingSteps.find(({ name }) => name === "Sign finalized AppImage"),
    "Linux AppImage signing step",
  );
  expect(signAppImage.env).toMatchObject({
    RELEASE_TAG: "${{ needs.validate_release.outputs.release_tag }}",
    TAG_SHA: "${{ needs.validate_release.outputs.tag_sha }}",
    TAURI_SIGNING_PRIVATE_KEY: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
    UPDATER_PUBLIC_KEY: "${{ needs.validate_release.outputs.updater_pubkey }}",
  });
  const signingToolsInstaller = expectDefined(
    signingSteps.find(({ name }) => name === "Install trusted signing tools"),
    "Linux signing tools installer",
  );
  expect(linux.env).toMatchObject({
    MINISIGN_ARCHIVE_SHA256: "9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73",
    MINISIGN_BINARY_SHA256: "2c74dffcc1c9a5ee55957c60971998ace2b89f22585631594ec2152c588af8db",
    MINISIGN_URL:
      "https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-linux.tar.gz",
    TAURI_CLI_ARCHIVE_SHA256: "6864602a34292aa6f2ad40ae019eebe5c1064d6c623fe20696a8a8974067e60b",
    TAURI_CLI_BINARY_SHA256: "23a27f61c50417fe87c92fa958fb56ecc8de7c791f78df3cac046c8579b45897",
    TAURI_CLI_URL:
      "https://github.com/tauri-apps/tauri/releases/download/tauri-cli-v2.11.4/cargo-tauri-x86_64-unknown-linux-gnu.tgz",
  });
  expect(signingToolsInstaller.run?.match(/--proto '=https' --tlsv1\.2/gu)).toHaveLength(2);
  expect(signingToolsInstaller.run?.match(/--connect-timeout 10 --max-time 120/gu)).toHaveLength(2);
  expect(signingToolsInstaller.run).toContain('--output "$minisign_archive" "$MINISIGN_URL"');
  expect(signingToolsInstaller.run).toContain(
    'printf \'%s  %s\\n\' "$MINISIGN_ARCHIVE_SHA256" "$minisign_archive" | sha256sum --check -',
  );
  expect(signingToolsInstaller.run).toContain(
    'tar -xzf "$minisign_archive" -C "${RUNNER_TEMP}/bin" --strip-components=2 \\\n  minisign-linux/x86_64/minisign',
  );
  expect(signingToolsInstaller.run).toContain(
    'printf \'%s  %s\\n\' "$MINISIGN_BINARY_SHA256" "${RUNNER_TEMP}/bin/minisign" |',
  );
  expect(signingToolsInstaller.run).toContain(
    'printf \'%s  %s\\n\' "$TAURI_CLI_ARCHIVE_SHA256" "$tauri_archive" | sha256sum --check -',
  );
  expect(signingToolsInstaller.run).toContain('--output "$tauri_archive" "$TAURI_CLI_URL"');
  expect(signingToolsInstaller.run).toContain(
    'tar -xzf "$tauri_archive" -C "${RUNNER_TEMP}/bin" cargo-tauri',
  );
  expect(signingToolsInstaller.run).toContain(
    'printf \'%s  %s\\n\' "$TAURI_CLI_BINARY_SHA256" "${RUNNER_TEMP}/bin/cargo-tauri" |',
  );
  expect(signingToolsInstaller.run).toContain(
    'chmod 0555 "${RUNNER_TEMP}/bin/cargo-tauri" "${RUNNER_TEMP}/bin/minisign"',
  );
  expect(signingToolsInstaller.run).toContain('"${RUNNER_TEMP}/bin/cargo-tauri" --version');
  expect(signingToolsInstaller.run).toContain('"${RUNNER_TEMP}/bin/minisign" -v');
  expect(signingToolsInstaller.run).not.toMatch(
    /apt-get|GITHUB_PATH|(?:^|\n)\s*(?:export\s+)?PATH=/u,
  );
  expect(signAppImage.run).toContain(
    'printf \'%s  %s\\n\' "$TAURI_CLI_BINARY_SHA256" "${RUNNER_TEMP}/bin/cargo-tauri"',
  );
  expect(signAppImage.run).toContain(
    'printf \'%s  %s\\n\' "$MINISIGN_BINARY_SHA256" "${RUNNER_TEMP}/bin/minisign"',
  );
  expect(signAppImage.run).toContain(
    'appimage="dist/signing-input/OpenClaw-${version}-amd64.AppImage"',
  );
  expect(signAppImage.run).toContain('"${RUNNER_TEMP}/bin/cargo-tauri" signer sign "$appimage"');
  expect(signAppImage.run).toContain(
    "unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  );
  const signAppImageRun = expectDefined(signAppImage.run, "AppImage signing command");
  expect(signAppImageRun.indexOf("unset TAURI_SIGNING_PRIVATE_KEY")).toBeGreaterThan(
    signAppImageRun.indexOf('"${RUNNER_TEMP}/bin/cargo-tauri" signer sign "$appimage"'),
  );
  expect(signAppImageRun.indexOf("unset TAURI_SIGNING_PRIVATE_KEY")).toBeLessThan(
    signAppImageRun.indexOf('"${RUNNER_TEMP}/bin/minisign" -Vm "$appimage"'),
  );
  expect(signAppImage.run).toContain('before=$(sha256sum "$appimage")');
  expect(signAppImage.run).toContain('after=$(sha256sum "$appimage")');
  expect(signAppImage.run).toContain('base64 --decode < "${appimage}.sig"');
  expect(signAppImage.run).toContain('"${RUNNER_TEMP}/bin/minisign" -Vm "$appimage"');
  expect(signAppImage.run).not.toMatch(/\b(?:curl|wget|npm|pnpm|npx|corepack)\b|https?:\/\//u);
  expect(signAppImage.run).not.toMatch(/(?:^|\n)\s*(?:export\s+)?PATH=/u);
  expect(signAppImage.run).not.toContain("finalize-appimage.sh");
  expect(signingSteps.find(({ id }) => id === "upload_signed_appimage")?.with).toMatchObject({
    name: "linux-app-release-signed-appimage",
    path: "dist/linux-app",
  });
  for (const [jobName, job] of Object.entries(linux.jobs)) {
    if (jobName === "sign_linux" || jobName === "sign_desktop") {
      continue;
    }
    expect(JSON.stringify(job), `${jobName} must not reference signer binaries`).not.toMatch(
      /\$\{RUNNER_TEMP\}\/bin\/(?:cargo-tauri|minisign)/u,
    );
  }
  const macosBuildSteps = linux.jobs.build_macos.steps as WorkflowStep[];
  const buildMacos = expectDefined(
    macosBuildSteps.find(({ name }) => name === "Build macOS test bundles"),
    "macOS bundle build step",
  );
  expect(buildMacos.run).toContain('\\"createUpdaterArtifacts\\":false');
  const stageMacos = expectDefined(
    macosBuildSteps.find(({ name }) => name === "Verify and stage unsigned macOS bundles"),
    "macOS unsigned staging step",
  );
  expect(stageMacos.run).toContain(
    "archives=(apps/linux/src-tauri/target/release/bundle/macos/*.app.tar.gz)",
  );
  expect(stageMacos.run).toContain(
    "signatures=(apps/linux/src-tauri/target/release/bundle/macos/*.sig)",
  );
  expect(stageMacos.run).toContain(
    'tar -czf "$archive" -C "$(dirname "${apps[0]}")" "$(basename "${apps[0]}")"',
  );
  expect(linux.jobs.build_macos.outputs).toEqual({
    dmg_artifact_id: "${{ steps.upload_dmg.outputs.artifact-id }}",
    unsigned_updater_artifact_id: "${{ steps.upload_updater.outputs.artifact-id }}",
  });
  expect(macosBuildSteps.find(({ id }) => id === "upload_dmg")?.with).toMatchObject({
    name: "macos-app-release-dmg",
    path: "dist/macos-app/release/*.dmg",
  });
  expect(macosBuildSteps.find(({ id }) => id === "upload_updater")?.with).toMatchObject({
    name: "macos-app-release-unsigned-updater",
    path: "dist/macos-app/unsigned/*.app.tar.gz",
  });

  const windowsBuildSteps = linux.jobs.build_windows.steps as WorkflowStep[];
  const buildWindows = expectDefined(
    windowsBuildSteps.find(({ name }) => name === "Build Windows test bundle"),
    "Windows bundle build step",
  );
  expect(buildWindows.run).toContain('\\"createUpdaterArtifacts\\":false');
  const stageWindows = expectDefined(
    windowsBuildSteps.find(({ name }) => name === "Verify and stage unsigned Windows bundle"),
    "Windows unsigned staging step",
  );
  expect(stageWindows.run).toContain(
    'Get-ChildItem "apps/linux/src-tauri/target/release/bundle/nsis/*.sig"',
  );
  expect(linux.jobs.build_windows.outputs).toEqual({
    unsigned_updater_artifact_id: "${{ steps.upload_updater.outputs.artifact-id }}",
  });
  expect(windowsBuildSteps.find(({ id }) => id === "upload_updater")?.with).toMatchObject({
    name: "windows-app-release-unsigned-updater",
    path: "dist/windows-app/unsigned/*.exe",
  });

  const desktopSigningJob = linux.jobs.sign_desktop;
  const desktopSigningSteps = desktopSigningJob.steps as WorkflowStep[];
  expect(desktopSigningJob.needs).toEqual(["validate_release", "build_macos", "build_windows"]);
  expect(desktopSigningJob.permissions).toEqual({});
  expect(desktopSigningJob.outputs).toEqual({
    signed_desktop_artifact_id: "${{ steps.upload_signed_desktop.outputs.artifact-id }}",
  });
  expect(
    desktopSigningSteps
      .map(({ uses }) => uses)
      .filter((uses): uses is string => uses !== undefined),
  ).toEqual([DOWNLOAD_ARTIFACT_V8, DOWNLOAD_ARTIFACT_V8, UPLOAD_ARTIFACT_V7]);
  expect(desktopSigningSteps.some((step) => step["working-directory"] !== undefined)).toBe(false);
  const desktopSigningBodies = desktopSigningSteps.map(({ run }) => run ?? "").join("\n");
  expect(desktopSigningBodies).not.toMatch(
    /(?:^|\s)(?:git|cargo)\s|\.release-tooling|apps\/linux\//mu,
  );
  expect(desktopSigningBodies).not.toMatch(/\b(?:npm|pnpm|npx|corepack)\b/u);
  expect(
    desktopSigningSteps.find(({ name }) => name === "Download finalized macOS updater archive")
      ?.with,
  ).toEqual({
    "artifact-ids": "${{ needs.build_macos.outputs.unsigned_updater_artifact_id }}",
    path: "dist/signing-input/macos",
  });
  expect(
    desktopSigningSteps.find(({ name }) => name === "Download finalized Windows updater installer")
      ?.with,
  ).toEqual({
    "artifact-ids": "${{ needs.build_windows.outputs.unsigned_updater_artifact_id }}",
    path: "dist/signing-input/windows",
  });
  const signDesktop = expectDefined(
    desktopSigningSteps.find(({ name }) => name === "Sign finalized desktop updater bundles"),
    "desktop updater signing step",
  );
  expect(signDesktop.env).toMatchObject({
    RELEASE_TAG: "${{ needs.validate_release.outputs.release_tag }}",
    TAG_SHA: "${{ needs.validate_release.outputs.tag_sha }}",
    TAURI_SIGNING_PRIVATE_KEY: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
    UPDATER_PUBLIC_KEY: "${{ needs.validate_release.outputs.updater_pubkey }}",
  });
  expect(desktopSigningSteps.find(({ name }) => name === "Install trusted signing tools")).toEqual(
    signingToolsInstaller,
  );
  expect(signDesktop.run).toContain(
    'printf \'%s  %s\\n\' "$TAURI_CLI_BINARY_SHA256" "${RUNNER_TEMP}/bin/cargo-tauri"',
  );
  expect(signDesktop.run).toContain(
    'printf \'%s  %s\\n\' "$MINISIGN_BINARY_SHA256" "${RUNNER_TEMP}/bin/minisign"',
  );
  expect(signDesktop.run).toContain('"${RUNNER_TEMP}/bin/cargo-tauri" signer sign "$macos"');
  expect(signDesktop.run).toContain('"${RUNNER_TEMP}/bin/cargo-tauri" signer sign "$windows"');
  expect(signDesktop.run).toContain(
    "unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  );
  const signDesktopRun = expectDefined(signDesktop.run, "desktop updater signing command");
  expect(signDesktopRun.indexOf("unset TAURI_SIGNING_PRIVATE_KEY")).toBeGreaterThan(
    signDesktopRun.indexOf('"${RUNNER_TEMP}/bin/cargo-tauri" signer sign "$windows"'),
  );
  expect(signDesktopRun.indexOf("unset TAURI_SIGNING_PRIVATE_KEY")).toBeLessThan(
    signDesktopRun.indexOf('"${RUNNER_TEMP}/bin/minisign" -Vm "$macos"'),
  );
  expect(signDesktop.run).toContain('macos_before=$(sha256sum "$macos")');
  expect(signDesktop.run).toContain('windows_after=$(sha256sum "$windows")');
  expect(signDesktop.run).toContain('"${RUNNER_TEMP}/bin/minisign" -Vm "$macos"');
  expect(signDesktop.run).toContain('"${RUNNER_TEMP}/bin/minisign" -Vm "$windows"');
  expect(signDesktop.run).not.toMatch(/\b(?:curl|wget|npm|pnpm|npx|corepack)\b|https?:\/\//u);
  expect(signDesktop.run).not.toMatch(/(?:^|\n)\s*(?:export\s+)?PATH=/u);
  expect(desktopSigningSteps.find(({ id }) => id === "upload_signed_desktop")?.with).toMatchObject({
    name: "desktop-test-release-signed-updaters",
    path: "dist/desktop-test",
  });

  expect(linux.jobs.publish.needs).toContain("sign_linux");
  expect(linux.jobs.publish.needs).toContain("sign_desktop");
  expect(linux.jobs.publish.if).toContain("needs.sign_linux.result == 'success'");
  expect(linux.jobs.publish.if).toContain("needs.sign_desktop.result == 'success'");
  expect(linux.jobs.publish.if).not.toContain("inputs.");
  expect(
    (linux.jobs.publish.steps as WorkflowStep[]).find(
      ({ name }) => name === "Download Debian bundle",
    )?.with,
  ).toEqual({
    "artifact-ids": "${{ needs.build_linux.outputs.deb_artifact_id }}",
    path: "dist/input/linux/release",
  });
  expect(
    (linux.jobs.publish.steps as WorkflowStep[]).find(
      ({ name }) => name === "Download signed AppImage",
    )?.with,
  ).toEqual({
    "artifact-ids": "${{ needs.sign_linux.outputs.signed_appimage_artifact_id }}",
    path: "dist/input/linux",
  });
  expect(
    (linux.jobs.publish.steps as WorkflowStep[]).find(
      ({ name }) => name === "Download macOS test DMG",
    )?.with,
  ).toEqual({
    "artifact-ids": "${{ needs.build_macos.outputs.dmg_artifact_id }}",
    path: "dist/input/macos/release",
  });
  expect(
    (linux.jobs.publish.steps as WorkflowStep[]).find(
      ({ name }) => name === "Download signed desktop updater bundles",
    )?.with,
  ).toEqual({
    "artifact-ids": "${{ needs.sign_desktop.outputs.signed_desktop_artifact_id }}",
    path: "dist/input",
  });
  const publishLinuxBundles = expectDefined(
    (linux.jobs.publish.steps as WorkflowStep[]).find(
      ({ name }) => name === "Assemble release assets and updater manifest",
    ),
    "Linux release publication step",
  );
  expect(publishLinuxBundles.run).toContain(
    'linux_signature=$(cat "dist/input/linux/signatures/OpenClaw-${version}-amd64.AppImage.sig")',
  );
  expect(publishLinuxBundles.run).toContain(
    '--arg linux_url "${url_base}/OpenClaw-${version}-amd64.AppImage"',
  );
  expect(publishLinuxBundles.run).toContain(
    '"linux-x86_64": {signature: $linux_signature, url: $linux_url}',
  );
  const appImageToolsPath = "apps/linux/scripts/tauri-appimage-tools.sh";
  const appImageTools = readFileSync(appImageToolsPath, "utf8");
  const appImageToolsManifest = readFileSync(
    "apps/linux/scripts/tauri-appimage-tools-x86_64.tsv",
    "utf8",
  );
  const aarch64AppImageToolsManifest = readFileSync(
    "apps/linux/scripts/tauri-appimage-tools-aarch64.tsv",
    "utf8",
  );
  expect(appImageTools).toContain("prepare)");
  expect(appImageTools).toContain('verify_directory "$tools_dir" "$2"');
  expect(appImageTools).toContain("--proto '=https' --tlsv1.2");
  expect(appImageTools).toContain("--connect-timeout 10 --max-time 120");
  expect(appImageTools).toContain("--retry 3 --retry-all-errors");
  expect(appImageTools).toContain('mv -Tn -- "$staging_dir" "$tools_dir"');
  expect(appImageTools).toContain('fail "refusing existing Tauri tool cache: $tools_dir"');
  expect(appImageTools).toContain('offset=$("$plugin" --appimage-offset)');
  expect(appImageTools).toContain('cmp --silent --bytes="$offset" -- "$plugin" "$runtime"');
  expect(appImageToolsManifest.trim().split("\n")).toEqual([
    [
      "AppRun-x86_64",
      "https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-x86_64",
      "f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f",
      "f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f",
      "0555",
    ].join("\t"),
    [
      "linuxdeploy-x86_64.AppImage",
      "https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy/linuxdeploy-x86_64.AppImage",
      "e762bea85c8eb0d4b3508d46e5c1f037f717d0f9303ae3b4aafc8b04991fa1ef",
      "20eebde3c18ae2e44279bd624fc72482503aece216d5d77f10932235342f71c1",
      "0755",
    ].join("\t"),
    [
      "linuxdeploy-plugin-gtk.sh",
      "https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/b5eb8d05b4c0ed40107fe2158c5d8527f94568ef/linuxdeploy-plugin-gtk.sh",
      "cb379f9b0733e9ad9f8bd78f8c2fa038aef2478523bb7d4c8e64ff6a1ea3501a",
      "cb379f9b0733e9ad9f8bd78f8c2fa038aef2478523bb7d4c8e64ff6a1ea3501a",
      "0555",
    ].join("\t"),
    [
      "linuxdeploy-plugin-gstreamer.sh",
      "https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gstreamer/2a2e67491c32995a3f279ad0ecbe77abd512b42a/linuxdeploy-plugin-gstreamer.sh",
      "c107b49d84edbffc6ab226ed1007e0626a4f7aa2c3a36b7782bef62351d49e94",
      "c107b49d84edbffc6ab226ed1007e0626a4f7aa2c3a36b7782bef62351d49e94",
      "0555",
    ].join("\t"),
    [
      "linuxdeploy-plugin-appimage.AppImage",
      "https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-x86_64.AppImage",
      "0441769ab38009504d2678c38cd7e526955388dd30a215b4a20afaa5471652f2",
      "0441769ab38009504d2678c38cd7e526955388dd30a215b4a20afaa5471652f2",
      "0555",
    ].join("\t"),
  ]);
  expect(aarch64AppImageToolsManifest.trim().split("\n")).toEqual([
    [
      "AppRun-aarch64",
      "https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-aarch64",
      "072f17c0895a85c490282fe5395c5007e5fc75da727e553b3b8fb680feb11578",
      "072f17c0895a85c490282fe5395c5007e5fc75da727e553b3b8fb680feb11578",
      "0555",
    ].join("\t"),
    [
      "linuxdeploy-aarch64.AppImage",
      "https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy/linuxdeploy-aarch64.AppImage",
      "b12b5cc57bd0921e1f98d73f58aa364503bc1a27f54b7a69fd2870bce7fa2f55",
      "a4335edd7c91b99fa9fbb2339d8e5611efbc4fd243ad07b9980ddc961b77d632",
      "0755",
    ].join("\t"),
    [
      "linuxdeploy-plugin-gtk.sh",
      "https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/b5eb8d05b4c0ed40107fe2158c5d8527f94568ef/linuxdeploy-plugin-gtk.sh",
      "cb379f9b0733e9ad9f8bd78f8c2fa038aef2478523bb7d4c8e64ff6a1ea3501a",
      "cb379f9b0733e9ad9f8bd78f8c2fa038aef2478523bb7d4c8e64ff6a1ea3501a",
      "0555",
    ].join("\t"),
    [
      "linuxdeploy-plugin-gstreamer.sh",
      "https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gstreamer/2a2e67491c32995a3f279ad0ecbe77abd512b42a/linuxdeploy-plugin-gstreamer.sh",
      "c107b49d84edbffc6ab226ed1007e0626a4f7aa2c3a36b7782bef62351d49e94",
      "c107b49d84edbffc6ab226ed1007e0626a4f7aa2c3a36b7782bef62351d49e94",
      "0555",
    ].join("\t"),
    [
      "linuxdeploy-plugin-appimage.AppImage",
      "https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-aarch64.AppImage",
      "ce574719bcf9cc1fb12728d60b17e48cc87d9b6c40f6f48b04cff7d273b5eb24",
      "ce574719bcf9cc1fb12728d60b17e48cc87d9b6c40f6f48b04cff7d273b5eb24",
      "0555",
    ].join("\t"),
  ]);
  expect(appImageTools).toMatch(/continuous[\s\S]*digest-pinned/u);

  const prLinux = parse(readFileSync(".github/workflows/linux-app.yml", "utf8"));
  expect(prLinux.jobs.build["runs-on"]).toBe("ubuntu-22.04");
  expect(prLinux.jobs.build.strategy).toBeUndefined();
  expect(prLinux.on.workflow_dispatch?.inputs).toBeUndefined();
  const abiScannerTest = expectDefined(
    (prLinux.jobs.build.steps as WorkflowStep[]).find(
      ({ name }) => name === "Test packaged runtime ABI scanner",
    ),
    "pull request AppImage ABI scanner test",
  );
  expect(abiScannerTest.run).toContain("python3 -m unittest discover");
  expect(abiScannerTest.run).toContain("-s apps/linux/tests -p 'test_packaged_runtime_smoke.py'");
  const workflowContracts = [
    {
      job: prLinux.jobs.build,
      helper: appImageToolsPath,
      label: "pull request",
    },
    {
      job: linux.jobs.build_linux,
      helper: `.release-tooling/${appImageToolsPath}`,
      label: "release",
    },
  ];
  for (const contract of workflowContracts) {
    const steps = contract.job.steps as WorkflowStep[];
    const prepareIndex = steps.findIndex(({ name }) => name === "Prepare pinned AppImage tools");
    const buildIndex = steps.findIndex(({ name }) => name === "Build Linux companion bundles");
    const finalizeIndex = steps.findIndex(({ name }) => name === "Finalize AppImage");
    expect(prepareIndex, `${contract.label} prepare`).toBeGreaterThan(0);
    expect(buildIndex, `${contract.label} build`).toBe(prepareIndex + 1);
    expect(finalizeIndex, `${contract.label} finalize`).toBe(buildIndex + 1);
    for (const index of [prepareIndex, buildIndex, finalizeIndex]) {
      expect(steps[index]?.env?.XDG_CACHE_HOME, `${contract.label} cache path`).toBe(
        "${{ runner.temp }}/openclaw-tauri-cache",
      );
    }
    expect(steps[prepareIndex]?.run, contract.label).toContain(`${contract.helper} prepare`);
    expect(steps[prepareIndex]?.run, contract.label).toContain(
      `${contract.helper} verify pre-build`,
    );
    expect(steps[buildIndex]?.run, contract.label).toContain("@tauri-apps/cli@2.11.4");
    expect(steps[buildIndex]?.run, contract.label).toMatch(/\\?"useLocalToolsDir\\?":false/u);
    expect(steps[finalizeIndex]?.run, contract.label).toMatch(
      /finalize-appimage\.sh "?\\?\$?bundle_dir"?|finalize-appimage\.sh apps\/linux\/src-tauri\/target\/release\/bundle\/appimage/u,
    );
    expect(JSON.stringify(contract.job), contract.label).not.toContain("${{ secrets.");
  }
  const prPrepare = expectDefined(
    (prLinux.jobs.build.steps as WorkflowStep[]).find(
      ({ name }) => name === "Prepare pinned AppImage tools",
    ),
    "pull request AppImage tool preparation",
  );
  expect(prPrepare.run).toContain(
    "runtime_file=$(apps/linux/scripts/tauri-appimage-tools.sh runtime-path)",
  );
  expect(prPrepare.run).toContain(
    'printf \'LDAI_RUNTIME_FILE=%s\\n\' "$runtime_file" >> "$GITHUB_ENV"',
  );
  expect(
    (prLinux.jobs.build.steps as WorkflowStep[]).find(
      ({ name }) => name === "Build Linux companion bundles",
    )?.env,
  ).not.toHaveProperty("LDAI_RUNTIME_FILE");
  expect(linux.jobs.build_linux["runs-on"]).toBe("ubuntu-22.04");
  expect(linux.jobs.build_linux.strategy).toBeUndefined();
  const finalizerSource = readFileSync("apps/linux/scripts/finalize-appimage.sh", "utf8");
  const postBuildVerifications =
    finalizerSource.match(/"\$tools_helper" verify post-build/gu) ?? [];
  expect(postBuildVerifications).toHaveLength(2);
  expect(finalizerSource.indexOf(postBuildVerifications[0]!)).toBeLessThan(
    finalizerSource.indexOf("mapfile -d '' forbidden_libraries"),
  );
  expect(finalizerSource.lastIndexOf(postBuildVerifications[1]!)).toBeLessThan(
    finalizerSource.indexOf('"$plugin" --appdir "$appdir"'),
  );
  expect(finalizerSource).toContain('LDAI_RUNTIME_FILE="$runtime"');
  const architectureRoot = tempDirs.make("openclaw-appimage-architecture-");
  const architectureBin = path.join(architectureRoot, "bin");
  const architectureCache = path.join(architectureRoot, "cache");
  mkdirSync(architectureBin);
  writeExecutable(path.join(architectureBin, "uname"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'case "$1" in',
    '  -s) printf "%s\\n" "${SYNTHETIC_UNAME_SYSTEM:?}" ;;',
    '  -m) printf "%s\\n" "${SYNTHETIC_UNAME_MACHINE:?}" ;;',
    "  *) exit 64 ;;",
    "esac",
  ]);
  const architectureEnv = (system: string, machine: string, cache = architectureCache) => ({
    ...process.env,
    PATH: `${architectureBin}${path.delimiter}${process.env.PATH ?? ""}`,
    SYNTHETIC_UNAME_MACHINE: machine,
    SYNTHETIC_UNAME_SYSTEM: system,
    XDG_CACHE_HOME: cache,
  });
  for (const [machine, expected] of [
    ["x86_64", "x86_64"],
    ["amd64", "x86_64"],
    ["aarch64", "aarch64"],
    ["arm64", "aarch64"],
  ] as const) {
    const result = spawnSync(path.resolve(appImageToolsPath), ["architecture"], {
      encoding: "utf8",
      env: architectureEnv("Linux", machine),
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toBe(`${expected}\n`);
    expect(existsSync(architectureCache)).toBe(false);
  }
  const runtimePath = spawnSync(path.resolve(appImageToolsPath), ["runtime-path"], {
    encoding: "utf8",
    env: architectureEnv("Linux", "arm64"),
  });
  expect(runtimePath.status, `${runtimePath.stdout}${runtimePath.stderr}`).toBe(0);
  expect(runtimePath.stdout).toBe(`${architectureCache}/tauri/.appimage-runtime-aarch64\n`);
  expect(existsSync(architectureCache)).toBe(false);
  const relativeRuntimePath = spawnSync(path.resolve(appImageToolsPath), ["runtime-path"], {
    encoding: "utf8",
    env: architectureEnv("Linux", "x86_64", "relative-cache"),
  });
  expect(relativeRuntimePath.status).not.toBe(0);
  for (const [system, machine] of [
    ["Darwin", "arm64"],
    ["Linux", "riscv64"],
  ] as const) {
    const rejectedCache = path.join(architectureRoot, `${system}-${machine}`);
    const result = spawnSync(path.resolve(appImageToolsPath), ["prepare"], {
      encoding: "utf8",
      env: architectureEnv(system, machine, rejectedCache),
    });
    expect(result.status).not.toBe(0);
    expect(existsSync(rejectedCache)).toBe(false);
  }
  if (process.platform === "linux") {
    const selectedTagRoot = tempDirs.make("openclaw-linux-release-v2026.8.2-");
    const trustedTools = path.join(
      selectedTagRoot,
      ".release-tooling/apps/linux/scripts/tauri-appimage-tools.sh",
    );
    const trustedToolsManifest = path.join(
      selectedTagRoot,
      ".release-tooling/apps/linux/scripts/tauri-appimage-tools-x86_64.tsv",
    );
    const trustedArmToolsManifest = path.join(
      selectedTagRoot,
      ".release-tooling/apps/linux/scripts/tauri-appimage-tools-aarch64.tsv",
    );
    const trustedFinalizer = path.join(
      selectedTagRoot,
      ".release-tooling/apps/linux/scripts/finalize-appimage.sh",
    );
    const trustedSmoke = path.join(
      selectedTagRoot,
      ".release-tooling/apps/linux/tests/packaged_runtime_smoke.py",
    );
    const trustedFirstRun = path.join(
      selectedTagRoot,
      ".release-tooling/apps/linux/tests/first_run.py",
    );
    const bundleDir = path.join(
      selectedTagRoot,
      "apps/linux/src-tauri/target/release/bundle/appimage",
    );
    const appDir = path.join(bundleDir, "OpenClaw.AppDir");
    const appImage = path.join(bundleDir, "OpenClaw_2026.8.2_amd64.AppImage");
    const cacheRoot = path.join(selectedTagRoot, ".cache");
    const toolSourceDir = path.join(selectedTagRoot, "tool-sources");
    const fakeBin = path.join(selectedTagRoot, "fake-bin");
    const pluginSentinel = path.join(selectedTagRoot, "plugin-executed");
    const toolNames = [
      "AppRun-x86_64",
      "linuxdeploy-x86_64.AppImage",
      "linuxdeploy-plugin-gtk.sh",
      "linuxdeploy-plugin-gstreamer.sh",
      "linuxdeploy-plugin-appimage.AppImage",
    ] as const;
    mkdirSync(path.dirname(trustedFinalizer), { recursive: true });
    mkdirSync(path.dirname(trustedSmoke), { recursive: true });
    mkdirSync(toolSourceDir, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    copyFileSync("apps/linux/scripts/tauri-appimage-tools.sh", trustedTools);
    copyFileSync("apps/linux/scripts/tauri-appimage-tools-x86_64.tsv", trustedToolsManifest);
    copyFileSync("apps/linux/scripts/finalize-appimage.sh", trustedFinalizer);
    copyFileSync("apps/linux/tests/packaged_runtime_smoke.py", trustedSmoke);
    copyFileSync("apps/linux/tests/first_run.py", trustedFirstRun);
    chmodSync(trustedTools, 0o755);
    chmodSync(trustedFinalizer, 0o755);

    const toolSources = new Map<string, Buffer>();
    for (const toolName of toolNames) {
      const contents =
        toolName === "linuxdeploy-plugin-appimage.AppImage"
          ? Buffer.from(
              [
                "#!/usr/bin/env bash",
                "set -euo pipefail",
                'if [[ ${1:-} == "--appimage-offset" ]]; then',
                "  printf '16\\n'",
                "  exit 0",
                "fi",
                '[[ "$1" == "--appdir" && -d "$2" ]]',
                '[[ "${ARCH:?}" == "${EXPECTED_ARCH:?}" ]]',
                '[[ -f "${LDAI_RUNTIME_FILE:?}" ]]',
                'printf "executed\\n" > "$PLUGIN_SENTINEL"',
                'cat "$LDAI_RUNTIME_FILE" > "$LDAI_OUTPUT"',
                `printf '\\n#!/bin/sh\\nexit 0\\n' >> "$LDAI_OUTPUT"`,
                'chmod +x "$LDAI_OUTPUT"',
                "",
              ].join("\n"),
            )
          : Buffer.from(`#!/bin/sh\n# synthetic ${toolName}\nexit 0\n`);
      toolSources.set(toolName, contents);
      writeFileSync(path.join(toolSourceDir, toolName), contents, { mode: 0o755 });
    }
    const preBuildLinuxdeploy = Buffer.from(
      expectDefined(toolSources.get("linuxdeploy-x86_64.AppImage"), "linuxdeploy source"),
    );
    const postBuildLinuxdeploy = Buffer.from(preBuildLinuxdeploy);
    postBuildLinuxdeploy.fill(0, 8, 11);
    const digest = (contents: Buffer) => createHash("sha256").update(contents).digest("hex");
    const writeSyntheticManifest = (wrongDigest = false) => {
      writeFileSync(
        trustedToolsManifest,
        toolNames
          .map((toolName, index) => {
            const contents = expectDefined(toolSources.get(toolName), `${toolName} source`);
            const preBuildDigest = wrongDigest && index === 0 ? "0".repeat(64) : digest(contents);
            const postBuildDigest =
              toolName === "linuxdeploy-x86_64.AppImage"
                ? digest(postBuildLinuxdeploy)
                : digest(contents);
            const mode = toolName === "linuxdeploy-x86_64.AppImage" ? "0755" : "0555";
            return [
              toolName,
              `https://example.invalid/${toolName}`,
              preBuildDigest,
              postBuildDigest,
              mode,
            ].join("\t");
          })
          .join("\n") + "\n",
      );
    };
    writeFileSync(
      path.join(fakeBin, "curl"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "output=",
        "url=",
        "while [[ $# -gt 0 ]]; do",
        '  case "$1" in',
        "    --output) output=$2; shift 2 ;;",
        "    https://*) url=$1; shift ;;",
        "    *) shift ;;",
        "  esac",
        "done",
        '[[ -n "$output" && -n "$url" ]]',
        'if [[ ${CACHE_RACE_TOOL:-} == "${url##*/}" ]]; then',
        '  mkdir -p "$XDG_CACHE_HOME/tauri"',
        '  printf "raced\\n" > "$XDG_CACHE_HOME/tauri/race-marker"',
        "fi",
        'cp "$TOOL_SOURCE_DIR/${url##*/}" "$output"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    copyFileSync(path.join(architectureBin, "uname"), path.join(fakeBin, "uname"));
    chmodSync(path.join(fakeBin, "uname"), 0o755);
    const toolEnv = {
      ...process.env,
      EXPECTED_ARCH: "x86_64",
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      SYNTHETIC_UNAME_MACHINE: "x86_64",
      SYNTHETIC_UNAME_SYSTEM: "Linux",
      TOOL_SOURCE_DIR: toolSourceDir,
      XDG_CACHE_HOME: cacheRoot,
    };
    writeSyntheticManifest(true);
    const rejectedPrepare = spawnSync(trustedTools, ["prepare"], {
      cwd: selectedTagRoot,
      encoding: "utf8",
      env: toolEnv,
    });
    expect(rejectedPrepare.status).not.toBe(0);
    expect(existsSync(path.join(cacheRoot, "tauri"))).toBe(false);

    writeSyntheticManifest();
    const rejectedRacedPrepare = spawnSync(trustedTools, ["prepare"], {
      cwd: selectedTagRoot,
      encoding: "utf8",
      env: {
        ...toolEnv,
        CACHE_RACE_TOOL: "linuxdeploy-plugin-appimage.AppImage",
      },
    });
    expect(
      rejectedRacedPrepare.status,
      `${rejectedRacedPrepare.stdout}${rejectedRacedPrepare.stderr}`,
    ).not.toBe(0);
    expect(readFileSync(path.join(cacheRoot, "tauri/race-marker"), "utf8")).toBe("raced\n");
    expect(globSync(path.join(cacheRoot, ".tauri-tools.*"))).toEqual([]);
    rmSync(path.join(cacheRoot, "tauri"), { recursive: true });

    const prepared = spawnSync(trustedTools, ["prepare"], {
      cwd: selectedTagRoot,
      encoding: "utf8",
      env: toolEnv,
    });
    expect(prepared.status, `${prepared.stdout}${prepared.stderr}`).toBe(0);
    expect(globSync(path.join(cacheRoot, ".tauri-tools.*"))).toEqual([]);
    const verifiedPreBuild = spawnSync(trustedTools, ["verify", "pre-build"], {
      cwd: selectedTagRoot,
      encoding: "utf8",
      env: toolEnv,
    });
    expect(verifiedPreBuild.status, `${verifiedPreBuild.stdout}${verifiedPreBuild.stderr}`).toBe(0);
    const toolsDir = path.join(cacheRoot, "tauri");
    const runtime = path.join(toolsDir, ".appimage-runtime-x86_64");
    const appImagePlugin = expectDefined(
      toolSources.get("linuxdeploy-plugin-appimage.AppImage"),
      "AppImage plugin source",
    );
    expect(readFileSync(runtime)).toEqual(appImagePlugin.subarray(0, 16));
    expect(statSync(runtime).mode & 0o777).toBe(0o444);
    const rejectedStaleCache = spawnSync(trustedTools, ["prepare"], {
      cwd: selectedTagRoot,
      encoding: "utf8",
      env: toolEnv,
    });
    expect(rejectedStaleCache.status).not.toBe(0);

    const linuxdeploy = path.join(toolsDir, "linuxdeploy-x86_64.AppImage");
    writeFileSync(linuxdeploy, postBuildLinuxdeploy);
    chmodSync(linuxdeploy, 0o755);
    const verifiedPostBuild = spawnSync(trustedTools, ["verify", "post-build"], {
      cwd: selectedTagRoot,
      encoding: "utf8",
      env: toolEnv,
    });
    expect(verifiedPostBuild.status, `${verifiedPostBuild.stdout}${verifiedPostBuild.stderr}`).toBe(
      0,
    );

    const resetBundle = () => {
      rmSync(bundleDir, { force: true, recursive: true });
      mkdirSync(path.join(appDir, "usr/lib"), { recursive: true });
      writeFileSync(path.join(appDir, "usr/lib/libwayland-client.so.0"), "host-incompatible");
      writeFileSync(appImage, "pre-finalized");
      chmodSync(appImage, 0o755);
      writeFileSync(`${appImage}.sig`, "stale-signature");
      rmSync(pluginSentinel, { force: true });
    };
    const runFinalizer = () =>
      spawnSync(trustedFinalizer, [bundleDir], {
        cwd: selectedTagRoot,
        encoding: "utf8",
        env: {
          ...toolEnv,
          PLUGIN_SENTINEL: pluginSentinel,
        },
      });
    const restoreTool = (toolName: (typeof toolNames)[number]) => {
      const contents =
        toolName === "linuxdeploy-x86_64.AppImage"
          ? postBuildLinuxdeploy
          : expectDefined(toolSources.get(toolName), `${toolName} source`);
      rmSync(path.join(toolsDir, toolName), { force: true });
      writeFileSync(path.join(toolsDir, toolName), contents, { mode: 0o755 });
      chmodSync(
        path.join(toolsDir, toolName),
        toolName === "linuxdeploy-x86_64.AppImage" ? 0o755 : 0o555,
      );
    };

    for (const toolName of toolNames) {
      resetBundle();
      const tool = path.join(toolsDir, toolName);
      chmodSync(tool, 0o755);
      writeFileSync(tool, Buffer.concat([readFileSync(tool), Buffer.from("tampered")]));
      const rejected = runFinalizer();
      expect(rejected.status, `${toolName}: ${rejected.stdout}${rejected.stderr}`).not.toBe(0);
      expect(existsSync(pluginSentinel), `${toolName} plugin execution`).toBe(false);
      expect(existsSync(path.join(appDir, "usr/lib/libwayland-client.so.0")), toolName).toBe(true);
      expect(readFileSync(appImage, "utf8"), toolName).toBe("pre-finalized");
      expect(readFileSync(`${appImage}.sig`, "utf8"), toolName).toBe("stale-signature");
      restoreTool(toolName);
    }

    resetBundle();
    const appRun = path.join(toolsDir, "AppRun-x86_64");
    rmSync(appRun);
    symlinkSync(path.join(toolSourceDir, "AppRun-x86_64"), appRun);
    const rejectedSymlink = runFinalizer();
    expect(rejectedSymlink.status).not.toBe(0);
    expect(existsSync(pluginSentinel)).toBe(false);
    restoreTool("AppRun-x86_64");

    resetBundle();
    const gtkPlugin = path.join(toolsDir, "linuxdeploy-plugin-gtk.sh");
    chmodSync(gtkPlugin, 0o444);
    const rejectedNonExecutable = runFinalizer();
    expect(rejectedNonExecutable.status).not.toBe(0);
    expect(existsSync(pluginSentinel)).toBe(false);
    restoreTool("linuxdeploy-plugin-gtk.sh");

    resetBundle();
    chmodSync(runtime, 0o644);
    writeFileSync(runtime, Buffer.concat([readFileSync(runtime), Buffer.from("tampered")]));
    const rejectedRuntime = runFinalizer();
    expect(rejectedRuntime.status).not.toBe(0);
    expect(existsSync(pluginSentinel)).toBe(false);
    expect(existsSync(path.join(appDir, "usr/lib/libwayland-client.so.0"))).toBe(true);
    expect(readFileSync(appImage, "utf8")).toBe("pre-finalized");
    writeFileSync(runtime, appImagePlugin.subarray(0, 16), { mode: 0o644 });
    chmodSync(runtime, 0o444);

    resetBundle();
    const finalized = runFinalizer();
    expect(finalized.status, `${finalized.stdout}${finalized.stderr}`).toBe(0);
    expect(readFileSync(appImage).subarray(0, 16)).toEqual(appImagePlugin.subarray(0, 16));
    expect(readFileSync(appImage, "utf8")).toContain("#!/bin/sh");
    expect(existsSync(`${appImage}.sig`)).toBe(false);
    expect(existsSync(path.join(appDir, "usr/lib/libwayland-client.so.0"))).toBe(false);
    expect(readFileSync(pluginSentinel, "utf8")).toBe("executed\n");

    writeFileSync(
      path.join(appDir, "usr/lib/libwayland-client.so.0"),
      "post-finalization-smoke-fixture",
    );
    expect(existsSync(path.join(selectedTagRoot, "apps/linux/scripts/finalize-appimage.sh"))).toBe(
      false,
    );
    const smokeChild = spawnSync(
      "python3",
      [
        "-c",
        [
          "from pathlib import Path",
          "import subprocess",
          "import sys",
          'child = Path(sys.argv[1]).with_name("first_run.py")',
          "assert child.is_file()",
          'subprocess.run([sys.executable, str(child), "--help"], check=True)',
        ].join("; "),
        trustedSmoke,
      ],
      { cwd: selectedTagRoot, encoding: "utf8" },
    );
    expect(smokeChild.status, `${smokeChild.stdout}${smokeChild.stderr}`).toBe(0);

    const armToolNames = [
      "AppRun-aarch64",
      "linuxdeploy-aarch64.AppImage",
      "linuxdeploy-plugin-gtk.sh",
      "linuxdeploy-plugin-gstreamer.sh",
      "linuxdeploy-plugin-appimage.AppImage",
    ] as const;
    const armToolSourceDir = path.join(selectedTagRoot, "arm-tool-sources");
    const armCacheRoot = path.join(selectedTagRoot, ".arm-cache");
    const armBundleDir = path.join(selectedTagRoot, "arm-bundle");
    const armAppDir = path.join(armBundleDir, "OpenClaw.AppDir");
    const armAppImage = path.join(armBundleDir, "OpenClaw_2026.8.2_arm64.AppImage");
    const armPluginSentinel = path.join(selectedTagRoot, "arm-plugin-executed");
    mkdirSync(armToolSourceDir);
    const armToolSources = new Map<string, Buffer>();
    for (const toolName of armToolNames) {
      const contents =
        toolName === "linuxdeploy-plugin-appimage.AppImage"
          ? expectDefined(toolSources.get(toolName), `${toolName} source`)
          : Buffer.from(`#!/bin/sh\n# synthetic ${toolName}\nexit 0\n`);
      armToolSources.set(toolName, contents);
      writeFileSync(path.join(armToolSourceDir, toolName), contents, { mode: 0o755 });
    }
    const armPostBuildLinuxdeploy = Buffer.from(
      expectDefined(armToolSources.get("linuxdeploy-aarch64.AppImage"), "ARM linuxdeploy source"),
    );
    armPostBuildLinuxdeploy.fill(0, 8, 11);
    writeFileSync(
      trustedArmToolsManifest,
      armToolNames
        .map((toolName) => {
          const contents = expectDefined(armToolSources.get(toolName), `${toolName} source`);
          return [
            toolName,
            `https://example.invalid/${toolName}`,
            digest(contents),
            toolName === "linuxdeploy-aarch64.AppImage"
              ? digest(armPostBuildLinuxdeploy)
              : digest(contents),
            toolName === "linuxdeploy-aarch64.AppImage" ? "0755" : "0555",
          ].join("\t");
        })
        .join("\n") + "\n",
    );
    const armToolEnv = {
      ...toolEnv,
      EXPECTED_ARCH: "aarch64",
      SYNTHETIC_UNAME_MACHINE: "arm64",
      TOOL_SOURCE_DIR: armToolSourceDir,
      XDG_CACHE_HOME: armCacheRoot,
    };
    const armPrepared = spawnSync(trustedTools, ["prepare"], {
      cwd: selectedTagRoot,
      encoding: "utf8",
      env: armToolEnv,
    });
    expect(armPrepared.status, `${armPrepared.stdout}${armPrepared.stderr}`).toBe(0);
    const armRuntimePath = spawnSync(trustedTools, ["runtime-path"], {
      cwd: selectedTagRoot,
      encoding: "utf8",
      env: armToolEnv,
    });
    expect(armRuntimePath.status, `${armRuntimePath.stdout}${armRuntimePath.stderr}`).toBe(0);
    expect(armRuntimePath.stdout).toBe(`${armCacheRoot}/tauri/.appimage-runtime-aarch64\n`);
    const armToolsDir = path.join(armCacheRoot, "tauri");
    const armLinuxdeploy = path.join(armToolsDir, "linuxdeploy-aarch64.AppImage");
    writeFileSync(armLinuxdeploy, armPostBuildLinuxdeploy);
    chmodSync(armLinuxdeploy, 0o755);
    mkdirSync(path.join(armAppDir, "usr/lib"), { recursive: true });
    writeFileSync(path.join(armAppDir, "usr/lib/libwayland-client.so.0"), "host-incompatible");
    writeFileSync(armAppImage, "pre-finalized", { mode: 0o755 });
    writeFileSync(`${armAppImage}.sig`, "stale-signature");
    const armFinalized = spawnSync(trustedFinalizer, [armBundleDir], {
      cwd: selectedTagRoot,
      encoding: "utf8",
      env: {
        ...armToolEnv,
        PLUGIN_SENTINEL: armPluginSentinel,
      },
    });
    expect(armFinalized.status, `${armFinalized.stdout}${armFinalized.stderr}`).toBe(0);
    expect(readFileSync(armAppImage).subarray(0, 16)).toEqual(appImagePlugin.subarray(0, 16));
    expect(existsSync(`${armAppImage}.sig`)).toBe(false);
    expect(existsSync(path.join(armAppDir, "usr/lib/libwayland-client.so.0"))).toBe(false);
    expect(readFileSync(armPluginSentinel, "utf8")).toBe("executed\n");

    const writeSigningToolFixtures = (root: string) => {
      const bin = path.join(root, "bin");
      const poisonBin = path.join(root, "poison-bin");
      const tauri = path.join(bin, "cargo-tauri");
      const tauriLog = path.join(root, "cargo-tauri.log");
      const minisignLog = path.join(root, "minisign.log");
      mkdirSync(bin, { recursive: true });
      mkdirSync(poisonBin, { recursive: true });
      writeFileSync(
        tauri,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          '[[ "$#" -eq 3 && "$1" == "signer" && "$2" == "sign" ]]',
          '[[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]',
          '[[ -n "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]]',
          'printf "%s\\n" "$*" >> "$TAURI_SIGN_LOG"',
          'printf "ephemeral-signature:%s" "$(basename "$3")" | base64 > "$3.sig"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      writeFileSync(
        path.join(bin, "minisign"),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          '[[ "$#" -eq 6 && "$1" == "-Vm" && "$3" == "-x" && "$5" == "-p" ]]',
          '[[ -z "${TAURI_SIGNING_PRIVATE_KEY+x}" ]]',
          '[[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+x}" ]]',
          '[[ -s "$2" && -s "$4" && -s "$6" ]]',
          '[[ "$(cat "$6")" == "ephemeral-public-key" ]]',
          'printf "%s\\n" "$(basename "$2")" >> "$MINISIGN_LOG"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      for (const command of ["cargo-tauri", "minisign", "npm", "pnpm", "npx", "corepack"]) {
        writeFileSync(path.join(poisonBin, command), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
      }
      return {
        minisignBinarySha256: createHash("sha256")
          .update(readFileSync(path.join(bin, "minisign")))
          .digest("hex"),
        minisignLog,
        path: `${poisonBin}${path.delimiter}${process.env.PATH ?? ""}`,
        tauriBinarySha256: createHash("sha256").update(readFileSync(tauri)).digest("hex"),
        tauriLog,
      };
    };

    const signingRoot = tempDirs.make("openclaw-linux-signing-job-");
    const signingInput = path.join(signingRoot, "dist/signing-input");
    const finalizedArtifact = path.join(signingInput, "OpenClaw-2026.8.2-amd64.AppImage");
    mkdirSync(signingInput, { recursive: true });
    writeFileSync(finalizedArtifact, "trusted-finalized-bytes");
    const linuxSigningTools = writeSigningToolFixtures(signingRoot);
    const signed = spawnSync("bash", ["-c", signAppImage.run ?? ""], {
      cwd: signingRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: linuxSigningTools.path,
        RELEASE_TAG: "v2026.8.2",
        RUNNER_TEMP: signingRoot,
        TAG_SHA: "a".repeat(40),
        MINISIGN_BINARY_SHA256: linuxSigningTools.minisignBinarySha256,
        TAURI_CLI_BINARY_SHA256: linuxSigningTools.tauriBinarySha256,
        TAURI_SIGN_LOG: linuxSigningTools.tauriLog,
        TAURI_SIGNING_PRIVATE_KEY: "ephemeral-test-key",
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "ephemeral-test-password",
        UPDATER_PUBLIC_KEY: Buffer.from("ephemeral-public-key").toString("base64"),
        MINISIGN_LOG: linuxSigningTools.minisignLog,
      },
    });
    expect(signed.status, `${signed.stdout}${signed.stderr}`).toBe(0);
    expect(readFileSync(finalizedArtifact, "utf8")).toBe("trusted-finalized-bytes");
    expect(
      readFileSync(
        path.join(signingRoot, "dist/linux-app/release/OpenClaw-2026.8.2-amd64.AppImage"),
        "utf8",
      ),
    ).toBe("trusted-finalized-bytes");
    expect(
      readFileSync(
        path.join(signingRoot, "dist/linux-app/signatures/OpenClaw-2026.8.2-amd64.AppImage.sig"),
        "utf8",
      ),
    ).toBe(
      `${Buffer.from("ephemeral-signature:OpenClaw-2026.8.2-amd64.AppImage").toString("base64")}\n`,
    );
    expect(readFileSync(linuxSigningTools.tauriLog, "utf8")).toBe(
      "signer sign dist/signing-input/OpenClaw-2026.8.2-amd64.AppImage\n",
    );
    expect(readFileSync(linuxSigningTools.minisignLog, "utf8")).toBe(
      "OpenClaw-2026.8.2-amd64.AppImage\n",
    );
    expect(existsSync(path.join(signingRoot, ".release-tooling"))).toBe(false);
    expect(existsSync(path.join(signingRoot, "apps"))).toBe(false);

    const desktopSigningRoot = tempDirs.make("openclaw-desktop-signing-job-");
    const macosInput = path.join(
      desktopSigningRoot,
      "dist/signing-input/macos/OpenClaw-2026.8.2-darwin-aarch64.app.tar.gz",
    );
    const windowsInput = path.join(
      desktopSigningRoot,
      "dist/signing-input/windows/OpenClaw-2026.8.2-windows-x86_64.exe",
    );
    mkdirSync(path.dirname(macosInput), { recursive: true });
    mkdirSync(path.dirname(windowsInput), { recursive: true });
    writeFileSync(macosInput, "finalized-macos-updater-bytes");
    writeFileSync(windowsInput, "finalized-windows-updater-bytes");
    const desktopSigningTools = writeSigningToolFixtures(desktopSigningRoot);
    const desktopSigned = spawnSync("bash", ["-c", signDesktop.run ?? ""], {
      cwd: desktopSigningRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: desktopSigningTools.path,
        RELEASE_TAG: "v2026.8.2",
        RUNNER_TEMP: desktopSigningRoot,
        TAG_SHA: "a".repeat(40),
        MINISIGN_BINARY_SHA256: desktopSigningTools.minisignBinarySha256,
        TAURI_CLI_BINARY_SHA256: desktopSigningTools.tauriBinarySha256,
        TAURI_SIGN_LOG: desktopSigningTools.tauriLog,
        TAURI_SIGNING_PRIVATE_KEY: "ephemeral-test-key",
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "ephemeral-test-password",
        UPDATER_PUBLIC_KEY: Buffer.from("ephemeral-public-key").toString("base64"),
        MINISIGN_LOG: desktopSigningTools.minisignLog,
      },
    });
    expect(desktopSigned.status, `${desktopSigned.stdout}${desktopSigned.stderr}`).toBe(0);
    expect(readFileSync(macosInput, "utf8")).toBe("finalized-macos-updater-bytes");
    expect(readFileSync(windowsInput, "utf8")).toBe("finalized-windows-updater-bytes");
    expect(
      readFileSync(
        path.join(
          desktopSigningRoot,
          "dist/desktop-test/macos/release/OpenClaw-2026.8.2-darwin-aarch64.app.tar.gz",
        ),
        "utf8",
      ),
    ).toBe("finalized-macos-updater-bytes");
    expect(
      readFileSync(
        path.join(
          desktopSigningRoot,
          "dist/desktop-test/windows/release/OpenClaw-2026.8.2-windows-x86_64.exe",
        ),
        "utf8",
      ),
    ).toBe("finalized-windows-updater-bytes");
    expect(
      Buffer.from(
        readFileSync(
          path.join(
            desktopSigningRoot,
            "dist/desktop-test/macos/signatures/OpenClaw-2026.8.2-darwin-aarch64.app.tar.gz.sig",
          ),
          "utf8",
        ),
        "base64",
      ).toString(),
    ).toContain("OpenClaw-2026.8.2-darwin-aarch64.app.tar.gz");
    expect(
      Buffer.from(
        readFileSync(
          path.join(
            desktopSigningRoot,
            "dist/desktop-test/windows/signatures/OpenClaw-2026.8.2-windows-x86_64.exe.sig",
          ),
          "utf8",
        ),
        "base64",
      ).toString(),
    ).toContain("OpenClaw-2026.8.2-windows-x86_64.exe");
    expect(readFileSync(desktopSigningTools.tauriLog, "utf8")).toBe(
      "signer sign dist/signing-input/macos/OpenClaw-2026.8.2-darwin-aarch64.app.tar.gz\n" +
        "signer sign dist/signing-input/windows/OpenClaw-2026.8.2-windows-x86_64.exe\n",
    );
    expect(readFileSync(desktopSigningTools.minisignLog, "utf8")).toBe(
      "OpenClaw-2026.8.2-darwin-aarch64.app.tar.gz\nOpenClaw-2026.8.2-windows-x86_64.exe\n",
    );
    expect(existsSync(path.join(desktopSigningRoot, ".release-tooling"))).toBe(false);
    expect(existsSync(path.join(desktopSigningRoot, "apps"))).toBe(false);
  }
  const linuxBuildBodies = linuxBuildSteps.map(({ run }) => run ?? "").join("\n");
  for (const helper of [
    "apps/linux/scripts/stage-appimage-gstreamer.sh",
    "apps/linux/scripts/finalize-appimage.sh",
    "apps/linux/tests/packaged_runtime_smoke.py",
  ]) {
    expect(linuxBuildBodies).toContain(`.release-tooling/${helper}`);
    expect(linuxBuildBodies).not.toMatch(new RegExp(`(^|\\s)${helper.replaceAll(".", "\\.")}`));
  }
  const linuxBody = expectDefined(
    (linux.jobs.validate_release.steps as WorkflowStep[]).find(
      ({ name }) => name === workflows[0].validation,
    )?.run,
    "Linux release admission body",
  );
  expect(linuxBody).toContain('exec python3 -I -S "$CI_GIT_OWNER" --policy -');
  expect(linuxBody.match(/timeout=120/gu)).toHaveLength(2);
  expect(linuxBody).toContain('"+refs/heads/main:refs/remotes/origin/main"');
  expect(linuxBody).toContain('run_git(workspace, "merge-base", "--is-ancestor", sha, ref)');

  const macos = parse(readFileSync(workflows[1].file, "utf8"));
  const macosBody = expectDefined(
    (macos.jobs.validate_macos_release_request.steps as WorkflowStep[]).find(
      ({ name }) => name === workflows[1].validation,
    )?.run,
    "macOS release admission body",
  );
  expect(macosBody.match(/--git 0/gu)).toHaveLength(1);
  expect(macosBody.match(/--checkout-git 120/gu)).toHaveLength(1);
  expect(macosBody).toContain(
    '"+refs/heads/${PUBLIC_RELEASE_BRANCH}:refs/remotes/origin/${PUBLIC_RELEASE_BRANCH}"',
  );
  expect(macosBody.indexOf("--checkout-git 120")).toBeLessThan(
    macosBody.indexOf("pnpm release:openclaw:npm:check"),
  );

  const placeholder = parse(readFileSync(workflows[2].file, "utf8"));
  const placeholderBody = expectDefined(
    (placeholder.jobs.plan.steps as WorkflowStep[]).find(
      ({ name }) => name === workflows[2].validation,
    )?.run,
    "placeholder admission body",
  );
  expect(placeholderBody).toContain('exec python3 -I -S "$CI_GIT_OWNER" --policy -');
  expect(placeholderBody.match(/timeout=120/gu)).toHaveLength(1);
  expect(placeholderBody.match(/run_git\(workspace, "merge-base"/gu)).toHaveLength(2);
  expect(placeholderBody).toContain('output.write(f"sha={source_ref}\\n")');
});

it("pins every Performance Git owner before checkout and preserves Git deadlines", () => {
  const source = readFileSync(".github/workflows/openclaw-performance.yml", "utf8");
  const workflow = parse(source);
  const targets = [
    ["resolve_target", "Checkout target metadata", undefined, 10],
    ["kova", "Checkout OpenClaw", "Decide lane", 240],
    ["source_performance", "Checkout OpenClaw source target", undefined, 120],
    ["publish", "Checkout performance publisher helper", "Decide report publication lane", 30],
  ] as const;
  for (const [jobId, checkout, decision, timeout] of targets) {
    const job = workflow.jobs[jobId];
    const steps = job.steps as WorkflowStep[];
    const index = steps.findIndex(({ name }) => name === "Prepare Git owner");
    expect(index).toBe(decision ? 1 : 0);
    expect(steps[index + 1]?.name).toBe(checkout);
    if (decision) {
      expect(steps[index - 1]?.name).toBe(decision);
    }
    expect(steps[index]).toEqual({
      name: "Prepare Git owner",
      uses: "openclaw/openclaw/.github/actions/git-owner@a379bbd73e30b84a89aca4d54744ab9ca19082e7",
      ...(decision ? { if: "steps.lane.outputs.run == 'true'" } : {}),
    });
    expect(job["timeout-minutes"]).toBe(timeout);
    const bodies = steps.map(({ run }) => run ?? "").join("\n");
    expect(bodies).not.toMatch(/(?:^|[\s(])git\s/mu);
    expect(bodies).not.toMatch(/(?:^|[\s(])timeout\s+[^\n]*\bgit\b/u);
    const ownerDeadlines = [...bodies.matchAll(/--(?:checkout-)?git (\d+)/gu)].map((match) =>
      Number(match[1]),
    );
    expect(ownerDeadlines.every((deadline) => deadline === 0)).toBe(true);
    if (jobId !== "publish") {
      expect(bodies).not.toMatch(/timeout=\d+/u);
    } else {
      expect(bodies.match(/timeout=120/g)).toHaveLength(2);
      expect(bodies).not.toMatch(/timeout=(?!120)\d+/u);
      expect(bodies.match(/for attempt in range\(1, 6\)/gu)).toHaveLength(1);
      expect(bodies.match(/backoff\(attempt \* 2\)/gu)).toHaveLength(1);
      expect(bodies).toContain('"push", "origin", "HEAD:main", timeout=120, reclaim_locks=True');
      expect(
        bodies.match(/"fetch", "--depth=1", "origin", "main", timeout=120, reclaim_locks=True/gu),
      ).toHaveLength(1);
      expect(bodies).toContain('fetch(sys.argv[3], "main", max_attempts=3, retry_failures=True)');
      expect(bodies).toContain("if error.code != 1:");
      expect(bodies).toContain(
        '"ls-tree", "--name-only", "FETCH_HEAD", "--", f"{dest}/report.json"',
      );
    }
  }
  expect(workflow.on.schedule).toEqual([{ cron: "11 5 * * *" }]);
  expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual([
    "mode",
    "target_ref",
    "baseline_ref",
    "profile",
    "repeat",
    "deep_profile",
    "live_openai_candidate",
    "fail_on_regression",
    "publish_reports",
    "kova_ref",
    "kova_config_contract",
    "dispatch_id",
  ]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.jobs.publish.permissions).toEqual({ actions: "read", contents: "read" });
  expect(workflow.concurrency).toEqual({
    group:
      "${{ github.event_name == 'workflow_dispatch' && format('{0}-{1}', github.workflow, github.run_id) || format('{0}-{1}', github.workflow, github.ref) }}",
    "cancel-in-progress": false,
  });
});

describe("frozen CI compatibility contracts", () => {
  it("skips current-only launcher and QA contracts for frozen targets", () => {
    const source = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(source).toContain(
      `if: \${{ needs.preflight.outputs.frozen_target != 'true' }}\n        run: |\n          bun openclaw.mjs --help`,
    );
    expect(source).toContain(
      "[skip] ${partId} is not declared by this checkout's legacy smoke plan",
    );
    expect(source).not.toContain('"control-ui-chat-flow-playwright",');
    expect(source).toContain("if (!source.includes(marker)) process.exit(0);");
  });
});
