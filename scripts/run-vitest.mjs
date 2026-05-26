import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { isUiTestTarget, isUnitUiTestTarget } from "../test/vitest/vitest.ui-paths.mjs";
import { resolveLocalVitestEnv } from "./lib/vitest-local-scheduling.mjs";
import { spawnPnpmRunner } from "./pnpm-runner.mjs";
import {
  forwardSignalToVitestProcessGroup,
  installVitestProcessGroupCleanup,
  shouldUseDetachedVitestProcessGroup,
} from "./vitest-process-group.mjs";

const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const ANSI_CSI_PREFIX = `${String.fromCharCode(27)}[`;
const ANSI_CSI_SUFFIX_RE = /^[0-?]*[ -/]*[@-~]/u;
const SUPPRESSED_VITEST_STDERR_PATTERNS = ["[PLUGIN_TIMINGS]"];
const UI_VITEST_CONFIG = "test/vitest/vitest.ui.config.ts";
const UNIT_UI_VITEST_CONFIG = "test/vitest/vitest.unit-ui.config.ts";
const EXPLICIT_TEST_FILE_RE = /\.(?:test|e2e|live)\.(?:[cm]?[jt]sx?)$/u;
const GLOB_PATTERN_CHARS_RE = /[*?[\]{}]/u;
const VITEST_OPTIONS_WITH_VALUE = new Set([
  "--attachmentsDir",
  "--bail",
  "--browser",
  "--config",
  "--configLoader",
  "-c",
  "--changed",
  "--dir",
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

function isTruthyEnvValue(value) {
  return TRUTHY_ENV_VALUES.has(value?.trim().toLowerCase() ?? "");
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveVitestNodeArgs(env = process.env) {
  if (isTruthyEnvValue(env.OPENCLAW_VITEST_ENABLE_MAGLEV)) {
    return [];
  }

  return ["--no-maglev"];
}

export function resolveVitestCliEntry() {
  const vitestPackageJson = require.resolve("vitest/package.json");
  return path.join(path.dirname(vitestPackageJson), "vitest.mjs");
}

export function resolveVitestNoOutputTimeoutMs(env = process.env) {
  return parsePositiveInt(env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS);
}

export function resolveVitestSpawnParams(env = process.env, platform = process.platform) {
  return {
    env: resolveVitestSpawnEnv(env),
    detached: shouldUseDetachedVitestProcessGroup(platform),
    stdio: ["inherit", "pipe", "pipe"],
  };
}

export function resolveVitestSpawnEnv(env = process.env) {
  const nextEnv = resolveLocalVitestEnv(env);
  if (!shouldApplyNativeWorkerBudget(nextEnv)) {
    return nextEnv;
  }

  const nativeWorkerCount = String(resolveNativeWorkerCount(nextEnv));
  return {
    ...nextEnv,
    RAYON_NUM_THREADS: nextEnv.RAYON_NUM_THREADS?.trim() || nativeWorkerCount,
    TOKIO_WORKER_THREADS: nextEnv.TOKIO_WORKER_THREADS?.trim() || nativeWorkerCount,
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

export function shouldSuppressVitestStderrLine(line) {
  const normalizedLine = line
    .split(ANSI_CSI_PREFIX)
    .map((segment, index) => (index === 0 ? segment : segment.replace(ANSI_CSI_SUFFIX_RE, "")))
    .join("");
  return SUPPRESSED_VITEST_STDERR_PATTERNS.some((pattern) => normalizedLine.includes(pattern));
}

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

function isExplicitTestFileArg(arg) {
  if (!EXPLICIT_TEST_FILE_RE.test(arg) || GLOB_PATTERN_CHARS_RE.test(arg)) {
    return false;
  }
  return (
    path.isAbsolute(arg) || arg.startsWith("./") || arg.startsWith("../") || /[/\\]/u.test(arg)
  );
}

function collectExplicitTestFileArgs(argv) {
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
    if (isExplicitTestFileArg(arg)) {
      files.push(arg);
    }
  }
  return files;
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

export function resolveMissingExplicitTestFiles(argv, cwd = process.cwd(), fsImpl = fs) {
  if (hasExplicitVitestConfigArg(argv) || hasAlternateVitestRootArg(argv)) {
    return [];
  }
  return collectExplicitTestFileArgs(argv)
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

export function resolveImplicitVitestArgs(argv, cwd = process.cwd()) {
  if (hasExplicitVitestConfigArg(argv)) {
    return argv;
  }
  const testTargets = argv
    .filter((arg) => !arg.startsWith("-") && arg.endsWith(".test.ts"))
    .map((arg) => toRepoRelativeArg(arg, cwd));
  if (testTargets.length === 0 || !testTargets.every(isUnitUiTestTarget)) {
    if (
      testTargets.length > 0 &&
      testTargets.every((target) => isUiTestTarget(target) && !isUnitUiTestTarget(target))
    ) {
      return withImplicitVitestConfig(argv, UI_VITEST_CONFIG);
    }
    return argv;
  }
  return withImplicitVitestConfig(argv, UNIT_UI_VITEST_CONFIG);
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

export function installVitestNoOutputWatchdog(params) {
  const timeoutMs = params.timeoutMs;
  if (!timeoutMs || timeoutMs <= 0) {
    return () => {};
  }

  const setTimeoutFn = params.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = params.clearTimeoutFn ?? clearTimeout;
  const forceKillAfterMs = params.forceKillAfterMs ?? 5_000;
  const streams = params.streams?.filter(Boolean) ?? [];
  const label = params.label?.trim();
  const suffix = label ? ` (${label})` : "";

  let active = true;
  let silenceTimer = null;
  let forceKillTimer = null;

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

  const resetSilenceTimer = () => {
    if (!active) {
      return;
    }
    clearSilenceTimer();
    silenceTimer = setTimeoutFn(() => {
      if (!active) {
        return;
      }
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
    for (const { stream, handler } of listeners) {
      stream.off("data", handler);
    }
  };
}

export function forwardVitestOutput(stream, target, shouldSuppressLine = () => false) {
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

export function spawnWatchedVitestProcess({
  pnpmArgs,
  spawnParams,
  env,
  label,
  onNoOutputTimeout,
}) {
  const child = spawnVitestProcess({
    pnpmArgs,
    spawnParams,
  });
  const teardownChildCleanup = installVitestProcessGroupCleanup({ child });
  const teardownNoOutputWatchdog = installVitestNoOutputWatchdog({
    streams: [child.stdout, child.stderr],
    timeoutMs: resolveVitestNoOutputTimeoutMs(env),
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
    teardown: () => {
      teardownChildCleanup();
      teardownNoOutputWatchdog();
    },
  };
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
        "[vitest] explicit test file(s) not found:",
        ...missingTestFiles.map((file) => `  - ${file}`),
      ].join("\n"),
    );
    process.exit(1);
  }

  const vitestArgs = resolveImplicitVitestArgs(argv);
  const { child, teardown } = spawnWatchedVitestProcess({
    pnpmArgs: [
      "exec",
      "node",
      ...resolveVitestNodeArgs(env),
      resolveVitestCliEntry(),
      ...vitestArgs,
    ],
    spawnParams: resolveVitestSpawnParams(env),
    env,
    label: vitestArgs.join(" "),
  });

  child.on("exit", (code, signal) => {
    teardown();
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
