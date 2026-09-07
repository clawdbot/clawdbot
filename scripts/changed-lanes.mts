import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { stableStringify } from "../packages/normalization-core/src/stable-stringify.ts";
import { booleanFlag, parseFlagArgs, stringFlag } from "./lib/arg-utils.mts";
import { getChangedPathFacts, normalizeChangedPath } from "./lib/changed-path-facts.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { resolveMergeHeadDiffBase } from "./lib/merge-head-diff-base.mjs";
import { isRecord } from "./lib/record-shared.mjs";

const GIT_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;
const IMPLAUSIBLE_NO_MERGE_BASE_DIFF_PATHS = 200;
const RAW_SYNC_CHANGED_LANES_ENV = "OPENCLAW_CHANGED_LANES_RAW_SYNC";

// Source files knip's production scan reads. Any edit to one of these can orphan
// an export -- including an import-only edit that drops a barrel re-export's last
// consumer -- so the scan is selected by path, not by inspecting changed lines.
const DEADCODE_SOURCE_PATH_RE = /^(?:src|extensions|ui|packages)\/.+\.[cm]?[jt]sx?$/u;

/** Returns whether any changed path is production source knip scans. */
export function hasDeadcodeScannedSource(changedPaths: string[]): boolean {
  return changedPaths.some((path) => DEADCODE_SOURCE_PATH_RE.test(path));
}

const PROTOCOL_EVENT_COVERAGE_INPUT_RE =
  /^(?:src\/gateway\/(?:server-methods-list|events)\.ts|scripts\/(?:(?:check-protocol-event-coverage|changed-lanes|check-changed)\.m[jt]s|tsx\.mjs|lib\/(?:(?:tsx-cli-shim|record-shared)\.mjs|local-check-runtime\.mts)|protocol-event-coverage\.allowlist\.json)|apps\/(?:ios\/Sources|shared\/OpenClawKit\/Sources)\/.+\.swift|apps\/android\/app\/src\/main\/java\/ai\/openclaw\/app\/.+\.kt)$/u;

export function hasProtocolEventCoverageInput(changedPaths: string[]): boolean {
  // Match the guard's scan roots and excluded directories, including deleted inputs.
  return changedPaths.some(
    (path) =>
      PROTOCOL_EVENT_COVERAGE_INPUT_RE.test(path) && !/\/(?:Tests|\.build|build)\//u.test(path),
  );
}

const SCRIPTS_TYPECHECK_PATH_RE =
  /^(?:scripts\/.*\.(?:[cm]?ts|[cm]?tsx)|tsconfig\.scripts\.json)$/u;
/** @internal Shared repository-script contract. */
export const LIVE_DOCKER_AUTH_SHELL_TARGETS = [
  "scripts/lib/live-docker-auth.sh",
  "scripts/test-live-acp-bind-docker.sh",
  "scripts/test-live-cli-backend-docker.sh",
  "scripts/test-live-codex-harness-docker.sh",
  "scripts/test-live-gateway-models-docker.sh",
  "scripts/test-live-models-docker.sh",
  "scripts/test-live-subagent-announce-docker.sh",
];
const LIVE_DOCKER_TOOLING_PATHS = new Set([
  ...LIVE_DOCKER_AUTH_SHELL_TARGETS,
  "scripts/test-docker-all.mjs",
  "scripts/test-docker-all.mts",
  "src/gateway/gateway-acp-bind.live.test.ts",
  "src/gateway/live-agent-probes.test.ts",
]);
const LIVE_DOCKER_PACKAGE_SCRIPT_RE = /^test:docker:live-[\w:-]+$/u;
const PUBLIC_EXTENSION_CONTRACT_RE =
  /^(?:src\/plugin-sdk\/|src\/plugins\/contracts\/|src\/channels\/plugins\/|scripts\/lib\/plugin-sdk-entrypoints\.json$|scripts\/(?:sync-plugin-sdk-exports|plugin-sdk-api-diff)\.mts$)/u;
const BUNDLED_CHANNEL_CONFIG_METADATA_PATH_RE =
  /^(?:src\/config\/(?:bundled-channel-config-metadata\.generated|zod-schema\.[^/]+)\.ts|src\/channels\/plugins\/config-schema\.ts|src\/plugin-sdk\/(?:bundled-channel-config-schema|channel-config-schema)\.ts|src\/plugins\/(?:bundled-dir|public-surface-loader|public-surface-runtime|sdk-alias)\.ts|scripts\/(?:generate-bundled-channel-config-metadata\.ts|load-channel-config-surface\.ts|lib\/(?:bundled-plugin-source-utils|format-generated-module|generated-output-utils)\.mts)|extensions\/[^/]+\/(?:openclaw\.plugin\.json|package\.json|(?:config|security-contract)-api\.[cm]?[jt]sx?|src\/config-(?:schema(?:-[^/]+)?|surface|ui-hints)\.[cm]?[jt]sx?))$/u;
