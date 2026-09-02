#!/usr/bin/env node

// Summarizes OpenClaw performance source fixtures for reports.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { requireOptionArgument } from "./lib/arg-utils.mts";
import { collectSqliteQueryPlanEvidence } from "./lib/sqlite-query-plan-evidence.js";

type JsonObject = { [key: string]: JsonValue };
type JsonValue = boolean | number | string | null | JsonObject | JsonValue[];
type RequiredOption = { required?: boolean };

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["boolean", "number", "string"].includes(typeof value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function parseJson(source: string): JsonValue {
  const value: unknown = JSON.parse(source);
  if (!isJsonValue(value)) {
    throw new Error("parsed value is not JSON");
  }
  return value;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return isRecord(value);
}

function valueAt(value: JsonValue | undefined, ...keys: string[]): JsonValue | undefined {
  let current = value;
  for (const key of keys) {
    current = isJsonObject(current) ? current[key] : undefined;
  }
  return current;
}

function objectArray(value: JsonValue | undefined): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

export function parseArgs(argv: string[]) {
  const options: Record<"baselineSourceDir" | "sourceDir" | "output", string | null> = {
    baselineSourceDir: null,
    sourceDir: null,
    output: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const readValue = () => {
      const value = requireOptionArgument(argv, index, arg);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--source-dir":
        options.sourceDir = path.resolve(readValue());
        break;
      case "--baseline-source-dir":
        options.baselineSourceDir = path.resolve(readValue());
        break;
      case "--output":
        options.output = path.resolve(readValue());
        break;
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.sourceDir) {
    throw new Error("--source-dir is required");
  }
  return { ...options, sourceDir: options.sourceDir };
}

function printHelp() {
  console.log(`Usage: node --import tsx scripts/openclaw-performance-source-summary.mts --source-dir <dir> [--baseline-source-dir <dir>] [--output <summary.md>]

Summarizes OpenClaw-native performance probe artifacts for CI reports.`);
}

function readJsonIfExists(filePath: string): JsonValue {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return parseJson(fs.readFileSync(filePath, "utf8"));
}

function readRequiredJson(filePath: string, label: string): JsonValue {
  if (!fs.existsSync(filePath)) {
    throw new Error(`[source-performance] missing required ${label}: ${filePath}`);
  }
  return parseJson(fs.readFileSync(filePath, "utf8"));
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function formatMs(value: unknown) {
  return finiteNumber(value) ? `${value.toFixed(1)}ms` : "n/a";
}

function formatMb(value: unknown) {
  return finiteNumber(value) ? `${value.toFixed(1)}MB` : "n/a";
}

function formatBytesAsMb(value: unknown) {
  return finiteNumber(value) ? formatMb(value / 1024 / 1024) : "n/a";
}

function formatRatio(value: unknown) {
  return finiteNumber(value) ? value.toFixed(3) : "n/a";
}

function metric(stats: JsonValue | undefined, key: "p50" | "p95" = "p50") {
  const value = valueAt(stats, key);
  return typeof value === "number" ? value : null;
}

function percentDelta(before: unknown, after: unknown) {
  if (typeof before !== "number" || typeof after !== "number") {
    return null;
  }
  if (before === 0) {
    return after === 0 ? 0 : null;
  }
  return ((after - before) / before) * 100;
}

function formatDeltaMb(before: unknown, after: unknown) {
  if (typeof before !== "number" || typeof after !== "number") {
    return "n/a";
  }
  const delta = after - before;
  const percent = percentDelta(before, after);
  const sign = delta > 0 ? "+" : "";
  const percentText = percent == null ? "new" : `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`;
  return `${sign}${formatMb(delta)} (${percentText})`;
}

function memoryRisk(before: unknown, after: unknown) {
  const percent = percentDelta(before, after);
  const delta = typeof before === "number" && typeof after === "number" ? after - before : null;
  if (percent == null || delta == null) {
    return "n/a";
  }
  if (percent >= 20 && delta >= 10) {
    return "watch";
  }
  if (percent <= -10 && delta <= -10) {
    return "improved";
  }
  return "stable";
}

function escapeCell(value: unknown) {
  return String(value).replaceAll("|", "\\|");
}

function table(headers: string[], rows: unknown[][]) {
  if (rows.length === 0) {
    return ["No data.", ""];
  }
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map((cell) => escapeCell(cell)).join(" | ")} |`),
    "",
  ];
}

function validateMockHelloSummary(summary: JsonValue, filePath: string) {
  const total = valueAt(summary, "counts", "total");
  const passed = valueAt(summary, "counts", "passed");
  const failed = valueAt(summary, "counts", "failed");
  const scenarios = objectArray(valueAt(summary, "scenarios"));
  if (
    !isNonNegativeInteger(total) ||
    !isNonNegativeInteger(passed) ||
    !isNonNegativeInteger(failed) ||
    total <= 0 ||
    failed !== 0 ||
    passed !== total
  ) {
    throw new Error(`[source-performance] invalid mock hello summary counts: ${filePath}`);
  }
  if (scenarios.length !== total) {
    throw new Error(`[source-performance] invalid mock hello scenario evidence: ${filePath}`);
  }
  const passedScenarios = scenarios.filter((scenario) => scenario.status === "pass").length;
  const failedScenarios = scenarios.filter((scenario) => scenario.status === "fail").length;
  const invalidScenario = scenarios.find((scenario) => {
    const status = scenario.status;
    return typeof status !== "string" || !["pass", "fail", "skip"].includes(status);
  });
  if (invalidScenario || passedScenarios !== passed || failedScenarios !== failed) {
    throw new Error(`[source-performance] invalid mock hello scenario evidence: ${filePath}`);
  }
  const requiredMetrics = [
    "wallMs",
    "gatewayCpuCoreRatio",
    "gatewayProcessRssStartBytes",
    "gatewayProcessRssEndBytes",
    "gatewayProcessRssDeltaBytes",
  ];
  const missingMetric = requiredMetrics.find(
    (key) => !finiteNumber(valueAt(summary, "metrics", key)),
  );
  if (missingMetric) {
    throw new Error(`[source-performance] missing mock hello metric ${missingMetric}: ${filePath}`);
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function loadMockHelloSummaries(sourceDir: string, { required = false }: RequiredOption = {}) {
  const root = path.join(sourceDir, "mock-hello");
  if (!fs.existsSync(root)) {
    if (required) {
      throw new Error(`[source-performance] missing required mock hello directory: ${root}`);
    }
    return [];
  }
  const summaries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      id: entry.name,
      summaryPath: path.join(root, entry.name, "qa-suite-summary.json"),
    }))
    .filter((entry) => fs.existsSync(entry.summaryPath))
    .map((entry) => ({
      id: entry.id,
      summary: parseJson(fs.readFileSync(entry.summaryPath, "utf8")),
      summaryPath: entry.summaryPath,
    }))
    .toSorted((a, b) => a.id.localeCompare(b.id));
  if (required && summaries.length === 0) {
    throw new Error(`[source-performance] missing required mock hello summaries: ${root}`);
  }
  if (required) {
    for (const entry of summaries) {
      validateMockHelloSummary(entry.summary, entry.summaryPath);
    }
  }
  return summaries.map(({ id, summary }) => ({ id, summary }));
}

type MockHelloEntry = ReturnType<typeof loadMockHelloSummaries>[number];

function validateStartupArtifact(startup: JsonValue, filePath: string) {
  const results = objectArray(valueAt(startup, "results"));
  if (results.length === 0) {
    throw new Error(`[source-performance] missing gateway startup results: ${filePath}`);
  }
  for (const result of results) {
    if (
      !finiteNumber(valueAt(result, "summary", "readyzMs", "p50")) ||
      !finiteNumber(valueAt(result, "summary", "maxRssMb", "p95")) ||
      !finiteNumber(valueAt(result, "summary", "cpuCoreRatio", "p95"))
    ) {
      const resultId = typeof result.id === "string" ? result.id : "unknown";
      throw new Error(
        `[source-performance] incomplete gateway startup metrics for ${resultId}: ${filePath}`,
      );
    }
  }
}

function validateCliArtifact(cli: JsonValue, filePath: string) {
  const cases = objectArray(valueAt(cli, "primary", "cases"));
  if (cases.length === 0) {
    throw new Error(`[source-performance] missing CLI startup cases: ${filePath}`);
  }
  for (const entry of cases) {
    if (
      !finiteNumber(valueAt(entry, "summary", "durationMs", "p50")) ||
      !finiteNumber(valueAt(entry, "summary", "maxRssMb", "p95"))
    ) {
      const entryId = typeof entry.id === "string" ? entry.id : "unknown";
      throw new Error(
        `[source-performance] incomplete CLI startup metrics for ${entryId}: ${filePath}`,
      );
    }
  }
}

function validateExtensionMemoryArtifact(extensionMemory: JsonValue, filePath: string) {
  const rows = objectArray(valueAt(extensionMemory, "topByDeltaMb"));
  if (rows.length === 0) {
    throw new Error(`[source-performance] missing extension memory rows: ${filePath}`);
  }
  if (
    !finiteNumber(valueAt(extensionMemory, "baseline", "maxRssMb")) ||
    !finiteNumber(valueAt(extensionMemory, "combined", "maxRssMb"))
  ) {
    throw new Error(`[source-performance] incomplete extension memory context: ${filePath}`);
  }
  for (const entry of rows) {
    if (!finiteNumber(entry.maxRssMb) || !finiteNumber(entry.deltaFromBaselineMb)) {
      const entryDir = typeof entry.dir === "string" ? entry.dir : "unknown";
      throw new Error(
        `[source-performance] incomplete extension memory metrics for ${entryDir}: ${filePath}`,
      );
    }
  }
}

function validateSqlitePerfCommon(sqlitePerf: JsonValue, filePath: string) {
  if (valueAt(sqlitePerf, "profile") !== "smoke") {
    throw new Error(`[source-performance] invalid SQLite perf profile: ${filePath}`);
  }
  if (valueAt(sqlitePerf, "integrity", "state") !== "ok") {
    throw new Error(`[source-performance] SQLite integrity check did not pass: ${filePath}`);
  }
  const agentIntegrity = valueAt(sqlitePerf, "integrity", "agent");
  if (
    !Array.isArray(agentIntegrity) ||
    agentIntegrity.length === 0 ||
    agentIntegrity.some((entry) => entry !== "ok")
  ) {
    throw new Error(`[source-performance] SQLite agent integrity check did not pass: ${filePath}`);
  }
  const stateRows = valueAt(sqlitePerf, "rows", "stateRows");
  const agentRows = valueAt(sqlitePerf, "rows", "agentCacheEntries");
  const totalMs = valueAt(sqlitePerf, "timingsMs", "total");
  const stateWalBefore = valueAt(sqlitePerf, "walBytes", "stateBefore");
  const queries = objectArray(valueAt(sqlitePerf, "queries"));
  if (
    !isNonNegativeInteger(stateRows) ||
    stateRows <= 0 ||
    !isNonNegativeInteger(agentRows) ||
    agentRows <= 0 ||
    !finiteNumber(totalMs) ||
    totalMs < 0 ||
    !finiteNumber(stateWalBefore) ||
    stateWalBefore < 0 ||
    valueAt(sqlitePerf, "walBytes", "stateAfter") !== 0 ||
    queries.length === 0
  ) {
    throw new Error(`[source-performance] incomplete SQLite perf metrics: ${filePath}`);
  }
  return queries;
}

function isNormalizedStringArray(
  value: JsonValue | undefined,
  { allowEmpty = true, unique = false } = {},
) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    return false;
  }
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return (
    strings.length === value.length &&
    strings.every(
      (entry) => entry.length > 0 && entry.trim() === entry && !hasControlCharacters(entry),
    ) &&
    (!unique || new Set(strings).size === strings.length)
  );
}

function validateLegacySqlitePerfArtifact(sqlitePerf: JsonValue, filePath: string) {
  const queries = validateSqlitePerfCommon(sqlitePerf, filePath);
  for (const entry of queries) {
    if (!finiteNumber(entry.p50Ms) || !finiteNumber(entry.p95Ms) || !finiteNumber(entry.rows)) {
      throw new Error(`[source-performance] incomplete SQLite query metrics: ${filePath}`);
    }
  }
}

function validateSqlitePerfV2Artifact(sqlitePerf: JsonValue, filePath: string) {
  const queries = validateSqlitePerfCommon(sqlitePerf, filePath);
  const rawQueries = valueAt(sqlitePerf, "queries");
  const sqliteVersion = valueAt(sqlitePerf, "versions", "sqlite");
  const stateSchemaVersion = valueAt(sqlitePerf, "versions", "stateSchema");
  const agentSchemaVersion = valueAt(sqlitePerf, "versions", "agentSchema");
  if (
    typeof sqliteVersion !== "string" ||
    sqliteVersion.length === 0 ||
    sqliteVersion.trim() !== sqliteVersion ||
    hasControlCharacters(sqliteVersion) ||
    !isNonNegativeInteger(stateSchemaVersion) ||
    stateSchemaVersion <= 0 ||
    !isNonNegativeInteger(agentSchemaVersion) ||
    agentSchemaVersion <= 0 ||
    !Array.isArray(rawQueries) ||
    rawQueries.length !== queries.length
  ) {
    throw new Error(`[source-performance] invalid SQLite run metadata: ${filePath}`);
  }

  const ids = new Set<string>();
  for (const entry of queries) {
    const id = entry.id;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.trim() !== id ||
      hasControlCharacters(id) ||
      ids.has(id)
    ) {
      throw new Error(`[source-performance] invalid SQLite scenario ID: ${filePath}`);
    }
    ids.add(id);

    if (
      (entry.database !== "state" && entry.database !== "agent") ||
      typeof entry.sql !== "string" ||
      entry.sql.trim().length === 0 ||
      !isNonNegativeInteger(entry.rows) ||
      !isNonNegativeInteger(entry.runs) ||
      entry.runs <= 0 ||
      !finiteNumber(entry.p50Ms) ||
      entry.p50Ms < 0 ||
      !finiteNumber(entry.p95Ms) ||
      entry.p95Ms < entry.p50Ms
    ) {
      throw new Error(`[source-performance] invalid SQLite scenario metrics: ${filePath}`);
    }

    const plan = isJsonObject(entry.plan) ? entry.plan : undefined;
    if (
      !plan ||
      !isNormalizedStringArray(plan.raw, { allowEmpty: false }) ||
      !isNormalizedStringArray(plan.indexes, { unique: true }) ||
      !isNormalizedStringArray(plan.fullTableScans) ||
      !isNormalizedStringArray(plan.tempSorts)
    ) {
      throw new Error(`[source-performance] invalid SQLite scenario plan: ${filePath}`);
    }
    const expectedPlan = collectSqliteQueryPlanEvidence(plan.raw as string[]);
    if (
      JSON.stringify(plan.indexes) !== JSON.stringify(expectedPlan.indexes) ||
      JSON.stringify(plan.fullTableScans) !== JSON.stringify(expectedPlan.fullTableScans) ||
      JSON.stringify(plan.tempSorts) !== JSON.stringify(expectedPlan.tempSorts)
    ) {
      throw new Error(`[source-performance] invalid SQLite scenario plan: ${filePath}`);
    }
  }
}

function validateSqlitePerfArtifact(sqlitePerf: JsonValue, filePath: string) {
  const schemaVersion = valueAt(sqlitePerf, "schemaVersion");
  if (schemaVersion === undefined) {
    validateLegacySqlitePerfArtifact(sqlitePerf, filePath);
    return;
  }
  if (schemaVersion !== 2) {
    throw new Error(`[source-performance] unsupported SQLite perf schema version: ${filePath}`);
  }
  validateSqlitePerfV2Artifact(sqlitePerf, filePath);
}

function validateGatewaySummaryArtifact(gatewaySummary: JsonValue, filePath: string) {
  if (!Array.isArray(valueAt(gatewaySummary, "observations"))) {
    throw new Error(`[source-performance] missing gateway observation summary: ${filePath}`);
  }
}

function loadSourceArtifacts(sourceDir: string | null, { required = false }: RequiredOption = {}) {
  if (!sourceDir || !fs.existsSync(sourceDir)) {
    if (required) {
      throw new Error(`[source-performance] missing required source dir: ${sourceDir}`);
    }
    return null;
  }
  const stat = fs.statSync(sourceDir);
  if (!stat.isDirectory()) {
    throw new Error(`[source-performance] source path is not a directory: ${sourceDir}`);
  }
  const startupPath = path.join(sourceDir, "gateway-cpu", "gateway-startup-bench.json");
  const cliPath = path.join(sourceDir, "cli-startup.json");
  const extensionMemoryPath = path.join(sourceDir, "extension-memory.json");
  const sqlitePerfPath = path.join(sourceDir, "sqlite-perf-smoke.json");
  const artifacts = {
    startup: required
      ? readRequiredJson(startupPath, "gateway startup artifact")
      : readJsonIfExists(startupPath),
    cli: required ? readRequiredJson(cliPath, "CLI startup artifact") : readJsonIfExists(cliPath),
    extensionMemory: required
      ? readRequiredJson(extensionMemoryPath, "extension memory artifact")
      : readJsonIfExists(extensionMemoryPath),
    sqlitePerf: readJsonIfExists(sqlitePerfPath),
    mockHelloSummaries: loadMockHelloSummaries(sourceDir, { required }),
  };
  if (required) {
    validateStartupArtifact(artifacts.startup, startupPath);
    validateCliArtifact(artifacts.cli, cliPath);
    validateExtensionMemoryArtifact(artifacts.extensionMemory, extensionMemoryPath);
  }
  if (artifacts.sqlitePerf) {
    validateSqlitePerfArtifact(artifacts.sqlitePerf, sqlitePerfPath);
  }
  return artifacts;
}

type SourceArtifacts = NonNullable<ReturnType<typeof loadSourceArtifacts>>;

function buildStartupRows(startup: JsonValue) {
  return objectArray(valueAt(startup, "results")).map((result) => [
    result.id ?? "unknown",
    result.name ?? result.id ?? "unknown",
    formatMs(metric(valueAt(result, "summary", "readyzMs"))),
    formatMs(metric(valueAt(result, "summary", "readyzMs"), "p95")),
    formatMs(metric(valueAt(result, "summary", "healthzMs"))),
    formatMs(metric(valueAt(result, "summary", "httpListenLogMs"))),
    formatMs(metric(valueAt(result, "summary", "gatewayReadyLogMs"))),
    formatMs(metric(valueAt(result, "summary", "firstOutputMs"))),
    formatMb(metric(valueAt(result, "summary", "maxRssMb"), "p95")),
    formatRatio(metric(valueAt(result, "summary", "cpuCoreRatio"), "p95")),
  ]);
}

function buildTraceRows(startup: JsonValue) {
  const rows: unknown[][] = [];
  for (const result of objectArray(valueAt(startup, "results"))) {
    const trace = valueAt(result, "summary", "startupTrace");
    const traceEntries = (isJsonObject(trace) ? Object.entries(trace) : [])
      .filter(([name, stats]) => isStartupTraceDuration(name) && metric(stats) !== null)
      .toSorted((a, b) => (metric(b[1]) ?? 0) - (metric(a[1]) ?? 0))
      .slice(0, 5);
    for (const [name, stats] of traceEntries) {
      rows.push([
        result.id ?? "unknown",
        name,
        formatMs(metric(stats)),
        formatMs(metric(stats, "p95")),
      ]);
    }
  }
  return rows;
}

function isStartupTraceDuration(name: string) {
  if (name.endsWith(".total") || name.startsWith("memory.")) {
    return false;
  }
  const metricName = name.slice(name.lastIndexOf(".") + 1);
  return !metricName.endsWith("Count") && !metricName.endsWith("Mb");
}

function buildMockHelloRows(summaries: MockHelloEntry[]) {
  return summaries.map(({ id, summary }) => {
    const failed = valueAt(summary, "counts", "failed");
    const countInfo = valueAt(summary, "counts");
    const status = typeof failed === "number" && failed > 0 ? "fail" : "pass";
    const passed = isJsonObject(countInfo) ? countInfo.passed : undefined;
    const total = isJsonObject(countInfo) ? countInfo.total : undefined;
    const counts =
      isNonNegativeInteger(passed) && isNonNegativeInteger(total) ? `${passed}/${total}` : "n/a";
    return [
      id,
      status,
      counts,
      formatMs(valueAt(summary, "metrics", "wallMs")),
      formatRatio(valueAt(summary, "metrics", "gatewayCpuCoreRatio")),
      formatBytesAsMb(valueAt(summary, "metrics", "gatewayProcessRssStartBytes")),
      formatBytesAsMb(valueAt(summary, "metrics", "gatewayProcessRssEndBytes")),
      formatBytesAsMb(valueAt(summary, "metrics", "gatewayProcessRssDeltaBytes")),
      valueAt(summary, "run", "primaryModel") ?? "n/a",
    ];
  });
}

function buildCliRows(cli: JsonValue) {
  return objectArray(valueAt(cli, "primary", "cases")).map((commandCase) => [
    commandCase.id ?? "unknown",
    commandCase.name ?? commandCase.id ?? "unknown",
    formatMs(valueAt(commandCase, "summary", "durationMs", "p50")),
    formatMs(valueAt(commandCase, "summary", "durationMs", "p95")),
    formatMb(valueAt(commandCase, "summary", "maxRssMb", "p95")),
    formatExitSummary(valueAt(commandCase, "summary", "exitSummary")),
  ]);
}

function buildStartupMemoryDeltaRows(current: JsonValue, baseline: JsonValue) {
  const baselineById = new Map(
    objectArray(valueAt(baseline, "results")).map((result) => [result.id, result]),
  );
  return objectArray(valueAt(current, "results"))
    .map((result) => {
      const before = baselineById.get(result.id);
      if (!before) {
        return null;
      }
      const beforeRss = metric(valueAt(before, "summary", "maxRssMb"), "p95");
      const afterRss = metric(valueAt(result, "summary", "maxRssMb"), "p95");
      const beforeReadyHeap = metric(
        valueAt(before, "summary", "startupTrace", "memory.ready.heapUsedMb"),
        "p95",
      );
      const afterReadyHeap = metric(
        valueAt(result, "summary", "startupTrace", "memory.ready.heapUsedMb"),
        "p95",
      );
      return [
        "gateway boot",
        result.id ?? "unknown",
        formatMb(beforeRss),
        formatMb(afterRss),
        formatDeltaMb(beforeRss, afterRss),
        formatDeltaMb(beforeReadyHeap, afterReadyHeap),
        memoryRisk(beforeRss, afterRss),
      ];
    })
    .filter((row) => row !== null);
}

function buildCliMemoryDeltaRows(current: JsonValue, baseline: JsonValue) {
  const baselineById = new Map(
    objectArray(valueAt(baseline, "primary", "cases")).map((entry) => [entry.id, entry]),
  );
  return objectArray(valueAt(current, "primary", "cases"))
    .map((entry) => {
      const before = baselineById.get(entry.id);
      if (!before) {
        return null;
      }
      const beforeRss = metric(valueAt(before, "summary", "maxRssMb"), "p95");
      const afterRss = metric(valueAt(entry, "summary", "maxRssMb"), "p95");
      return [
        "cli",
        entry.id ?? "unknown",
        formatMb(beforeRss),
        formatMb(afterRss),
        formatDeltaMb(beforeRss, afterRss),
        "n/a",
        memoryRisk(beforeRss, afterRss),
      ];
    })
    .filter((row) => row !== null);
}

function average(values: unknown[]) {
  const numeric = values.filter(finiteNumber);
  if (numeric.length === 0) {
    return null;
  }
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
}

function buildMockHelloMemoryDeltaRows(current: MockHelloEntry[], baseline: MockHelloEntry[]) {
  const beforeDeltaBytes = average(
    baseline.map((entry) => valueAt(entry.summary, "metrics", "gatewayProcessRssDeltaBytes")),
  );
  const afterDeltaBytes = average(
    current.map((entry) => valueAt(entry.summary, "metrics", "gatewayProcessRssDeltaBytes")),
  );
  if (beforeDeltaBytes == null || afterDeltaBytes == null) {
    return [];
  }
  const beforeDelta = beforeDeltaBytes / 1024 / 1024;
  const afterDelta = afterDeltaBytes / 1024 / 1024;
  return [
    [
      "mock hello",
      "gateway RSS delta avg",
      formatMb(beforeDelta),
      formatMb(afterDelta),
      formatDeltaMb(beforeDelta, afterDelta),
      "n/a",
      memoryRisk(beforeDelta, afterDelta),
    ],
  ];
}

function buildExtensionMemoryRows(extensionMemory: JsonValue) {
  return objectArray(valueAt(extensionMemory, "topByDeltaMb"))
    .slice(0, 10)
    .map((entry) => [
      entry.dir ?? "unknown",
      formatMb(entry.maxRssMb),
      formatMb(entry.deltaFromBaselineMb),
      entry.status ?? "unknown",
    ]);
}

function buildExtensionMemoryContextRows(extensionMemory: JsonValue) {
  const baselineMb = valueAt(extensionMemory, "baseline", "maxRssMb");
  const combinedMb = valueAt(extensionMemory, "combined", "maxRssMb");
  const totalEntries = valueAt(extensionMemory, "counts", "totalEntries");
  return [
    [
      "empty Node process",
      formatMb(baselineMb),
      formatMb(0),
      valueAt(extensionMemory, "baseline", "status") ?? "unknown",
    ],
    [
      finiteNumber(totalEntries)
        ? `all ${totalEntries} bundled plugins`
        : "all selected bundled plugins",
      formatMb(combinedMb),
      finiteNumber(baselineMb) && finiteNumber(combinedMb)
        ? formatMb(combinedMb - baselineMb)
        : "n/a",
      valueAt(extensionMemory, "combined", "status") ?? "unknown",
    ],
  ];
}

function sqliteArtifactFormat(sqlitePerf: JsonValue) {
  return valueAt(sqlitePerf, "schemaVersion") === 2 ? "v2" : "legacy";
}

function buildSqliteRunRows(current: JsonValue, baseline: JsonValue) {
  const rows: unknown[][] = [];
  for (const [label, artifact] of [
    ["current", current],
    ["baseline", baseline],
  ] as const) {
    if (!artifact) {
      continue;
    }
    rows.push([
      label,
      sqliteArtifactFormat(artifact),
      valueAt(artifact, "profile") ?? "unknown",
      valueAt(artifact, "versions", "sqlite") ?? "n/a",
      valueAt(artifact, "versions", "stateSchema") ?? "n/a",
      valueAt(artifact, "versions", "agentSchema") ?? "n/a",
      valueAt(artifact, "rows", "stateRows") ?? "n/a",
      valueAt(artifact, "rows", "agentCacheEntries") ?? "n/a",
      valueAt(artifact, "integrity", "state") ?? "n/a",
      formatBytesAsMb(valueAt(artifact, "walBytes", "stateBefore")),
      formatBytesAsMb(valueAt(artifact, "walBytes", "stateAfter")),
      formatMs(valueAt(artifact, "timingsMs", "total")),
    ]);
  }
  return rows;
}

function formatPercentDelta(before: unknown, after: unknown) {
  const delta = percentDelta(before, after);
  if (delta == null) {
    return "n/a";
  }
  return `${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`;
}

function formatSqlitePlan(plan: JsonValue | undefined) {
  if (!isJsonObject(plan)) {
    return "not reported";
  }
  const indexes = stringArray(plan.indexes);
  const fullTableScans = stringArray(plan.fullTableScans);
  const tempSorts = stringArray(plan.tempSorts);
  return [
    `indexes: ${indexes.length > 0 ? indexes.join(", ") : "none"}`,
    `full scans: ${fullTableScans.length > 0 ? fullTableScans.join(", ") : "none"}`,
    `temp sorts: ${tempSorts.length > 0 ? tempSorts.join(", ") : "none"}`,
  ].join("; ");
}

function buildSqliteScenarioRows(current: JsonValue, baseline: JsonValue) {
  if (!current) {
    return [];
  }
  const currentIsV2 = valueAt(current, "schemaVersion") === 2;
  const baselineById =
    valueAt(baseline, "schemaVersion") === 2
      ? new Map(objectArray(valueAt(baseline, "queries")).map((entry) => [entry.id, entry]))
      : new Map<JsonValue | undefined, JsonObject>();

  return objectArray(valueAt(current, "queries")).map((entry, index) => {
    const id = currentIsV2 ? entry.id : `legacy query ${index + 1}`;
    const before = currentIsV2 ? baselineById.get(entry.id) : undefined;
    const comparable =
      before !== undefined &&
      before.database === entry.database &&
      before.sql === entry.sql &&
      before.rows === entry.rows &&
      before.runs === entry.runs;
    return [
      id ?? "unknown",
      currentIsV2 ? (entry.database ?? "unknown") : "unknown",
      entry.rows ?? "n/a",
      currentIsV2 ? (entry.runs ?? "n/a") : "n/a",
      formatMs(entry.p50Ms),
      formatMs(entry.p95Ms),
      before?.rows ?? "n/a",
      before?.runs ?? "n/a",
      formatMs(before?.p95Ms),
      comparable
        ? formatPercentDelta(before.p95Ms, entry.p95Ms)
        : before
          ? "n/a (workload differs)"
          : "n/a",
      formatSqlitePlan(entry.plan),
    ];
  });
}

function buildMemoryDeltaRows(current: SourceArtifacts, baseline: SourceArtifacts | null) {
  if (!baseline) {
    return [];
  }
  return [
    ...buildStartupMemoryDeltaRows(current.startup, baseline.startup),
    ...buildCliMemoryDeltaRows(current.cli, baseline.cli),
    ...buildMockHelloMemoryDeltaRows(current.mockHelloSummaries, baseline.mockHelloSummaries),
  ];
}

function formatExitSummary(value: unknown) {
  if (typeof value !== "string" || !value) {
    return "n/a";
  }
  return value.replaceAll(/\b(code:(?:null|-?\d+)|signal:[^,\s]+)x(\d+)\b/g, "$1 x$2");
}

function buildObservationRows(summary: JsonValue) {
  return objectArray(valueAt(summary, "observations")).map((observation) => [
    observation.kind ?? "unknown",
    observation.id ?? "unknown",
    formatRatio(observation.cpuCoreRatio ?? observation.cpuCoreRatioMax),
    formatMs(observation.wallMs ?? observation.wallMsMax),
  ]);
}

export function buildMarkdown(sourceDir: string, baselineSourceDir: string | null) {
  const current = loadSourceArtifacts(sourceDir, { required: true });
  const baseline = loadSourceArtifacts(baselineSourceDir ?? null);
  const gatewaySummaryPath = path.join(sourceDir, "gateway-cpu", "summary.json");
  const gatewaySummary = readRequiredJson(gatewaySummaryPath, "gateway observation summary");
  if (!current) {
    throw new Error(`[source-performance] missing required source dir: ${sourceDir}`);
  }
  validateGatewaySummaryArtifact(gatewaySummary, gatewaySummaryPath);
  const memoryDeltaRows = buildMemoryDeltaRows(current, baseline);

  const lines = [
    "# OpenClaw Source Performance",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Gateway Boot",
    "",
    ...table(
      [
        "case",
        "name",
        "readyz p50",
        "readyz p95",
        "healthz p50",
        "http listen p50",
        "gateway ready p50",
        "first output p50",
        "RSS p95",
        "CPU core p95",
      ],
      buildStartupRows(current.startup),
    ),
    "## Memory Trend",
    "",
    baseline
      ? "Compared with the latest published mock-provider source probe for this tested ref."
      : "No published source baseline was available for this tested ref.",
    "",
    ...table(
      [
        "surface",
        "case",
        "baseline RSS p95",
        "current RSS p95",
        "RSS delta",
        "heap delta",
        "state",
      ],
      memoryDeltaRows,
    ),
    "## Bundled Plugin Import Memory",
    "",
    "Per-plugin rows are isolated cold imports and are not additive. The combined row measures all selected bundled-plugin entrypoints in one process.",
    "",
    ...table(
      ["measurement", "max RSS", "delta from empty process", "status"],
      buildExtensionMemoryContextRows(current.extensionMemory),
    ),
    ...table(
      ["plugin", "isolated max RSS", "isolated delta from empty process", "status"],
      buildExtensionMemoryRows(current.extensionMemory),
    ),
    "## Startup Hotspots",
    "",
    ...table(["case", "phase", "p50", "p95"], buildTraceRows(current.startup)),
    "## Fake Model Hello Loops",
    "",
    ...table(
      [
        "run",
        "status",
        "pass",
        "wall",
        "gateway CPU core",
        "RSS start",
        "RSS end",
        "RSS delta",
        "model",
      ],
      buildMockHelloRows(current.mockHelloSummaries),
    ),
    "## CLI Against Booted Gateway",
    "",
    ...table(
      ["case", "command", "duration p50", "duration p95", "RSS p95", "exits"],
      buildCliRows(current.cli),
    ),
    "## SQLite State Smoke",
    "",
    ...table(
      [
        "run",
        "format",
        "profile",
        "SQLite",
        "state schema",
        "agent schema",
        "state rows",
        "agent rows",
        "integrity",
        "WAL before",
        "WAL after",
        "total",
      ],
      buildSqliteRunRows(current.sqlitePerf, baseline?.sqlitePerf ?? null),
    ),
    ...table(
      [
        "scenario",
        "database",
        "rows",
        "runs",
        "p50",
        "p95",
        "baseline rows",
        "baseline runs",
        "baseline p95",
        "delta",
        "plan/index",
      ],
      buildSqliteScenarioRows(current.sqlitePerf, baseline?.sqlitePerf ?? null),
    ),
    "## Observations",
    "",
    ...table(["kind", "id", "CPU core", "wall"], buildObservationRows(gatewaySummary)),
  ];

  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const markdown = buildMarkdown(options.sourceDir, options.baselineSourceDir);
  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, markdown, "utf8");
  } else {
    process.stdout.write(markdown);
  }
}

function isCliEntry() {
  const cliArg = process.argv[1];
  return cliArg ? import.meta.url === pathToFileURL(cliArg).href : false;
}

if (isCliEntry()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
