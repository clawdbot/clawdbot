import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const SHA_RE = /^[0-9a-f]{40}$/u;
const SAFE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@/+-]+$/u;

export type BenchmarkSide = "baseline" | "candidate";
export type BenchmarkPhase = "correctness" | "warmup" | "measured" | "cold";

export type BenchmarkLane = {
  id: string;
  critical: boolean;
  config?: string;
  files: string[];
};

export type BenchmarkThresholds = {
  overallWallRatio: number;
  criticalLaneWallRatio: number;
  criticalLaneRssRatio: number;
  coldWallRatio: number;
  improvementRatio: number;
  improvementPairCount: number;
};

export type BenchmarkManifest = {
  version: 1;
  rounds: 7;
  thresholds: BenchmarkThresholds;
  lanes: BenchmarkLane[];
};

export type BenchmarkRunPlan = {
  id: string;
  phase: BenchmarkPhase;
  side: BenchmarkSide;
  lane: BenchmarkLane;
  round: number | null;
  pair: string | null;
  cacheMode: "fresh" | "warm";
};

export type ProcessSample = {
  atMs: number;
  processCount: number;
  rssBytes: number;
};

export type BenchmarkRunRecord = {
  id: string;
  phase: BenchmarkPhase;
  side: BenchmarkSide;
  lane: string;
  round: number | null;
  pair: string | null;
  cacheMode: "fresh" | "warm";
  command: string[];
  startedAt: string;
  durationMs: number;
  userCpuMs: number;
  systemCpuMs: number;
  peakRssBytes: number;
  processSampleCount: number;
  exitCode: number | null;
  error?: string;
};

export type BenchmarkAnalysis = {
  verdict: "pass" | "regression";
  performance: "improved" | "no-material-change";
  overall: {
    measuredWallRatio: number;
    measuredRssRatio: number;
    coldWallRatio: number;
    candidateFasterPairs: number;
    measuredPairCount: number;
  };
  lanes: Array<{
    id: string;
    critical: boolean;
    measuredWallRatio: number;
    measuredRssRatio: number;
    coldWallRatio: number;
    candidateFasterPairs: number;
    measuredPairCount: number;
    regressions: string[];
  }>;
  regressions: string[];
  claim: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertFiniteRatio(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

function assertSafeRelativePath(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !SAFE_PATH_RE.test(value) ||
    path.posix.normalize(value) !== value
  ) {
    throw new Error(`${name} must be a normalized repository-relative path`);
  }
}

export function validateBenchmarkManifest(value: unknown): BenchmarkManifest {
  if (!isRecord(value) || value.version !== 1 || value.rounds !== 7) {
    throw new Error("benchmark manifest must use version 1 and exactly seven measured rounds");
  }
  if (!isRecord(value.thresholds)) {
    throw new Error("benchmark manifest thresholds are required");
  }
  const thresholds = value.thresholds as Record<string, unknown>;
  for (const name of [
    "overallWallRatio",
    "criticalLaneWallRatio",
    "criticalLaneRssRatio",
    "coldWallRatio",
    "improvementRatio",
  ]) {
    assertFiniteRatio(thresholds[name], `thresholds.${name}`);
  }
  if (
    !Number.isInteger(thresholds.improvementPairCount) ||
    Number(thresholds.improvementPairCount) < 1 ||
    Number(thresholds.improvementPairCount) > 7
  ) {
    throw new Error("thresholds.improvementPairCount must be an integer from 1 through 7");
  }
  if (!Array.isArray(value.lanes) || value.lanes.length < 4) {
    throw new Error("benchmark manifest must define at least four representative lanes");
  }
  const ids = new Set<string>();
  const lanes = value.lanes.map((entry, laneIndex) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !/^[a-z0-9-]+$/u.test(entry.id)) {
      throw new Error(`lanes[${laneIndex}].id is invalid`);
    }
    if (ids.has(entry.id)) {
      throw new Error(`duplicate benchmark lane id: ${entry.id}`);
    }
    ids.add(entry.id);
    if (entry.critical !== true && entry.critical !== false) {
      throw new Error(`lanes[${laneIndex}].critical must be boolean`);
    }
    if (entry.config !== undefined) {
      assertSafeRelativePath(entry.config, `lanes[${laneIndex}].config`);
    }
    if (!Array.isArray(entry.files) || entry.files.length === 0) {
      throw new Error(`lanes[${laneIndex}].files must be non-empty`);
    }
    const files = entry.files.map((file, fileIndex) => {
      assertSafeRelativePath(file, `lanes[${laneIndex}].files[${fileIndex}]`);
      if (!file.endsWith(".test.ts")) {
        throw new Error(`benchmark inventory entry must be a TypeScript test: ${file}`);
      }
      return file;
    });
    if (new Set(files).size !== files.length) {
      throw new Error(`benchmark lane ${entry.id} contains duplicate files`);
    }
    return {
      id: entry.id,
      critical: entry.critical,
      ...(entry.config === undefined ? {} : { config: entry.config }),
      files,
    };
  });
  return {
    version: 1,
    rounds: 7,
    thresholds: {
      overallWallRatio: thresholds.overallWallRatio as number,
      criticalLaneWallRatio: thresholds.criticalLaneWallRatio as number,
      criticalLaneRssRatio: thresholds.criticalLaneRssRatio as number,
      coldWallRatio: thresholds.coldWallRatio as number,
      improvementRatio: thresholds.improvementRatio as number,
      improvementPairCount: Number(thresholds.improvementPairCount),
    },
    lanes,
  };
}

