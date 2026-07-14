#!/usr/bin/env node
// Reports and enforces compressed Control UI asset budgets after a production build.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const KIB = 1024;

// Small, explicit headroom over the optimized baseline. Budget changes should
// accompany an intentional loading or chunking decision.
export const CONTROL_UI_PERFORMANCE_BUDGETS = Object.freeze({
  startupJsRequests: 25,
  startupCssRequests: 1,
  startupJsGzipBytes: 320 * KIB,
  startupCssGzipBytes: 42 * KIB,
  largestJsGzipBytes: 205 * KIB,
  largestCssGzipBytes: 42 * KIB,
});

function controlUiAssetPathFromUrl(value) {
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

export function extractControlUiStartupAssetPaths(html) {
  const assets = new Set();
  for (const tag of html.matchAll(/<(?:link|script)\b[^>]*>/giu)) {
    const attribute = tag[0].match(/\s(?:href|src)\s*=\s*["']([^"']+)["']/iu);
    const assetPath = attribute ? controlUiAssetPathFromUrl(attribute[1]) : null;
    if (assetPath) {
      assets.add(assetPath);
    }
  }
  return [...assets].toSorted((left, right) => left.localeCompare(right));
}

function readAssetMetrics(assetsDir, entry) {
  const file = `assets/${entry.name}`;
  const sourcePath = path.join(assetsDir, entry.name);
  const gzipPath = `${sourcePath}.gz`;
  const brotliPath = `${sourcePath}.br`;
  for (const sidecarPath of [gzipPath, brotliPath]) {
    if (!fs.existsSync(sidecarPath)) {
      throw new Error(`Control UI performance check missing ${path.basename(sidecarPath)}`);
    }
  }
  return {
    file,
    type: entry.name.endsWith(".js") ? "js" : "css",
    rawBytes: fs.statSync(sourcePath).size,
    gzipBytes: fs.statSync(gzipPath).size,
    brotliBytes: fs.statSync(brotliPath).size,
  };
}

function summarizeAssets(assets) {
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

function largestAsset(assets) {
  return assets.toSorted(
    (left, right) => right.gzipBytes - left.gzipBytes || left.file.localeCompare(right.file),
  )[0];
}

export function collectControlUiPerformanceMetrics(distDir) {
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
    schemaVersion: 1,
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
  metrics,
  budgets = CONTROL_UI_PERFORMANCE_BUDGETS,
) {
  const checks = [
    ["startup JS requests", metrics.startup.js.requests, budgets.startupJsRequests, "count"],
    ["startup CSS requests", metrics.startup.css.requests, budgets.startupCssRequests, "count"],
    ["startup JS gzip", metrics.startup.js.gzipBytes, budgets.startupJsGzipBytes, "bytes"],
    ["startup CSS gzip", metrics.startup.css.gzipBytes, budgets.startupCssGzipBytes, "bytes"],
    ["largest JS gzip", metrics.largest.js.gzipBytes, budgets.largestJsGzipBytes, "bytes"],
    ["largest CSS gzip", metrics.largest.css.gzipBytes, budgets.largestCssGzipBytes, "bytes"],
  ];
  return checks.flatMap(([metric, actual, limit, unit]) =>
    actual > limit ? [{ metric, actual, limit, unit }] : [],
  );
}

export function formatControlUiPerformanceBytes(bytes) {
  return bytes < KIB ? `${bytes} B` : `${(bytes / KIB).toFixed(1)} KiB`;
}

function formatRequestCount(count) {
  return `${count} ${count === 1 ? "request" : "requests"}`;
}

function formatAssetSummary(summary) {
  return `${formatRequestCount(summary.requests)}, ${formatControlUiPerformanceBytes(summary.gzipBytes)} gzip, ${formatControlUiPerformanceBytes(summary.brotliBytes)} br`;
}

function formatViolation(violation) {
  const actual =
    violation.unit === "bytes"
      ? formatControlUiPerformanceBytes(violation.actual)
      : String(violation.actual);
  const limit =
    violation.unit === "bytes"
      ? formatControlUiPerformanceBytes(violation.limit)
      : String(violation.limit);
  return `${violation.metric}: ${actual} exceeds ${limit}`;
}

export function formatControlUiPerformanceReport(
  metrics,
  budgets = CONTROL_UI_PERFORMANCE_BUDGETS,
) {
  const violations = evaluateControlUiPerformanceBudgets(metrics, budgets);
  const lines = [
    "Control UI performance:",
    `  startup JS: ${formatAssetSummary(metrics.startup.js)} (limits: ${formatRequestCount(budgets.startupJsRequests)}, ${formatControlUiPerformanceBytes(budgets.startupJsGzipBytes)} gzip)`,
    `  startup CSS: ${formatAssetSummary(metrics.startup.css)} (limits: ${formatRequestCount(budgets.startupCssRequests)}, ${formatControlUiPerformanceBytes(budgets.startupCssGzipBytes)} gzip)`,
    `  largest JS: ${metrics.largest.js.file}, ${formatControlUiPerformanceBytes(metrics.largest.js.gzipBytes)} gzip (limit: ${formatControlUiPerformanceBytes(budgets.largestJsGzipBytes)})`,
    `  largest CSS: ${metrics.largest.css.file}, ${formatControlUiPerformanceBytes(metrics.largest.css.gzipBytes)} gzip (limit: ${formatControlUiPerformanceBytes(budgets.largestCssGzipBytes)})`,
    `  all JS: ${formatAssetSummary(metrics.total.js)}`,
    `  all CSS: ${formatAssetSummary(metrics.total.css)}`,
  ];
  if (violations.length > 0) {
    lines.push(
      "  violations:",
      ...violations.map((violation) => `    - ${formatViolation(violation)}`),
    );
  }
  return lines.join("\n");
}

export function runControlUiPerformanceCheck(distDir, budgets = CONTROL_UI_PERFORMANCE_BUDGETS) {
  const metrics = collectControlUiPerformanceMetrics(distDir);
  return {
    metrics,
    budgets,
    violations: evaluateControlUiPerformanceBudgets(metrics, budgets),
    report: formatControlUiPerformanceReport(metrics, budgets),
  };
}

function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((arg) => arg !== "--json");
  if (unknown.length > 0) {
    throw new Error(`Unknown option: ${unknown[0]}`);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const result = runControlUiPerformanceCheck(path.resolve(here, "../dist/control-ui"));
  if (argv.includes("--json")) {
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
