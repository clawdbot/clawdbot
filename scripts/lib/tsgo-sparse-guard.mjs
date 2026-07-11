// Detects sparse-checkout gaps before tsgo runs core TypeScript projects.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readFlagValue } from "./arg-utils.mjs";
import { createManagedCommandInvocation } from "./managed-child-process.mjs";

const CORE_TEST_CONFIGS = new Set([
  "tsconfig.core.test.json",
  "tsconfig.core.test.agents.json",
  "tsconfig.core.test.non-agents.json",
]);

const CORE_PROD_CONFIGS = new Set(["tsconfig.core.json"]);
const UI_PROD_CONFIGS = new Set(["tsconfig.ui.json"]);
const TSGO_SPARSE_SKIP_ENV_KEY = "OPENCLAW_TSGO_SPARSE_SKIP";
const CORE_PROD_SPARSE_ROOTS = ["packages"];
const UI_PROD_SPARSE_ROOTS = ["packages", "src", "ui/config", "ui/src"];
const CORE_TEST_SPARSE_ROOTS = ["packages", "ui/config", "ui/src"];

const CORE_PROD_REQUIRED_PATHS = [
  {
    path: "scripts/lib/bundled-runtime-sidecar-paths.json",
    whenPresent: "src/plugins/runtime-sidecar-paths.ts",
  },
  {
    path: "scripts/lib/official-external-channel-catalog.json",
    whenPresent: "src/channels/plugins/catalog.ts",
  },
  {
    path: "scripts/lib/official-external-plugin-catalog.json",
    whenPresent: "src/plugins/official-external-plugin-catalog.ts",
  },
  {
    path: "scripts/lib/official-external-provider-catalog.json",
    whenPresent: "src/plugins/official-external-plugin-catalog.ts",
  },
  {
    path: "scripts/lib/plugin-sdk-entrypoints.json",
    whenPresent: "src/plugin-sdk/entrypoints.ts",
  },
];

const UI_PROD_REQUIRED_PATHS = [
  {
    path: "apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json",
    whenPresent: "ui/src/lib/chat/tool-display.ts",
  },
];

const CORE_TEST_REQUIRED_PATHS = [
  "packages/plugin-package-contract/src/index.ts",
  "ui/config/control-ui-chunking.ts",
  "ui/src/i18n/lib/registry.ts",
  "ui/src/i18n/lib/types.ts",
  "ui/src/app/settings.ts",
  "ui/src/api/gateway.ts",
];

/**
 * Reports whether the caller explicitly opted out of sparse tsgo guard errors.
 */
export function shouldSkipSparseTsgoGuardError(env = process.env) {
  const value = env[TSGO_SPARSE_SKIP_ENV_KEY]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * Creates an environment that suppresses recursive sparse tsgo guard checks.
 */
export function createSparseTsgoSkipEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    [TSGO_SPARSE_SKIP_ENV_KEY]: baseEnv[TSGO_SPARSE_SKIP_ENV_KEY]?.trim() || "1",
  };
}

/**
 * Builds the sparse-checkout diagnostic for core tsgo projects, when needed.
 */
export function getSparseTsgoGuardError(
  args,
  {
    cwd = process.cwd(),
    fileExists = fs.existsSync,
    isSparseCheckoutEnabled,
    sparseCheckoutPatterns,
  } = {},
) {
  const projectPath = readProjectFlag(args);
  const projectName = projectPath ? path.basename(projectPath) : null;
  if (
    !projectName ||
    (!CORE_PROD_CONFIGS.has(projectName) &&
      !UI_PROD_CONFIGS.has(projectName) &&
      !CORE_TEST_CONFIGS.has(projectName)) ||
    isMetadataOnlyCommand(args)
  ) {
    return null;
  }

  const sparseEnabled =
    isSparseCheckoutEnabled?.({ cwd }) ?? getGitBooleanConfig("core.sparseCheckout", { cwd });
  if (!sparseEnabled) {
    return null;
  }

  const sparsePatterns = sparseCheckoutPatterns ?? getSparseCheckoutPatterns({ cwd });
  const missingPaths = [
    ...getRequiredSparseRootsForProject(projectName).filter((relativePath) =>
      sparsePatterns ? !isSparseRootCovered(relativePath, sparsePatterns) : false,
    ),
    ...getRequiredPathsForProject(projectName, cwd, fileExists).filter(
      (relativePath) => !fileExists(path.join(cwd, relativePath)),
    ),
  ];
  if (missingPaths.length === 0) {
    return null;
  }

  return [
    `${projectName} cannot be typechecked from this sparse checkout because tracked project inputs are missing or only partially included:`,
    ...missingPaths.map((relativePath) => `- ${relativePath}`),
    "Expand this worktree's sparse checkout to include those paths, or rerun in a full worktree.",
  ].join("\n");
}