export function loadBenchmarkManifest(file: string): BenchmarkManifest {
  return validateBenchmarkManifest(JSON.parse(readFileSync(file, "utf8")) as unknown);
}

function stableManifestValue(manifest: BenchmarkManifest) {
  return {
    version: manifest.version,
    rounds: manifest.rounds,
    thresholds: manifest.thresholds,
    lanes: manifest.lanes.map((lane) => ({
      id: lane.id,
      critical: lane.critical,
      config: lane.config ?? null,
      files: lane.files,
    })),
  };
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function benchmarkInventoryDigest(manifest: BenchmarkManifest): string {
  return sha256(JSON.stringify(stableManifestValue(manifest)));
}

export function assertInventoryAvailable(root: string, manifest: BenchmarkManifest) {
  const canonicalRoot = realpathSync(root);
  const entries: Array<{ path: string; sha256: string; bytes: number }> = [];
  const paths = new Set<string>();
  for (const lane of manifest.lanes) {
    if (lane.config) {
      paths.add(lane.config);
    }
    for (const file of lane.files) {
      paths.add(file);
    }
  }
  for (const relative of [...paths].toSorted()) {
    const absolute = path.join(canonicalRoot, relative);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      throw new Error(`benchmark inventory path is missing: ${relative}`);
    }
    const real = realpathSync(absolute);
    if (real !== canonicalRoot && !real.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new Error(`benchmark inventory path escapes its checkout: ${relative}`);
    }
    const contents = readFileSync(real);
    entries.push({ path: relative, sha256: sha256(contents), bytes: contents.byteLength });
  }
  return {
    inventorySha256: benchmarkInventoryDigest(manifest),
    entries,
  };
}

export function assertSingleWorkflowAttempt(value: string | number): void {
  if (String(value) !== "1") {
    throw new Error("vitest-pair benchmark refuses workflow reruns; dispatch a fresh run");
  }
}

export function assertExactSha(value: string, name: string): void {
  if (!SHA_RE.test(value)) {
    throw new Error(`${name} must be an exact lowercase 40-character SHA`);
  }
}

function rotated<T>(values: T[], offset: number): T[] {
  const shift = offset % values.length;
  return [...values.slice(shift), ...values.slice(0, shift)];
}

export function buildBenchmarkSchedule(manifest: BenchmarkManifest): BenchmarkRunPlan[] {
  const plans: BenchmarkRunPlan[] = [];
  for (const lane of manifest.lanes) {
    for (const side of ["baseline", "candidate"] as const) {
      plans.push({
        id: `warmup-${lane.id}-${side}`,
        phase: "warmup",
        side,
        lane,
        round: null,
        pair: null,
        cacheMode: "warm",
      });
    }
  }
  for (let round = 0; round < manifest.rounds; round += 1) {
    const sides =
      round % 2 === 0 ? (["baseline", "candidate"] as const) : (["candidate", "baseline"] as const);
    for (const lane of rotated(manifest.lanes, round)) {
      const pair = `measured-${round + 1}-${lane.id}`;
      for (const side of sides) {
        plans.push({
          id: `${pair}-${side}`,
          phase: "measured",
          side,
          lane,
          round: round + 1,
          pair,
          cacheMode: "warm",
        });
      }
    }
  }
  for (const [index, lane] of manifest.lanes.entries()) {
    const sides =
      index % 2 === 0 ? (["baseline", "candidate"] as const) : (["candidate", "baseline"] as const);
    const pair = `cold-${lane.id}`;
    for (const side of sides) {
      plans.push({
        id: `${pair}-${side}`,
        phase: "cold",
        side,
        lane,
        round: null,
        pair,
        cacheMode: "fresh",
      });
    }
  }
  return plans;
}

