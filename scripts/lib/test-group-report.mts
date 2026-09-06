// Builds grouped Vitest timing reports and comparisons for CI/test analysis.
import path from "node:path";
import {
  collectVitestAssertionDurations,
  collectVitestFileDurations,
  normalizeTrackedRepoPath,
} from "../test-report-utils.mts";
import { formatMs } from "./vitest-report-cli-utils.mts";

type GroupedCounter = {
  configs: string[];
  durationMs: number;
  fileCount: number;
  key: string;
  testCount: number;
};

type GroupedFile = {
  config: string;
  durationMs: number;
  file: string;
  group: string;
  testCount: number;
};

type NumericCounter = {
  durationMs: number;
  fileCount: number;
  testCount: number;
};

type CounterAccumulator = NumericCounter & {
  configs: Set<string>;
  key: string;
};

type ComparableCounter = Partial<NumericCounter> & { key: string };

type ComparableFile = Partial<Pick<GroupedFile, "durationMs" | "testCount">> &
  Pick<GroupedFile, "config" | "file" | "group">;

type FileSnapshot = Pick<NumericCounter, "durationMs" | "testCount">;

type ComparableRun = {
  config: string;
  elapsedMs?: number;
  label?: string;
  maxRssBytes?: number;
  status?: number;
};

type RunSnapshot = {
  elapsedMs: number | null;
  maxRssBytes: number | null;
  status: number | null;
};

type SlowTestEntry = {
  config: string;
  durationMs: number;
  file: string;
  fullName: string;
  status: string;
};

type ComparisonStatus = "added" | "changed" | "removed";

type GroupedTestReportInput = {
  configs?: ComparableCounter[];
  groupBy?: string;
  groups?: ComparableCounter[];
  runs?: ComparableRun[];
  topFiles?: ComparableFile[];
  totals?: Partial<NumericCounter>;
};

/**
 * Formats byte counts as megabytes, preserving missing RSS values as `n/a`.
 */
export function formatBytesAsMb(valueBytes: number | null | undefined): string {
  return valueBytes === null || valueBytes === undefined
    ? "n/a"
    : `${(valueBytes / 1024 / 1024).toFixed(1)}MB`;
}

function formatSignedMs(value: number, digits = 1): string {
  return `${value > 0 ? "+" : ""}${formatMs(value, digits)}`;
}

function formatSignedBytesAsMb(valueBytes: number): string {
  return `${valueBytes > 0 ? "+" : ""}${formatBytesAsMb(valueBytes)}`;
}

/**
 * Shortens a Vitest config path into the label used by timing reports.
 */
export function normalizeConfigLabel(config: string): string {
  return config.replace(/^test\/vitest\/vitest\./u, "").replace(/\.config\.ts$/u, "");
}

/**
 * Derives a top-level test area from a repo-relative file path.
 */
export function resolveTestArea(file: string): string {
  const normalized = normalizeTrackedRepoPath(file);
  const parts = normalized.split("/");
  if (parts[0] === "extensions" && parts[1]) {
    return `extensions/${parts[1]}`;
  }
  if (parts[0] === "src" && parts[1]) {
    return `src/${parts[1]}`;
  }
  if (parts[0] === "packages" && parts[1]) {
    return `packages/${parts[1]}`;
  }
  if (parts[0] === "apps" && parts[1]) {
    return `apps/${parts[1]}`;
  }
  if (parts[0] === "ui") {
    return parts[3] ? `ui/${parts[3]}` : "ui";
  }
  if (parts[0] === "test" && parts[1]) {
    return `test/${parts[1]}`;
  }
  return parts[0] || normalized;
}

function resolveTestFolder(file: string, depth = 2): string {
  const normalized = normalizeTrackedRepoPath(file);
  const dir = path.posix.dirname(normalized);
  if (dir === ".") {
    return normalized;
  }
  return dir.split("/").slice(0, Math.max(1, depth)).join("/");
}

/**
 * Derives the grouping key for area, folder, or top-level reports.
 */