const CONFIG_DOC_INPUT_PATH_RE =
  /^(?:src\/config\/[^/]+\.ts|src\/channels\/ids\.ts|src\/plugin-sdk\/(?:channel-core|secret-input)\.ts|src\/plugins\/(?:manifest(?:-registry|-setup-normalizers)?|package-manifest|discovery|bundled-channel-config-metadata)\.ts|scripts\/(?:generate-config-doc-baseline\.ts|(?:check-changed|changed-lanes)\.m[jt]s|lib\/changed-path-facts\.mjs))$/u;
const CONFIG_DOC_BASELINE_PATHS = new Set([
  "docs/.generated/config-baseline.counts.json",
  "docs/.generated/config-baseline.sha256",
]);

// Bridge shared schema/hint owners consumed through SDK/workspace aliases.
// Facades in CONFIG_DOC_INPUT_PATH_RE are direct inputs, not runtime traversal roots.
const CONFIG_DOC_SCHEMA_SOURCE_PATHS = new Set([
  "src/config/schema.ts",
  "src/plugin-sdk/channel-config-ui-hints.ts",
  "src/plugin-sdk/secret-input-schema.ts",
  "packages/net-policy/src/redact-sensitive-url.ts",
]);

/** Source entries and shared owners consumed by core schema and bundled metadata collectors. */
export function isConfigDocSchemaSourcePath(file: string): boolean {
  return (
    CONFIG_DOC_SCHEMA_SOURCE_PATHS.has(file) ||
    /^extensions\/[^/]+\/(?:src\/config-(?:schema|surface)|channel-config-api)\.[cm]?[jt]sx?$/u.test(
      file,
    )
  );
}

/** Config docs consume core schema/help plus the bundled plugin metadata pipeline. */
export function hasConfigDocInput(changedPaths: string[]): boolean {
  return changedPaths.some(
    (changedPath) =>
      !getChangedPathFacts(changedPath).isChangedLaneTest &&
      (CONFIG_DOC_BASELINE_PATHS.has(changedPath) ||
        isConfigDocSchemaSourcePath(changedPath) ||
        CONFIG_DOC_INPUT_PATH_RE.test(changedPath) ||
        BUNDLED_CHANNEL_CONFIG_METADATA_PATH_RE.test(changedPath)),
  );
}

/**
 * Files whose changes are treated as release metadata only.
 * @internal Shared repository-script contract.
 */
export const RELEASE_METADATA_PATHS = new Set([
  "CHANGELOG.md",
  "apps/android/CHANGELOG.md",
  "apps/android/Config/Version.properties",
  "apps/android/fastlane/metadata/android/en-US/release_notes.txt",
  "apps/android/version.json",
  "apps/ios/CHANGELOG.md",
  "apps/macos/Sources/OpenClaw/Resources/Info.plist",
  "apps/mobile/version.json",
  ...CONFIG_DOC_BASELINE_PATHS,
  "docs/install/updating.md",
  "package.json",
]);

type ChangedLanes = ReturnType<typeof createEmptyChangedLanes>;

export type ChangedLaneResult = {
  paths: string[];
  lanes: ChangedLanes;
  extensionImpactFromCore: boolean;
  docsOnly: boolean;
  reasons: string[];
};

/** Eligible leaf inputs; compiler inventories still decide all consuming graphs. */
export function getChangedCoreTestPaths(result: ChangedLaneResult): string[] | undefined {
  const { lanes } = result;
  if (lanes.all || lanes.core || lanes.ui || lanes.tooling || lanes.liveDockerTooling) {
    return undefined;
  }
  const paths = result.paths.filter((file) => getChangedPathFacts(file).surface !== "docs");
  return paths.length > 0 &&
    paths.every((file) => /^(?:src|ui|packages)\/.+\.test\.tsx?$/u.test(file))
    ? paths
    : undefined;
}

type DetectChangedLanesOptions = {
  packageJsonChangeKind?: "liveDockerTooling" | "tooling" | null;
};

