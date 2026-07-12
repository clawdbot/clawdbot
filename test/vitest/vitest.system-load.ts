// Vitest system load helper probes host load before expensive test lanes.

type EnvMap = Record<string, string | undefined>;

export type VitestProcessStats = {
  otherVitestRootCount: number;
  otherVitestWorkerCount: number;
  otherVitestCpuPercent: number;
};

const BOOLEAN_TRUE_VALUES = new Set(["1", "true"]);

function isVitestWorkerArgs(args: string): boolean {
  return args.includes("/vitest/dist/workers/") || args.includes("\\vitest\\dist\\workers\\");
}

function isVitestRootArgs(args: string): boolean {
  return (
    args.includes("node_modules/.bin/vitest") ||
    /\bvitest(?:\.(?:m?js|cmd|exe))?\b/u.test(args) ||
    args.includes("scripts/test-projects.mjs") ||
    args.includes("scripts/run-vitest.mjs")
  );
}

function normalizeCpu(rawCpu: string): number {
  const parsed = Number.parseFloat(rawCpu);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function parseVitestProcessStats(
  psOutput: string,
  selfPid: number = process.pid,
): VitestProcessStats {
  const stats: VitestProcessStats = {
    otherVitestRootCount: 0,
    otherVitestWorkerCount: 0,
    otherVitestCpuPercent: 0,
  };

  for (const line of psOutput.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const match = /^(\d+)\s+([0-9.]+)\s+(.*)$/u.exec(trimmed);
    if (!match) {
      continue;
    }

    const [, rawPid, rawCpu, args] = match;
    if (!rawPid || !rawCpu || args === undefined) {
      continue;
    }
    const pid = Number.parseInt(rawPid, 10);
    if (!Number.isFinite(pid) || pid === selfPid) {
      continue;
    }

    if (!isVitestWorkerArgs(args) && !isVitestRootArgs(args)) {
      continue;
    }

    stats.otherVitestCpuPercent += normalizeCpu(rawCpu);
    if (isVitestWorkerArgs(args)) {
      stats.otherVitestWorkerCount += 1;
    } else {
      stats.otherVitestRootCount += 1;
    }
  }

  stats.otherVitestCpuPercent = Number.parseFloat(stats.otherVitestCpuPercent.toFixed(1));
  return stats;
}

export function shouldPrintVitestThrottle(env: EnvMap = process.env): boolean {
  const normalized = env.OPENCLAW_VITEST_PRINT_SYSTEM_THROTTLE?.trim().toLowerCase();
  return normalized ? BOOLEAN_TRUE_VALUES.has(normalized) : false;
}
