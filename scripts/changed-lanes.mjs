import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { booleanFlag, parseFlagArgs, stringFlag } from "./lib/arg-utils.mjs";

const DOCS_PATH_RE = /^(?:docs\/|README\.md$|AGENTS\.md$|.*\.mdx?$)/u;
const APP_PATH_RE = /^(?:apps\/|Swabble\/|appcast\.xml$)/u;
const EXTENSION_PATH_RE = /^extensions\/[^/]+(?:\/|$)/u;
const CORE_PATH_RE = /^(?:src\/|ui\/|packages\/)/u;
const TOOLING_PATH_RE =
  /^(?:scripts\/|test\/vitest\/|\.github\/|git-hooks\/|vitest(?:\..+)?\.config\.ts$|tsconfig.*\.json$|\.oxlint.*|\.oxfmt.*)/u;
const ROOT_GLOBAL_PATH_RE =
  /^(?:package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsdown\.config\.ts$|vitest\.config\.ts$)/u;
const TEST_PATH_RE =
  /(?:^|\/)(?:test|__tests__)\/|(?:\.|\/)(?:test|spec|e2e|browser\.test)\.[cm]?[jt]sx?$/u;
const PUBLIC_EXTENSION_CONTRACT_RE =
  /^(?:src\/plugin-sdk\/|src\/plugins\/contracts\/|src\/channels\/plugins\/|scripts\/lib\/plugin-sdk-entrypoints\.json$|scripts\/sync-plugin-sdk-exports\.mjs$|scripts\/generate-plugin-sdk-api-baseline\.ts$)/u;

/** @typedef {"core" | "coreTests" | "extensions" | "extensionTests" | "apps" | "docs" | "tooling" | "all"} ChangedLane */

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
    all: false,
  };
}

/**
 * @param {string[]} changedPaths
 * @returns {ChangedLaneResult}
 */
export function detectChangedLanes(changedPaths) {
  const paths = [...new Set(changedPaths.map(normalizeChangedPath).filter(Boolean))].toSorted(
    (left, right) => left.localeCompare(right),
  );
  const lanes = createEmptyChangedLanes();
  const reasons = [];
  let extensionImpactFromCore = false;
  let hasNonDocs = false;

  if (paths.length === 0) {
    reasons.push("no changed paths");
    return { paths, lanes, extensionImpactFromCore: false, docsOnly: false, reasons };
  }

  for (const changedPath of paths) {
    if (DOCS_PATH_RE.test(changedPath)) {
      lanes.docs = true;
      continue;
    }

    hasNonDocs = true;

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

    if (changedPath.startsWith("test/")) {
      lanes.tooling = true;
      reasons.push(`${changedPath}: root test/support surface`);
      continue;
    }

    if (TOOLING_PATH_RE.test(changedPath)) {
      lanes.tooling = true;
      reasons.push(`${changedPath}: tooling surface`);
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
 * @param {{ base: string; head?: string; includeWorktree?: boolean }} params
 * @returns {string[]}
 */
export function listChangedPathsFromGit(params) {
  const base = params.base;
  const head = params.head ?? "HEAD";
  if (!base) {
    return [];
  }
  const rangePaths = runGitNameOnlyDiff([`${base}...${head}`]);
  if (params.includeWorktree === false) {
    return rangePaths;
  }
  return [
    ...new Set([
      ...rangePaths,
      ...runGitNameOnlyDiff(["--cached", "--diff-filter=ACMR"]),
      ...runGitNameOnlyDiff(["--diff-filter=ACMR"]),
      ...runGitLsFiles(["--others", "--exclude-standard"]),
    ]),
  ].toSorted((left, right) => left.localeCompare(right));
}

function runGitNameOnlyDiff(extraArgs) {
  const output = execFileSync("git", ["diff", "--name-only", ...extraArgs], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return output.split("\n").map(normalizeChangedPath).filter(Boolean);
}

function runGitLsFiles(extraArgs) {
  const output = execFileSync("git", ["ls-files", ...extraArgs], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return output.split("\n").map(normalizeChangedPath).filter(Boolean);
}

export function listStagedChangedPaths() {
  const output = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return output.split("\n").map(normalizeChangedPath).filter(Boolean);
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
  const result = detectChangedLanes(paths);
  if (args.githubOutput) {
    writeChangedLaneGitHubOutput(result);
  }
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!args.githubOutput) {
    printHuman(result);
  }
}
