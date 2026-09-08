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
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";

const SHA_RE = /^[0-9a-f]{40}$/u;
const SAFE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@/+-]+$/u;

export type BenchmarkSide = "baseline" | "candidate";
type BenchmarkPhase = "correctness" | "warmup" | "measured" | "cold";

export type BenchmarkLane = {
  id: string;
  critical: boolean;
  config?: string;
  files: string[];
};

type BenchmarkThresholds = {
  overallWallRatio: number;
  criticalLaneWallRatio: number;
  criticalLaneWallDeltaMs: number;
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

export type PackageManagerIdentity = {
  executable: string;
  resolvedExecutable: string;
  version: string;
};

type BenchmarkExecutionCounts = {
  numTotalTestSuites: number;
  numPassedTestSuites: number;
  numFailedTestSuites: number;
  numPendingTestSuites: number;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
};

export type BenchmarkExecutionSummary = {
  digest: string;
  fileCount: number;
  assertionCount: number;
  counts: BenchmarkExecutionCounts;
  success: true;
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
  packageManager: PackageManagerIdentity;
  startedAt: string;
  durationMs: number;
  userCpuMs: number;
  systemCpuMs: number;
  execution: BenchmarkExecutionSummary | null;
  exitCode: number | null;
  error?: string;
};

export type BenchmarkAnalysis = {
  verdict: "pass" | "regression";
  performance: "improved" | "no-material-change";
  overall: {
    measuredWallRatio: number;
    coldWallRatio: number;
    candidateImprovedPairs: number;
    measuredPairCount: number;
  };
  lanes: Array<{
    id: string;
    critical: boolean;
    measuredWallRatio: number;
    measuredWallDeltaMs: number;
    coldWallRatio: number;
    candidateImprovedPairs: number;
    measuredPairCount: number;
    regressions: string[];
  }>;
  regressions: string[];
  claim: string;
};

export type BenchmarkInventory = {
  inventorySha256: string;
  entries: Array<{ path: string; sha256: string; bytes: number }>;
};

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
  for (const name of ["overallWallRatio", "criticalLaneWallRatio", "improvementRatio"]) {
    assertFiniteRatio(thresholds[name], `thresholds.${name}`);
  }
  assertFiniteRatio(thresholds.criticalLaneWallDeltaMs, "thresholds.criticalLaneWallDeltaMs");
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
      criticalLaneWallDeltaMs: thresholds.criticalLaneWallDeltaMs as number,
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

const VITEST_EXECUTION_COUNT_KEYS = [
  "numTotalTestSuites",
  "numPassedTestSuites",
  "numFailedTestSuites",
  "numPendingTestSuites",
  "numTotalTests",
  "numPassedTests",
  "numFailedTests",
  "numPendingTests",
  "numTodoTests",
] as const satisfies readonly (keyof BenchmarkExecutionCounts)[];
const VITEST_ASSERTION_STATUSES = new Set(["failed", "passed", "pending", "skipped", "todo"]);

function readNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return Number(value);
}

function normalizeReportedTestPath(root: string, value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a test file path`);
  }
  const absolute = path.isAbsolute(value) ? value : path.resolve(root, value);
  const real = realpathSync(absolute);
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${name} escapes its checkout`);
  }
  const relative = path.relative(root, real).split(path.sep).join("/");
  assertSafeRelativePath(relative, name);
  return relative;
}

