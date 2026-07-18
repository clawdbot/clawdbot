// Runs Vitest through repo project selection, local scheduling policy, output
// watchdogs, and process-group cleanup.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toolingIsolatedTestFiles } from "../test/vitest/vitest.tooling-isolated-paths.mjs";
import { isUiTestTarget } from "../test/vitest/vitest.ui-paths.mjs";
import { boundaryTestFiles } from "../test/vitest/vitest.unit-paths.mjs";
import { resolveLocalVitestEnv } from "./lib/vitest-local-scheduling.mjs";
import { spawnPnpmRunner } from "./pnpm-runner.mjs";
import {
  forceKillVitestProcessGroup,
  forwardSignalToVitestProcessGroup,
  installVitestProcessGroupCleanup,
  shouldUseDetachedVitestProcessGroup,
} from "./vitest-process-group.mjs";

const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const ANSI_CSI_PREFIX = `${String.fromCharCode(27)}[`;
const ANSI_CSI_SUFFIX_RE = /^[0-?]*[ -/]*[@-~]/u;
const SUPPRESSED_VITEST_STDERR_PATTERNS = ["[PLUGIN_TIMINGS]"];
/** Default watchdog timeout for Vitest runs that stop producing output. */
export const DEFAULT_VITEST_NO_OUTPUT_TIMEOUT_MS = 120_000;
/** Default heartbeat interval while waiting on silent Vitest output. */
export const DEFAULT_VITEST_NO_OUTPUT_HEARTBEAT_MS = 30_000;
/** Longer watchdog timeout for known long-running Vitest configs. */
export const DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS = 300_000;
/** Extra-long watchdog timeout for broad configs that can stay silent on macOS. */
export const DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS = 2_400_000;
const VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY = "OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS";
const VITEST_NO_OUTPUT_HEARTBEAT_ENV_KEY = "OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS";
const UI_VITEST_CONFIG = "test/vitest/vitest.ui.config.ts";
const TOOLING_DOCKER_VITEST_CONFIG = "test/vitest/vitest.tooling-docker.config.ts";
const TOOLING_VITEST_CONFIG = "test/vitest/vitest.tooling.config.ts";
const GATEWAY_CORE_VITEST_CONFIG = "test/vitest/vitest.gateway-core.config.ts";
const GATEWAY_SERVER_VITEST_CONFIG = "test/vitest/vitest.gateway-server.config.ts";
const GATEWAY_VITEST_CONFIG = "test/vitest/vitest.gateway.config.ts";
export const VITEST_CONFIG_NO_OUTPUT_TIMEOUT_MS = new Map([
  ["test/vitest/vitest.e2e.config.ts", DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS],
  [GATEWAY_VITEST_CONFIG, DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS],
  ["test/vitest/vitest.ui-e2e.config.ts", DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS],
  ["test/vitest/vitest.full-agentic.config.ts", DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS],
  [
    "test/vitest/vitest.full-core-contracts.config.ts",
    DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS,
  ],
  [
    "test/vitest/vitest.contracts-plugin.config.ts",
    DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS,
  ],
  ["test/vitest/vitest.infra.config.ts", DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS],
  [GATEWAY_CORE_VITEST_CONFIG, DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS],
  [GATEWAY_SERVER_VITEST_CONFIG, DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS],
]);
export const TOOLING_EXCLUDED_TESTS = new Set([
  ...boundaryTestFiles,
  "test/scripts/docker-build-helper.test.ts",
  ...toolingIsolatedTestFiles,
]);
const EXPLICIT_FILE_TARGET_RE = /\.(?:[cm]?[jt]sx?)$/u;
const EXPLICIT_TEST_FILE_RE = /\.(?:test|e2e|live)\.(?:[cm]?[jt]sx?)$/u;
const GLOB_PATTERN_CHARS_RE = /[*?[\]{}]/u;
const NON_RUN_VITEST_SUBCOMMANDS = new Set(["bench", "list", "related"]);
const VITEST_OPTIONS_WITH_VALUE = new Set([
  "--attachmentsDir",
  "--bail",
  "--browser",
  "--config",
  "--configLoader",
  "-c",
  "--changed",
  "--dir",
  "--diff",
  "--environment",
  "--exclude",
  "--execArgv",
  "--hookTimeout",
  "--inspect",
  "--inspect-brk",
  "--listTags",
  "--maxConcurrency",
  "--maxWorkers",
  "--mergeReports",
  "--mode",
  "--outputFile",
  "--pool",
  "--project",
  "--reporter",
  "--reporters",
  "--retry",
  "--root",
  "-r",
  "--sequence.shuffle.seed",
  "--shard",
  "--silent",
  "--slowTestThreshold",
  "--tagsFilter",
  "--teardownTimeout",
  "--testNamePattern",
  "-t",
  "--testTimeout",
  "--update",
  "-u",
  "--vmMemoryLimit",
]);
const VITEST_DOTTED_OPTIONS_WITH_VALUE_PREFIXES = [
  "--browser.",
  "--coverage.",
  "--diff.",
  "--expect.",
  "--experimental.",
  "--outputFile.",
  "--retry.",
  "--sequence.",
  "--typecheck.",
];
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testProjectsRunnerPath = path.join(repoRoot, "scripts", "test-projects.mjs");

