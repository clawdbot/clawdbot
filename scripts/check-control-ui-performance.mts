#!/usr/bin/env node
// Reports and enforces compressed Control UI asset budgets after a production build.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function isMetricsRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const KIB = 1024;
const STARTUP_JS_BASELINE_RATCHET_BYTES = 4096;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STARTUP_BUDGET_BASELINE_PATH = path.resolve(
  SCRIPT_DIR,
  "../config/control-ui-startup-budget-baseline.json",
);

// Each landed change can consume this much ratchet tolerance, so small increases
// may accumulate. The fixed startup JS ceiling bounds that cumulative creep.
const CONTROL_UI_STARTUP_JS_GZIP_TOLERANCE_BYTES = 512;

// Small, explicit headroom over the optimized baseline. Budget changes should
// accompany an intentional loading or chunking decision.
const controlUiPerformanceBudgets = {
  startupJsRequests: 18,
  startupCssRequests: 1,
  // 350 KiB maintainer-approved by Vyctor 2026-08-11 for #121686;
  // #121734 left main 6 B below the prior 319 KiB hard ceiling.
  startupJsGzipBytes: 350 * KIB,
  // 45 KiB CSS ceilings maintainer-approved 2026-07 alongside the interleaved
  // sidebar zone styling; headroom over the ~36.5 KiB post-diet baseline.
  startupCssGzipBytes: 45 * KIB,
  largestJsGzipBytes: 215 * KIB,
  // Startup CSS stays at 45 KiB; the boot-group consolidation (2026-08,
  // control-ui-boot chunking) merges boot-path component CSS into one file
  // that lands just above it, trading ~1 KiB of ceiling for ~95 fewer boot
  // requests on HTTP/1.1 gateways.
  largestCssGzipBytes: 47 * KIB,
} satisfies Record<string, number>;
export const CONTROL_UI_PERFORMANCE_BUDGETS = Object.freeze(controlUiPerformanceBudgets);

