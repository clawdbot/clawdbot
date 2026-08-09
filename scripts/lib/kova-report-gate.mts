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
const INSTRUMENTED_PERFORMANCE_REASON = "instrumented-performance-measurement";
const REQUIRE_INSTRUMENTED_PERFORMANCE_CONTRACT_FLAG =
  "--require-instrumented-performance-contract";
const RSS_METRICS = ["peakRssMb", "resourcePeakGatewayRssMb"];
const CPU_METRICS = ["cpuPercentMax"];
const DIRECT_VIOLATIONS = new Set(["cpuPercentMax", "peakRssMb"]);
const SOAK_VIOLATIONS = new Set(["gatewayRssGrowthMb", "rssGrowthMb"]);
const ROLE_VIOLATION = /^resourceByRole\.([^.]+)\.(maxCpuPercent|peakRssMb)$/u;

type JsonRecord = Record<string, unknown>;
type KovaReportGateOptions = { requireInstrumentedPerformanceContract?: boolean };

// This gate is copied into standalone report fixtures without workspace packages.
function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function check(condition: unknown, reason: string): asserts condition {
  if (!condition) {
    throw new Error(reason);
  }
}

function object(value: unknown, label: string) {
  check(isRecord(value), `invalid ${label}`);
  return value;
}

function hasOwn(value: unknown, key: PropertyKey) {
  return isRecord(value) && Object.hasOwn(value, key);
}

function array(value: unknown, label: string) {
  check(Array.isArray(value), `invalid ${label}`);
  return value;
}

function recordViolations(record: JsonRecord) {
  if (!Object.hasOwn(record, "violations")) {
    return [];
  }
  return array(record.violations, "record violations");
}

function count(value: unknown, label: string, { positive = false }: { positive?: boolean } = {}) {
  check(
    typeof value === "number" && Number.isSafeInteger(value) && value >= (positive ? 1 : 0),
    `invalid ${label}`,
  );
  return value;
}

function text(value: unknown, label: string) {
  check(typeof value === "string" && value.trim().length > 0, `invalid ${label}`);
  return value;
}

function finite(value: unknown, label: string) {
  check(typeof value === "number" && Number.isFinite(value), `invalid ${label}`);
  return value;
}