export function resolveGroupKey(file: string, mode = "area"): string {
  if (mode === "folder") {
    return resolveTestFolder(file, 3);
  }
  if (mode === "top") {
    return normalizeTrackedRepoPath(file).split("/")[0] || file;
  }
  return resolveTestArea(file);
}

function createCounter(key: string): CounterAccumulator {
  return {
    key,
    durationMs: 0,
    fileCount: 0,
    testCount: 0,
    configs: new Set<string>(),
  };
}

function addFileEntry(
  target: CounterAccumulator,
  entry: ReturnType<typeof collectVitestFileDurations>[number],
  config: string,
): void {
  target.durationMs += entry.durationMs;
  target.fileCount += 1;
  target.testCount += entry.testCount;
  target.configs.add(config);
}

function finalizeCounter(counter: CounterAccumulator): GroupedCounter {
  return {
    key: counter.key,
    durationMs: counter.durationMs,
    fileCount: counter.fileCount,
    testCount: counter.testCount,
    configs: [...counter.configs].toSorted((left, right) => left.localeCompare(right)),
  };
}

/**
 * Aggregates Vitest report files into grouped timing counters and slow tests.
 */
export function buildGroupedTestReport(params: {
  groupBy: string;
  maxTestMs?: number;
  reports: Array<{ config: string; report: unknown }>;
}) {
  const byGroup = new Map<string, CounterAccumulator>();
  const byConfig = new Map<string, CounterAccumulator>();
  const files: GroupedFile[] = [];
  const maxTestMs = params.maxTestMs ?? null;
  const slowTests: SlowTestEntry[] = [];

  for (const input of params.reports) {
    const config = normalizeConfigLabel(input.config);
    const fileEntries = collectVitestFileDurations(input.report, normalizeTrackedRepoPath);
    const configCounter = byConfig.get(config) ?? createCounter(config);
    byConfig.set(config, configCounter);

    for (const entry of fileEntries) {
      const groupKey = resolveGroupKey(entry.file, params.groupBy);
      const groupCounter = byGroup.get(groupKey) ?? createCounter(groupKey);
      byGroup.set(groupKey, groupCounter);
      addFileEntry(groupCounter, entry, config);
      addFileEntry(configCounter, entry, config);
      files.push({ ...entry, config, group: groupKey });
    }

    if (typeof maxTestMs === "number") {
      const assertions = collectVitestAssertionDurations(input.report, normalizeTrackedRepoPath);
      for (const entry of assertions) {
        if (entry.durationMs > maxTestMs) {
          slowTests.push({ ...entry, config });
        }
      }
    }
  }

  const sortByDuration = (left: GroupedCounter, right: GroupedCounter) =>
    right.durationMs - left.durationMs || left.key.localeCompare(right.key);
  const sortFilesByDuration = (left: GroupedFile, right: GroupedFile) =>
    right.durationMs - left.durationMs || left.file.localeCompare(right.file);

  const groups = [...byGroup.values()].map(finalizeCounter).toSorted(sortByDuration);
  const configs = [...byConfig.values()].map(finalizeCounter).toSorted(sortByDuration);
  const topFiles = files.toSorted(sortFilesByDuration);
  slowTests.sort(
    (left, right) =>
      right.durationMs - left.durationMs ||
      left.file.localeCompare(right.file) ||
      left.fullName.localeCompare(right.fullName),
  );
  const totals = groups.reduce(
    (acc, group) => ({
      durationMs: acc.durationMs + group.durationMs,
      fileCount: acc.fileCount + group.fileCount,
      testCount: acc.testCount + group.testCount,
    }),
    { durationMs: 0, fileCount: 0, testCount: 0 },
  );

  return {
    generatedAt: new Date().toISOString(),
    groupBy: params.groupBy,
    totals,
    groups,
    configs,
    topFiles,
    slowTests,
  };
}

type GroupedTestReport = ReturnType<typeof buildGroupedTestReport>;

