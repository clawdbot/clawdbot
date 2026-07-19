// Classifies changed files into CI lanes and release metadata scopes.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { booleanFlag, parseFlagArgs, stringFlag } from "./lib/arg-utils.mjs";
import { getChangedPathFacts, normalizeChangedPath } from "./lib/changed-path-facts.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { resolveMergeHeadDiffBase } from "./lib/merge-head-diff-base.mjs";

const GIT_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;
const IMPLAUSIBLE_NO_MERGE_BASE_DIFF_PATHS = 200;
const RAW_SYNC_CHANGED_LANES_ENV = "OPENCLAW_CHANGED_LANES_RAW_SYNC";

const SCRIPTS_TYPECHECK_PATH_RE =
  /^(?:scripts\/.*\.(?:[cm]?ts|[cm]?tsx)|tsconfig\.scripts\.json)$/u;
const TEST_ROOT_TYPECHECK_PATH_RE =
  /^(?:test\/(?!fixtures\/).*\.(?:[cm]?ts|[cm]?tsx)|test\/tsconfig\/tsconfig\.test\.root\.json)$/u;
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
  "src/gateway/gateway-acp-bind.live.test.ts",
  "src/gateway/live-agent-probes.test.ts",
]);
const LIVE_DOCKER_PACKAGE_SCRIPT_RE = /^test:docker:live-[\w:-]+$/u;
const PUBLIC_EXTENSION_CONTRACT_RE =
  /^(?:src\/plugin-sdk\/|src\/plugins\/contracts\/|src\/channels\/plugins\/|scripts\/lib\/plugin-sdk-entrypoints\.json$|scripts\/sync-plugin-sdk-exports\.mjs$|scripts\/generate-plugin-sdk-api-baseline\.ts$)/u;
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
  "docs/.generated/config-baseline.counts.json",
  "docs/.generated/config-baseline.sha256",
  "docs/install/updating.md",
  "package.json",
]);

/** @typedef {"core" | "coreTests" | "ui" | "extensions" | "extensionTests" | "scripts" | "testRoot" | "apps" | "docs" | "tooling" | "liveDockerTooling" | "releaseMetadata" | "all"} ChangedLane */

/**
 * @typedef {{
 *   paths: string[];
 *   lanes: Record<ChangedLane, boolean>;
 *   extensionImpactFromCore: boolean;
 *   docsOnly: boolean;
 *   reasons: string[];
 * }} ChangedLaneResult
 */

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
    releaseMetadata: false,
    all: false,
  };
}

/** @internal Shared repository-script contract. */
export function isChangedLaneTestPath(changedPath) {
  return getChangedPathFacts(normalizeChangedPath(changedPath)).isChangedLaneTest;
}

/**
 * @param {string[]} changedPaths
 * @param {{ packageJsonChangeKind?: "liveDockerTooling" | "tooling" | null }} [options]
 * @returns {ChangedLaneResult}
 */
/**
 * Classifies a list of changed paths into docs, app, extension, core, and tooling lanes.
 * @internal Shared repository-script contract.
 */
