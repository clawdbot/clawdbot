import { createRequire } from "node:module";
import path from "node:path";
import { spawnPnpmRunner } from "./pnpm-runner.mjs";
import {
  forwardSignalToVitestProcessGroup,
  installVitestProcessGroupCleanup,
  shouldUseDetachedVitestProcessGroup,
} from "./vitest-process-group.mjs";

const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const SUPPRESSED_VITEST_STDERR_PATTERNS = ["[PLUGIN_TIMINGS] Warning:"];
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
    env,
    detached: shouldUseDetachedVitestProcessGroup(platform),
    stdio: ["inherit", "pipe", "pipe"],
  };
}

export function shouldSuppressVitestStderrLine(line) {
  return SUPPRESSED_VITEST_STDERR_PATTERNS.some((pattern) => line.includes(pattern));
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

export function spawnWatchedVitestProcess({ pnpmArgs, spawnParams, env, label }) {
  const child = spawnPnpmRunner({
    pnpmArgs,
    ...spawnParams,
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

  const { child, teardown } = spawnWatchedVitestProcess({
    pnpmArgs: ["exec", "node", ...resolveVitestNodeArgs(env), resolveVitestCliEntry(), ...argv],
    spawnParams: resolveVitestSpawnParams(env),
    env,
    label: argv.join(" "),
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
