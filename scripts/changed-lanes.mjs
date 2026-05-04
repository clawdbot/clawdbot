import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { booleanFlag, parseFlagArgs, stringFlag } from "./lib/arg-utils.mjs";

const GIT_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;

const DOCS_PATH_RE = /^(?:docs\/|README\.md$|AGENTS\.md$|.*\.mdx?$)/u;
const APP_PATH_RE = /^(?:apps\/|Swabble\/|appcast\.xml$)/u;
const EXTENSION_PATH_RE = /^extensions\/[^/]+(?:\/|$)/u;
const CORE_PATH_RE = /^(?:src\/|ui\/|packages\/)/u;
const TOOLING_PATH_RE =
  /^(?:scripts\/|test\/vitest\/|\.github\/|\.vscode\/|config\/|deploy\/|git-hooks\/|Dockerfile\.sandbox(?:-(?:browser|common))?$|Makefile$|docker-setup\.sh$|setup-podman\.sh$|openclaw\.podman\.env$|skills\/pyproject\.toml$|vitest(?:\..+)?\.config\.ts$|tsconfig.*\.json$|\.dockerignore$|\.gitignore$|\.jscpd\.json$|\.npmignore$|\.pre-commit-config\.yaml$|\.swiftformat$|\.swiftlint\.yml$|\.oxlint.*|\.oxfmt.*)/u;
const ROOT_GLOBAL_PATH_RE =
  /^(?:package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsdown\.config\.ts$|vitest\.config\.ts$)/u;
const LEGACY_ROOT_ASSET_PATH_RE = /^assets\//u;
const LIVE_DOCKER_TOOLING_PATH_RE =
  /^(?:scripts\/test-docker-all\.mjs|scripts\/test-docker-all\.sh|scripts\/lib\/live-docker-auth\.sh|scripts\/test-live-(?:acp-bind|cli-backend|codex-harness|gateway-models|models)-docker\.sh|src\/gateway\/gateway-acp-bind\.live\.test\.ts|src\/gateway\/live-agent-probes\.test\.ts)$/u;
const LIVE_DOCKER_PACKAGE_SCRIPT_RE = /^test:docker:live-[\w:-]+$/u;
const TEST_PATH_RE =
  /(?:^|\/)(?:test|__tests__)\/|(?:\.|\/)(?:test|spec|e2e|browser\.test)\.[cm]?[jt]sx?$/u;
const PUBLIC_EXTENSION_CONTRACT_RE =
  /^(?:src\/plugin-sdk\/|src\/plugins\/contracts\/|src\/channels\/plugins\/|scripts\/lib\/plugin-sdk-entrypoints\.json$|scripts\/sync-plugin-sdk-exports\.mjs$|scripts\/generate-plugin-sdk-api-baseline\.ts$)/u;
export const RELEASE_METADATA_PATHS = new Set([
  "CHANGELOG.md",
  "apps/android/app/build.gradle.kts",
  "apps/ios/CHANGELOG.md",
  "apps/ios/Config/Version.xcconfig",
  "apps/ios/fastlane/metadata/en-US/release_notes.txt",
  "apps/ios/version.json",
  "apps/macos/Sources/OpenClaw/Resources/Info.plist",
  "docs/.generated/config-baseline.sha256",
  "docs/install/updating.md",
  "package.json",
  "src/config/schema.base.generated.ts",
]);

/** @typedef {"core" | "coreTests" | "extensions" | "extensionTests" | "apps" | "docs" | "tooling" | "liveDockerTooling" | "releaseMetadata" | "all"} ChangedLane */

/**
 * @typedef {{
 *   paths: string[];
 *   lanes: Record<ChangedLane, boolean>;
 *   extensionImpactFromCore: boolean;
 *   docsOnly: boolean;
 *   reasons: string[];
 * }} ChangedLaneResult
 */