export function parseVitestExecutionReport(
  reportFile: string,
  checkoutRoot: string,
  lane: BenchmarkLane,
): BenchmarkExecutionSummary {
  const report = JSON.parse(readFileSync(reportFile, "utf8")) as unknown;
  if (!isRecord(report)) {
    throw new Error("Vitest JSON report must be an object");
  }
  if (report.success !== true) {
    throw new Error(`Vitest JSON report did not report success for lane ${lane.id}`);
  }

  const counts = Object.fromEntries(
    VITEST_EXECUTION_COUNT_KEYS.map((key) => [
      key,
      readNonNegativeInteger(report[key], `Vitest JSON report ${key}`),
    ]),
  ) as BenchmarkExecutionCounts;
  if (
    counts.numPassedTestSuites + counts.numFailedTestSuites + counts.numPendingTestSuites !==
    counts.numTotalTestSuites
  ) {
    throw new Error("Vitest JSON report suite counts are inconsistent");
  }
  if (
    counts.numPassedTests + counts.numFailedTests + counts.numPendingTests + counts.numTodoTests !==
    counts.numTotalTests
  ) {
    throw new Error("Vitest JSON report test counts are inconsistent");
  }
  if (counts.numFailedTestSuites !== 0 || counts.numFailedTests !== 0) {
    throw new Error(`Vitest JSON report contains failures for lane ${lane.id}`);
  }
  if (!Array.isArray(report.testResults)) {
    throw new Error("Vitest JSON report testResults must be an array");
  }

  const root = realpathSync(checkoutRoot);
  const files = report.testResults
    .map((testResult, fileIndex) => {
      if (!isRecord(testResult)) {
        throw new Error(`Vitest JSON report testResults[${String(fileIndex)}] must be an object`);
      }
      if (testResult.status !== "passed") {
        throw new Error(`Vitest JSON report file did not pass for lane ${lane.id}`);
      }
      if (!Array.isArray(testResult.assertionResults)) {
        throw new Error(
          `Vitest JSON report testResults[${String(fileIndex)}].assertionResults must be an array`,
        );
      }
      const assertions = testResult.assertionResults
        .map((assertion, assertionIndex) => {
          if (!isRecord(assertion)) {
            throw new Error(
              `Vitest JSON report assertion ${String(fileIndex)}:${String(assertionIndex)} must be an object`,
            );
          }
          if (typeof assertion.fullName !== "string" || assertion.fullName.length === 0) {
            throw new Error(
              `Vitest JSON report assertion ${String(fileIndex)}:${String(assertionIndex)} fullName is invalid`,
            );
          }
          if (
            typeof assertion.status !== "string" ||
            !VITEST_ASSERTION_STATUSES.has(assertion.status)
          ) {
            throw new Error(
              `Vitest JSON report assertion ${String(fileIndex)}:${String(assertionIndex)} status is invalid`,
            );
          }
          if (
            !isRecord(assertion.location) ||
            !Number.isSafeInteger(assertion.location.line) ||
            Number(assertion.location.line) <= 0 ||
            !Number.isSafeInteger(assertion.location.column) ||
            Number(assertion.location.column) <= 0
          ) {
            throw new Error(
              `Vitest JSON report assertion ${String(fileIndex)}:${String(assertionIndex)} location must contain positive integer line and column`,
            );
          }
          return {
            line: Number(assertion.location.line),
            column: Number(assertion.location.column),
            status: assertion.status,
          };
        })
        // test.each cases intentionally share one source location; retain every occurrence.
        .toSorted(
          (left, right) =>
            left.line - right.line ||
            left.column - right.column ||
            left.status.localeCompare(right.status),
        );
      return {
        path: normalizeReportedTestPath(
          root,
          testResult.name,
          `Vitest JSON report testResults[${String(fileIndex)}].name`,
        ),
        assertions,
      };
    })
    .toSorted((left, right) => left.path.localeCompare(right.path));
  const executedFiles = files.map((entry) => entry.path);
  if (new Set(executedFiles).size !== executedFiles.length) {
    throw new Error(`Vitest JSON report contains duplicate files for lane ${lane.id}`);
  }
  const expectedFiles = lane.files.toSorted();
  if (
    executedFiles.length !== expectedFiles.length ||
    executedFiles.some((file, index) => file !== expectedFiles[index])
  ) {
    throw new Error(
      `Vitest JSON report executed files differ for lane ${lane.id}: expected ${expectedFiles.join(", ")}, got ${executedFiles.join(", ")}`,
    );
  }
  const assertionCount = files.reduce((total, file) => total + file.assertions.length, 0);
  if (assertionCount !== counts.numTotalTests) {
    throw new Error(`Vitest JSON report assertion count differs for lane ${lane.id}`);
  }
  const canonical = {
    version: 1,
    files,
    counts,
    success: true,
  };
  return {
    digest: sha256(JSON.stringify(canonical)),
    fileCount: files.length,
    assertionCount,
    counts,
    success: true,
  };
}