export function detectChangedLanes(changedPaths, options = {}) {
  const paths = [...new Set(changedPaths.map(normalizeChangedPath).filter(Boolean))]
    .toSorted((left, right) => left.localeCompare(right))
    .filter((changedPath) => changedPath !== "--");
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
    if (SCRIPTS_TYPECHECK_PATH_RE.test(changedPath)) {
      lanes.scripts = true;
    }
    if (TEST_ROOT_TYPECHECK_PATH_RE.test(changedPath)) {
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

    if (PUBLIC_EXTENSION_CONTRACT_RE.test(changedPath)) {
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
 * @param {{ paths: string[]; base: string; head?: string; staged?: boolean; mergeHeadFirstParent?: boolean }} params
 * @returns {ChangedLaneResult}
 */
/**
 * Classifies changed paths with optional package.json before/after contents.
 * @internal Shared repository-script contract.
 */
export function detectChangedLanesForPaths(params) {
  const base = params.staged
    ? params.base
    : resolveMergeHeadDiffBase({
        base: params.base,
        head: params.head ?? "HEAD",
        maxBuffer: GIT_OUTPUT_MAX_BUFFER,
        preferFirstParent: params.mergeHeadFirstParent === true,
      });
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
 * @param {{ base: string; head?: string; includeWorktree?: boolean; cwd?: string; mergeHeadFirstParent?: boolean }} params
 * @returns {string[]}
 */
/**
 * Lists changed paths from git for a base/head comparison.
 */
export function listChangedPathsFromGit(params) {
  const head = params.head ?? "HEAD";
  const cwd = params.cwd ?? process.cwd();
  const base = resolveMergeHeadDiffBase({
    base: params.base,
    head,
    cwd,
    maxBuffer: GIT_OUTPUT_MAX_BUFFER,
    preferFirstParent: params.mergeHeadFirstParent === true,
  });
  if (!base) {
    return [];
  }
  let rangePaths;
  let noMergeBase = false;
  try {
    // oxlint-disable-next-line typescript/no-base-to-string, typescript/restrict-template-expressions -- resolveMergeHeadDiffBase returns a git ref string when present.
    rangePaths = runGitNameOnlyDiff([`${base}...${head}`], cwd);
  } catch (error) {
    if (!isGitNoMergeBaseError(error)) {
      throw error;
    }
    noMergeBase = true;
    // oxlint-disable-next-line typescript/no-base-to-string, typescript/restrict-template-expressions -- resolveMergeHeadDiffBase returns a git ref string when present.
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

function runGitNameOnlyDiff(extraArgs, cwd = process.cwd()) {
  const output = execFileSync("git", ["diff", "--name-only", ...extraArgs], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_MAX_BUFFER,
  });
  return output.split("\n").map(normalizeChangedPath).filter(Boolean);
}

function isGitNoMergeBaseError(error) {
  const text = [
    error?.message,
    error?.stderr?.toString?.("utf8"),
    Array.isArray(error?.output)
      ? error.output.map((value) => value?.toString?.("utf8")).join("\n")
      : "",
  ].join("\n");
  return text.includes("no merge base");
}

function runGitLsFiles(extraArgs, cwd = process.cwd()) {
  const output = execFileSync("git", ["ls-files", ...extraArgs], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_MAX_BUFFER,
  });
  return output.split("\n").map(normalizeChangedPath).filter(Boolean);
}

/**
 * Lists staged changed paths for pre-commit checks.
 */
export function listStagedChangedPaths(cwd = process.cwd()) {
  const output = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMRD"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_MAX_BUFFER,
  });
  return output.split("\n").map(normalizeChangedPath).filter(Boolean);
}

/**
 * Classifies package.json script-only changes from git content.
 */
function classifyPackageJsonChangeFromGit(params) {
  try {
    const { before, after } = readPackageJsonBeforeAfter(params);
    if (isLiveDockerPackageScriptOnlyChange(before, after)) {
      return "liveDockerTooling";
    }
    return isPackageScriptOnlyChange(before, after) ? "tooling" : null;
  } catch {
    return null;
  }
}

/**
 * Checks whether package scripts changed only live Docker script entries.
 * @internal Directly tested script implementation detail.
 */
export function isLiveDockerPackageScriptOnlyChange(before, after) {
  const beforePackage = JSON.parse(before);
  const afterPackage = JSON.parse(after);
  const beforeAllowed = extractLiveDockerPackageScripts(beforePackage);
  const afterAllowed = extractLiveDockerPackageScripts(afterPackage);
  const beforeStripped = stripLiveDockerPackageScripts(beforePackage);
  const afterStripped = stripLiveDockerPackageScripts(afterPackage);

  return (
    stableJson(beforeStripped) === stableJson(afterStripped) &&
    stableJson(beforeAllowed) !== stableJson(afterAllowed)
  );
}

/**
 * Checks whether package.json changes are limited to scripts.
 * @internal Directly tested script implementation detail.
 */
export function isPackageScriptOnlyChange(before, after) {
  const beforePackage = JSON.parse(before);
  const afterPackage = JSON.parse(after);
  const beforeScripts = extractPackageScripts(beforePackage);
  const afterScripts = extractPackageScripts(afterPackage);
  const beforeStripped = stripPackageScripts(beforePackage);
  const afterStripped = stripPackageScripts(afterPackage);

  return (
    stableJson(beforeStripped) === stableJson(afterStripped) &&
    stableJson(beforeScripts) !== stableJson(afterScripts)
  );
}

function readPackageJsonBeforeAfter(params) {
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

function readGitText(ref, filePath) {
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

function extractLiveDockerPackageScripts(packageJson) {
  const scripts = packageJson?.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(scripts).filter(([name]) => LIVE_DOCKER_PACKAGE_SCRIPT_RE.test(name)),
  );
}

function stripLiveDockerPackageScripts(packageJson) {
  const clone = structuredClone(packageJson);
  const scripts = clone.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    return clone;
  }
  for (const name of Object.keys(scripts)) {
    if (LIVE_DOCKER_PACKAGE_SCRIPT_RE.test(name)) {
      delete scripts[name];
    }
  }
  return clone;
}

function extractPackageScripts(packageJson) {
  const scripts = packageJson?.scripts;
  return scripts && typeof scripts === "object" && !Array.isArray(scripts) ? scripts : {};
}

function stripPackageScripts(packageJson) {
  const clone = structuredClone(packageJson);
  delete clone.scripts;
  return clone;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Writes changed-lane booleans to the GitHub Actions output file.
 */
function writeChangedLaneGitHubOutput(result, outputPath = process.env.GITHUB_OUTPUT) {
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

function toSnakeCase(value) {
  return value.replace(/[A-Z]/gu, (match) => `_${match.toLowerCase()}`);
}

function parseArgs(argv) {
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
    paths: [],
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

function printHuman(result) {
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