type PackageJsonGitParams = {
  base: string;
  head?: string;
  staged?: boolean;
  includeWorktree?: boolean;
};

/**
 * Creates the default changed-lanes result object.
 * @internal Directly tested script implementation detail.
 */
export function createEmptyChangedLanes() {
  return {
    core: false,
    coreTests: false,
    ui: false,
    extensions: false,
    extensionTests: false,
    scripts: false,
    testRoot: false,
    apps: false,
    docs: false,
    tooling: false,
    liveDockerTooling: false,
    bundledChannelConfigMetadata: false,
    releaseMetadata: false,
    all: false,
  };
}

export function isChangedLaneTestPath(changedPath: string) {
  return getChangedPathFacts(changedPath).isChangedLaneTest;
}

/**
 * Classifies a list of changed paths into docs, app, extension, core, and tooling lanes.
 * @internal Shared repository-script contract.
 */
export function detectChangedLanes(
  changedPaths: string[],
  options: DetectChangedLanesOptions = {},
): ChangedLaneResult {
  const paths = [...new Set(changedPaths.filter(Boolean))].toSorted((left, right) =>
    left.localeCompare(right),
  );
  const lanes = createEmptyChangedLanes();
  const reasons = [];
  let extensionImpactFromCore = false;
  let hasNonDocs = false;
  const packageJsonIsLiveDockerTooling =
    paths.includes("package.json") && options.packageJsonChangeKind === "liveDockerTooling";
  const packageJsonIsTooling =
    paths.includes("package.json") && options.packageJsonChangeKind === "tooling";

  if (paths.length === 0) {
    reasons.push("no changed paths");
    return { paths, lanes, extensionImpactFromCore: false, docsOnly: false, reasons };
  }

  if (
    !packageJsonIsLiveDockerTooling &&
    !packageJsonIsTooling &&
    paths.some((changedPath) => RELEASE_METADATA_PATHS.has(changedPath)) &&
    paths.every((changedPath) => RELEASE_METADATA_PATHS.has(changedPath))
  ) {
    lanes.releaseMetadata = true;
    lanes.docs = paths.some((changedPath) => getChangedPathFacts(changedPath).surface === "docs");
    for (const changedPath of paths) {
      reasons.push(`${changedPath}: release metadata`);
    }
    return { paths, lanes, extensionImpactFromCore: false, docsOnly: false, reasons };
  }

  for (const changedPath of paths) {
    const facts = getChangedPathFacts(changedPath);
    if (BUNDLED_CHANNEL_CONFIG_METADATA_PATH_RE.test(changedPath)) {
      lanes.bundledChannelConfigMetadata = true;
      reasons.push(`${changedPath}: bundled channel config metadata input`);
    }
    if (SCRIPTS_TYPECHECK_PATH_RE.test(changedPath)) {
      lanes.scripts = true;
    }
    if (
      facts.isRootTestSource ||
      changedPath === "test/tsconfig.json" ||
      changedPath === "test/tsconfig/tsconfig.test.root.json"
    ) {
      lanes.testRoot = true;
    }

    if (facts.surface === "docs") {
      lanes.docs = true;
      continue;
    }

    hasNonDocs = true;

    if (changedPath === "package.json" && packageJsonIsLiveDockerTooling) {
      lanes.liveDockerTooling = true;
      reasons.push(`${changedPath}: live Docker package scripts`);
      continue;
    }

    if (changedPath === "package.json" && packageJsonIsTooling) {
      lanes.tooling = true;
      reasons.push(`${changedPath}: package scripts`);
      continue;
    }

    if (LIVE_DOCKER_TOOLING_PATHS.has(changedPath)) {
      lanes.liveDockerTooling = true;
      reasons.push(`${changedPath}: live Docker tooling surface`);
      continue;
    }

    if (facts.surface === "rootGlobal") {
      lanes.all = true;
      extensionImpactFromCore = true;
      reasons.push(`${changedPath}: root config/package surface`);
      continue;
    }

    // Test leaves exercise contracts; shared helpers and suites can affect their consumers.
    if (
      PUBLIC_EXTENSION_CONTRACT_RE.test(changedPath) &&
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(changedPath)
    ) {
      lanes.core = true;
      lanes.coreTests = true;
      lanes.extensions = true;
      lanes.extensionTests = true;
      extensionImpactFromCore = true;
      reasons.push(`${changedPath}: public core/plugin contract affects extensions`);
      continue;
    }

    if (facts.surface === "extension") {
      if (facts.isChangedLaneTest) {
        lanes.extensionTests = true;
        reasons.push(`${changedPath}: extension test`);
      } else {
        lanes.extensions = true;
        lanes.extensionTests = true;
        reasons.push(`${changedPath}: extension production`);
      }
      continue;
    }

    // Shared inputs retain their Node/tooling owner as well as browser checks.
    if (
      changedPath === "tsconfig.json" ||
      /^packages\/normalization-core\/(?:package\.json|src\/record-coerce\.ts)$/u.test(changedPath)
    ) {
      lanes.ui = true;
      reasons.push(`${changedPath}: shared browser renderer input`);
    }

    // Native hosts bundle this DOM runtime; the Node-only core graph cannot own it.
    if (changedPath.startsWith("packages/mermaid-renderer/")) {
      lanes.ui = true;
      lanes.coreTests = true;
      reasons.push(`${changedPath}: shared browser renderer`);
      continue;
    }

    if (facts.surface === "source" || facts.surface === "package") {
      if (facts.isChangedLaneTest) {
        lanes.coreTests = true;
        reasons.push(`${changedPath}: core test`);
      } else {
        lanes.core = true;
        lanes.coreTests = true;
        reasons.push(`${changedPath}: core production`);
      }
      continue;
    }

    if (facts.surface === "ui") {
      if (facts.isChangedLaneTest) {
        lanes.coreTests = true;
        reasons.push(`${changedPath}: UI test`);
      } else {
        lanes.ui = true;
        lanes.coreTests = true;
        reasons.push(`${changedPath}: UI production`);
      }
      continue;
    }

    if (facts.surface === "app") {
      lanes.apps = true;
      reasons.push(`${changedPath}: app surface`);
      continue;
    }

    if (facts.surface === "rootTest" || facts.surface === "testFixture") {
      lanes.tooling = true;
      reasons.push(`${changedPath}: root test/support surface`);
      continue;
    }

    if (facts.surface === "rootTooling") {
      lanes.tooling = true;
      reasons.push(`${changedPath}: tooling surface`);
      continue;
    }

    if (facts.surface === "legacyRootAsset") {
      lanes.tooling = true;
      reasons.push(`${changedPath}: legacy root asset cleanup`);
      continue;
    }

    lanes.all = true;
    extensionImpactFromCore = true;
    reasons.push(`${changedPath}: unknown surface; fail-safe all lanes`);
  }

  return {
    paths,
    lanes,
    extensionImpactFromCore,
    docsOnly: lanes.docs && !hasNonDocs,
    reasons,
  };
}