function finiteOrNull(value: unknown) {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function stateId(record: JsonRecord) {
  return text(object(record.state, "record state").id, "record state id");
}

function recordKey(record: JsonRecord) {
  return [
    text(record.scenario, "record scenario"),
    text(record.surface, "record surface"),
    stateId(record),
  ].join("\u0000");
}

function statusCounts(records: JsonRecord[]) {
  const statuses: Record<string, number> = {};
  for (const record of records) {
    const status = text(record.status, "record status");
    statuses[status] = (statuses[status] ?? 0) + 1;
  }
  return statuses;
}

function exactCounts(actualValue: unknown, expected: Record<string, number>, label: string) {
  const actual = object(actualValue, label);
  check(Object.keys(actual).length === Object.keys(expected).length, `${label} keys did not match`);
  for (const [key, expectedCount] of Object.entries(expected)) {
    check(count(actual[key], `${label}.${key}`) === expectedCount, `${label}.${key} did not match`);
  }
}

function exactStrings(actualValue: unknown, expected: unknown[], label: string) {
  const actual = array(actualValue, label);
  check(
    actual.length === expected.length && actual.every((value, index) => value === expected[index]),
    `${label} did not match`,
  );
}

function validateCommandResult(value: unknown, label: string) {
  const result = object(value, label);
  check(result.status === 0 && result.timedOut === false, `${label} failed`);
}

function validateCollectorOnlyPhase(phase: JsonRecord) {
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

function validateCleanup(
  status: unknown,
  resultValue: unknown,
  successStatus: string,
  noun: string,
  label: string,
) {
  const result = object(resultValue, `${label} result`);
  if (status === successStatus) {
    validateCommandResult(result, `${label} result`);
    return;
  }
  check(status === "already-absent", `${label} was not completed`);
  check(
    Number.isSafeInteger(result.status) && result.status !== 0,
    `${noun} cleanup status was invalid`,
  );
  check(result.timedOut === false, `${noun} cleanup timed out`);
  const output = [result.stdout, result.stderr]
    .filter((value) => typeof value === "string")
    .join("\n");
  const missing = new RegExp(`\\b${noun}\\b[\\s\\S]*\\b(?:does not exist|not found)\\b`, "iu").test(
    output,
  );
  check(missing, `${noun} cleanup lacked already-absent evidence`);
}

function validateRecord(recordValue: unknown) {
  const record = object(recordValue, "record");
  recordKey(record);
  const measurements = object(record.measurements, "record measurements");
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
  return Object.assign({}, record, { measurements, profiling });
}

type ValidatedRecord = ReturnType<typeof validateRecord>;

function validateBaselines(report: JsonRecord, gate: JsonRecord) {
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
  ] satisfies Array<[string, string]>) {
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

function validateMetric(metricValue: unknown, sampleCount: number, label: string) {
  const metric = object(metricValue, label);
  const samples = array(metric.samples, `${label} samples`);
  const metricCount = count(metric.count, `${label} count`, { positive: true });
  check(metricCount === samples.length && metricCount <= sampleCount, `${label} count drift`);
  check(
    metric.classification === "stable" || metric.classification === "unstable",
    `${label} classification was invalid`,
  );
  return samples.map((sample) => finite(sample, `${label} sample`));
}

function sampledMetric(metrics: JsonRecord, ids: string[], sampleCount: number, label: string) {
  for (const id of ids) {
    if (metrics[id] !== undefined) {
      const samples = validateMetric(metrics[id], sampleCount, `${label}.${id}`);
      check(samples.length === sampleCount, `${label}.${id} did not cover every record`);
      return { id, samples };
    }
  }
  throw new Error(`${label} was not sampled`);
}

function measured(record: ValidatedRecord, ids: string[], label: string) {
  for (const id of ids) {
    if (record.measurements[id] !== undefined) {
      return finite(record.measurements[id], `${label}.${id}`);
    }
  }
  throw new Error(`${label} was not measured`);
}

function validatePerformance(report: JsonRecord, records: ValidatedRecord[], repeat: number) {
  const performance = object(report.performance, "performance");
  check(performance.schemaVersion === SCHEMA.performance, "wrong performance schema");
  check(performance.repeat === repeat, "performance repeat did not match controls");
  const groups = array(performance.groups, "performance groups");
  check(
    count(performance.groupCount, "performance group count") === groups.length,
    "group count drift",
  );

  const recordsByKey = new Map<string, ValidatedRecord[]>();
  for (const record of records) {
    const key = recordKey(record);
    const matching = recordsByKey.get(key) ?? [];
    matching.push(record);
    recordsByKey.set(key, matching);
  }
  check(groups.length === recordsByKey.size, "performance groups did not map to records");

  const groupsByKey = new Map<string, JsonRecord>();
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
    check(matching !== undefined && matching.length > 0, "performance group had no records");
    const sampleCount = count(group.sampleCount, "group sample count", { positive: true });
    check(sampleCount === matching.length, "sample count drift");
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
      validateMetric(metric, sampleCount, `group metric ${id}`),
    );
    const rss = sampledMetric(metrics, RSS_METRICS, sampleCount, "group RSS");
    const cpu = sampledMetric(metrics, CPU_METRICS, sampleCount, "group CPU");
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
  const unstableCount = groups.filter((groupValue) => {
    const group = object(groupValue, "performance group");
    return Object.values(object(group.metrics, "group metrics")).some(
      (metricValue) => object(metricValue, "group metric").classification === "unstable",
    );
  }).length;
  check(
    count(performance.unstableGroupCount, "unstable group count") === unstableCount,
    "unstable group count drift",
  );
  return groupsByKey;
}

function instrumentedRecordKey(record: ValidatedRecord, required: boolean) {
  const assessment = object(
    record.performanceThresholdAssessment,
    "performance threshold assessment",
  );
  const skipped = array(assessment.skipped, "skipped performance thresholds");
  const skippedCount = count(assessment.skippedCount, "skipped threshold count");
  const complete = skippedCount === 0;
  check(
    record.profiling.enabled === true &&
      record.profiling.affectsPerformanceMeasurements === true &&
      record.profiling.baselineEligible === false &&
      record.measurements.profilingAffectsPerformanceMeasurements === true &&
      record.measurements.performanceThresholdSkippedCount === skippedCount &&
      assessment.schemaVersion === "kova.performanceThresholdAssessment.v1" &&
      assessment.complete === complete &&
      (complete
        ? assessment.reason === null && assessment.rerun === null
        : assessment.reason === INSTRUMENTED_PERFORMANCE_REASON &&
          typeof assessment.rerun === "string") &&
      skipped.length === skippedCount,
    "instrumented performance assessment was invalid",
  );
  if (complete) {
    return null;
  }
  check(
    skipped.every((entryValue) => {
      const entry = object(entryValue, "skipped performance threshold");
      return (
        entry.status === "SKIPPED" &&
        entry.reason === INSTRUMENTED_PERFORMANCE_REASON &&
        entry.affectsRecordStatus === false &&
        typeof entry.metric === "string" &&
        entry.metric.trim().length > 0 &&
        finiteOrNull(entry.actual) &&
        finiteOrNull(entry.threshold)
      );
    }),
    "skipped performance threshold was invalid",
  );
  const first = object(skipped[0], "first skipped performance threshold");
  return JSON.stringify([
    text(record.scenario, "record scenario"),
    stateId(record),
    required,
    skippedCount,
    first.metric,
    first.actual,
    first.threshold,
  ]);
}

function recordAffectsPerformanceMeasurements(record: ValidatedRecord) {
  const profiling = object(record.profiling, "record profiling");
  const measurements = object(record.measurements, "record measurements");
  const affects =
    profiling.nodeProfile === true ||
    profiling.heapSnapshot === true ||
    profiling.diagnosticReport === true;
  check(
    profiling.affectsPerformanceMeasurements === affects &&
      measurements.profilingAffectsPerformanceMeasurements === affects,
    "record profiling performance provenance drift",
  );
  return affects;
}

function expectedInstrumentedEvidence(gate: JsonRecord, records: ValidatedRecord[]) {
  const warnings = array(gate.warning, "gate warning policy");
  const evidence = new Map<string, number>();
  for (const record of records) {
    const affectsPerformanceMeasurements = recordAffectsPerformanceMeasurements(record);
    if (!affectsPerformanceMeasurements || record.status !== "PASS") {
      continue;
    }
    const scenario = text(record.scenario, "record scenario");
    const state = stateId(record);
    const required = !warnings.some((entryValue) => {
      const entry = object(entryValue, "gate warning policy entry");
      return entry.scenario === scenario && (!entry.state || entry.state === state);
    });
    const key = instrumentedRecordKey(record, required);
    if (key === null) {
      continue;
    }
    check(
      gate.verdict === "PARTIAL",
      "non-PARTIAL report contained incomplete instrumented performance evidence",
    );
    evidence.set(key, (evidence.get(key) ?? 0) + 1);
  }
  return evidence;
}

function instrumentedCardKey(card: JsonRecord) {
  check(
    card.status === "SKIPPED" &&
      typeof card.required === "boolean" &&
      array(card.violations, "instrumented performance card violations").length === 0,
    "instrumented performance card metadata was invalid",
  );
  const scenario = text(card.scenario, "instrumented performance card scenario");
  const state = text(card.state, "instrumented performance card state");
  const measurements = object(card.measurements, "instrumented performance card measurements");
  return JSON.stringify([
    scenario,
    state,
    card.required,
    count(measurements.skippedCount, "card skipped threshold count", { positive: true }),
    text(measurements.firstMetric, "card first skipped metric"),
    finiteOrNull(measurements.firstActual) ? measurements.firstActual : "invalid",
    finiteOrNull(measurements.firstThreshold) ? measurements.firstThreshold : "invalid",
  ]);
}

function hasInstrumentedPerformanceContractMarker(gate: JsonRecord, records: unknown[]) {
  if (
    hasOwn(gate, "instrumentedPerformanceIncompleteCount") ||
    (Array.isArray(gate.cards) &&
      gate.cards.some(
        (card) => hasOwn(card, "kind") && card.kind === "instrumented-performance-thresholds",
      ))
  ) {
    return true;
  }
  return records.some((record) => {
    if (!isRecord(record)) {
      return false;
    }
    return (
      hasOwn(record, "performanceThresholdAssessment") ||
      hasOwn(record.profiling, "affectsPerformanceMeasurements") ||
      hasOwn(record.measurements, "profilingAffectsPerformanceMeasurements") ||
      hasOwn(record.measurements, "performanceThresholdSkippedCount")
    );
  });
}

function validateGateCards(
  gate: JsonRecord,
  records: ValidatedRecord[],
  validateInstrumentedPerformance: boolean,
) {
  const cards = array(gate.cards, "gate cards");
  const validatedCards: JsonRecord[] = [];
  const severities: Record<"blocking" | "warning" | "info", number> = {
    blocking: 0,
    warning: 0,
    info: 0,
  };
  const instrumentedEvidence = validateInstrumentedPerformance
    ? expectedInstrumentedEvidence(gate, records)
    : new Map();
  let requiredInstrumented = 0;
  for (const cardValue of cards) {
    const card = object(cardValue, "gate card");
    validatedCards.push(card);
    const severity = card.severity;
    check(
      severity === "blocking" || severity === "warning" || severity === "info",
      "unknown gate card severity",
    );
    if (severity === "info") {
      check(
        (card.kind === "filtered-required-scenario" ||
          card.kind === "filtered-required-coverage") &&
          card.status === "MISSING",
        "unexpected info gate card",
      );
    }
    if (severity === "warning") {
      if (card.kind === "instrumented-performance-thresholds") {
        const key = instrumentedCardKey(card);
        const remaining = instrumentedEvidence.get(key) ?? 0;
        check(remaining > 0, "instrumented performance card lacked matching evidence");
        if (remaining === 1) {
          instrumentedEvidence.delete(key);
        } else {
          instrumentedEvidence.set(key, remaining - 1);
        }
        requiredInstrumented += Number(card.required);
      } else {
        check(
          card.kind === "missing-required-coverage" && card.status === "MISSING",
          "unexpected warning gate card",
        );
      }
    }
    severities[severity] += 1;
  }
  check(
    instrumentedEvidence.size === 0,
    "instrumented performance evidence lacked matching gate cards",
  );
  if (validateInstrumentedPerformance) {
    check(
      count(gate.instrumentedPerformanceIncompleteCount, "instrumented incomplete count") ===
        requiredInstrumented,
      "instrumented incomplete count drift",
    );
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
  return { cards: validatedCards, requiredInstrumented };
}

function validateEnvelope(reportValue: unknown, options: KovaReportGateOptions = {}) {
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
  const recordValues = array(report.records, "records");
  const validateInstrumentedPerformance =
    options.requireInstrumentedPerformanceContract === true ||
    hasInstrumentedPerformanceContractMarker(gate, recordValues);
  const records = recordValues.map(validateRecord);
  check(records.length > 0, "report had no records");
  validateBaselines(report, gate);
  const summary = object(report.summary, "report summary");
  check(
    count(summary.total, "summary total") === records.length,
    "summary total did not match records",
  );
  exactCounts(summary.statuses, statusCounts(records), "summary statuses");
  if (text(report.target, "report target").startsWith("local-build:")) {
    const cleanup = object(report.targetCleanup, "target cleanup");
    validateCleanup(cleanup.status, cleanup.result, "removed", "runtime", "target cleanup");
  } else {
    check(report.targetCleanup === null, "non-local target had cleanup metadata");
  }
  const groups = validatePerformance(report, records, repeat);
  const { cards, requiredInstrumented } = validateGateCards(
    gate,
    records,
    validateInstrumentedPerformance,
  );
  return { report, gate, records, cards, groups, requiredInstrumented };
}

function deepProfiled(record: ValidatedRecord) {
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

function violationMeasurement(record: ValidatedRecord, violation: JsonRecord) {
  const metric = text(violation.metric, "violation metric");
  if (violation.kind === "threshold" && DIRECT_VIOLATIONS.has(metric)) {
    return finite(record.measurements[metric], `measurement ${metric}`);
  }
  if (violation.kind === "soak" && SOAK_VIOLATIONS.has(metric)) {
    return finite(record.measurements[metric], `measurement ${metric}`);
  }
  const match = violation.kind === "resource" ? ROLE_VIOLATION.exec(metric) : null;
  check(match !== null && violation.role === match[1], "role violation identity was invalid");
  const roleId = match[1];
  const roleMetric = match[2];
  check(roleId !== undefined && roleMetric !== undefined, "role violation metric was invalid");
  const roleMeasurement = object(
    object(record.measurements.resourceByRole, "role measurements")[roleId],
    "role measurement",
  );
  return finite(roleMeasurement[roleMetric], `role measurement ${metric}`);
}

function validateProfiledFailure(record: ValidatedRecord, card: JsonRecord, group: JsonRecord) {
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
        count(group.sampleCount, "group sample count", { positive: true }),
        `violation group metric ${metric}`,
      );
      check(samples.includes(actual), "violation was not sampled in its performance group");
    }
    text(violation.expected, "violation expectation");
    text(violation.message, "violation message");
  }
  const messages = violations.map((violation) => object(violation, "violation").message);
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

function evaluate(evaluator: () => void) {
  try {
    evaluator();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function evaluateToleratedPartialKovaReport(
  report: unknown,
  options: KovaReportGateOptions = {},
) {
  return evaluate(() => {
    const { gate, records, cards, requiredInstrumented } = validateEnvelope(report, options);
    check(gate.verdict === "PARTIAL", "gate verdict was not PARTIAL");
    check(gate.blockingCount === 0, "PARTIAL gate had blocking cards");
    check(
      requiredInstrumented === 0,
      "PARTIAL gate had incomplete required instrumented performance evidence",
    );
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

export function evaluateToleratedProfiledKovaReport(
  report: unknown,
  options: KovaReportGateOptions = {},
) {
  return evaluate(() => {
    const { gate, records, cards, groups } = validateEnvelope(report, options);
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
      const group = groups.get(recordKey(record));
      check(card !== undefined && group !== undefined, "profiled failure evidence was incomplete");
      validateProfiledFailure(record, card, group);
    }
    check(remaining.length === 0, "blocking cards did not map one-to-one");
  });
}

export function evaluateToleratedKovaReport(report: unknown, options: KovaReportGateOptions = {}) {
  const partial = evaluateToleratedPartialKovaReport(report, options);
  if (partial.ok) {
    return { ok: true, classification: "filtered-partial" };
  }
  const profiled = evaluateToleratedProfiledKovaReport(report, options);
  if (profiled.ok) {
    return { ok: true, classification: "profiled-resource-only" };
  }
  return { ok: false, reason: `partial: ${partial.reason}; profiled: ${profiled.reason}` };
}

function readCliInvocation() {
  let reportPath: string | undefined;
  let requireInstrumentedPerformanceContract = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === REQUIRE_INSTRUMENTED_PERFORMANCE_CONTRACT_FLAG) {
      requireInstrumentedPerformanceContract = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else if (reportPath === undefined) {
      reportPath = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  reportPath ??= process.env.REPORT_JSON;
  if (!reportPath) {
    throw new Error(
      `usage: node scripts/lib/kova-report-gate.mjs [${REQUIRE_INSTRUMENTED_PERFORMANCE_CONTRACT_FLAG}] <report.json>`,
    );
  }
  return {
    options: { requireInstrumentedPerformanceContract },
    reportPath,
  };
}

const modulePath = fs.realpathSync.native(fileURLToPath(import.meta.url));
const invokedPath = process.argv[1] ? fs.realpathSync.native(path.resolve(process.argv[1])) : "";

if (modulePath === invokedPath) {
  try {
    const invocation = readCliInvocation();
    const report = JSON.parse(fs.readFileSync(invocation.reportPath, "utf8"));
    const result = evaluateToleratedKovaReport(report, invocation.options);
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