function isTruthyEnvValue(value) {
  return TRUTHY_ENV_VALUES.has(value?.trim().toLowerCase() ?? "");
}

function parsePositiveInt(value) {
  const text = value?.trim();
  if (!text || !/^\d+$/u.test(text)) {
    return null;
  }
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Resolves default Node flags for Vitest, including the local Maglev opt-in.
 */
export function resolveVitestNodeArgs(env = process.env) {
  if (isTruthyEnvValue(env.OPENCLAW_VITEST_ENABLE_MAGLEV)) {
    return [];
  }

  return ["--no-maglev"];
}

function isMissingVitestResolveError(error) {
  return (
    error instanceof Error &&
    error.code === "MODULE_NOT_FOUND" &&
    error.message.includes("vitest/package.json")
  );
}

/**
 * Builds the actionable dependency-install message when Vitest is unavailable.
 */
export function resolveMissingVitestDependencyMessage(baseDir = repoRoot, fsImpl = fs) {
  const hasNodeModules = fsImpl.existsSync(path.join(baseDir, "node_modules"));
  const reason = hasNodeModules
    ? "[vitest] Vitest is not installed in node_modules."
    : "[vitest] node_modules is missing; Vitest cannot be resolved.";
  return [
    reason,
    "Install dependencies before running scripts/run-vitest.mjs:",
    "  pnpm install --frozen-lockfile",
    "For raw Crabbox/AWS macOS source syncs, hydrate or install dependencies before this runner.",
  ].join("\n");
}

function resolvePathFromBase(value, baseDir) {
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function resolvePnpmModulesDir(env) {
  return env.PNPM_CONFIG_MODULES_DIR?.trim() || env.npm_config_modules_dir?.trim() || "";
}

function resolveHydratedVitestPackageJson({ baseDir, env, fsImpl }) {
  const modulesDir = resolvePnpmModulesDir(env);
  if (!modulesDir) {
    return null;
  }
  const packageJsonPath = path.join(
    resolvePathFromBase(modulesDir, baseDir),
    "vitest",
    "package.json",
  );
  return fsImpl.existsSync(packageJsonPath) ? packageJsonPath : null;
}

function ensureHydratedNodeModulesSelfLink({ hydratedNodeModulesPath, fsImpl, platform }) {
  if (platform !== "win32") {
    return true;
  }
  const selfLinkPath = path.join(hydratedNodeModulesPath, "node_modules");
  if (fsImpl.existsSync(selfLinkPath)) {
    return true;
  }
  try {
    fsImpl.symlinkSync(hydratedNodeModulesPath, selfLinkPath, "junction");
    return true;
  } catch {
    return false;
  }
}

function resolveHydratedVitestCliEntry({ baseDir, env, fsImpl, platform }) {
  const hydratedVitestPackageJson = resolveHydratedVitestPackageJson({ baseDir, env, fsImpl });
  if (!hydratedVitestPackageJson) {
    return null;
  }
  const hydratedNodeModulesPath = path.dirname(path.dirname(hydratedVitestPackageJson));
  if (!ensureHydratedNodeModulesSelfLink({ hydratedNodeModulesPath, fsImpl, platform })) {
    return null;
  }
  const nodeModulesPath = path.join(baseDir, "node_modules");
  if (fsImpl.existsSync(nodeModulesPath)) {
    const workspaceVitestCliEntry = path.join(nodeModulesPath, "vitest", "vitest.mjs");
    return fsImpl.existsSync(workspaceVitestCliEntry) ? workspaceVitestCliEntry : null;
  }
  try {
    fsImpl.symlinkSync(
      hydratedNodeModulesPath,
      nodeModulesPath,
      platform === "win32" ? "junction" : "dir",
    );
  } catch {
    return null;
  }
  return path.join(nodeModulesPath, "vitest", "vitest.mjs");
}

/**
 * Resolves the Vitest CLI entry from normal or hydrated node_modules layouts.
 */
export function resolveVitestCliEntry({
  baseDir = repoRoot,
  env = process.env,
  fsImpl = fs,
  platform = process.platform,
  requireResolve = require.resolve.bind(require),
} = {}) {
  const hydratedVitestCliEntry = resolveHydratedVitestCliEntry({
    baseDir,
    env,
    fsImpl,
    platform,
  });
  if (hydratedVitestCliEntry) {
    return hydratedVitestCliEntry;
  }

  let vitestPackageJson;
  try {
    vitestPackageJson = requireResolve("vitest/package.json");
  } catch (error) {
    if (isMissingVitestResolveError(error)) {
      const wrappedError = new Error(resolveMissingVitestDependencyMessage(baseDir, fsImpl));
      wrappedError.code = "OPENCLAW_MISSING_VITEST";
      throw wrappedError;
    }
    throw error;
  }
  return path.join(path.dirname(vitestPackageJson), "vitest.mjs");
}

/**
 * Reads the explicit no-output watchdog timeout, if configured.
 */
export function resolveVitestNoOutputTimeoutMs(env = process.env) {
  return parsePositiveInt(env[VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY]);
}

/**
 * Reads the explicit no-output heartbeat interval, if configured.
 */
export function resolveVitestNoOutputHeartbeatMs(env = process.env) {
  return parsePositiveInt(env[VITEST_NO_OUTPUT_HEARTBEAT_ENV_KEY]);
}

function resolveBooleanModeFlag(argv, index, longName, shortName = null) {
  const arg = argv[index];
  const parseValue = (rawValue) => rawValue !== "false";
  for (const flag of [`--${longName}`, shortName].filter(Boolean)) {
    if (arg === `--no-${longName}`) {
      return { value: false, consumedNext: false };
    }
    if (arg === flag) {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        return { value: parseValue(next), consumedNext: true };
      }
      return { value: true, consumedNext: false };
    }
    if (arg.startsWith(`${flag}=`)) {
      return { value: parseValue(arg.slice(flag.length + 1)), consumedNext: false };
    }
  }
  return null;
}

function resolveExplicitVitestMode(argv) {
  let mode = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      break;
    }
    const watchFlag = resolveBooleanModeFlag(argv, index, "watch", "-w");
    if (watchFlag) {
      if (watchFlag.consumedNext) {
        index += 1;
      }
      if (watchFlag.value) {
        return "watch";
      }
      mode = "run";
      continue;
    }
    const runFlag = resolveBooleanModeFlag(argv, index, "run");
    if (runFlag) {
      if (runFlag.consumedNext) {
        index += 1;
      }
      if (runFlag.value) {
        mode = "run";
      }
      continue;
    }
    if (optionConsumesNextArg(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    if (mode !== null) {
      continue;
    }
    if (arg === "watch" || arg === "dev") {
      return "watch";
    }
    if (arg === "run") {
      mode = "run";
      continue;
    }
    return null;
  }
  return mode;
}

function resolveVitestCompileCacheSafeEnv(env) {
  if (!env.NODE_COMPILE_CACHE && !env.NODE_COMPILE_CACHE_PORTABLE) {
    return env;
  }
  // Coverage can be enabled inside a dynamic Vitest config, which this wrapper
  // cannot know before spawning. Keep the cache for orchestration/build tools,
  // but never let a Vitest child deserialize bytecode into V8 coverage.
  const spawnEnv = { ...env, NODE_DISABLE_COMPILE_CACHE: "1" };
  delete spawnEnv.NODE_COMPILE_CACHE;
  delete spawnEnv.NODE_COMPILE_CACHE_PORTABLE;
  return spawnEnv;
}

/**
 * Adds default watchdog env for non-watch Vitest runs.
 */
export function resolveRunVitestSpawnEnv(env = process.env, argv = []) {
  const baseEnv = resolveVitestCompileCacheSafeEnv(env);
  const explicitMode = resolveExplicitVitestMode(argv);
  if (explicitMode === "watch") {
    return baseEnv;
  }
  if (explicitMode !== "run" && !isTruthyEnvValue(baseEnv.CI)) {
    return baseEnv;
  }
  const defaultTimeoutMs = resolveDefaultVitestNoOutputTimeoutMs(argv);
  const hasTimeout = Object.hasOwn(baseEnv, VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY);
  const timeoutMs = hasTimeout
    ? parsePositiveInt(baseEnv[VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY])
    : defaultTimeoutMs;
  const hasHeartbeat = Object.hasOwn(baseEnv, VITEST_NO_OUTPUT_HEARTBEAT_ENV_KEY);
  return {
    ...baseEnv,
    ...(!hasTimeout ? { [VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY]: String(defaultTimeoutMs) } : {}),
    ...(!hasHeartbeat && timeoutMs !== null && DEFAULT_VITEST_NO_OUTPUT_HEARTBEAT_MS < timeoutMs
      ? { [VITEST_NO_OUTPUT_HEARTBEAT_ENV_KEY]: String(DEFAULT_VITEST_NO_OUTPUT_HEARTBEAT_MS) }
      : {}),
  };
}

/**
 * Chooses the default watchdog timeout from the selected Vitest config.
 */
export function resolveDefaultVitestNoOutputTimeoutMs(argv = []) {
  const config = resolveVitestConfigArg(argv);
  return config === null
    ? DEFAULT_VITEST_NO_OUTPUT_TIMEOUT_MS
    : (resolveVitestConfigNoOutputTimeoutMs(config) ?? DEFAULT_VITEST_NO_OUTPUT_TIMEOUT_MS);
}

function resolveVitestConfigArg(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      return null;
    }
    if (arg === "--config" || arg === "-c") {
      return argv[index + 1] ?? null;
    }
    if (arg.startsWith("--config=")) {
      return arg.slice("--config=".length);
    }
  }
  return null;
}