function percentDelta(beforeValue: number, afterValue: number): number | null {
  if (beforeValue === 0) {
    return afterValue === 0 ? 0 : null;
  }
  return ((afterValue - beforeValue) / beforeValue) * 100;
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "new";
  }
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function normalizeCounter(item?: Partial<NumericCounter>): NumericCounter {
  return {
    durationMs: item?.durationMs ?? 0,
    fileCount: item?.fileCount ?? 0,
    testCount: item?.testCount ?? 0,
  };
}

function compareStatus(beforeItem: unknown, afterItem: unknown): ComparisonStatus {
  if (beforeItem && afterItem) {
    return "changed";
  }
  return beforeItem ? "removed" : "added";
}

function compareCounters(
  beforeItems: ComparableCounter[] = [],
  afterItems: ComparableCounter[] = [],
) {
  const beforeByKey = new Map(beforeItems.map((item) => [item.key, item]));
  const afterByKey = new Map(afterItems.map((item) => [item.key, item]));
  const keys = new Set([...beforeByKey.keys(), ...afterByKey.keys()]);

  return [...keys]
    .map((key) => {
      const beforeItem = beforeByKey.get(key);
      const afterItem = afterByKey.get(key);
      const before = normalizeCounter(beforeItem);
      const after = normalizeCounter(afterItem);
      return {
        key,
        status: compareStatus(beforeItem, afterItem),
        before,
        after,
        delta: {
          durationMs: after.durationMs - before.durationMs,
          fileCount: after.fileCount - before.fileCount,
          testCount: after.testCount - before.testCount,
        },
        percent: {
          durationMs: percentDelta(before.durationMs, after.durationMs),
        },
      };
    })
    .toSorted(
      (left, right) =>
        Math.abs(right.delta.durationMs) - Math.abs(left.delta.durationMs) ||
        left.key.localeCompare(right.key),
    );
}

function normalizeFileCounter(item?: Partial<FileSnapshot>): FileSnapshot {
  return {
    durationMs: item?.durationMs ?? 0,
    testCount: item?.testCount ?? 0,
  };
}

function fileKey(item: Pick<ComparableFile, "config" | "file">): string {
  return `${item.config}\0${item.file}`;
}

function compareFiles(beforeFiles: ComparableFile[] = [], afterFiles: ComparableFile[] = []) {
  const beforeByKey = new Map(beforeFiles.map((item) => [fileKey(item), item]));
  const afterByKey = new Map(afterFiles.map((item) => [fileKey(item), item]));
  const keys = new Set([...beforeByKey.keys(), ...afterByKey.keys()]);

  return [...keys]
    .map((key) => {
      const beforeItem = beforeByKey.get(key);
      const afterItem = afterByKey.get(key);
      const before = normalizeFileCounter(beforeItem);
      const after = normalizeFileCounter(afterItem);
      const source = afterItem ?? beforeItem;
      if (!source) {
        throw new Error(`missing file comparison source for ${key}`);
      }
      return {
        key,
        config: source.config,
        file: source.file,
        group: source.group,
        status: compareStatus(beforeItem, afterItem),
        before,
        after,
        delta: {
          durationMs: after.durationMs - before.durationMs,
          testCount: after.testCount - before.testCount,
        },
        percent: {
          durationMs: percentDelta(before.durationMs, after.durationMs),
        },
      };
    })
    .toSorted(
      (left, right) =>
        Math.abs(right.delta.durationMs) - Math.abs(left.delta.durationMs) ||
        left.file.localeCompare(right.file) ||
        left.config.localeCompare(right.config),
    );
}

function runKey(run: ComparableRun): string {
  if (typeof run.label === "string" && run.label.trim().length > 0) {
    return normalizeConfigLabel(run.label);
  }
  return normalizeConfigLabel(run.config);
}

function compareOptionalNumber(
  beforeValue: number | null,
  afterValue: number | null,
): number | null {
  if (typeof beforeValue !== "number" || typeof afterValue !== "number") {
    return null;
  }
  return afterValue - beforeValue;
}

