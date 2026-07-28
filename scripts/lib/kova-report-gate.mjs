import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const SCHEMA = {
  report: "kova.report.v1",
  gate: "kova.gate.v1",
  performance: "kova.performance.v1",
  profiling: "kova.profiling.v1",
  baseline: "kova.baselineComparison.v1",
  gateBaseline: "kova.gateBaselineSummary.v1",
};
const PROFILED_INTERPRETATION =
  "instrumented run; CPU/RSS can include profiler and diagnostic overhead";
const RSS_METRICS = ["peakRssMb", "resourcePeakGatewayRssMb"];
const CPU_METRICS = ["cpuPercentMax"];
const DIRECT_VIOLATIONS = new Set(["cpuPercentMax", "peakRssMb"]);
const SOAK_VIOLATIONS = new Set(["gatewayRssGrowthMb", "rssGrowthMb"]);
const ROLE_VIOLATION = /^resourceByRole\.([^.]+)\.(maxCpuPercent|peakRssMb)$/u;
function check(condition, reason) {
  if (!condition) {
    throw new Error(reason);
  }
}

function object(value, label) {
  check(value !== null && typeof value === "object" && !Array.isArray(value), `invalid ${label}`);
  return value;
}

function array(value, label) {
  check(Array.isArray(value), `invalid ${label}`);
  return value;
}

function recordViolations(record) {
  if (!Object.hasOwn(record, "violations")) {
    return [];
  }
  return array(record.violations, "record violations");
}

function count(value, label, { positive = false } = {}) {
  check(Number.isSafeInteger(value) && value >= (positive ? 1 : 0), `invalid ${label}`);
  return value;
}

function text(value, label) {
  check(typeof value === "string" && value.trim().length > 0, `invalid ${label}`);
  return value;
}

function finite(value, label) {
  check(typeof value === "number" && Number.isFinite(value), `invalid ${label}`);
  return value;
}

function stateId(record) {
  return text(object(record.state, "record state").id, "record state id");
}

function recordKey(record) {
  return [
    text(record.scenario, "record scenario"),
    text(record.surface, "record surface"),
    stateId(record),
  ].join("\u0000");
}

function statusCounts(records) {
  const statuses = {};
  for (const record of records) {
    text(record.status, "record status");
    statuses[record.status] = (statuses[record.status] ?? 0) + 1;
  }
  return statuses;
}

function exactCounts(actualValue, expected, label) {
  const actual = object(actualValue, label);
  check(Object.keys(actual).length === Object.keys(expected).length, `${label} keys did not match`);
  for (const [key, expectedCount] of Object.entries(expected)) {
    check(count(actual[key], `${label}.${key}`) === expectedCount, `${label}.${key} did not match`);
  }
}

function exactStrings(actualValue, expected, label) {
  const actual = array(actualValue, label);
  check(
    actual.length === expected.length && actual.every((value, index) => value === expected[index]),
    `${label} did not match`,
  );
}

function validateCommandResult(value, label) {
  const result = object(value, label);
  check(result.status === 0 && result.timedOut === false, `${label} failed`);
}

function validateCollectorOnlyPhase(phase) {
  check(
    phase.driverKind === "none" && phase.collectionIntent === "post-ready-health",
    "commandless phase was not a collector-only phase",
  );
  const evidence = array(phase.evidence, "collector-only phase evidence");
  check(
    evidence.length > 0 &&
      evidence.every((entry) => typeof entry === "string" && entry.trim().length > 0),
    "collector-only phase evidence was invalid",
  );
  check(
    object(phase.metrics, "collector-only phase metrics").schemaVersion === "kova.envMetrics.v1",
    "collector-only phase metrics schema was invalid",
  );
}

function alreadyAbsent(result, noun) {
  check(
    Number.isSafeInteger(result.status) && result.status !== 0,
    `${noun} cleanup status was invalid`,
  );
  check(result.timedOut === false, `${noun} cleanup timed out`);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const missing = new RegExp(`\\b${noun}\\b[\\s\\S]*\\b(?:does not exist|not found)\\b`, "iu").test(
    output,
  );
  check(missing, `${noun} cleanup lacked already-absent evidence`);
}