function controlUiAssetPathFromUrl(value: string): string | null {
  const normalized = value.split(/[?#]/u, 1)[0]?.replace(/\\/gu, "/") ?? "";
  const markerIndex = normalized.lastIndexOf("assets/");
  if (markerIndex === -1) {
    return null;
  }
  const assetPath = normalized.slice(markerIndex);
  if (assetPath.includes("../") || !/\.(?:css|js)$/u.test(assetPath)) {
    return null;
  }
  return assetPath;
}

export function extractControlUiStartupAssetPaths(html: string): string[] {
  const assets = new Set<string>();
  for (const tag of html.matchAll(/<(?:link|script)\b[^>]*>/giu)) {
    const attribute = tag[0].match(/\s(?:href|src)\s*=\s*["']([^"']+)["']/iu);
    const assetPath = attribute?.[1] ? controlUiAssetPathFromUrl(attribute[1]) : null;
    if (assetPath) {
      assets.add(assetPath);
    }
  }
  return [...assets].toSorted((left, right) => left.localeCompare(right));
}

function readAssetMetrics(assetsDir: string, entry: fs.Dirent) {
  const file = `assets/${entry.name}`;
  const sourcePath = path.join(assetsDir, entry.name);
  const gzipPath = `${sourcePath}.gz`;
  const brotliPath = `${sourcePath}.br`;
  for (const sidecarPath of [gzipPath, brotliPath]) {
    if (!fs.existsSync(sidecarPath)) {
      throw new Error(`Control UI performance check missing ${path.basename(sidecarPath)}`);
    }
  }
  const type = entry.name.endsWith(".js") ? "js" : "css";
  return {
    file,
    type,
    rawBytes: fs.statSync(sourcePath).size,
    gzipBytes: fs.statSync(gzipPath).size,
    brotliBytes: fs.statSync(brotliPath).size,
  };
}

function summarizeAssets(assets: Array<ReturnType<typeof readAssetMetrics>>) {
  return assets.reduce(
    (summary, asset) => ({
      requests: summary.requests + 1,
      rawBytes: summary.rawBytes + asset.rawBytes,
      gzipBytes: summary.gzipBytes + asset.gzipBytes,
      brotliBytes: summary.brotliBytes + asset.brotliBytes,
    }),
    { requests: 0, rawBytes: 0, gzipBytes: 0, brotliBytes: 0 },
  );
}

function largestAsset(assets: Array<ReturnType<typeof readAssetMetrics>>) {
  return assets.toSorted(
    (left, right) => right.gzipBytes - left.gzipBytes || left.file.localeCompare(right.file),
  )[0]!;
}

export function collectControlUiPerformanceMetrics(distDir: string) {
  const assetsDir = path.join(distDir, "assets");
  const html = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
  const assets = fs
    .readdirSync(assetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:css|js)$/u.test(entry.name))
    .map((entry) => readAssetMetrics(assetsDir, entry));
  const assetsByFile = new Map(assets.map((asset) => [asset.file, asset]));
  const startup = extractControlUiStartupAssetPaths(html).map((file) => {
    const asset = assetsByFile.get(file);
    if (!asset) {
      throw new Error(`Control UI performance check cannot find startup asset ${file}`);
    }
    return asset;
  });
  const jsAssets = assets.filter((asset) => asset.type === "js");
  const cssAssets = assets.filter((asset) => asset.type === "css");
  if (jsAssets.length === 0 || cssAssets.length === 0 || startup.length === 0) {
    throw new Error("Control UI performance check found an incomplete production bundle");
  }
  return {
    schemaVersion: 1 as const,
    startup: {
      js: summarizeAssets(startup.filter((asset) => asset.type === "js")),
      css: summarizeAssets(startup.filter((asset) => asset.type === "css")),
      assets: startup,
    },
    total: {
      js: summarizeAssets(jsAssets),
      css: summarizeAssets(cssAssets),
    },
    largest: {
      js: largestAsset(jsAssets),
      css: largestAsset(cssAssets),
    },
  };
}

export function evaluateControlUiPerformanceBudgets(
  metrics: ReturnType<typeof collectControlUiPerformanceMetrics>,
  budgets: Readonly<typeof CONTROL_UI_PERFORMANCE_BUDGETS> = CONTROL_UI_PERFORMANCE_BUDGETS,
  startupBudgetBaseline: Readonly<ControlUiStartupBudgetBaseline> | null = null,
  startupJsTolerance = CONTROL_UI_STARTUP_JS_GZIP_TOLERANCE_BYTES,
) {
  const baselineBytes = startupBudgetBaseline?.startupJsGzipBytes;
  const startupJsGzipLimit =
    baselineBytes === undefined
      ? budgets.startupJsGzipBytes
      : Math.min(baselineBytes, budgets.startupJsGzipBytes) + startupJsTolerance;
  const checks: Array<[string, number, number, "count" | "bytes"]> = [
    ["startup JS requests", metrics.startup.js.requests, budgets.startupJsRequests, "count"],
    ["startup CSS requests", metrics.startup.css.requests, budgets.startupCssRequests, "count"],
    ["startup JS gzip", metrics.startup.js.gzipBytes, startupJsGzipLimit, "bytes"],
    ["startup CSS gzip", metrics.startup.css.gzipBytes, budgets.startupCssGzipBytes, "bytes"],
    ["largest JS gzip", metrics.largest.js.gzipBytes, budgets.largestJsGzipBytes, "bytes"],
    ["largest CSS gzip", metrics.largest.css.gzipBytes, budgets.largestCssGzipBytes, "bytes"],
  ];
  const violations = checks.flatMap(([metric, actual, limit, unit]) =>
    actual > limit ? [{ metric, actual, limit, unit }] : [],
  );
  if (baselineBytes !== undefined && baselineBytes > budgets.startupJsGzipBytes) {
    violations.unshift({
      metric: "startup JS gzip baseline",
      actual: baselineBytes,
      limit: budgets.startupJsGzipBytes,
      unit: "bytes",
    });
  }
  return violations;
}

type ControlUiPerformanceBudgetViolation = ReturnType<
  typeof evaluateControlUiPerformanceBudgets
>[number];

function formatControlUiPerformanceBytes(bytes: number): string {
  return bytes < KIB ? `${bytes} B` : `${(bytes / KIB).toFixed(1)} KiB`;
}

function formatRequestCount(count: number): string {
  return `${count} ${count === 1 ? "request" : "requests"}`;
}

function formatAssetSummary(summary: ReturnType<typeof summarizeAssets>): string {
  return `${formatRequestCount(summary.requests)}, ${formatControlUiPerformanceBytes(summary.gzipBytes)} gzip, ${formatControlUiPerformanceBytes(summary.brotliBytes)} br`;
}

function formatViolation(violation: ControlUiPerformanceBudgetViolation): string {
  const actual =
    violation.unit === "bytes"
      ? formatControlUiPerformanceBytes(violation.actual)
      : String(violation.actual);
  const limit =
    violation.unit === "bytes"
      ? formatControlUiPerformanceBytes(violation.limit)
      : String(violation.limit);
  const exactBytes =
    violation.unit === "bytes" && actual === limit
      ? ` (${violation.actual} B vs ${violation.limit} B)`
      : "";
  return `${violation.metric}: ${actual} exceeds ${limit}${exactBytes}`;
}

export function formatControlUiPerformanceReport(
  metrics: ReturnType<typeof collectControlUiPerformanceMetrics>,
  budgets: Readonly<typeof CONTROL_UI_PERFORMANCE_BUDGETS> = CONTROL_UI_PERFORMANCE_BUDGETS,
  startupBudgetBaseline: Readonly<ControlUiStartupBudgetBaseline> | null = null,
  startupJsTolerance: number = CONTROL_UI_STARTUP_JS_GZIP_TOLERANCE_BYTES,
): string {
  const violations = evaluateControlUiPerformanceBudgets(
    metrics,
    budgets,
    startupBudgetBaseline,
    startupJsTolerance,
  );
  const lines = [
    "Control UI performance:",
    `  startup JS: ${formatAssetSummary(metrics.startup.js)} (limits: ${formatRequestCount(budgets.startupJsRequests)}, ${formatControlUiPerformanceBytes(startupBudgetBaseline ? Math.min(startupBudgetBaseline.startupJsGzipBytes, budgets.startupJsGzipBytes) + startupJsTolerance : budgets.startupJsGzipBytes)} gzip)`,
  ];
  if (startupBudgetBaseline) {
    lines.push(
      `  startup JS gzip vs baseline: ${metrics.startup.js.gzipBytes} B (baseline ${startupBudgetBaseline.startupJsGzipBytes} B + tolerance ${startupJsTolerance} B, max committed baseline ${budgets.startupJsGzipBytes} B)`,
    );
  }
  lines.push(
    `  startup CSS: ${formatAssetSummary(metrics.startup.css)} (limits: ${formatRequestCount(budgets.startupCssRequests)}, ${formatControlUiPerformanceBytes(budgets.startupCssGzipBytes)} gzip)`,
    `  largest JS: ${metrics.largest.js.file}, ${formatControlUiPerformanceBytes(metrics.largest.js.gzipBytes)} gzip (limit: ${formatControlUiPerformanceBytes(budgets.largestJsGzipBytes)})`,
    `  largest CSS: ${metrics.largest.css.file}, ${formatControlUiPerformanceBytes(metrics.largest.css.gzipBytes)} gzip (limit: ${formatControlUiPerformanceBytes(budgets.largestCssGzipBytes)})`,
    `  all JS: ${formatAssetSummary(metrics.total.js)}`,
    `  all CSS: ${formatAssetSummary(metrics.total.css)}`,
  );
  if (
    startupBudgetBaseline &&
    metrics.startup.js.gzipBytes + STARTUP_JS_BASELINE_RATCHET_BYTES <
      startupBudgetBaseline.startupJsGzipBytes
  ) {
    lines.push(
      `  hint: startup JS gzip is more than ${STARTUP_JS_BASELINE_RATCHET_BYTES} B below the ${startupBudgetBaseline.startupJsGzipBytes} B baseline; lower it with node --import tsx scripts/check-control-ui-performance.mts --update-baseline --reason "<reason>"`,
    );
  }
  if (violations.length > 0) {
    lines.push(
      "  violations:",
      ...violations.map((violation) => `    - ${formatViolation(violation)}`),
    );
  }
  return lines.join("\n");
}

function baselineUpdateCommand(): string {
  return 'node --import tsx scripts/check-control-ui-performance.mts --update-baseline --reason "<reason>"';
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function readControlUiStartupBudgetBaseline(baselinePath: string): ControlUiStartupBudgetBaseline {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    const record: Record<string, unknown> = isMetricsRecord(parsed) ? parsed : {};
    const { startupJsGzipBytes, reason, updatedAt } = record;
    if (
      typeof startupJsGzipBytes !== "number" ||
      !Number.isSafeInteger(startupJsGzipBytes) ||
      startupJsGzipBytes < 0 ||
      startupJsGzipBytes > CONTROL_UI_PERFORMANCE_BUDGETS.startupJsGzipBytes ||
      typeof reason !== "string" ||
      reason.trim().length === 0 ||
      typeof updatedAt !== "string" ||
      !isIsoDate(updatedAt)
    ) {
      throw new Error(
        `expected startupJsGzipBytes at most ${CONTROL_UI_PERFORMANCE_BUDGETS.startupJsGzipBytes}, non-empty reason, and YYYY-MM-DD updatedAt`,
      );
    }
    return { startupJsGzipBytes, reason, updatedAt };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot read Control UI startup budget baseline ${baselinePath}: ${detail}. Regenerate it with ${baselineUpdateCommand()}.`,
      { cause: error },
    );
  }
}

function writeControlUiStartupBudgetBaseline(
  baselinePath: string,
  startupJsGzipBytes: number,
  reason: string,
) {
  if (startupJsGzipBytes > CONTROL_UI_PERFORMANCE_BUDGETS.startupJsGzipBytes) {
    throw new Error("startup JS gzip baseline exceeds the committed-baseline cap");
  }
  const baseline = {
    startupJsGzipBytes,
    reason,
    updatedAt: new Date().toISOString().slice(0, 10),
  };
  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  return baseline;
}

type ControlUiStartupBudgetBaseline = ReturnType<typeof writeControlUiStartupBudgetBaseline>;

function validateExplicitStartupJsBytes(
  startupJsBytes: number,
  currentBaseline: ControlUiStartupBudgetBaseline,
): void {
  const delta = Math.abs(startupJsBytes - currentBaseline.startupJsGzipBytes);
  if (delta > STARTUP_JS_BASELINE_RATCHET_BYTES) {
    throw new Error(
      `startup JS gzip baseline update: ${startupJsBytes} B differs from current baseline ${currentBaseline.startupJsGzipBytes} B by ${delta} B, exceeding the ${STARTUP_JS_BASELINE_RATCHET_BYTES} B ratchet`,
    );
  }
}

export function runControlUiPerformanceCheck(
  distDir: string,
  budgets: Readonly<typeof CONTROL_UI_PERFORMANCE_BUDGETS> = CONTROL_UI_PERFORMANCE_BUDGETS,
  baselinePath = DEFAULT_STARTUP_BUDGET_BASELINE_PATH,
) {
  const startupBudgetBaseline = readControlUiStartupBudgetBaseline(baselinePath);
  const metrics = collectControlUiPerformanceMetrics(distDir);
  const violations = evaluateControlUiPerformanceBudgets(metrics, budgets, startupBudgetBaseline);
  const report = formatControlUiPerformanceReport(metrics, budgets, startupBudgetBaseline);
  return {
    metrics,
    budgets,
    startupBudgetBaseline,
    startupJsTolerance: CONTROL_UI_STARTUP_JS_GZIP_TOLERANCE_BYTES,
    violations,
    report,
  };
}

function main(argv: string[] = process.argv.slice(2)): void {
  let json = false;
  let updateBaseline = false;
  let reason: string | undefined;
  let startupJsBytes: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--update-baseline") {
      updateBaseline = true;
    } else if (arg === "--reason") {
      reason = argv[index + 1];
      if (!reason || reason.trim().length === 0 || reason.startsWith("--")) {
        throw new Error("--reason requires a non-empty value");
      }
      index += 1;
    } else if (arg === "--startup-js-bytes") {
      const value = argv[index + 1];
      if (!value || !/^[1-9]\d*$/u.test(value)) {
        throw new Error("--startup-js-bytes requires a positive integer");
      }
      startupJsBytes = Number(value);
      if (!Number.isSafeInteger(startupJsBytes)) {
        throw new Error("--startup-js-bytes requires a positive integer");
      }
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (reason !== undefined && !updateBaseline) {
    throw new Error("--reason requires --update-baseline");
  }
  if (startupJsBytes !== undefined && !updateBaseline) {
    throw new Error("--startup-js-bytes requires --update-baseline");
  }
  if (json && updateBaseline) {
    throw new Error("--json cannot be combined with --update-baseline");
  }
  const distDir = path.resolve(SCRIPT_DIR, "../dist/control-ui");
  if (updateBaseline) {
    if (startupJsBytes !== undefined) {
      const currentBaseline = readControlUiStartupBudgetBaseline(
        DEFAULT_STARTUP_BUDGET_BASELINE_PATH,
      );
      validateExplicitStartupJsBytes(startupJsBytes, currentBaseline);
    }
    const nextStartupJsBytes =
      startupJsBytes ?? collectControlUiPerformanceMetrics(distDir).startup.js.gzipBytes;
    const baseline = writeControlUiStartupBudgetBaseline(
      DEFAULT_STARTUP_BUDGET_BASELINE_PATH,
      nextStartupJsBytes,
      reason ?? "manual baseline update",
    );
    process.stdout.write(
      `Updated config/control-ui-startup-budget-baseline.json to ${baseline.startupJsGzipBytes} B (${baseline.reason}).\n`,
    );
    return;
  }
  const result = runControlUiPerformanceCheck(distDir);
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.report}\n`);
  }
  if (result.violations.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