export function normalizeChangedPath(inputPath) {
  return String(inputPath ?? "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "");
}

export function createEmptyChangedLanes() {
  return {
    core: false,
    coreTests: false,
    extensions: false,
    extensionTests: false,
    apps: false,
    docs: false,
    tooling: false,
    liveDockerTooling: false,
    releaseMetadata: false,
    all: false,
  };
}

/**
 * @param {string[]} changedPaths
 * @param {{ packageJsonChangeKind?: "liveDockerTooling" | "tooling" | null }} [options]
 * @returns {ChangedLaneResult}
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
    lanes.docs = paths.some((changedPath) => DOCS_PATH_RE.test(changedPath));
    for (const changedPath of paths) {
      reasons.push(`${changedPath}: release metadata`);
    }
    return { paths, lanes, extensionImpactFromCore: false, docsOnly: false, reasons };
  }

  for (const changedPath of paths) {
    if (DOCS_PATH_RE.test(changedPath)) {
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

    if (LIVE_DOCKER_TOOLING_PATH_RE.test(changedPath)) {
      lanes.liveDockerTooling = true;
      reasons.push(`${changedPath}: live Docker tooling surface`);
      continue;
    }

    if (ROOT_GLOBAL_PATH_RE.test(changedPath)) {
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

    if (EXTENSION_PATH_RE.test(changedPath)) {
      if (TEST_PATH_RE.test(changedPath)) {
        lanes.extensionTests = true;
        reasons.push(`${changedPath}: extension test`);
      } else {
        lanes.extensions = true;
        lanes.extensionTests = true;
        reasons.push(`${changedPath}: extension production`);
      }
      continue;
    }

    if (CORE_PATH_RE.test(changedPath)) {
      if (TEST_PATH_RE.test(changedPath)) {
        lanes.coreTests = true;
        reasons.push(`${changedPath}: core test`);
      } else {
        lanes.core = true;
        lanes.coreTests = true;
        reasons.push(`${changedPath}: core production`);
      }
      continue;
    }

    if (APP_PATH_RE.test(changedPath)) {
      lanes.apps = true;
      reasons.push(`${changedPath}: app surface`);
      continue;
    }

    if (changedPath.startsWith("test/") || changedPath.startsWith("test-fixtures/")) {
      lanes.tooling = true;
      reasons.push(`${changedPath}: root test/support surface`);
      continue;
    }

    if (TOOLING_PATH_RE.test(changedPath)) {
      lanes.tooling = true;
      reasons.push(`${changedPath}: tooling surface`);
      continue;
    }

    if (LEGACY_ROOT_ASSET_PATH_RE.test(changedPath)) {
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
 * @param {{ paths: string[]; base: string; head?: string; staged?: boolean }} params
 * @returns {ChangedLaneResult}
 */
export function detectChangedLanesForPaths(params) {
  const packageJsonChangeKind = params.paths.includes("package.json")
    ? classifyPackageJsonChangeFromGit({
        base: params.base,
        head: params.head,
        staged: params.staged,
      })
    : null;
  return detectChangedLanes(params.paths, { packageJsonChangeKind });
}

/**
 * @param {{ base: string; head?: string; includeWorktree?: boolean; cwd?: string }} params
 * @returns {string[]}
 */
export function listChangedPathsFromGit(params) {
  const base = params.base;
  const head = params.head ?? "HEAD";
  const cwd = params.cwd ?? process.cwd();
  if (!base) {
    return [];
  }
  const rangePaths = runGitNameOnlyDiff([`${base}...${head}`], cwd);
  if (params.includeWorktree === false) {
    return rangePaths;
  }
  return [
    ...new Set([
      ...rangePaths,
      ...runGitNameOnlyDiff(["--cached", "--diff-filter=ACMRD"], cwd),
      ...runGitNameOnlyDiff(["--diff-filter=ACMRD"], cwd),
      ...runGitLsFiles(["--others", "--exclude-standard"], cwd),
    ]),
  ].toSorted((left, right) => left.localeCompare(right));
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

function runGitLsFiles(extraArgs, cwd = process.cwd()) {
  const output = execFileSync("git", ["ls-files", ...extraArgs], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_MAX_BUFFER,
  });
  return output.split("\n").map(normalizeChangedPath).filter(Boolean);
}

export function listStagedChangedPaths() {
  const output = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMRD"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_MAX_BUFFER,
  });
  return output.split("\n").map(normalizeChangedPath).filter(Boolean);
}

export function classifyPackageJsonChangeFromGit(params) {
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
  const clone = JSON.parse(JSON.stringify(packageJson));
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
  const clone = JSON.parse(JSON.stringify(packageJson));
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

export function writeChangedLaneGitHubOutput(result, outputPath = process.env.GITHUB_OUTPUT) {
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
  const args = {
    base: "origin/main",
    head: "HEAD",
    staged: false,
    json: false,
    githubOutput: false,
    paths: [],
  };
  return parseFlagArgs(
    argv,
    args,
    [
      stringFlag("--base", "base"),
      stringFlag("--head", "head"),
      booleanFlag("--staged", "staged"),
      booleanFlag("--json", "json"),
      booleanFlag("--github-output", "githubOutput"),
    ],
    {
      onUnhandledArg(arg, target) {
        if (arg === "--") {
          return "handled";
        }
        target.paths.push(arg);
        return "handled";
      },
    },
  );
}

function isDirectRun() {
  const direct = process.argv[1];
  return Boolean(direct && import.meta.url.endsWith(direct));
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
  const args = parseArgs(process.argv.slice(2));
  const paths =
    args.paths.length > 0
      ? args.paths
      : args.staged
        ? listStagedChangedPaths()
        : listChangedPathsFromGit({ base: args.base, head: args.head });
  const result = detectChangedLanesForPaths({
    paths,
    base: args.base,
    head: args.head,
    staged: args.staged,
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