function validateCleanup(status, resultValue, successStatus, noun, label) {
  const result = object(resultValue, `${label} result`);
  if (status === successStatus) {
    validateCommandResult(result, `${label} result`);
    return;
  }
  check(status === "already-absent", `${label} was not completed`);
  alreadyAbsent(result, noun);
}

function validateRecord(recordValue) {
  const record = object(recordValue, "record");
  recordKey(record);
  object(record.measurements, "record measurements");
  const profiling = object(record.profiling, "record profiling");
  check(profiling.schemaVersion === SCHEMA.profiling, "wrong profiling schema");
  const phases = array(record.phases, "record phases");
  check(phases.length > 0, "record had no phases");
  for (const phaseValue of phases) {
    const phase = object(phaseValue, "phase");
    const commands = array(phase.commands, "phase commands");
    const results = array(phase.results, "phase results");
    check(commands.length === results.length, "phase command/result counts did not match");
    if (commands.length === 0) {
      validateCollectorOnlyPhase(phase);
      continue;
    }
    results.forEach((resultValue, index) => {
      const result = object(resultValue, `phase result ${index}`);
      check(
        text(result.command, `phase result ${index} command`) ===
          text(commands[index], `phase command ${index}`),
        `phase command ${index} did not match its result`,
      );
      validateCommandResult(result, `phase result ${index}`);
    });
  }
  validateCleanup(
    record.cleanup,
    record.cleanupResult,
    "destroyed",
    "environment",
    "record cleanup",
  );
  return record;
}

function validateTargetCleanup(report) {
  if (!text(report.target, "report target").startsWith("local-build:")) {
    check(report.targetCleanup === null, "non-local target had cleanup metadata");
    return;
  }
  const cleanup = object(report.targetCleanup, "target cleanup");
  validateCleanup(cleanup.status, cleanup.result, "removed", "runtime", "target cleanup");
}

function validateBaselines(report, gate) {
  const reportBaseline = report.baseline;
  const gateBaseline = gate.baseline;
  check(
    (reportBaseline === null || reportBaseline === undefined) ===
      (gateBaseline === null || gateBaseline === undefined),
    "baseline evidence was one-sided",
  );
  if (reportBaseline === null || reportBaseline === undefined) {
    return;
  }
  const comparison = object(
    object(reportBaseline, "report baseline").comparison,
    "baseline comparison",
  );
  const summary = object(gateBaseline, "gate baseline");
  check(comparison.schemaVersion === SCHEMA.baseline, "wrong baseline comparison schema");
  check(summary.schemaVersion === SCHEMA.gateBaseline, "wrong gate baseline schema");
  for (const [field, listField] of [
    ["regressionCount", "regressions"],
    ["missingBaselineCount", "missing"],
  ]) {
    check(count(comparison[field], `baseline ${field}`) === 0, `baseline ${field} was nonzero`);
    check(
      array(comparison[listField], `baseline ${listField}`).length === 0,
      `baseline ${listField} present`,
    );
    check(
      count(summary[field], `gate baseline ${field}`) === 0,
      `gate baseline ${field} was nonzero`,
    );
    const gateList = field === "regressionCount" ? "regressedGroups" : listField;
    check(
      array(summary[gateList], `gate baseline ${gateList}`).length === 0,
      `gate baseline ${gateList} present`,
    );
  }
  check(comparison.ok === true && summary.ok === true, "baseline was not ok");
  check(
    count(comparison.baselineEntryCount, "baseline entry count") ===
      count(summary.baselineEntryCount, "gate baseline entry count"),
    "baseline entry counts did not match",
  );
}

function validateSummary(report, records) {
  const summary = object(report.summary, "report summary");
  check(
    count(summary.total, "summary total") === records.length,
    "summary total did not match records",
  );
  exactCounts(summary.statuses, statusCounts(records), "summary statuses");
}

