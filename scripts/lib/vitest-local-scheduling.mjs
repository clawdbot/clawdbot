/** @typedef {{ cpuCount?: number, loadAverage1m?: number, totalMemoryBytes?: number, freeMemoryBytes?: number }} VitestHostInfo */
/** @typedef {{ maxWorkers: number, fileParallelism: boolean, throttledBySystem: boolean }} LocalVitestScheduling */

import os from "node:os";

export const DEFAULT_LOCAL_FULL_SUITE_PARALLELISM = 4;
export const LARGE_LOCAL_FULL_SUITE_PARALLELISM = 10;
export const DEFAULT_LOCAL_FULL_SUITE_VITEST_WORKERS = 1;
export const LARGE_LOCAL_FULL_SUITE_VITEST_WORKERS = 2;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function parsePositiveInt(value) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isSystemThrottleDisabled(env) {
  const normalized = env.OPENCLAW_VITEST_DISABLE_SYSTEM_THROTTLE?.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

export function isCiLikeEnv(env = process.env) {
  return env.CI === "true" || env.GITHUB_ACTIONS === "true";
}

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
 */
export function resolveLocalVitestScheduling(
  env = process.env,
  system = detectVitestHostInfo(),
  pool = "threads",
) {
  const override = parsePositiveInt(env.OPENCLAW_VITEST_MAX_WORKERS ?? env.OPENCLAW_TEST_WORKERS);
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

export function shouldUseLargeLocalFullSuiteProfile(
  env = process.env,
  system = detectVitestHostInfo(),
) {
  if (isCiLikeEnv(env)) {
    return false;
  }
  const scheduling = resolveLocalVitestScheduling(env, system, "threads");
  return scheduling.maxWorkers >= 5 && !scheduling.throttledBySystem;
}

export function resolveLocalFullSuiteProfile(env = process.env, system = detectVitestHostInfo()) {
  if (!isSystemThrottleDisabled(env)) {
    const memoryPressureLimit = resolveMemoryPressureWorkerLimit(system);
    if (memoryPressureLimit === 1) {
      return {
        shardParallelism: 1,
        vitestMaxWorkers: 1,
      };
    }
    if (memoryPressureLimit === 2) {
      return {
        shardParallelism: 2,
        vitestMaxWorkers: 1,
      };
    }
  }

  if (shouldUseLargeLocalFullSuiteProfile(env, system)) {
    return {
      shardParallelism: LARGE_LOCAL_FULL_SUITE_PARALLELISM,
      vitestMaxWorkers: LARGE_LOCAL_FULL_SUITE_VITEST_WORKERS,
    };
  }
  return {
    shardParallelism: DEFAULT_LOCAL_FULL_SUITE_PARALLELISM,
    vitestMaxWorkers: DEFAULT_LOCAL_FULL_SUITE_VITEST_WORKERS,
  };
}