function normalizeRun(run?: ComparableRun): RunSnapshot {
  return run
    ? {
        elapsedMs: typeof run.elapsedMs === "number" ? run.elapsedMs : null,
        maxRssBytes: typeof run.maxRssBytes === "number" ? run.maxRssBytes : null,
        status: typeof run.status === "number" ? run.status : null,
      }
    : {
        elapsedMs: null,
        maxRssBytes: null,
        status: null,
      };
}

function compareRuns(beforeRuns: ComparableRun[] = [], afterRuns: ComparableRun[] = []) {
  const beforeByKey = new Map(beforeRuns.map((run) => [runKey(run), run]));
  const afterByKey = new Map(afterRuns.map((run) => [runKey(run), run]));
  const keys = new Set([...beforeByKey.keys(), ...afterByKey.keys()]);

  return [...keys]
    .map((key) => {
      const beforeRun = beforeByKey.get(key);
      const afterRun = afterByKey.get(key);
      const before = normalizeRun(beforeRun);
      const after = normalizeRun(afterRun);
      return {
        key,
        status: compareStatus(beforeRun, afterRun),
        before,
        after,
        delta: {
          elapsedMs: compareOptionalNumber(before.elapsedMs, after.elapsedMs),
          maxRssBytes: compareOptionalNumber(before.maxRssBytes, after.maxRssBytes),
        },
      };
    })
    .toSorted((left, right) => {
      const leftMagnitude = Math.abs(left.delta.elapsedMs ?? left.delta.maxRssBytes ?? 0);
      const rightMagnitude = Math.abs(right.delta.elapsedMs ?? right.delta.maxRssBytes ?? 0);
      return rightMagnitude - leftMagnitude || left.key.localeCompare(right.key);
    });
}

/**
 * Compares baseline and current grouped test reports.
 */
export function buildGroupedTestComparison(params: {
  after: GroupedTestReportInput;
  afterPath?: string;
  before: GroupedTestReportInput;
  beforePath?: string;
}) {
  const before = params.before;
  const after = params.after;
  const beforeTotals = normalizeCounter(before.totals);
  const afterTotals = normalizeCounter(after.totals);
  const warnings = [];

  if (before.groupBy !== after.groupBy) {
    warnings.push(`groupBy differs: before=${before.groupBy} after=${after.groupBy}`);
  }

  return {
    generatedAt: new Date().toISOString(),
    command: "test-group-report:compare",
    groupBy: after.groupBy ?? before.groupBy,
    warnings,
    totals: {
      before: beforeTotals,
      after: afterTotals,
      delta: {
        durationMs: afterTotals.durationMs - beforeTotals.durationMs,
        fileCount: afterTotals.fileCount - beforeTotals.fileCount,
        testCount: afterTotals.testCount - beforeTotals.testCount,
      },
      percent: {
        durationMs: percentDelta(beforeTotals.durationMs, afterTotals.durationMs),
      },
    },
    groups: compareCounters(before.groups, after.groups),
    configs: compareCounters(before.configs, after.configs),
    files: compareFiles(before.topFiles, after.topFiles),
    runs: compareRuns(before.runs, after.runs),
    inputs: {
      before: params.beforePath ?? null,
      after: params.afterPath ?? null,
    },
  };
}

type GroupedTestComparison = ReturnType<typeof buildGroupedTestComparison>;

function formatCountDelta(value: number): string {
  return `${value > 0 ? "+" : ""}${value}`;
}

function formatOptionalMs(value: number | null): string {
  return typeof value === "number" ? formatMs(value) : "n/a";
}

function formatOptionalSignedMs(value: number | null): string {
  return typeof value === "number" ? formatSignedMs(value) : "n/a";
}

function formatOptionalBytes(value: number | null): string {
  return typeof value === "number" ? formatBytesAsMb(value) : "n/a";
}

function formatOptionalSignedBytes(value: number | null): string {
  return typeof value === "number" ? formatSignedBytesAsMb(value) : "n/a";
}