function validateMetric(metricValue, sampleCount, label) {
  const metric = object(metricValue, label);
  const samples = array(metric.samples, `${label} samples`);
  const metricCount = count(metric.count, `${label} count`, { positive: true });
  check(metricCount === samples.length && metricCount <= sampleCount, `${label} count drift`);
  check(
    metric.classification === "stable" || metric.classification === "unstable",
    `${label} classification was invalid`,
  );
  samples.forEach((sample) => finite(sample, `${label} sample`));
  return samples;
}

function sampledMetric(metrics, ids, sampleCount, label) {
  for (const id of ids) {
    if (metrics[id] !== undefined) {
      const samples = validateMetric(metrics[id], sampleCount, `${label}.${id}`);
      check(samples.length === sampleCount, `${label}.${id} did not cover every record`);
      return { id, samples };
    }
  }
  throw new Error(`${label} was not sampled`);
}

function measured(record, ids, label) {
  for (const id of ids) {
    if (record.measurements[id] !== undefined) {
      return finite(record.measurements[id], `${label}.${id}`);
    }
  }
  throw new Error(`${label} was not measured`);
}

function validatePerformance(report, records, repeat) {
  const performance = object(report.performance, "performance");
  check(performance.schemaVersion === SCHEMA.performance, "wrong performance schema");
  check(performance.repeat === repeat, "performance repeat did not match controls");
  const groups = array(performance.groups, "performance groups");
  check(
    count(performance.groupCount, "performance group count") === groups.length,
    "group count drift",
  );

  const recordsByKey = new Map();
  for (const record of records) {
    const key = recordKey(record);
    const matching = recordsByKey.get(key) ?? [];
    matching.push(record);
    recordsByKey.set(key, matching);
  }
  check(groups.length === recordsByKey.size, "performance groups did not map to records");

  const groupsByKey = new Map();
  let profiledCount = 0;
  for (const groupValue of groups) {
    const group = object(groupValue, "performance group");
    const identity = [
      text(group.scenario, "group scenario"),
      text(group.surface, "group surface"),
      text(group.state, "group state"),
    ];
    const key = identity.join("\u0000");
    check(
      group.key === identity.join("|") && !groupsByKey.has(key),
      "performance group identity was invalid",
    );
    const matching = recordsByKey.get(key);
    check(matching?.length > 0, "performance group had no records");
    check(
      count(group.sampleCount, "group sample count", { positive: true }) === matching.length,
      "sample count drift",
    );
    exactCounts(group.statuses, statusCounts(matching), "group statuses");
    const matchingProfiled = matching.filter((record) => record.profiling.enabled === true).length;
    check(
      count(group.profiledRunCount, "group profiled count") === matchingProfiled,
      "profile count drift",
    );
    check(
      group.resourceInterpretation === (matchingProfiled > 0 ? "instrumented" : "normal"),
      "group resource interpretation was invalid",
    );
    profiledCount += matchingProfiled;
    const metrics = object(group.metrics, "group metrics");
    Object.entries(metrics).forEach(([id, metric]) =>
      validateMetric(metric, group.sampleCount, `group metric ${id}`),
    );
    const rss = sampledMetric(metrics, RSS_METRICS, group.sampleCount, "group RSS");
    const cpu = sampledMetric(metrics, CPU_METRICS, group.sampleCount, "group CPU");
    for (const record of matching) {
      check(
        rss.samples.includes(measured(record, RSS_METRICS, "record RSS")),
        "record RSS was not sampled",
      );
      check(
        cpu.samples.includes(measured(record, CPU_METRICS, "record CPU")),
        "record CPU was not sampled",
      );
    }
    groupsByKey.set(key, group);
  }
  check(
    count(performance.profiledRunCount, "performance profiled count") === profiledCount,
    "profile total drift",
  );
  const unstableCount = groups.filter((group) =>
    Object.values(group.metrics).some((metric) => metric.classification === "unstable"),
  ).length;
  check(
    count(performance.unstableGroupCount, "unstable group count") === unstableCount,
    "unstable group count drift",
  );
  return groupsByKey;
}