/**
 * Classifies changed paths with optional package.json before/after contents.
 * @internal Shared repository-script contract.
 */
export function detectChangedLanesForPaths(params: {
  paths: string[];
  base: string;
  head?: string;
  staged?: boolean;
  mergeHeadFirstParent?: boolean;
}): ChangedLaneResult {
  const resolvedBase = params.staged
    ? params.base
    : resolveMergeHeadDiffBase({
        base: params.base,
        head: params.head ?? "HEAD",
        maxBuffer: GIT_OUTPUT_MAX_BUFFER,
        preferFirstParent: params.mergeHeadFirstParent === true,
      });
  const base = typeof resolvedBase === "string" ? resolvedBase : "";
  const packageJsonChangeKind = params.paths.includes("package.json")
    ? classifyPackageJsonChangeFromGit({
        base,
        head: params.head,
        staged: params.staged,
      })
    : null;
  return detectChangedLanes(params.paths, { packageJsonChangeKind });
}

/**
 * Lists changed paths from git for a base/head comparison.
 */
export function listChangedPathsFromGit(params: {
  base: string;
  head?: string;
  includeWorktree?: boolean;
  cwd?: string;
  mergeHeadFirstParent?: boolean;
}): string[] {
  const head = params.head ?? "HEAD";
  const cwd = params.cwd ?? process.cwd();
  const resolvedBase = resolveMergeHeadDiffBase({
    base: params.base,
    head,
    cwd,
    maxBuffer: GIT_OUTPUT_MAX_BUFFER,
    preferFirstParent: params.mergeHeadFirstParent === true,
  });
  const base = typeof resolvedBase === "string" ? resolvedBase : "";
  if (!base) {
    return [];
  }
  let rangePaths: string[];
  let noMergeBase = false;
  try {
    rangePaths = runGitNameOnlyDiff([`${base}...${head}`], cwd);
  } catch (error) {
    if (!isGitNoMergeBaseError(error)) {
      throw error;
    }
    noMergeBase = true;
    rangePaths = runGitNameOnlyDiff([`${base}..${head}`], cwd);
  }
  if (params.includeWorktree === false) {
    return rangePaths;
  }
  const worktreePaths = [
    ...runGitNameOnlyDiff(["--cached", "--diff-filter=ACMRD"], cwd),
    ...runGitNameOnlyDiff(["--diff-filter=ACMRD"], cwd),
    ...runGitLsFiles(["--others", "--exclude-standard"], cwd),
  ];
  // Raw Crabbox syncs can have unrelated synthetic refs; prefer the synced
  // worktree delta instead of turning that into an accidental whole-repo gate.
  if (
    noMergeBase &&
    process.env[RAW_SYNC_CHANGED_LANES_ENV] === "1" &&
    worktreePaths.length > 0 &&
    rangePaths.length > IMPLAUSIBLE_NO_MERGE_BASE_DIFF_PATHS
  ) {
    rangePaths = [];
  }
  return [...new Set([...rangePaths, ...worktreePaths])].toSorted((left, right) =>
    left.localeCompare(right),
  );
}

