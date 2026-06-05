// Vitest system load helper probes host load before expensive test lanes.
import { spawnSync } from "node:child_process";

type EnvMap = Record<string, string | undefined>;

export type VitestProcessStats = {
  otherVitestRootCount: number;
  otherVitestWorkerCount: number;
  otherVitestCpuPercent: number;
};

type PsResult = {
  status: number | null;
  stdout: string;
};

type DetectVitestProcessStatsOptions = {
  platform?: NodeJS.Platform;
  selfPid?: number;
  runPs?: () => PsResult;
};

const EMPTY_VITEST_PROCESS_STATS: VitestProcessStats = {
  otherVitestRootCount: 0,
  otherVitestWorkerCount: 0,
  otherVitestCpuPercent: 0,
};

const BOOLEAN_TRUE_VALUES = new Set(["1", "true"]);

function isExplicitlyEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized ? BOOLEAN_TRUE_VALUES.has(normalized) : false;
}

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
  const stats = { ...EMPTY_VITEST_PROCESS_STATS };

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

export function detectVitestProcessStats(
  env: EnvMap = process.env,
  options: DetectVitestProcessStatsOptions = {},
): VitestProcessStats {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return { ...EMPTY_VITEST_PROCESS_STATS };
  }

  if (isExplicitlyEnabled(env.OPENCLAW_VITEST_DISABLE_SYSTEM_THROTTLE)) {
    return { ...EMPTY_VITEST_PROCESS_STATS };
  }

  const result =
    options.runPs?.() ??
    spawnSync("ps", ["-xao", "pid=,pcpu=,args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

  if (result.status === 0 && typeof result.stdout === "string" && result.stdout.length > 0) {
    return parseVitestProcessStats(result.stdout, options.selfPid ?? process.pid);
  }

  return { ...EMPTY_VITEST_PROCESS_STATS };
}

export function shouldPrintVitestThrottle(env: EnvMap = process.env): boolean {
  const normalized = env.OPENCLAW_VITEST_PRINT_SYSTEM_THROTTLE?.trim().toLowerCase();
  return normalized ? BOOLEAN_TRUE_VALUES.has(normalized) : false;
}