function validateGateCards(gate) {
  const cards = array(gate.cards, "gate cards");
  const severities = { blocking: 0, warning: 0, info: 0 };
  for (const cardValue of cards) {
    const card = object(cardValue, "gate card");
    const severity = card.severity;
    check(Object.hasOwn(severities, severity), "unknown gate card severity");
    if (severity === "info") {
      check(
        (card.kind === "filtered-required-scenario" ||
          card.kind === "filtered-required-coverage") &&
          card.status === "MISSING",
        "unexpected info gate card",
      );
    }
    if (severity === "warning") {
      check(
        card.kind === "missing-required-coverage" && card.status === "MISSING",
        "unexpected warning gate card",
      );
    }
    severities[severity] += 1;
  }
  check(
    count(gate.blockingCount, "blocking count") === severities.blocking,
    "blocking count drift",
  );
  check(count(gate.warningCount, "warning count") === severities.warning, "warning count drift");
  check(count(gate.infoCount, "info count") === severities.info, "info count drift");
  check(
    count(gate.missingRequiredCount, "missing required count") === severities.info,
    "missing count drift",
  );
  return cards;
}

function validateEnvelope(reportValue) {
  const report = object(reportValue, "report");
  const gate = object(report.gate, "gate");
  const controls = object(report.controls, "controls");
  check(
    report.schemaVersion === SCHEMA.report && report.mode === "execution",
    "wrong report schema or mode",
  );
  check(
    gate.schemaVersion === SCHEMA.gate && gate.enabled === true,
    "wrong or disabled gate schema",
  );
  check(controls.gate === true, "gate controls were disabled");
  const filters = [
    ...array(controls.include, "include filters"),
    ...array(controls.exclude, "exclude filters"),
  ];
  check(
    filters.length > 0 &&
      filters.every((filter) => typeof filter === "string" && filter.trim().length > 0),
    "report filters were invalid",
  );
  const repeat = count(controls.repeat, "repeat", { positive: true });
  check(
    gate.partial === true && gate.complete === false && gate.ok === false,
    "gate metadata was not partial",
  );
  const records = array(report.records, "records").map(validateRecord);
  check(records.length > 0, "report had no records");
  const cards = validateGateCards(gate);
  validateBaselines(report, gate);
  validateSummary(report, records);
  validateTargetCleanup(report);
  const groups = validatePerformance(report, records, repeat);
  return { report, gate, records, cards, groups };
}

function deepProfiled(record) {
  const profiling = record.profiling;
  const measurements = record.measurements;
  return [
    [profiling.enabled, true],
    [profiling.deepProfile, true],
    [profiling.nodeProfile, true],
    [profiling.heapSnapshot, true],
    [profiling.diagnosticReport, true],
    [profiling.profileOnFailure, false],
    [profiling.affectsResourceMeasurements, true],
    [profiling.baselineEligible, false],
    [profiling.interpretation, PROFILED_INTERPRETATION],
    [measurements.profilingEnabled, true],
    [measurements.profilingAffectsResourceMeasurements, true],
    [measurements.profilingBaselineEligible, false],
    [measurements.profilingResourceInterpretation, PROFILED_INTERPRETATION],
  ].every(([actual, expected]) => actual === expected);
}

function violationMeasurement(record, violation) {
  const metric = text(violation.metric, "violation metric");
  if (violation.kind === "threshold" && DIRECT_VIOLATIONS.has(metric)) {
    return finite(record.measurements[metric], `measurement ${metric}`);
  }
  if (violation.kind === "soak" && SOAK_VIOLATIONS.has(metric)) {
    return finite(record.measurements[metric], `measurement ${metric}`);
  }
  const match = violation.kind === "resource" ? ROLE_VIOLATION.exec(metric) : null;
  check(match !== null && violation.role === match[1], "role violation identity was invalid");
  const role = object(
    object(record.measurements.resourceByRole, "role measurements")[match[1]],
    "role measurement",
  );
  return finite(role[match[2]], `role measurement ${metric}`);
}

