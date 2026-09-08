import os from "node:os";
import { parsePermissiveBooleanToken } from "./arg-utils.mts";
export type VitestHostInfo = {
  cpuCount?: number;
  loadAverage1m?: number;
  totalMemoryBytes?: number;
  freeMemoryBytes?: number;
};
export type LocalVitestScheduling = {
  maxWorkers: number;
  fileParallelism: boolean;
  throttledBySystem: boolean;
};

const MAX_LOCAL_FULL_SUITE_PARALLELISM = 10;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function parsePositiveInt(value: string | undefined, label: string) {
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

function isSystemThrottleDisabled(env: Record<string, string | undefined>) {
  const normalized = env.OPENCLAW_VITEST_DISABLE_SYSTEM_THROTTLE?.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

/** @internal Shared repository-script contract. */
export function isCiLikeEnv(env: Record<string, string | undefined> = process.env) {
  return (
    parsePermissiveBooleanToken(env.CI) === true ||
    parsePermissiveBooleanToken(env.GITHUB_ACTIONS) === true
  );
}

/** @internal Shared repository-script contract. */
export function resolveLocalVitestEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
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

// Vite bundles each project config on its own, so a module-level cache would be
// per-project. The snapshot must live on globalThis to span every bundle in a process.
const SCHEDULING_HOST_INFO = Symbol.for("openclaw.vitestSchedulingHostInfo");

/**
 * Worker sizing reads the 1m load average, so re-detecting per Vitest project lets two
 * projects resolve different maxWorkers. Vitest rejects a run whose projects share
 * sequence.groupOrder but disagree on maxWorkers, and the selection then collects zero
 * tests. Size every project in a process against one snapshot; live readings stay on
 * detectVitestHostInfo for the resource reporter.
 */
function schedulingHostInfo(): ReturnType<typeof detectVitestHostInfo> {
  const store = globalThis as Record<PropertyKey, unknown>;
  if (!Object.hasOwn(store, SCHEDULING_HOST_INFO)) {
    store[SCHEDULING_HOST_INFO] = detectVitestHostInfo();
  }
  return store[SCHEDULING_HOST_INFO] as ReturnType<typeof detectVitestHostInfo>;
}

function resolveMemoryPressureWorkerLimit(system: VitestHostInfo) {
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

/**
 * @internal Shared repository-script contract.
 */
export function resolveLocalVitestScheduling(
  env: Record<string, string | undefined> = process.env,
  system: VitestHostInfo = schedulingHostInfo(),
  pool: "forks" | "threads" = "threads",
): LocalVitestScheduling {
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
export function resolveLocalFullSuiteProfile(
  env: Record<string, string | undefined> = process.env,
  system: VitestHostInfo = schedulingHostInfo(),
) {
  const scheduling = resolveLocalVitestScheduling(env, system, "threads");
  return {
    // Each shard is a separate Vitest process with its own module graph. Spend the
    // host worker budget once across shards instead of multiplying it inside them.
    shardParallelism: Math.min(scheduling.maxWorkers, MAX_LOCAL_FULL_SUITE_PARALLELISM),
    vitestMaxWorkers: 1,
  };
}