function resolveVitestConfigNoOutputTimeoutMs(config) {
  const normalized = path.normalize(config).replaceAll(path.sep, "/").replace(/^\.\//u, "");
  for (const [candidate, timeoutMs] of VITEST_CONFIG_NO_OUTPUT_TIMEOUT_MS) {
    if (normalized === candidate || normalized.endsWith(`/${candidate}`)) {
      return timeoutMs;
    }
  }
  return null;
}

/**
 * Builds spawn options for the primary Vitest child process.
 */
export function resolveVitestSpawnParams(env = process.env, platform = process.platform) {
  return {
    env: resolveVitestSpawnEnv(env),
    detached: shouldUseDetachedVitestProcessGroup(platform),
    stdio: ["inherit", "pipe", "pipe"],
  };
}

/**
 * Applies local Vitest scheduling and native worker budget env.
 */
function resolveVitestSpawnEnv(env = process.env) {
  const baseEnv = resolveLocalVitestEnv(env);
  if (!shouldApplyNativeWorkerBudget(baseEnv)) {
    return baseEnv;
  }

  const nativeWorkerCount = String(resolveNativeWorkerCount(baseEnv));
  return {
    ...baseEnv,
    RAYON_NUM_THREADS: baseEnv.RAYON_NUM_THREADS?.trim() || nativeWorkerCount,
    TOKIO_WORKER_THREADS: baseEnv.TOKIO_WORKER_THREADS?.trim() || nativeWorkerCount,
  };
}

function shouldApplyNativeWorkerBudget(env) {
  if (env.RAYON_NUM_THREADS?.trim() && env.TOKIO_WORKER_THREADS?.trim()) {
    return false;
  }
  return (
    env.OPENCLAW_TEST_PROJECTS_SERIAL === "1" || resolveExplicitVitestWorkerBudget(env) !== null
  );
}

function resolveNativeWorkerCount(env) {
  return Math.min(resolveExplicitVitestWorkerBudget(env) ?? 1, 4);
}

function resolveExplicitVitestWorkerBudget(env) {
  return parsePositiveInt(env.OPENCLAW_VITEST_MAX_WORKERS ?? env.OPENCLAW_TEST_WORKERS);
}

/**
 * Filters known noisy Vitest stderr lines after stripping ANSI escapes.
 */
export function shouldSuppressVitestStderrLine(line) {
  const normalizedLine = line
    .split(ANSI_CSI_PREFIX)
    .map((segment, index) => (index === 0 ? segment : segment.replace(ANSI_CSI_SUFFIX_RE, "")))
    .join("");
  return SUPPRESSED_VITEST_STDERR_PATTERNS.some((pattern) => normalizedLine.includes(pattern));
}

/**
 * Detects pnpm exec node invocations so the wrapper can spawn Node directly.
 */
export function resolveDirectNodeVitestArgs(pnpmArgs) {
  return pnpmArgs[0] === "exec" && pnpmArgs[1] === "node" ? pnpmArgs.slice(2) : null;
}

function hasExplicitVitestConfigArg(argv) {
  return argv.some((arg) => arg === "--config" || arg === "-c" || arg.startsWith("--config="));
}

function optionConsumesNextArg(arg) {
  if (arg.includes("=")) {
    return false;
  }
  return (
    VITEST_OPTIONS_WITH_VALUE.has(arg) ||
    VITEST_DOTTED_OPTIONS_WITH_VALUE_PREFIXES.some((prefix) => arg.startsWith(prefix))
  );
}

function isPathLikeExplicitFileArg(arg) {
  return (
    path.isAbsolute(arg) || arg.startsWith("./") || arg.startsWith("../") || /[/\\]/u.test(arg)
  );
}

function isExplicitFileTargetArg(arg) {
  if (!EXPLICIT_FILE_TARGET_RE.test(arg) || GLOB_PATTERN_CHARS_RE.test(arg)) {
    return false;
  }
  return isPathLikeExplicitFileArg(arg);
}

function isExplicitTestFileArg(arg) {
  return EXPLICIT_TEST_FILE_RE.test(arg) && isExplicitFileTargetArg(arg);
}

function isDelegableBroadProjectRouterTarget(arg, cwd) {
  const relative = toRepoRelativeArg(arg, cwd).replace(/\/+$/u, "");
  return (
    relative === "test/scripts" ||
    relative === "test/scripts/*.test.ts" ||
    relative === "test/scripts/**/*.test.ts"
  );
}

function isExplicitProjectRouterTargetArg(arg, cwd = process.cwd(), fsImpl = fs) {
  if (!isPathLikeExplicitFileArg(arg)) {
    return false;
  }
  if (GLOB_PATTERN_CHARS_RE.test(arg)) {
    return isDelegableBroadProjectRouterTarget(arg, cwd);
  }
  if (isExplicitFileTargetArg(arg)) {
    return true;
  }
  const filePath = path.isAbsolute(arg) ? arg : path.resolve(cwd, arg);
  return fsImpl.existsSync(filePath) && isDelegableBroadProjectRouterTarget(arg, cwd);
}

function collectExplicitFileTargetArgs(argv, predicate = isExplicitFileTargetArg) {
  const files = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      break;
    }
    if (optionConsumesNextArg(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    if (predicate(arg)) {
      files.push(arg);
    }
  }
  return files;
}

function collectExplicitProjectRouterTargetArgs(argv, cwd = process.cwd(), fsImpl = fs) {
  return collectExplicitFileTargetArgs(argv, (arg) =>
    isExplicitProjectRouterTargetArg(arg, cwd, fsImpl),
  );
}

function isExplicitDirectoryTargetArg(arg, cwd = process.cwd(), fsImpl = fs) {
  if (!isPathLikeExplicitFileArg(arg) || GLOB_PATTERN_CHARS_RE.test(arg)) {
    return false;
  }
  const targetPath = path.isAbsolute(arg) ? arg : path.resolve(cwd, arg);
  try {
    return fsImpl.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function collectExplicitDirectoryTargetArgs(argv, cwd = process.cwd(), fsImpl = fs) {
  return collectExplicitFileTargetArgs(argv, (arg) =>
    isExplicitDirectoryTargetArg(arg, cwd, fsImpl),
  );
}

function collectExplicitTestFileArgs(argv) {
  return collectExplicitFileTargetArgs(argv, isExplicitTestFileArg);
}

/**
 * Forces explicit test-file targets to fail when Vitest finds no matching tests.
 */
export function resolveExplicitTestFileNoPassArgs(argv) {
  if (collectExplicitTestFileArgs(argv).length === 0) {
    return argv;
  }
  const sentinelIndex = argv.indexOf("--");
  if (sentinelIndex === -1) {
    return [...argv, "--passWithNoTests=false"];
  }
  return [...argv.slice(0, sentinelIndex), "--passWithNoTests=false", ...argv.slice(sentinelIndex)];
}

function hasAlternateVitestRootArg(argv) {
  return argv.some(
    (arg) =>
      arg === "--root" ||
      arg === "-r" ||
      arg === "--dir" ||
      arg.startsWith("--root=") ||
      arg.startsWith("--dir="),
  );
}

function hasExplicitVitestProjectArg(argv) {
  return argv.some((arg) => arg === "--project" || arg.startsWith("--project="));
}

function hasExplicitDisabledRunFlag(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      break;
    }
    const runFlag = resolveBooleanModeFlag(argv, index, "run");
    if (!runFlag) {
      if (optionConsumesNextArg(arg)) {
        index += 1;
      }
      continue;
    }
    if (runFlag.consumedNext) {
      index += 1;
    }
    if (!runFlag.value) {
      return true;
    }
  }
  return false;
}

function hasSeparateVitestOptionValueArg(argv) {
  for (const arg of argv) {
    if (arg === "--") {
      return false;
    }
    if (optionConsumesNextArg(arg)) {
      return true;
    }
  }
  return false;
}

function stripRunSubcommand(argv) {
  const stripped = [];
  let canRemoveRunSubcommand = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      stripped.push(arg);
      canRemoveRunSubcommand = false;
      continue;
    }
    if (canRemoveRunSubcommand && optionConsumesNextArg(arg)) {
      stripped.push(arg);
      if (index + 1 < argv.length) {
        index += 1;
        stripped.push(argv[index]);
      }
      continue;
    }
    if (canRemoveRunSubcommand && arg.startsWith("-")) {
      stripped.push(arg);
      continue;
    }
    if (canRemoveRunSubcommand && arg === "run") {
      canRemoveRunSubcommand = false;
      continue;
    }
    canRemoveRunSubcommand = false;
    stripped.push(arg);
  }
  return stripped;
}