function median(values: number[]): number {
  if (values.length === 0) {
    throw new Error("cannot calculate a median from an empty sample");
  }
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function ratiosFor(
  records: BenchmarkRunRecord[],
  phase: "measured" | "cold",
  lane: string,
  field: "durationMs" | "peakRssBytes",
): number[] {
  const selected = records.filter((record) => record.phase === phase && record.lane === lane);
  const pairs = new Map<string, Partial<Record<BenchmarkSide, BenchmarkRunRecord>>>();
  for (const record of selected) {
    if (!record.pair || record.exitCode !== 0) {
      throw new Error(`incomplete successful ${phase} record for ${lane}`);
    }
    const pair = pairs.get(record.pair) ?? {};
    if (pair[record.side]) {
      throw new Error(`duplicate ${record.side} record for ${record.pair}`);
    }
    pair[record.side] = record;
    pairs.set(record.pair, pair);
  }
  return [...pairs.entries()].map(([pairId, pair]) => {
    if (!pair.baseline || !pair.candidate) {
      throw new Error(`benchmark pair is incomplete: ${pairId}`);
    }
    const baseline = pair.baseline[field];
    const candidate = pair.candidate[field];
    if (baseline <= 0 || candidate <= 0) {
      throw new Error(`benchmark pair has a non-positive ${field}: ${pairId}`);
    }
    return candidate / baseline;
  });
}

export function analyzeBenchmark(
  records: BenchmarkRunRecord[],
  manifest: BenchmarkManifest,
): BenchmarkAnalysis {
  const lanes = manifest.lanes.map((lane) => {
    const wallRatios = ratiosFor(records, "measured", lane.id, "durationMs");
    const rssRatios = ratiosFor(records, "measured", lane.id, "peakRssBytes");
    const coldRatios = ratiosFor(records, "cold", lane.id, "durationMs");
    if (wallRatios.length !== manifest.rounds || rssRatios.length !== manifest.rounds) {
      throw new Error(`lane ${lane.id} does not have exactly ${manifest.rounds} measured pairs`);
    }
    if (coldRatios.length !== 1) {
      throw new Error(`lane ${lane.id} does not have exactly one cold pair`);
    }
    const measuredWallRatio = median(wallRatios);
    const measuredRssRatio = median(rssRatios);
    const coldWallRatio = median(coldRatios);
    const regressions: string[] = [];
    if (lane.critical && measuredWallRatio > manifest.thresholds.criticalLaneWallRatio) {
      regressions.push(
        `${lane.id} median paired wall ratio ${measuredWallRatio.toFixed(3)} exceeds ${manifest.thresholds.criticalLaneWallRatio.toFixed(3)}`,
      );
    }
    if (lane.critical && measuredRssRatio > manifest.thresholds.criticalLaneRssRatio) {
      regressions.push(
        `${lane.id} median paired RSS ratio ${measuredRssRatio.toFixed(3)} exceeds ${manifest.thresholds.criticalLaneRssRatio.toFixed(3)}`,
      );
    }
    if (coldWallRatio > manifest.thresholds.coldWallRatio) {
      regressions.push(
        `${lane.id} cold wall ratio ${coldWallRatio.toFixed(3)} exceeds ${manifest.thresholds.coldWallRatio.toFixed(3)}`,
      );
    }
    return {
      id: lane.id,
      critical: lane.critical,
      measuredWallRatio,
      measuredRssRatio,
      coldWallRatio,
      candidateFasterPairs: wallRatios.filter((ratio) => ratio < 1).length,
      measuredPairCount: wallRatios.length,
      regressions,
    };
  });
  const allWallRatios = manifest.lanes.flatMap((lane) =>
    ratiosFor(records, "measured", lane.id, "durationMs"),
  );
  const allRssRatios = manifest.lanes.flatMap((lane) =>
    ratiosFor(records, "measured", lane.id, "peakRssBytes"),
  );
  const allColdRatios = manifest.lanes.flatMap((lane) =>
    ratiosFor(records, "cold", lane.id, "durationMs"),
  );
  const overallWallRatio = median(allWallRatios);
  const regressions = lanes.flatMap((lane) => lane.regressions);
  if (overallWallRatio > manifest.thresholds.overallWallRatio) {
    regressions.unshift(
      `overall median paired wall ratio ${overallWallRatio.toFixed(3)} exceeds ${manifest.thresholds.overallWallRatio.toFixed(3)}`,
    );
  }
  const improvedLanes = lanes.filter(
    (lane) =>
      lane.measuredWallRatio <= manifest.thresholds.improvementRatio &&
      lane.candidateFasterPairs >= manifest.thresholds.improvementPairCount,
  );
  const performance =
    regressions.length === 0 && improvedLanes.length === lanes.length
      ? "improved"
      : "no-material-change";
  return {
    verdict: regressions.length === 0 ? "pass" : "regression",
    performance,
    overall: {
      measuredWallRatio: overallWallRatio,
      measuredRssRatio: median(allRssRatios),
      coldWallRatio: median(allColdRatios),
      candidateFasterPairs: allWallRatios.filter((ratio) => ratio < 1).length,
      measuredPairCount: allWallRatios.length,
    },
    lanes,
    regressions,
    claim:
      performance === "improved"
        ? "The candidate improved every representative lane under the predetermined paired threshold."
        : "No broad improvement claim: use the per-lane paired ratios and cold evidence.",
  };
}

export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
}

export async function withTerminalManifest<T>(
  outputDir: string,
  task: () => Promise<T>,
): Promise<T> {
  const terminalPath = path.join(outputDir, "terminal-manifest.json");
  const startedAt = new Date().toISOString();
  try {
    const result = await task();
    writeJsonAtomic(terminalPath, {
      version: 1,
      status: "success",
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    return result;
  } catch (error) {
    writeJsonAtomic(terminalPath, {
      version: 1,
      status: "failure",
      startedAt,
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