function validateProfiledFailure(record, card, group) {
  check(deepProfiled(record), "failed record was not canonical deep profiling");
  check(
    group.resourceInterpretation === "instrumented",
    "failed record group was not instrumented",
  );
  const violations = recordViolations(record);
  check(violations.length > 0, "failed record had no violations");
  for (const violationValue of violations) {
    const violation = object(violationValue, "violation");
    const actual = finite(violation.actual, "violation actual");
    check(actual === violationMeasurement(record, violation), "violation evidence drift");
    if (violation.kind === "threshold") {
      const metric = text(violation.metric, "violation metric");
      const samples = validateMetric(
        object(group.metrics, "group metrics")[metric],
        group.sampleCount,
        `violation group metric ${metric}`,
      );
      check(samples.includes(actual), "violation was not sampled in its performance group");
    }
    text(violation.expected, "violation expectation");
    text(violation.message, "violation message");
  }
  const messages = violations.map((violation) => violation.message);
  check(
    card.kind === "openclaw-failure" &&
      card.status === "FAIL" &&
      card.failedCommand === null &&
      card.scenario === record.scenario &&
      card.state === stateId(record),
    "blocking card identity was invalid",
  );
  check(card.summary === messages[0], "blocking card summary did not match");
  exactStrings(card.violations, messages, "blocking card violations");
  const cardMeasurements = object(card.measurements, "blocking card measurements");
  check(
    cardMeasurements.peakRssMb === record.measurements.peakRssMb &&
      cardMeasurements.cpuPercentMax === record.measurements.cpuPercentMax,
    "blocking card measurements did not match",
  );
}

function evaluate(evaluator) {
  try {
    evaluator();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function evaluateToleratedPartialKovaReport(report) {
  return evaluate(() => {
    const { gate, records, cards } = validateEnvelope(report);
    check(gate.verdict === "PARTIAL", "gate verdict was not PARTIAL");
    check(gate.blockingCount === 0, "PARTIAL gate had blocking cards");
    check(
      cards.every((card) => card.severity !== "blocking"),
      "PARTIAL gate had a blocking card",
    );
    check(
      records.every((record) => record.status === "PASS"),
      "PARTIAL report had a non-PASS record",
    );
    check(
      records.every((record) => recordViolations(record).length === 0),
      "PARTIAL report had violations",
    );
  });
}

export function evaluateToleratedProfiledKovaReport(report) {
  return evaluate(() => {
    const { gate, records, cards, groups } = validateEnvelope(report);
    check(gate.verdict === "DO_NOT_SHIP", "gate verdict was not DO_NOT_SHIP");
    check(
      records.every((record) => record.status === "PASS" || record.status === "FAIL"),
      "invalid record status",
    );
    check(
      records
        .filter((record) => record.status === "PASS")
        .every((record) => recordViolations(record).length === 0),
      "PASS record had violations",
    );
    const failed = records.filter((record) => record.status === "FAIL");
    const blocking = cards.filter((card) => card.severity === "blocking");
    check(
      failed.length > 0 && blocking.length === failed.length,
      "failure/card counts did not match",
    );
    const remaining = [...blocking];
    for (const record of failed) {
      const index = remaining.findIndex(
        (card) => card.scenario === record.scenario && card.state === stateId(record),
      );
      check(index >= 0, "blocking cards did not map one-to-one");
      const card = remaining.splice(index, 1)[0];
      validateProfiledFailure(record, card, groups.get(recordKey(record)));
    }
    check(remaining.length === 0, "blocking cards did not map one-to-one");
  });
}

export function evaluateToleratedKovaReport(report) {
  const partial = evaluateToleratedPartialKovaReport(report);
  if (partial.ok) {
    return { ok: true, classification: "filtered-partial" };
  }
  const profiled = evaluateToleratedProfiledKovaReport(report);
  if (profiled.ok) {
    return { ok: true, classification: "profiled-resource-only" };
  }
  return { ok: false, reason: `partial: ${partial.reason}; profiled: ${profiled.reason}` };
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
    const report = JSON.parse(fs.readFileSync(readCliReportPath(), "utf8"));
    const result = evaluateToleratedKovaReport(report);
    if (!result.ok) {
      console.error(`Kova verdict is not tolerable: ${result.reason}`);
      process.exit(1);
    }
    console.log(`Tolerated Kova verdict: ${result.classification}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