export function assertExecutionDigest(
  execution: BenchmarkExecutionSummary,
  expectedDigest: string,
  label: string,
): void {
  if (execution.digest !== expectedDigest) {
    throw new Error(
      `${label} execution digest differs: expected ${expectedDigest}, got ${execution.digest}`,
    );
  }
}

function benchmarkInventoryDigest(manifest: BenchmarkManifest): string {
  return sha256(JSON.stringify(stableManifestValue(manifest)));
}

export function assertInventoryAvailable(
  root: string,
  manifest: BenchmarkManifest,
): BenchmarkInventory {
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

export function assertEquivalentInventories(
  baseline: BenchmarkInventory,
  candidate: BenchmarkInventory,
): void {
  if (baseline.inventorySha256 !== candidate.inventorySha256) {
    throw new Error("baseline and candidate benchmark manifests differ");
  }
  if (baseline.entries.length !== candidate.entries.length) {
    throw new Error("baseline and candidate benchmark inventory sizes differ");
  }
  for (const [index, baselineEntry] of baseline.entries.entries()) {
    const candidateEntry = candidate.entries[index];
    if (
      !candidateEntry ||
      baselineEntry.path !== candidateEntry.path ||
      baselineEntry.sha256 !== candidateEntry.sha256 ||
      baselineEntry.bytes !== candidateEntry.bytes
    ) {
      throw new Error(
        `baseline and candidate benchmark workload bytes differ at ${baselineEntry.path}`,
      );
    }
  }
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

type PairedMeasurement = {
  lane: string;
  round: number | null;
  baselineDurationMs: number;
  candidateDurationMs: number;
  ratio: number;
  deltaMs: number;
};

function pairedMeasurementsFor(
  records: BenchmarkRunRecord[],
  phase: "measured" | "cold",
  lane: string,
): PairedMeasurement[] {
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
    if (pair.baseline.round !== pair.candidate.round) {
      throw new Error(`benchmark pair has mismatched rounds: ${pairId}`);
    }
    const round = pair.baseline.round;
    if (
      (phase === "measured" && (!Number.isInteger(round) || round === null || round < 1)) ||
      (phase === "cold" && round !== null)
    ) {
      throw new Error(`benchmark pair has an invalid ${phase} round: ${pairId}`);
    }
    const baselineDurationMs = pair.baseline.durationMs;
    const candidateDurationMs = pair.candidate.durationMs;
    if (baselineDurationMs <= 0 || candidateDurationMs <= 0) {
      throw new Error(`benchmark pair has a non-positive duration: ${pairId}`);
    }
    return {
      lane,
      round,
      baselineDurationMs,
      candidateDurationMs,
      ratio: candidateDurationMs / baselineDurationMs,
      deltaMs: candidateDurationMs - baselineDurationMs,
    };
  });
}

function aggregateRatio(measurements: PairedMeasurement[]): number {
  const baselineDurationMs = measurements.reduce(
    (total, measurement) => total + measurement.baselineDurationMs,
    0,
  );
  const candidateDurationMs = measurements.reduce(
    (total, measurement) => total + measurement.candidateDurationMs,
    0,
  );
  return candidateDurationMs / baselineDurationMs;
}