function hasNonRunVitestSubcommand(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      return false;
    }
    if (optionConsumesNextArg(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return NON_RUN_VITEST_SUBCOMMANDS.has(arg);
  }
  return false;
}

/**
 * Delegates explicit path runs to the repo test-projects runner.
 */
export function resolveTestProjectsDelegationArgs(argv, cwd = process.cwd()) {
  if (
    hasExplicitVitestConfigArg(argv) ||
    hasAlternateVitestRootArg(argv) ||
    hasExplicitVitestProjectArg(argv) ||
    resolveExplicitVitestMode(argv) === "watch" ||
    hasNonRunVitestSubcommand(argv) ||
    hasExplicitDisabledRunFlag(argv) ||
    hasSeparateVitestOptionValueArg(argv) ||
    collectExplicitProjectRouterTargetArgs(argv, cwd).length === 0
  ) {
    return null;
  }
  return stripRunSubcommand(argv);
}

/**
 * Lists explicit test file targets missing from the current checkout.
 */
export function resolveMissingExplicitTestFiles(argv, cwd = process.cwd(), fsImpl = fs) {
  if (hasExplicitVitestConfigArg(argv) || hasAlternateVitestRootArg(argv)) {
    return [];
  }
  return collectExplicitFileTargetArgs(argv)
    .filter((arg) => {
      const filePath = path.isAbsolute(arg) ? arg : path.resolve(cwd, arg);
      return !fsImpl.existsSync(filePath);
    })
    .map((arg) => toRepoRelativeArg(arg, cwd));
}