function pushRows<Entry>(
  lines: string[],
  entries: Entry[],
  limit: number,
  formatRow: (entry: Entry, index: number) => string,
): void {
  const selected = entries.slice(0, limit);
  if (selected.length === 0) {
    lines.push("  (none)");
  } else {
    for (const [index, entry] of selected.entries()) {
      lines.push(formatRow(entry, index));
    }
  }
}

const formatChangeRow = (entry: GroupedTestComparison["groups"][number], index: number) =>
  `${String(index + 1).padStart(2, " ")}. ${formatSignedMs(entry.delta.durationMs).padStart(11, " ")} (${formatPercent(entry.percent.durationMs).padStart(7, " ")}) | before=${formatMs(entry.before.durationMs).padStart(10, " ")} after=${formatMs(entry.after.durationMs).padStart(10, " ")} | files=${formatCountDelta(entry.delta.fileCount ?? 0).padStart(4, " ")} tests=${formatCountDelta(entry.delta.testCount ?? 0).padStart(5, " ")} | ${entry.key}`;

const formatFileChangeRow = (entry: GroupedTestComparison["files"][number], index: number) =>
  `${String(index + 1).padStart(2, " ")}. ${formatSignedMs(entry.delta.durationMs).padStart(11, " ")} (${formatPercent(entry.percent.durationMs).padStart(7, " ")}) | before=${formatMs(entry.before.durationMs).padStart(10, " ")} after=${formatMs(entry.after.durationMs).padStart(10, " ")} | tests=${formatCountDelta(entry.delta.testCount).padStart(4, " ")} | ${entry.config} | ${entry.file}`;

/**
 * Renders a grouped test comparison as CLI-friendly text.
 */
export function renderGroupedTestComparison(
  comparison: GroupedTestComparison,
  options: { limit?: number; topFiles?: number } = {},
): string {
  const limit = options.limit ?? 25;
  const topFiles = options.topFiles ?? 25;
  const groupRegressions = comparison.groups.filter((entry) => entry.delta.durationMs > 0);
  const groupGains = comparison.groups.filter((entry) => entry.delta.durationMs < 0);
  const fileRegressions = comparison.files.filter((entry) => entry.delta.durationMs > 0);
  const fileGains = comparison.files.filter((entry) => entry.delta.durationMs < 0);
  const addedFiles = comparison.files.filter((entry) => entry.status === "added").length;
  const removedFiles = comparison.files.filter((entry) => entry.status === "removed").length;
  const lines = [
    `[test-group-report:compare] groupBy=${comparison.groupBy} file-sum=${formatMs(comparison.totals.before.durationMs)} -> ${formatMs(comparison.totals.after.durationMs)} (${formatSignedMs(comparison.totals.delta.durationMs)}, ${formatPercent(comparison.totals.percent.durationMs)}) files=${comparison.totals.before.fileCount}->${comparison.totals.after.fileCount} (${formatCountDelta(comparison.totals.delta.fileCount)}) tests=${comparison.totals.before.testCount}->${comparison.totals.after.testCount} (${formatCountDelta(comparison.totals.delta.testCount)}) addedFiles=${addedFiles} removedFiles=${removedFiles}`,
  ];

  for (const warning of comparison.warnings) {
    lines.push(`[test-group-report:compare] warning: ${warning}`);
  }

  lines.push(
    "",
    `Top group regressions (${Math.min(limit, groupRegressions.length)} of ${groupRegressions.length})`,
  );
  pushRows(lines, groupRegressions, limit, formatChangeRow);

  lines.push("", `Top group gains (${Math.min(limit, groupGains.length)} of ${groupGains.length})`);
  pushRows(lines, groupGains, limit, formatChangeRow);

  lines.push(
    "",
    `Config duration deltas (${Math.min(limit, comparison.configs.length)} of ${comparison.configs.length})`,
  );
  pushRows(lines, comparison.configs, limit, formatChangeRow);

  if (comparison.runs.length > 0) {
    lines.push(
      "",
      `Config wall/RSS deltas (${Math.min(limit, comparison.runs.length)} of ${comparison.runs.length})`,
    );
    for (const [index, run] of comparison.runs.slice(0, limit).entries()) {
      lines.push(
        `${String(index + 1).padStart(2, " ")}. wall=${formatOptionalSignedMs(run.delta.elapsedMs).padStart(11, " ")} before=${formatOptionalMs(run.before.elapsedMs).padStart(10, " ")} after=${formatOptionalMs(run.after.elapsedMs).padStart(10, " ")} | rss=${formatOptionalSignedBytes(run.delta.maxRssBytes).padStart(10, " ")} before=${formatOptionalBytes(run.before.maxRssBytes).padStart(9, " ")} after=${formatOptionalBytes(run.after.maxRssBytes).padStart(9, " ")} | status=${run.before.status ?? "n/a"}->${run.after.status ?? "n/a"} | ${run.key}`,
      );
    }
  }

  lines.push(
    "",
    `Top file regressions (${Math.min(topFiles, fileRegressions.length)} of ${fileRegressions.length})`,
  );
  pushRows(lines, fileRegressions, topFiles, formatFileChangeRow);

  lines.push("", `Top file gains (${Math.min(topFiles, fileGains.length)} of ${fileGains.length})`);
  pushRows(lines, fileGains, topFiles, formatFileChangeRow);

  return lines.join("\n");
}