function measuredAggregateRatios(
  measurements: PairedMeasurement[],
  manifest: BenchmarkManifest,
): number[] {
  const expectedLanes = manifest.lanes.map((lane) => lane.id).toSorted();
  const byRound = new Map<number, PairedMeasurement[]>();
  for (const measurement of measurements) {
    if (measurement.round === null || measurement.round > manifest.rounds) {
      throw new Error(`benchmark measurement has an invalid round for ${measurement.lane}`);
    }
    const round = byRound.get(measurement.round) ?? [];
    round.push(measurement);
    byRound.set(measurement.round, round);
  }
  return Array.from({ length: manifest.rounds }, (_, index) => index + 1).map((round) => {
    const roundMeasurements = byRound.get(round) ?? [];
    const lanes = roundMeasurements.map((measurement) => measurement.lane).toSorted();
    if (
      lanes.length !== expectedLanes.length ||
      lanes.some((lane, laneIndex) => lane !== expectedLanes[laneIndex])
    ) {
      throw new Error(`benchmark round ${round} does not contain every lane exactly once`);
    }
    return aggregateRatio(roundMeasurements);
  });
}

export function analyzeBenchmark(
  records: BenchmarkRunRecord[],
  manifest: BenchmarkManifest,
): BenchmarkAnalysis {
  const measuredMeasurements: PairedMeasurement[] = [];
  const coldMeasurements: PairedMeasurement[] = [];
  const lanes = manifest.lanes.map((lane) => {
    const measured = pairedMeasurementsFor(records, "measured", lane.id);
    const cold = pairedMeasurementsFor(records, "cold", lane.id);
    if (measured.length !== manifest.rounds) {
      throw new Error(`lane ${lane.id} does not have exactly ${manifest.rounds} measured pairs`);
    }
    if (cold.length !== 1) {
      throw new Error(`lane ${lane.id} does not have exactly one cold pair`);
    }
    measuredMeasurements.push(...measured);
    coldMeasurements.push(...cold);
    const wallRatios = measured.map((measurement) => measurement.ratio);
    const measuredWallRatio = median(wallRatios);
    const measuredWallDeltaMs = median(measured.map((measurement) => measurement.deltaMs));
    const coldWallRatio = cold[0]!.ratio;
    const regressions: string[] = [];
    if (
      lane.critical &&
      measuredWallRatio > manifest.thresholds.criticalLaneWallRatio &&
      measuredWallDeltaMs >= manifest.thresholds.criticalLaneWallDeltaMs
    ) {
      regressions.push(
        `${lane.id} median paired wall ratio ${measuredWallRatio.toFixed(3)} exceeds ${manifest.thresholds.criticalLaneWallRatio.toFixed(3)} with ${measuredWallDeltaMs.toFixed(0)}ms median delta`,
      );
    }
    return {
      id: lane.id,
      critical: lane.critical,
      measuredWallRatio,
      measuredWallDeltaMs,
      coldWallRatio,
      candidateImprovedPairs: wallRatios.filter(
        (ratio) => ratio <= manifest.thresholds.improvementRatio,
      ).length,
      measuredPairCount: wallRatios.length,
      regressions,
    };
  });
  const allWallRatios = measuredMeasurements.map((measurement) => measurement.ratio);
  const overallWallRatio = median(measuredAggregateRatios(measuredMeasurements, manifest));
  const regressions = lanes.flatMap((lane) => lane.regressions);
  if (overallWallRatio > manifest.thresholds.overallWallRatio) {
    regressions.unshift(
      `overall median duration-weighted paired wall ratio ${overallWallRatio.toFixed(3)} exceeds ${manifest.thresholds.overallWallRatio.toFixed(3)}`,
    );
  }
  const improvedLanes = lanes.filter(
    (lane) =>
      lane.measuredWallRatio <= manifest.thresholds.improvementRatio &&
      lane.candidateImprovedPairs >= manifest.thresholds.improvementPairCount,
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
      coldWallRatio: aggregateRatio(coldMeasurements),
      candidateImprovedPairs: allWallRatios.filter(
        (ratio) => ratio <= manifest.thresholds.improvementRatio,
      ).length,
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
