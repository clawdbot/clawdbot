// Vitest child-process environment and native worker budget policy.
import path from "node:path";
import { embeddedAgentVitestProjectOwners } from "../../test/vitest/vitest.agents-paths.mjs";
import { parsePermissiveBooleanToken } from "./arg-utils.mts";
import { resolveExplicitVitestMode } from "./vitest-cli-mode.mts";
import { resolveLocalVitestEnv } from "./vitest-local-scheduling.mts";

function parsePositiveInt(value: string | undefined): number | null {
  const text = value?.trim();
  if (!text || !/^\d+$/u.test(text)) {
    return null;
  }
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveExplicitVitestWorkerBudget(env: NodeJS.ProcessEnv): number | null {
  return parsePositiveInt(env.OPENCLAW_VITEST_MAX_WORKERS ?? env.OPENCLAW_TEST_WORKERS);
}

function shouldApplyNativeWorkerBudget(env: NodeJS.ProcessEnv): boolean {
  if (env.RAYON_NUM_THREADS?.trim() && env.TOKIO_WORKER_THREADS?.trim()) {
    return false;
  }
  return (
    env.OPENCLAW_TEST_PROJECTS_SERIAL === "1" || resolveExplicitVitestWorkerBudget(env) !== null
  );
}

function resolveNativeWorkerCount(env: NodeJS.ProcessEnv): number {
  return Math.min(resolveExplicitVitestWorkerBudget(env) ?? 1, 4);
}

/** Applies local Vitest scheduling and native worker budget env. */
export function resolveVitestProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
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

/** Default watchdog timeout for Vitest runs that stop producing output. */
const DEFAULT_VITEST_NO_OUTPUT_TIMEOUT_MS = 120_000;
/** Default heartbeat interval while waiting on silent Vitest output. */
export const DEFAULT_VITEST_NO_OUTPUT_HEARTBEAT_MS = 30_000;
/** Longer watchdog timeout for known long-running Vitest configs. */
export const DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS = 300_000;
/** Extra-long watchdog timeout for broad configs that can stay silent on macOS. */
export const DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS = 2_400_000;
const VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY = "OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS";
const VITEST_NO_OUTPUT_HEARTBEAT_ENV_KEY = "OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS";
const GATEWAY_VITEST_CONFIG = "test/vitest/vitest.gateway.config.ts";
export const VITEST_CONFIG_NO_OUTPUT_TIMEOUT_MS = new Map([
  ["test/vitest/vitest.e2e.config.ts", DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS],
  ["test/vitest/vitest.tui-pty.config.ts", DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS],
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
  // Largest extension shard: silent transform/import startup was measured at
  // ~210s on a loaded macOS host, so the 120s default kills healthy runs (#123025).
  [
    "test/vitest/vitest.extension-discord.config.ts",
    DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS,
  ],
  // Codex extension shard: 168 serial files run ~6min total with silent
  // stretches beyond 300s under the default reporter (measured 61s import +
  // 293s testing while the worker burned ~95% CPU); the 300s CI window kills
  // healthy runs and flips with incidental flake output (#125825).
  [
    "test/vitest/vitest.extension-codex.config.ts",
    DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS,
  ],
  [
    "test/vitest/vitest.gateway-core.config.ts",
    DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS,
  ],
  [
    "test/vitest/vitest.gateway-server.config.ts",
    DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS,
  ],
]);
for (const owner of embeddedAgentVitestProjectOwners) {
  VITEST_CONFIG_NO_OUTPUT_TIMEOUT_MS.set(
    owner.config,
    DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS,
  );
}
/**
 * Resolves default Node flags for Vitest, including the local Maglev opt-in.
 */
export function resolveVitestNodeArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  if (parsePermissiveBooleanToken(env.OPENCLAW_VITEST_ENABLE_MAGLEV) === true) {
    return [];
  }

  return ["--no-maglev"];
}

/**
 * Reads the explicit no-output watchdog timeout, if configured.
 */
export function resolveVitestNoOutputTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  return parsePositiveInt(env[VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY]);
}

/**
 * Reads the explicit no-output heartbeat interval, if configured.
 */
export function resolveVitestNoOutputHeartbeatMs(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  return parsePositiveInt(env[VITEST_NO_OUTPUT_HEARTBEAT_ENV_KEY]);
}

export function resolveVitestCompileCacheSafeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!env.NODE_COMPILE_CACHE && !env.NODE_COMPILE_CACHE_PORTABLE) {
    return env;
  }
  // Coverage can be enabled inside a dynamic Vitest config, which this wrapper
  // cannot know before spawning. Keep the cache for orchestration/build tools,
  // but never let a Vitest child deserialize bytecode into V8 coverage.
  const spawnEnv: NodeJS.ProcessEnv = { ...env, NODE_DISABLE_COMPILE_CACHE: "1" };
  delete spawnEnv.NODE_COMPILE_CACHE;
  delete spawnEnv.NODE_COMPILE_CACHE_PORTABLE;
  return spawnEnv;
}

/**
 * Adds default watchdog env for non-watch Vitest runs.
 */
export function resolveRunVitestSpawnEnv(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = [],
): NodeJS.ProcessEnv {
  const baseEnv = resolveVitestCompileCacheSafeEnv(env);
  const explicitMode = resolveExplicitVitestMode(argv);
  if (explicitMode === "watch") {
    return baseEnv;
  }
  if (explicitMode !== "run" && parsePermissiveBooleanToken(baseEnv.CI) !== true) {
    return baseEnv;
  }
  const defaultTimeoutMs = resolveDefaultVitestNoOutputTimeoutMs(argv);
  const hasTimeout = Object.hasOwn(baseEnv, VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY);
  const envTimeoutMs = hasTimeout
    ? parsePositiveInt(baseEnv[VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY])
    : null;
  // Per-config entries in VITEST_CONFIG_NO_OUTPUT_TIMEOUT_MS are measured
  // silence floors for healthy lanes; a global env value (CI sets one for
  // every shard) may widen a mapped lane's window but must not shrink it
  // below its floor, or the watchdog kills legitimately quiet runs
  // (#125825). Unmapped configs keep the env value verbatim.
  const configArg = resolveVitestConfigArg(argv);
  const configFloorMs = configArg === null ? null : resolveVitestConfigNoOutputTimeoutMs(configArg);
  // An explicitly disabled or unparsable env value (e.g. "0") stays verbatim.
  const timeoutMs = hasTimeout
    ? envTimeoutMs === null || configFloorMs === null
      ? envTimeoutMs
      : Math.max(envTimeoutMs, configFloorMs)
    : defaultTimeoutMs;
  const hasHeartbeat = Object.hasOwn(baseEnv, VITEST_NO_OUTPUT_HEARTBEAT_ENV_KEY);
  return {
    ...baseEnv,
    ...(timeoutMs !== null && timeoutMs !== envTimeoutMs
      ? { [VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY]: String(timeoutMs) }
      : {}),
    ...(!hasHeartbeat && timeoutMs !== null && DEFAULT_VITEST_NO_OUTPUT_HEARTBEAT_MS < timeoutMs
      ? { [VITEST_NO_OUTPUT_HEARTBEAT_ENV_KEY]: String(DEFAULT_VITEST_NO_OUTPUT_HEARTBEAT_MS) }
      : {}),
  };
}

/**
 * Chooses the default watchdog timeout from the selected Vitest config.
 */
export function resolveDefaultVitestNoOutputTimeoutMs(argv: string[] = []): number {
  const config = resolveVitestConfigArg(argv);
  return config === null
    ? DEFAULT_VITEST_NO_OUTPUT_TIMEOUT_MS
    : (resolveVitestConfigNoOutputTimeoutMs(config) ?? DEFAULT_VITEST_NO_OUTPUT_TIMEOUT_MS);
}

export function resolveVitestConfigArg(argv: string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (arg === "--") {
      return null;
    }
    for (const option of ["--config", "-c"]) {
      // Native empty-inline values own the next token; missing values stay with the child.
      if (arg === option || arg === `${option}=`) {
        return argv[index + 1] ?? null;
      }
      if (arg.startsWith(`${option}=`)) {
        return arg.slice(option.length + 1);
      }
    }
  }
  return null;
}

function resolveVitestConfigNoOutputTimeoutMs(config: string): number | null {
  const normalized = normalizeVitestConfigPath(config);
  for (const [candidate, timeoutMs] of VITEST_CONFIG_NO_OUTPUT_TIMEOUT_MS) {
    if (matchesVitestConfigPath(normalized, candidate)) {
      return timeoutMs;
    }
  }
  return null;
}

export function normalizeVitestConfigPath(config: string): string {
  return path.normalize(config).replaceAll(path.sep, "/").replace(/^\.\//u, "");
}

export function matchesVitestConfigPath(normalized: string, candidate: string): boolean {
  return normalized === candidate || normalized.endsWith("/" + candidate);
}