/**
 * Renders a grouped test report as CLI-friendly text.
 */
export function renderGroupedTestReport(
  report: GroupedTestReport,
  options: { limit?: number; topFiles?: number } = {},
): string {
  const limit = options.limit ?? 25;
  const topFiles = options.topFiles ?? 25;
  const slowTests = report.slowTests ?? [];
  const lines = [
    `[test-group-report] groupBy=${report.groupBy} files=${report.totals.fileCount} tests=${report.totals.testCount} file-sum=${formatMs(report.totals.durationMs)}`,
    "",
    `Top groups (${Math.min(limit, report.groups.length)} of ${report.groups.length})`,
  ];

  for (const [index, group] of report.groups.slice(0, limit).entries()) {
    lines.push(
      `${String(index + 1).padStart(2, " ")}. ${formatMs(group.durationMs).padStart(10, " ")} | files=${String(group.fileCount).padStart(4, " ")} | tests=${String(group.testCount).padStart(5, " ")} | ${group.key}`,
    );
  }

  lines.push(
    "",
    `Top configs (${Math.min(limit, report.configs.length)} of ${report.configs.length})`,
  );
  for (const [index, config] of report.configs.slice(0, limit).entries()) {
    lines.push(
      `${String(index + 1).padStart(2, " ")}. ${formatMs(config.durationMs).padStart(10, " ")} | files=${String(config.fileCount).padStart(4, " ")} | tests=${String(config.testCount).padStart(5, " ")} | ${config.key}`,
    );
  }

  lines.push(
    "",
    `Top files (${Math.min(topFiles, report.topFiles.length)} of ${report.topFiles.length})`,
  );
  for (const [index, file] of report.topFiles.slice(0, topFiles).entries()) {
    lines.push(
      `${String(index + 1).padStart(2, " ")}. ${formatMs(file.durationMs).padStart(10, " ")} | tests=${String(file.testCount).padStart(4, " ")} | ${file.config} | ${file.file}`,
    );
  }

  if (slowTests.length > 0) {
    lines.push("", `Slow tests (${Math.min(topFiles, slowTests.length)} of ${slowTests.length})`);
    for (const [index, test] of slowTests.slice(0, topFiles).entries()) {
      lines.push(
        `${String(index + 1).padStart(2, " ")}. ${formatMs(test.durationMs).padStart(10, " ")} | ${test.status} | ${test.config} | ${test.file} | ${test.fullName}`,
      );
    }
  }

  return lines.join("\n");
}