function runGitNameOnlyDiff(extraArgs: string[], cwd = process.cwd()): string[] {
  const output = execFileSync("git", ["diff", "--name-only", "-z", ...extraArgs], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_MAX_BUFFER,
  });
  return output.split("\0").filter(Boolean);
}

function gitOutputText(value: unknown) {
  return typeof value === "string" || Buffer.isBuffer(value) ? value.toString() : "";
}

function isGitNoMergeBaseError(error: unknown) {
  const errorRecord = isRecord(error) ? error : null;
  const output = Array.isArray(errorRecord?.output)
    ? errorRecord.output.map(gitOutputText).join("\n")
    : "";
  const text = [
    error instanceof Error ? error.message : "",
    gitOutputText(errorRecord?.stderr),
    output,
  ].join("\n");
  return text.includes("no merge base");
}

function runGitLsFiles(extraArgs: string[], cwd = process.cwd()): string[] {
  const output = execFileSync("git", ["ls-files", "-z", ...extraArgs], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_MAX_BUFFER,
  });
  return output.split("\0").filter(Boolean);
}

/**
 * Lists staged changed paths for pre-commit checks.
 */
export function listStagedChangedPaths(cwd = process.cwd()) {
  return runGitNameOnlyDiff(["--cached", "--diff-filter=ACMRD"], cwd);
}

/**
 * Classifies package.json script-only changes from git content.
 */
function classifyPackageJsonChangeFromGit(params: PackageJsonGitParams) {
  try {
    const { before, after } = readPackageJsonBeforeAfter(params);
    return classifyPackageJsonScriptChange(before, after);
  } catch {
    return null;
  }
}

function classifyPackageJsonScriptChange(
  before: string,
  after: string,
): "liveDockerTooling" | "tooling" | null {
  const beforePackage = parsePackageJson(before);
  const afterPackage = parsePackageJson(after);
  if (!beforePackage || !afterPackage) {
    return null;
  }
  const { scripts: beforeScripts, ...beforeMetadata } = beforePackage;
  const { scripts: afterScripts, ...afterMetadata } = afterPackage;
  if (
    stableStringify(beforeMetadata) !== stableStringify(afterMetadata) ||
    stableStringify(isRecord(beforeScripts) ? beforeScripts : {}) ===
      stableStringify(isRecord(afterScripts) ? afterScripts : {})
  ) {
    return null;
  }
  // Coercing missing/non-record scripts to {} must not grant the narrower live-Docker lane.
  return isRecord(beforeScripts) &&
    isRecord(afterScripts) &&
    stableStringify(withoutLiveDockerScripts(beforeScripts)) ===
      stableStringify(withoutLiveDockerScripts(afterScripts))
    ? "liveDockerTooling"
    : "tooling";
}

function parsePackageJson(value: string) {
  const parsed: unknown = JSON.parse(value);
  return isRecord(parsed) ? parsed : null;
}

function readPackageJsonBeforeAfter(params: PackageJsonGitParams) {
  const before = readGitText(params.staged ? "HEAD" : params.base, "package.json");
  if (params.staged) {
    return { before, after: readGitText("INDEX", "package.json") };
  }

  let after = readGitText(params.head ?? "HEAD", "package.json");
  if (params.includeWorktree !== false && existsSync("package.json")) {
    const worktree = readGitText("WORKTREE", "package.json");
    if (worktree !== after) {
      after = worktree;
    }
  }
  return { before, after };
}