function getRequiredSparseRootsForProject(projectName) {
  if (CORE_PROD_CONFIGS.has(projectName)) {
    return CORE_PROD_SPARSE_ROOTS;
  }
  if (UI_PROD_CONFIGS.has(projectName)) {
    return UI_PROD_SPARSE_ROOTS;
  }
  if (CORE_TEST_CONFIGS.has(projectName)) {
    return CORE_TEST_SPARSE_ROOTS;
  }
  return [];
}

function getRequiredPathsForProject(projectName, cwd, fileExists) {
  const requiredPaths = [];
  if (CORE_PROD_CONFIGS.has(projectName)) {
    requiredPaths.push(...conditionalRequiredPaths(CORE_PROD_REQUIRED_PATHS, cwd, fileExists));
  }
  if (UI_PROD_CONFIGS.has(projectName)) {
    requiredPaths.push(...conditionalRequiredPaths(UI_PROD_REQUIRED_PATHS, cwd, fileExists));
  }
  if (CORE_TEST_CONFIGS.has(projectName)) {
    requiredPaths.push(...CORE_TEST_REQUIRED_PATHS);
  }
  return [...new Set(requiredPaths)].toSorted((left, right) => left.localeCompare(right));
}

function conditionalRequiredPaths(entries, cwd, fileExists) {
  return entries
    .filter((entry) => fileExists(path.join(cwd, entry.whenPresent)))
    .map((entry) => entry.path);
}

function getGitBooleanConfig(name, { cwd }) {
  const git = createManagedCommandInvocation({
    args: ["config", "--get", "--bool", name],
    bin: "git",
  });
  const result = spawnSync(git.command, git.args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: git.shell,
    windowsVerbatimArguments: git.windowsVerbatimArguments,
  });

  if (result.error || (result.status ?? 1) !== 0) {
    return false;
  }

  return (result.stdout ?? "").trim() === "true";
}

function getSparseCheckoutPatterns({ cwd }) {
  const git = createManagedCommandInvocation({
    args: ["sparse-checkout", "list"],
    bin: "git",
  });
  const result = spawnSync(git.command, git.args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: git.shell,
    windowsVerbatimArguments: git.windowsVerbatimArguments,
  });

  if (result.error || (result.status ?? 1) !== 0) {
    return null;
  }

  return (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isSparseRootCovered(relativeRoot, patterns) {
  const root = normalizeSparsePattern(relativeRoot);
  return patterns.some((pattern) => {
    if (pattern.startsWith("!")) {
      return false;
    }

    const normalized = normalizeSparsePattern(pattern);
    return normalized === root || (normalized.length > 0 && root.startsWith(`${normalized}/`));
  });
}

function normalizeSparsePattern(pattern) {
  return pattern
    .trim()
    .replaceAll("\\", "/")
    .replace(/^!/, "")
    .replace(/^\/+/, "")
    .replace(/\/\*\*$/, "")
    .replace(/\/+$/, "");
}

function readProjectFlag(args) {
  return readFlagValue(args, "-p") ?? readFlagValue(args, "--project");
}

function isMetadataOnlyCommand(args) {
  return args.some((arg) =>
    ["--help", "-h", "--version", "-v", "--init", "--showConfig"].includes(arg),
  );
}
