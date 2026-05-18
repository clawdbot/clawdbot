import path from "node:path";
import { collectVitestFileDurations, normalizeTrackedRepoPath } from "../test-report-utils.mjs";
import { formatMs } from "./vitest-report-cli-utils.mjs";

export function formatBytesAsMb(valueBytes) {
  return valueBytes === null || valueBytes === undefined
    ? "n/a"
    : `${(valueBytes / 1024 / 1024).toFixed(1)}MB`;
}

function formatSignedMs(value, digits = 1) {
  return `${value > 0 ? "+" : ""}${formatMs(value, digits)}`;
}

function formatSignedBytesAsMb(valueBytes) {
  return valueBytes === null || valueBytes === undefined
    ? "n/a"
    : `${valueBytes > 0 ? "+" : ""}${formatBytesAsMb(valueBytes)}`;
}

export function normalizeConfigLabel(config) {
  return config.replace(/^test\/vitest\/vitest\./u, "").replace(/\.config\.ts$/u, "");
}

export function resolveTestArea(file) {
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

function resolveTestFolder(file, depth = 2) {
  const normalized = normalizeTrackedRepoPath(file);
  const dir = path.posix.dirname(normalized);
  if (dir === ".") {
    return normalized;
  }
  return dir.split("/").slice(0, Math.max(1, depth)).join("/");
}

export function resolveGroupKey(file, mode = "area") {
  if (mode === "folder") {
    return resolveTestFolder(file, 3);
  }
  if (mode === "top") {
    return normalizeTrackedRepoPath(file).split("/")[0] || file;
  }
  return resolveTestArea(file);
}

function createCounter(key) {
  return {
    key,
    durationMs: 0,
    fileCount: 0,
    testCount: 0,
    configs: new Set(),
  };
}

function addFileEntry(target, entry, config) {
  target.durationMs += entry.durationMs;
  target.fileCount += 1;
  target.testCount += entry.testCount;
  target.configs.add(config);
}

function finalizeCounter(counter) {
  return {
    key: counter.key,
    durationMs: counter.durationMs,
    fileCount: counter.fileCount,
    testCount: counter.testCount,
    configs: [...counter.configs].toSorted((left, right) => left.localeCompare(right)),
  };
}

export function buildGroupedTestReport(params) {
  const byGroup = new Map();
  const byConfig = new Map();
  const files = [];

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
  }

  const sortByDuration = (left, right) =>
    right.durationMs - left.durationMs || left.key.localeCompare(right.key);
  const sortFilesByDuration = (left, right) =>
    right.durationMs - left.durationMs || left.file.localeCompare(right.file);

  const groups = [...byGroup.values()].map(finalizeCounter).toSorted(sortByDuration);
  const configs = [...byConfig.values()].map(finalizeCounter).toSorted(sortByDuration);
  const topFiles = files.toSorted(sortFilesByDuration);
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
  };
}

function percentDelta(beforeValue, afterValue) {
  if (beforeValue === 0) {
    return afterValue === 0 ? 0 : null;
  }
  return ((afterValue - beforeValue) / beforeValue) * 100;
}

function formatPercent(value) {
  if (value === null || value === undefined) {
    return "new";
  }
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function normalizeCounter(item) {
  return {
    durationMs: item?.durationMs ?? 0,
    fileCount: item?.fileCount ?? 0,
    testCount: item?.testCount ?? 0,
  };
}

function compareStatus(beforeItem, afterItem) {
  if (beforeItem && afterItem) {
    return "changed";
  }
  return beforeItem ? "removed" : "added";
}

function compareCounters(beforeItems = [], afterItems = []) {
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

function normalizeFileCounter(item) {
  return {
    durationMs: item?.durationMs ?? 0,
    testCount: item?.testCount ?? 0,
  };
}

function fileKey(item) {
  return `${item.config}\0${item.file}`;
}

function compareFiles(beforeFiles = [], afterFiles = []) {
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

function runKey(run) {
  if (typeof run.label === "string" && run.label.trim().length > 0) {
    return normalizeConfigLabel(run.label);
  }
  return normalizeConfigLabel(run.config);
}

function compareOptionalNumber(beforeValue, afterValue) {
  if (typeof beforeValue !== "number" || typeof afterValue !== "number") {
    return null;
  }
  return afterValue - beforeValue;
}

function normalizeRun(run) {
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

function compareRuns(beforeRuns = [], afterRuns = []) {
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

export function buildGroupedTestComparison(params) {
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

function formatCountDelta(value) {
  return `${value > 0 ? "+" : ""}${value}`;
}

function formatOptionalMs(value) {
  return typeof value === "number" ? formatMs(value) : "n/a";
}

function formatOptionalSignedMs(value) {
  return typeof value === "number" ? formatSignedMs(value) : "n/a";
}

function formatOptionalBytes(value) {
  return typeof value === "number" ? formatBytesAsMb(value) : "n/a";
}

function formatOptionalSignedBytes(value) {
  return typeof value === "number" ? formatSignedBytesAsMb(value) : "n/a";
}

function pushChangeRows(lines, entries, options) {
  const selected = entries.slice(0, options.limit);
  if (selected.length === 0) {
    lines.push("  (none)");
    return;
  }

  for (const [index, entry] of selected.entries()) {
    lines.push(
      `${String(index + 1).padStart(2, " ")}. ${formatSignedMs(entry.delta.durationMs).padStart(11, " ")} (${formatPercent(entry.percent.durationMs).padStart(7, " ")}) | before=${formatMs(entry.before.durationMs).padStart(10, " ")} after=${formatMs(entry.after.durationMs).padStart(10, " ")} | files=${formatCountDelta(entry.delta.fileCount ?? 0).padStart(4, " ")} tests=${formatCountDelta(entry.delta.testCount ?? 0).padStart(5, " ")} | ${entry.key}`,
    );
  }
}

function pushFileChangeRows(lines, entries, options) {
  const selected = entries.slice(0, options.limit);
  if (selected.length === 0) {
    lines.push("  (none)");
    return;
  }

  for (const [index, entry] of selected.entries()) {
    lines.push(
      `${String(index + 1).padStart(2, " ")}. ${formatSignedMs(entry.delta.durationMs).padStart(11, " ")} (${formatPercent(entry.percent.durationMs).padStart(7, " ")}) | before=${formatMs(entry.before.durationMs).padStart(10, " ")} after=${formatMs(entry.after.durationMs).padStart(10, " ")} | tests=${formatCountDelta(entry.delta.testCount).padStart(4, " ")} | ${entry.config} | ${entry.file}`,
    );
  }
}

export function renderGroupedTestComparison(comparison, options = {}) {
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
  pushChangeRows(lines, groupRegressions, { limit });

  lines.push("", `Top group gains (${Math.min(limit, groupGains.length)} of ${groupGains.length})`);
  pushChangeRows(lines, groupGains, { limit });

  lines.push(
    "",
    `Config duration deltas (${Math.min(limit, comparison.configs.length)} of ${comparison.configs.length})`,
  );
  pushChangeRows(lines, comparison.configs, { limit });

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
  pushFileChangeRows(lines, fileRegressions, { limit: topFiles });

  lines.push("", `Top file gains (${Math.min(topFiles, fileGains.length)} of ${fileGains.length})`);
  pushFileChangeRows(lines, fileGains, { limit: topFiles });

  return lines.join("\n");
}

export function renderGroupedTestReport(report, options = {}) {
  const limit = options.limit ?? 25;
  const topFiles = options.topFiles ?? 25;
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

  return lines.join("\n");
}
