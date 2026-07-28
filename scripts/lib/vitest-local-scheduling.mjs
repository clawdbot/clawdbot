/** @typedef {{ cpuCount?: number, loadAverage1m?: number, totalMemoryBytes?: number, freeMemoryBytes?: number }} VitestHostInfo */
/** @typedef {{ maxWorkers: number, fileParallelism: boolean, throttledBySystem: boolean }} LocalVitestScheduling */

import os from "node:os";

const MAX_LOCAL_FULL_SUITE_PARALLELISM = 10;
const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function parsePositiveInt(value, label) {
  const text = value?.trim();
  if (!text) {
    return null;
  }
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${label} must be a positive integer; got: ${value}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer; got: ${value}`);
  }
  return parsed;
}

function isSystemThrottleDisabled(env) {
  const normalized = env.OPENCLAW_VITEST_DISABLE_SYSTEM_THROTTLE?.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

function isTruthyEnvValue(value) {
  return TRUTHY_ENV_VALUES.has(value?.trim().toLowerCase() ?? "");
}

/** @internal Shared repository-script contract. */
export function isCiLikeEnv(env = process.env) {
  return isTruthyEnvValue(env.CI) || isTruthyEnvValue(env.GITHUB_ACTIONS);
}

/** @internal Shared repository-script contract. */
export function resolveLocalVitestEnv(env = process.env) {
  const normalizedLocalCheck = env.OPENCLAW_LOCAL_CHECK?.trim().toLowerCase();
  if (isCiLikeEnv(env) || (normalizedLocalCheck !== "0" && normalizedLocalCheck !== "false")) {
    return env;
  }

  return {
    ...env,
    OPENCLAW_LOCAL_CHECK: "1",
  };
}

/** @internal Directly tested script implementation detail. */
export function detectVitestHostInfo() {
  return {
    cpuCount:
      typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length,
    loadAverage1m: os.loadavg()[0] ?? 0,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
  };
}

function resolveMemoryPressureWorkerLimit(system) {
  const freeMemoryGb = (system.freeMemoryBytes ?? 0) / 1024 ** 3;
  if (!Number.isFinite(freeMemoryGb) || freeMemoryGb <= 0) {
    return null;
  }
  if (freeMemoryGb <= 4) {
    return 1;
  }
  if (freeMemoryGb <= 8) {
    return 2;
  }
  return null;
}

/** @internal Shared repository-script contract. */
export function resolveLocalVitestMaxWorkers(
  env = process.env,
  system = detectVitestHostInfo(),
  pool = "threads",
) {
  return resolveLocalVitestScheduling(env, system, pool).maxWorkers;
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {VitestHostInfo} system
 * @param {"forks" | "threads"} pool
 * @returns {LocalVitestScheduling}
 * @internal Shared repository-script contract.
 */
export function resolveLocalVitestScheduling(
  env = process.env,
  system = detectVitestHostInfo(),
  pool = "threads",
) {
  const override = parsePositiveInt(
    env.OPENCLAW_VITEST_MAX_WORKERS ?? env.OPENCLAW_TEST_WORKERS,
    env.OPENCLAW_VITEST_MAX_WORKERS === undefined
      ? "OPENCLAW_TEST_WORKERS"
      : "OPENCLAW_VITEST_MAX_WORKERS",
  );
  if (override !== null) {
    const maxWorkers = clamp(override, 1, 16);
    return {
      maxWorkers,
      fileParallelism: maxWorkers > 1,
      throttledBySystem: false,
    };
  }

  const cpuCount = Math.max(1, system.cpuCount ?? 1);
  const loadAverage1m = Math.max(0, system.loadAverage1m ?? 0);
  const totalMemoryGb = (system.totalMemoryBytes ?? 0) / 1024 ** 3;

  let inferred =
    cpuCount <= 2
      ? 1
      : cpuCount <= 4
        ? 2
        : cpuCount <= 8
          ? 4
          : Math.max(1, Math.floor(cpuCount * 0.75));

  if (totalMemoryGb <= 16) {
    inferred = Math.min(inferred, 2);
  } else if (totalMemoryGb <= 32) {
    inferred = Math.min(inferred, 4);
  } else if (totalMemoryGb <= 64) {
    inferred = Math.min(inferred, 6);
  } else if (totalMemoryGb <= 128) {
    inferred = Math.min(inferred, 8);
  } else if (totalMemoryGb <= 256) {
    inferred = Math.min(inferred, 12);
  } else {
    inferred = Math.min(inferred, 16);
  }

  const loadRatio = loadAverage1m > 0 ? loadAverage1m / cpuCount : 0;
  if (loadRatio >= 1) {
    inferred = Math.max(1, Math.floor(inferred / 2));
  } else if (loadRatio >= 0.75) {
    inferred = Math.max(1, inferred - 2);
  } else if (loadRatio >= 0.5) {
    inferred = Math.max(1, inferred - 1);
  }

  if (pool === "forks") {
    inferred = Math.min(inferred, 8);
  }

  inferred = clamp(inferred, 1, 16);

  if (isSystemThrottleDisabled(env)) {
    return {
      maxWorkers: inferred,
      fileParallelism: true,
      throttledBySystem: false,
    };
  }

  const memoryPressureLimit = resolveMemoryPressureWorkerLimit(system);
  if (memoryPressureLimit !== null && inferred > memoryPressureLimit) {
    const maxWorkers = memoryPressureLimit;
    return {
      maxWorkers,
      fileParallelism: maxWorkers > 1,
      throttledBySystem: true,
    };
  }

  if (loadRatio >= 1) {
    const maxWorkers = Math.max(1, Math.floor(inferred / 2));
    return {
      maxWorkers,
      fileParallelism: maxWorkers > 1,
      throttledBySystem: maxWorkers < inferred,
    };
  }

  if (loadRatio >= 0.75) {
    const maxWorkers = Math.max(2, Math.ceil(inferred * 0.75));
    return {
      maxWorkers,
      fileParallelism: true,
      throttledBySystem: maxWorkers < inferred,
    };
  }

  return {
    maxWorkers: inferred,
    fileParallelism: true,
    throttledBySystem: false,
  };
}

/** @internal Shared repository-script contract. */
export function resolveLocalFullSuiteProfile(env = process.env, system = detectVitestHostInfo()) {
  const scheduling = resolveLocalVitestScheduling(env, system, "threads");
  return {
    // Each shard is a separate Vitest process with its own module graph. Spend the
    // host worker budget once across shards instead of multiplying it inside them.
    shardParallelism: Math.min(scheduling.maxWorkers, MAX_LOCAL_FULL_SUITE_PARALLELISM),
    vitestMaxWorkers: 1,
  };
}