function readGitText(ref: string, filePath: string) {
  if (ref === "WORKTREE") {
    return readFileSync(filePath, "utf8");
  }
  const spec = ref === "INDEX" ? `:${filePath}` : `${ref}:${filePath}`;
  return execFileSync("git", ["show", spec], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function withoutLiveDockerScripts(scripts: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(scripts).filter(([name]) => !LIVE_DOCKER_PACKAGE_SCRIPT_RE.test(name)),
  );
}

/**
 * Writes changed-lane booleans to the GitHub Actions output file.
 */
function writeChangedLaneGitHubOutput(
  result: ChangedLaneResult,
  outputPath = process.env.GITHUB_OUTPUT,
) {
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required");
  }
  for (const [lane, enabled] of Object.entries(result.lanes)) {
    appendFileSync(outputPath, `run_${toSnakeCase(lane)}=${String(enabled)}\n`, "utf8");
  }
  appendFileSync(outputPath, `docs_only=${result.docsOnly}\n`, "utf8");
  appendFileSync(
    outputPath,
    `extension_impact_from_core=${result.extensionImpactFromCore}\n`,
    "utf8",
  );
}

function toSnakeCase(value: string) {
  return value.replace(/[A-Z]/gu, (match) => `_${match.toLowerCase()}`);
}

function parseArgs(argv: string[]) {
  const separatorIndex = argv.indexOf("--");
  const flagArgv = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
  const explicitPaths = separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1);
  const args = {
    base: "origin/main",
    head: "HEAD",
    staged: false,
    mergeHeadFirstParent: false,
    json: false,
    githubOutput: false,
    help: false,
    paths: new Array<string>(),
  };
  const parsed = parseFlagArgs(
    flagArgv,
    args,
    [
      stringFlag("--base", "base"),
      stringFlag("--head", "head"),
      booleanFlag("--staged", "staged"),
      booleanFlag("--merge-head-first-parent", "mergeHeadFirstParent"),
      booleanFlag("--json", "json"),
      booleanFlag("--github-output", "githubOutput"),
      booleanFlag("--help", "help"),
      booleanFlag("-h", "help"),
    ],
    {
      onUnhandledArg(arg, target) {
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        target.paths.push(arg);
        return "handled";
      },
    },
  );
  parsed.paths.push(...explicitPaths);
  parsed.paths = parsed.paths.map((changedPath) => normalizeChangedPath(changedPath));
  return parsed;
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/changed-lanes.mjs [options] [-- <paths...>]",
      "",
      "Options:",
      "  --base <ref>          Base ref for changed paths (default: origin/main)",
      "  --head <ref>          Head ref for changed paths (default: HEAD)",
      "  --staged              Inspect staged changes",
      "  --json                Print JSON result",
      "  --github-output       Append GitHub output variables",
      "  -h, --help            Show this help",
    ].join("\n"),
  );
}

function isDirectRun() {
  return isDirectRunUrl(process.argv[1], import.meta.url);
}

function printHuman(result: ChangedLaneResult) {
  const enabled = Object.entries(result.lanes)
    .filter(([, value]) => value)
    .map(([lane]) => lane);
  console.log(`lanes: ${enabled.length > 0 ? enabled.join(", ") : "none"}`);
  if (result.docsOnly) {
    console.log("docs-only: true");
  }
  if (result.extensionImpactFromCore) {
    console.log("extension-impact-from-core: true");
  }
  if (result.paths.length > 0) {
    console.log("paths:");
    for (const changedPath of result.paths) {
      console.log(`- ${changedPath}`);
    }
  }
  if (result.reasons.length > 0) {
    console.log("reasons:");
    for (const reason of result.reasons) {
      console.log(`- ${reason}`);
    }
  }
}

if (isDirectRun()) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  const paths =
    args.paths.length > 0
      ? args.paths
      : args.staged
        ? listStagedChangedPaths()
        : listChangedPathsFromGit({
            base: args.base,
            head: args.head,
            mergeHeadFirstParent: args.mergeHeadFirstParent,
          });
  const result = detectChangedLanesForPaths({
    paths,
    base: args.base,
    head: args.head,
    staged: args.staged,
    mergeHeadFirstParent: args.mergeHeadFirstParent,
  });
  if (args.githubOutput) {
    writeChangedLaneGitHubOutput(result);
  }
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!args.githubOutput) {
    printHuman(result);
  }
}