function toRepoRelativeArg(arg, cwd) {
  const normalized = path.isAbsolute(arg) ? path.relative(cwd, arg) : arg;
  return normalized.replaceAll(path.sep, "/").replace(/^\.\//u, "");
}

function withImplicitVitestConfig(argv, config) {
  if (argv[0] === "run") {
    return ["run", "--config", config, ...argv.slice(1)];
  }
  return ["--config", config, ...argv];
}

function isToolingTestTarget(target) {
  return (
    target.startsWith("test/") && target.endsWith(".test.ts") && !TOOLING_EXCLUDED_TESTS.has(target)
  );
}

function isToolingDockerTestTarget(target) {
  return target === "test/scripts/docker-build-helper.test.ts";
}

/**
 * Resolves config defaults and explicit-file handling for wrapper-inferred runs.
 */
export function resolveImplicitVitestArgs(argv, cwd = process.cwd()) {
  if (hasExplicitVitestConfigArg(argv)) {
    return argv;
  }
  const separatorIndex = argv.indexOf("--");
  const optionArgs = separatorIndex < 0 ? argv : argv.slice(0, separatorIndex);
  const hasExplicitIsolation = optionArgs.some(
    (arg) => arg === "--isolate" || arg === "--no-isolate" || arg.startsWith("--isolate="),
  );
  if (!hasExplicitIsolation && collectExplicitDirectoryTargetArgs(argv, cwd).length > 1) {
    // Mixed directory selectors can activate overlapping Vitest projects.
    // Isolate their module caches so one project's mocks cannot poison another.
    const resolved = [...argv];
    resolved.splice(separatorIndex < 0 ? resolved.length : separatorIndex, 0, "--isolate");
    return resolved;
  }
  const testTargets = argv
    .filter((arg) => !arg.startsWith("-") && arg.endsWith(".test.ts"))
    .map((arg) => toRepoRelativeArg(arg, cwd));
  if (testTargets.length > 0 && testTargets.every(isToolingDockerTestTarget)) {
    return withImplicitVitestConfig(argv, TOOLING_DOCKER_VITEST_CONFIG);
  }
  if (testTargets.length > 0 && testTargets.every(isToolingTestTarget)) {
    return withImplicitVitestConfig(argv, TOOLING_VITEST_CONFIG);
  }
  if (testTargets.length > 0 && testTargets.every(isUiTestTarget)) {
    return withImplicitVitestConfig(argv, UI_VITEST_CONFIG);
  }
  return argv;
}

function spawnVitestProcess({ pnpmArgs, spawnParams }) {
  const directNodeArgs = resolveDirectNodeVitestArgs(pnpmArgs);
  if (directNodeArgs) {
    return spawn(process.execPath, directNodeArgs, spawnParams);
  }
  return spawnPnpmRunner({
    pnpmArgs,
    ...spawnParams,
  });
}

/**
 * Installs the no-output watchdog for long-running Vitest children.
 */
export function installVitestNoOutputWatchdog(params) {
  const timeoutMs = params.timeoutMs;
  if (!timeoutMs || timeoutMs <= 0) {
    return () => {};
  }

  const setTimeoutFn = params.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = params.clearTimeoutFn ?? clearTimeout;
  const forceKillAfterMs = params.forceKillAfterMs ?? 5_000;
  const heartbeatMs =
    params.heartbeatMs && params.heartbeatMs > 0 && params.heartbeatMs < timeoutMs
      ? params.heartbeatMs
      : null;
  const streams = params.streams?.filter(Boolean) ?? [];
  const label = params.label?.trim();
  const suffix = label ? ` (${label})` : "";

  let active = true;
  let silenceTimer = null;
  let forceKillTimer = null;
  let heartbeatTimer = null;
  let silentForMs = 0;
  let timedOut = false;

  const clearHeartbeatTimer = () => {
    if (heartbeatTimer !== null) {
      clearTimeoutFn(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const clearForceKillTimer = () => {
    if (forceKillTimer !== null) {
      clearTimeoutFn(forceKillTimer);
      forceKillTimer = null;
    }
  };

  const clearSilenceTimer = () => {
    if (silenceTimer !== null) {
      clearTimeoutFn(silenceTimer);
      silenceTimer = null;
    }
  };

  const scheduleHeartbeatTimer = () => {
    if (!active || heartbeatMs === null) {
      return;
    }
    clearHeartbeatTimer();
    heartbeatTimer = setTimeoutFn(() => {
      if (!active) {
        return;
      }
      silentForMs += heartbeatMs;
      params.log?.(`[vitest] still running with no output for ${silentForMs}ms${suffix}.`);
      if (silentForMs + heartbeatMs < timeoutMs) {
        scheduleHeartbeatTimer();
      }
    }, heartbeatMs);
  };

  const resetSilenceTimer = () => {
    if (!active) {
      return;
    }
    clearSilenceTimer();
    silentForMs = 0;
    scheduleHeartbeatTimer();
    silenceTimer = setTimeoutFn(() => {
      if (!active) {
        return;
      }
      clearHeartbeatTimer();
      timedOut = true;
      params.log?.(
        `[vitest] no output for ${timeoutMs}ms; terminating stalled Vitest process group${suffix}.`,
      );
      params.onTimeout?.();
      if (forceKillAfterMs > 0) {
        clearForceKillTimer();
        forceKillTimer = setTimeoutFn(() => {
          if (!active) {
            return;
          }
          params.log?.(
            `[vitest] process group still alive after ${forceKillAfterMs}ms; sending SIGKILL${suffix}.`,
          );
          params.onForceKill?.();
        }, forceKillAfterMs);
      }
    }, timeoutMs);
  };

  const handleActivity = () => {
    if (timedOut) {
      return;
    }
    clearForceKillTimer();
    resetSilenceTimer();
  };

  const listeners = streams.map((stream) => {
    const handler = () => {
      handleActivity();
    };
    stream.on("data", handler);
    return { stream, handler };
  });

  resetSilenceTimer();

  return () => {
    if (!active) {
      return;
    }
    active = false;
    clearSilenceTimer();
    clearForceKillTimer();
    clearHeartbeatTimer();
    for (const { stream, handler } of listeners) {
      stream.off("data", handler);
    }
  };
}

/**
 * Forwards child output while optionally suppressing complete stderr lines.
 */
function forwardVitestOutput(stream, target, shouldSuppressLine = () => false) {
  if (!stream) {
    return;
  }

  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    while (true) {
      const newlineIndex = buffered.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = buffered.slice(0, newlineIndex + 1);
      buffered = buffered.slice(newlineIndex + 1);
      if (!shouldSuppressLine(line)) {
        target.write(line);
      }
    }
  });
  stream.on("end", () => {
    if (buffered.length > 0 && !shouldSuppressLine(buffered)) {
      target.write(buffered);
    }
  });
}

/**
 * Spawns Vitest with output forwarding, watchdogs, and process-group cleanup.
 */
export function spawnWatchedVitestProcess({
  pnpmArgs,
  spawnParams,
  env,
  label,
  onNoOutputTimeout,
}) {
  let forwardedSignal = null;
  const child = spawnVitestProcess({
    pnpmArgs,
    spawnParams,
  });
  const teardownChildCleanup = installVitestProcessGroupCleanup({
    child,
    forceSignal: "SIGKILL",
    forceSignalDelayMs: 100,
    onSignal: (signal) => {
      forwardedSignal ??= signal;
    },
  });
  const teardownNoOutputWatchdog = installVitestNoOutputWatchdog({
    streams: [child.stdout, child.stderr],
    timeoutMs: resolveVitestNoOutputTimeoutMs(env),
    heartbeatMs: resolveVitestNoOutputHeartbeatMs(env),
    label,
    log: (message) => {
      console.error(message);
    },
    onTimeout: () => {
      onNoOutputTimeout?.();
      forwardSignalToVitestProcessGroup({
        child,
        signal: "SIGTERM",
        kill: process.kill.bind(process),
      });
    },
    onForceKill: () => {
      forwardSignalToVitestProcessGroup({
        child,
        signal: "SIGKILL",
        kill: process.kill.bind(process),
      });
    },
  });
  forwardVitestOutput(child.stdout, process.stdout);
  forwardVitestOutput(child.stderr, process.stderr, shouldSuppressVitestStderrLine);

  return {
    child,
    getForwardedSignal: () => forwardedSignal,
    teardown: () => {
      teardownChildCleanup();
      teardownNoOutputWatchdog();
    },
  };
}

/**
 * Builds env for the delegated test-projects runner.
 */
export function resolveTestProjectsRunnerEnv(env) {
  return resolveVitestSpawnEnv(env);
}

/**
 * Builds spawn options for the delegated test-projects runner.
 */
export function resolveTestProjectsRunnerSpawnParams(env, platform = process.platform) {
  return {
    env: resolveTestProjectsRunnerEnv(env),
    detached: shouldUseDetachedVitestProcessGroup(platform),
    stdio: "inherit",
  };
}

function spawnTestProjectsRunner(argv, env, options = {}) {
  let forwardedSignal = null;
  const child = spawn(process.execPath, [options.runnerPath ?? testProjectsRunnerPath, ...argv], {
    ...resolveTestProjectsRunnerSpawnParams(env),
  });
  const teardown = installVitestProcessGroupCleanup({
    child,
    forceSignal: "SIGKILL",
    forceSignalDelayMs: 100,
    onSignal: (signal) => {
      forwardedSignal ??= signal;
    },
  });
  return { child, getForwardedSignal: () => forwardedSignal, teardown };
}

export function runTestProjectsDelegation(argv, env, options = {}) {
  const { child, getForwardedSignal, teardown } = spawnTestProjectsRunner(argv, env, options);
  child.on("exit", (code, signal) => {
    teardown();
    const forwardedSignal = getForwardedSignal();
    if (forwardedSignal) {
      forceKillVitestProcessGroup(child);
      process.kill(process.pid, forwardedSignal);
      return;
    }
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
  child.on("error", (error) => {
    teardown();
    console.error(error);
    process.exit(1);
  });
  return child;
}

function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length === 0) {
    console.error("usage: node scripts/run-vitest.mjs <vitest args...>");
    process.exit(1);
  }

  const missingTestFiles = resolveMissingExplicitTestFiles(argv);
  if (missingTestFiles.length > 0) {
    console.error(
      [
        "[vitest] explicit test/source file(s) not found:",
        ...missingTestFiles.map((file) => `  - ${file}`),
      ].join("\n"),
    );
    process.exit(1);
  }

  const delegatedArgs = resolveTestProjectsDelegationArgs(argv);
  if (delegatedArgs) {
    runTestProjectsDelegation(delegatedArgs, env);
    return;
  }

  const vitestArgs = resolveImplicitVitestArgs(argv);
  const guardedVitestArgs = resolveExplicitTestFileNoPassArgs(vitestArgs);
  const spawnEnv = resolveRunVitestSpawnEnv(env, guardedVitestArgs);
  let vitestCliEntry;
  try {
    vitestCliEntry = resolveVitestCliEntry();
  } catch (error) {
    if (error instanceof Error && error.code === "OPENCLAW_MISSING_VITEST") {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const { child, getForwardedSignal, teardown } = spawnWatchedVitestProcess({
    pnpmArgs: ["exec", "node", ...resolveVitestNodeArgs(env), vitestCliEntry, ...guardedVitestArgs],
    spawnParams: resolveVitestSpawnParams(spawnEnv),
    env: spawnEnv,
    label: guardedVitestArgs.join(" "),
  });

  child.on("exit", (code, signal) => {
    teardown();
    const forwardedSignal = getForwardedSignal();
    if (forwardedSignal) {
      forceKillVitestProcessGroup(child);
      process.kill(process.pid, forwardedSignal);
      return;
    }
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });

  child.on("error", (error) => {
    teardown();
    console.error(error);
    process.exit(1);
  });
}

if (import.meta.main) {
  main();
}
