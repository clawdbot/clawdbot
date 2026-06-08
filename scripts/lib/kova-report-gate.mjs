import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function numericCount(value) {
  if (typeof value !== "number") {
    return undefined;
  }
  return Number.isFinite(value) ? value : undefined;
}

const rssMetricIds = ["peakRssMb", "resourcePeakGatewayRssMb"];
const cpuMetricIds = ["cpuPercentMax"];

function hasSampledMetric(group, metricIds) {
  return metricIds.some((metricId) => {
    const metric = group?.metrics?.[metricId];
    return metric && Number(metric.count) > 0;
  });
}

export function evaluateToleratedPartialKovaReport(report) {
  const gate = report?.gate;
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
    return { ok: false, reason: "missing gate metadata" };
  }
  if (gate.verdict !== "PARTIAL") {
    return { ok: false, reason: `gate verdict was ${JSON.stringify(gate.verdict)}` };
  }

  const blockingCount = numericCount(gate.blockingCount);
  if (blockingCount === undefined) {
    return { ok: false, reason: "missing blocking count" };
  }
  if (blockingCount !== 0) {
    return { ok: false, reason: `blocking count was ${JSON.stringify(gate.blockingCount)}` };
  }

  const baselineRegressionCount = numericCount(
    report?.baseline?.comparison?.regressionCount ?? report?.gate?.baseline?.regressionCount,
  );
  if (baselineRegressionCount === undefined) {
    return { ok: false, reason: "missing baseline regression count" };
  }
  if (baselineRegressionCount !== 0) {
    return {
      ok: false,
      reason: `baseline regression count was ${JSON.stringify(baselineRegressionCount)}`,
    };
  }

  const statuses = report?.summary?.statuses;
  if (!statuses || typeof statuses !== "object" || Array.isArray(statuses)) {
    return { ok: false, reason: "missing status summary" };
  }

  const passCount = numericCount(statuses.PASS);
  if (passCount === undefined || passCount <= 0) {
    return { ok: false, reason: "status summary had no PASS records" };
  }

  const nonPassStatuses = Object.entries(statuses).filter(
    ([status, count]) => status !== "PASS" && (numericCount(count) ?? 0) > 0,
  );
  if (nonPassStatuses.length > 0) {
    return {
      ok: false,
      reason: `non-pass statuses present: ${nonPassStatuses
        .map(([status, count]) => `${status}=${count}`)
        .join(", ")}`,
    };
  }

  const records = Array.isArray(report?.records) ? report.records : [];
  if (records.length === 0) {
    return { ok: false, reason: "missing selected scenario records" };
  }

  const groups = Array.isArray(report?.performance?.groups) ? report.performance.groups : [];
  if (groups.length === 0) {
    return { ok: false, reason: "missing performance groups" };
  }

  if (!groups.some((group) => hasSampledMetric(group, rssMetricIds))) {
    return { ok: false, reason: "missing sampled RSS metric in performance groups" };
  }

  if (!groups.some((group) => hasSampledMetric(group, cpuMetricIds))) {
    return { ok: false, reason: "missing sampled CPU metric in performance groups" };
  }

  return { ok: true };
}

function readCliReportPath() {
  const reportPath = process.argv[2] || process.env.REPORT_JSON;
  if (!reportPath) {
    throw new Error("usage: node scripts/lib/kova-report-gate.mjs <report.json>");
  }
  return reportPath;
}

const modulePath = fs.realpathSync.native(fileURLToPath(import.meta.url));
const invokedPath = process.argv[1] ? fs.realpathSync.native(path.resolve(process.argv[1])) : "";

if (modulePath === invokedPath) {
  try {
    const reportPath = readCliReportPath();
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const result = evaluateToleratedPartialKovaReport(report);
    if (!result.ok) {
      console.error(`Kova PARTIAL verdict is not tolerable: ${result.reason}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
