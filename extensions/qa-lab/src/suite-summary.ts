// Qa Lab plugin module implements suite summary behavior.
import fs from "node:fs/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { asSafeIntegerInRange, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { QaSuiteArtifactError } from "./errors.js";
import type { QaEvidenceSummaryJson, QaEvidenceTiming } from "./evidence-summary.js";
import type { QaProviderMode } from "./model-selection.js";
import type { RuntimeId, RuntimeParityResult } from "./runtime-parity.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import type { QaScorecardChannelDriver } from "./scorecard-taxonomy.js";

type QaSuiteSummaryScenario = {
  name: string;
  status: "pass" | "fail" | "skip" | "skipped";
  steps: unknown[];
  details?: string;
  timing?: QaEvidenceTiming;
  runtimeParity?: RuntimeParityResult;
};

export type QaSuiteSummaryJson = {
  scenarios: QaSuiteSummaryScenario[];
  counts: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  metrics?: {
    wallMs: number;
    gatewayProcessCpuMs?: number | null;
    gatewayCpuCoreRatio?: number | null;
    gatewayProcessRssStartBytes?: number | null;
    gatewayProcessRssEndBytes?: number | null;
    gatewayProcessRssDeltaBytes?: number | null;
    gatewayProcessRssPeakBytes?: number | null;
    gatewayProcessRssPeakDeltaBytes?: number | null;
    gatewayProcessRssSamples?: Array<{
      label: string;
      at: string;
      gatewayProcessRssBytes: number;
    }>;
    gatewayHeapSnapshots?: Array<{
      label: string;
      at: string;
      path: string;
      bytes: number;
    }>;
  };
  evidence?: QaEvidenceSummaryJson;
  run: {
    status: "running" | "completed";
    startedAt: string;
    finishedAt: string;
    providerMode: QaProviderMode;
    primaryModel: string;
    primaryProvider: string | null;
    primaryModelName: string | null;
    alternateModel: string;
    alternateProvider: string | null;
    alternateModelName: string | null;
    fastMode: boolean;
    concurrency: number;
    channelDriver: QaScorecardChannelDriver | null;
    channel: string | null;
    channelCapabilityMatrixPath: string | null;
    channelDriverSmokePath: string | null;
    scenarioIds: string[] | null;
    runtimePair?: [RuntimeId, RuntimeId] | null;
  };
};

type QaSuiteScenarioStatus = {
  status?: unknown;
};
type QaSuiteReportOnlyScenario = {
  name?: unknown;
  status?: unknown;
  details?: unknown;
};
function readQaSuiteEvidenceEntries(summary: Record<string, unknown>): unknown[] | undefined {
  if (isRecord(summary.evidence) && Array.isArray(summary.evidence.entries)) {
    return summary.evidence.entries;
  }
  return Array.isArray(summary.entries) ? summary.entries : undefined;
}

function readQaSuiteEvidenceEntryStatus(entry: unknown): unknown {
  return isRecord(entry) && isRecord(entry.result) ? entry.result.status : undefined;
}

function isQaSuiteFailureStatus(status: unknown): boolean {
  return status !== "pass" && status !== "skip" && status !== "skipped";
}

export function findQaSuiteSummaryCompletionError(summary: unknown): string | undefined {
  if (!isRecord(summary)) {
    return "has invalid completion state";
  }
  if (!isRecord(summary.run) || !Object.hasOwn(summary.run, "status")) {
    return "is missing run.status";
  }
  const status = summary.run.status;
  if (status === "completed") {
    return undefined;
  }
  if (status === "running") {
    return "is still running";
  }
  return `has unsupported run.status=${typeof status === "string" ? status : typeof status}`;
}

export async function readCompletedQaSuiteSummaryFile(summaryPath: string): Promise<unknown> {
  let summaryText: string;
  try {
    summaryText = await fs.readFile(summaryPath, "utf8");
  } catch (error) {
    throw new QaSuiteArtifactError(
      "summary_read_failed",
      `Could not read QA summary JSON at ${summaryPath}: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
  try {
    const summary = JSON.parse(summaryText) as unknown;
    const completionError = findQaSuiteSummaryCompletionError(summary);
    if (completionError) {
      throw new QaSuiteArtifactError(
        "summary_not_completed",
        `QA summary at ${summaryPath} ${completionError}.`,
      );
    }
    return summary;
  } catch (error) {
    if (error instanceof QaSuiteArtifactError) {
      throw error;
    }
    throw new QaSuiteArtifactError(
      "summary_parse_failed",
      `Could not parse QA summary JSON at ${summaryPath}: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
}

function readNonNegativeCount(value: unknown): number | null {
  return asSafeIntegerInRange(value, { min: 0 }) ?? null;
}

type QaSuiteOutcomeCounts = {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
};

function countQaSuiteScenarioStatuses(statuses: readonly unknown[]): QaSuiteOutcomeCounts {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const status of statuses) {
    if (status === "pass") {
      passed += 1;
    } else if (status === "skip" || status === "skipped") {
      skipped += 1;
    } else {
      failed += 1;
    }
  }
  return { total: statuses.length, passed, failed, skipped };
}

function isQaSuiteScenarioOutcomeStatus(status: unknown): boolean {
  return status === "pass" || status === "fail" || status === "skip" || status === "skipped";
}

function isQaSuiteEvidenceOutcomeStatus(status: unknown): boolean {
  return (
    status === "pass" ||
    status === "fail" ||
    status === "blocked" ||
    status === "skip" ||
    status === "skipped"
  );
}

function findQaSuiteScenarioCountMismatch(
  counts: QaSuiteOutcomeCounts,
  observed: QaSuiteOutcomeCounts,
): string | undefined {
  for (const key of ["total", "passed", "failed", "skipped"] as const) {
    if (counts[key] !== observed[key]) {
      return `count/scenario mismatch: counts.${key}=${counts[key]}, scenario.${key}=${observed[key]}`;
    }
  }
  return undefined;
}

export function findQaSuiteSummaryAccountingError(summary: unknown): string | undefined {
  if (!isRecord(summary) || summary.counts === undefined) {
    return undefined;
  }
  if (!isRecord(summary.counts)) {
    return "counts must be a non-array object";
  }
  for (const countName of ["total", "passed", "failed", "skipped"] as const) {
    if (
      Object.hasOwn(summary.counts, countName) &&
      readNonNegativeCount(summary.counts[countName]) === null
    ) {
      return `counts.${countName} must be a non-negative safe integer`;
    }
  }

  const total = readNonNegativeCount(summary.counts.total);
  const passed = readNonNegativeCount(summary.counts.passed);
  const failed = readNonNegativeCount(summary.counts.failed);
  const skipped = readNonNegativeCount(summary.counts.skipped);
  const providedCountSum = (passed ?? 0) + (failed ?? 0) + (skipped ?? 0);
  if (total !== null && total < providedCountSum) {
    return `counts.total=${total} is less than provided count sum=${providedCountSum}`;
  }
  if (total === null || passed === null || failed === null || skipped === null) {
    return undefined;
  }
  if (total !== providedCountSum) {
    return `counts.total=${total} does not match counts.passed+counts.failed+counts.skipped=${providedCountSum}`;
  }

  const counts = { total, passed, failed, skipped };
  if (Array.isArray(summary.scenarios) && summary.scenarios.length > 0) {
    const statuses = summary.scenarios.map((scenario) =>
      isRecord(scenario) ? scenario.status : undefined,
    );
    if (statuses.every(isQaSuiteScenarioOutcomeStatus)) {
      const mismatch = findQaSuiteScenarioCountMismatch(
        counts,
        countQaSuiteScenarioStatuses(statuses),
      );
      if (mismatch) {
        return mismatch;
      }
    }
  }
  const evidenceEntries = readQaSuiteEvidenceEntries(summary);
  if (evidenceEntries && evidenceEntries.length > 0) {
    // Evidence rows are producer checks, not scenarios: one passing scenario may
    // legitimately contain blocked and passing checks. Validate only facts that
    // can contradict the aggregate without assuming one row per scenario.
    for (const [index, entry] of evidenceEntries.entries()) {
      const status = readQaSuiteEvidenceEntryStatus(entry);
      if (!isQaSuiteEvidenceOutcomeStatus(status)) {
        return `evidence.entries[${index}].result.status is not a supported outcome`;
      }
      if (status === "fail" && failed === 0) {
        return `counts.failed=0 contradicts failed evidence entry ${index}`;
      }
    }
  }
  return undefined;
}

function assertQaSuiteSummaryHasExecutedScenarios(
  summary: unknown,
  summaryPath: string,
  errorCode: "summary_failure_count_missing" | "summary_blocking_count_missing",
  optionalScenarioNames?: ReadonlySet<string>,
  requireExecutedScenario = false,
): void {
  if (!summary || typeof summary !== "object") {
    return;
  }
  const accountingError = findQaSuiteSummaryAccountingError(summary);
  if (accountingError) {
    throw new QaSuiteArtifactError(
      "summary_counts_invalid",
      `QA summary at ${summaryPath} ${accountingError}.`,
    );
  }
  const payload = summary as {
    counts?: { total?: unknown; passed?: unknown; failed?: unknown; skipped?: unknown };
    scenarios?: unknown;
  };
  const total = readNonNegativeCount(payload.counts?.total);
  const passed = readNonNegativeCount(payload.counts?.passed);
  const failed = readNonNegativeCount(payload.counts?.failed);
  const scenarios = Array.isArray(payload.scenarios)
    ? (payload.scenarios as QaSuiteReportOnlyScenario[])
    : undefined;
  const entries = isRecord(summary) ? readQaSuiteEvidenceEntries(summary) : undefined;
  const hasObservedOutcomeRows = (scenarios?.length ?? 0) > 0 || (entries?.length ?? 0) > 0;
  const hasCompletedScenario =
    scenarios?.some((scenario) => scenario.status === "pass" || scenario.status === "fail") ===
      true ||
    entries?.some((entry) => {
      const status = readQaSuiteEvidenceEntryStatus(entry);
      return status === "pass" || status === "fail";
    }) === true ||
    (failed ?? 0) > 0 ||
    (!hasObservedOutcomeRows && (passed ?? 0) > 0);
  const hasBlockingNonOptionalSkip =
    errorCode === "summary_blocking_count_missing" &&
    scenarios?.some(
      (scenario) =>
        (scenario.status === "skip" || scenario.status === "skipped") &&
        !isQaSuiteReportOnlyOptionalScenario(scenario, optionalScenarioNames),
    ) === true;
  const hasBlockingUnknownOrFailedScenario =
    scenarios?.some((scenario) => isQaSuiteFailureStatus(scenario.status)) === true;
  const hasBlockingNonPassEvidence =
    entries?.some((entry) => {
      const status = readQaSuiteEvidenceEntryStatus(entry);
      return (
        typeof status === "string" &&
        (errorCode === "summary_blocking_count_missing"
          ? isQaSuiteBlockingStatus(status)
          : isQaSuiteFailureStatus(status))
      );
    }) === true;

  // Optional skips are not execution: only a real scenario, evidence result,
  // or positive legacy count may clear a zero-work suite. Unverified skips
  // remain blocking, including package runs that expose evidence entries only.
  if (
    total === 0 ||
    scenarios?.length === 0 ||
    // A tolerated blocking result cannot authenticate a campaign that never completed a scenario.
    (requireExecutedScenario && !hasCompletedScenario) ||
    (!hasCompletedScenario &&
      !hasBlockingUnknownOrFailedScenario &&
      !hasBlockingNonOptionalSkip &&
      !hasBlockingNonPassEvidence)
  ) {
    throw new QaSuiteArtifactError(
      errorCode,
      `QA summary at ${summaryPath} did not include any executed scenarios.`,
    );
  }
}

function isQaSuiteBlockingStatus(status: unknown): boolean {
  return status !== "pass";
}

function isQaSuiteReportOnlyOptionalScenario(
  scenario: QaSuiteReportOnlyScenario,
  optionalScenarioNames: ReadonlySet<string> | undefined,
): boolean {
  return (
    (scenario.status === "skip" || scenario.status === "skipped") &&
    typeof scenario.name === "string" &&
    optionalScenarioNames?.has(scenario.name) === true &&
    typeof scenario.details === "string" &&
    scenario.details.includes("report-only")
  );
}

export function resolveQaReportOnlyOptionalScenarioNames(
  scenarios: readonly QaSeedScenarioWithSource[],
): ReadonlySet<string> {
  return new Set(
    scenarios
      .filter((scenario) => {
        const toolCoverage = scenario.execution.config?.toolCoverage;
        return (
          scenario.execution.kind === "flow" &&
          isRecord(toolCoverage) &&
          toolCoverage.required === false
        );
      })
      .map((scenario) => scenario.title),
  );
}

export function countQaSuiteFailedScenarios(
  scenarios: ReadonlyArray<QaSuiteScenarioStatus>,
): number {
  let failed = 0;
  for (const scenario of scenarios) {
    if (isQaSuiteFailureStatus(scenario.status)) {
      failed += 1;
    }
  }
  return failed;
}

function countQaSuiteFailedOrSkippedScenarios(
  scenarios: ReadonlyArray<QaSuiteScenarioStatus>,
): number {
  let blocking = 0;
  for (const scenario of scenarios) {
    if (isQaSuiteBlockingStatus(scenario.status)) {
      blocking += 1;
    }
  }
  return blocking;
}

function readQaSuiteFailedScenarioCountFromSummary(summary: unknown): number | null {
  if (!isRecord(summary)) {
    return null;
  }
  const payload = summary as {
    counts?: {
      failed?: unknown;
    };
    scenarios?: Array<QaSuiteScenarioStatus>;
  };
  const entries = readQaSuiteEvidenceEntries(summary);
  const countedFailures = readNonNegativeCount(payload.counts?.failed);
  const scenarioFailures = Array.isArray(payload.scenarios)
    ? countQaSuiteFailedScenarios(payload.scenarios)
    : null;
  const evidenceFailures = entries
    ? entries.filter((entry) => isQaSuiteFailureStatus(readQaSuiteEvidenceEntryStatus(entry)))
        .length
    : null;
  // Counts and scenario rows own scenario cardinality. Raw evidence is a
  // lower-level fallback only when neither aggregate is available.
  if (countedFailures !== null || scenarioFailures !== null) {
    return Math.max(countedFailures ?? 0, scenarioFailures ?? 0);
  }
  return evidenceFailures;
}

function readQaSuiteFailedOrSkippedScenarioCountFromSummary(summary: unknown): number | null {
  if (!isRecord(summary)) {
    return null;
  }
  const payload = summary as {
    counts?: {
      failed?: unknown;
      skipped?: unknown;
    };
    scenarios?: Array<QaSuiteScenarioStatus>;
  };
  const entries = readQaSuiteEvidenceEntries(summary);
  const countedFailures = readNonNegativeCount(payload.counts?.failed);
  const countedSkipped = readNonNegativeCount(payload.counts?.skipped);
  const countedBlocking =
    countedFailures !== null || countedSkipped !== null
      ? (countedFailures ?? 0) + (countedSkipped ?? 0)
      : null;
  const scenarioBlocking = Array.isArray(payload.scenarios)
    ? countQaSuiteFailedOrSkippedScenarios(payload.scenarios)
    : null;
  const evidenceBlocking = entries
    ? entries.filter((entry) => isQaSuiteBlockingStatus(readQaSuiteEvidenceEntryStatus(entry)))
        .length
    : null;
  if (countedBlocking !== null || scenarioBlocking !== null) {
    return Math.max(countedBlocking ?? 0, scenarioBlocking ?? 0);
  }
  return evidenceBlocking;
}

export async function readQaSuiteFailedScenarioCountFromFile(summaryPath: string): Promise<number> {
  const payload = await readCompletedQaSuiteSummaryFile(summaryPath);
  assertQaSuiteSummaryHasExecutedScenarios(payload, summaryPath, "summary_failure_count_missing");
  const failedScenarioCount = readQaSuiteFailedScenarioCountFromSummary(payload);
  if (failedScenarioCount !== null) {
    return failedScenarioCount;
  }
  throw new QaSuiteArtifactError(
    "summary_failure_count_missing",
    `QA summary at ${summaryPath} did not include counts.failed, scenarios[].status, or entries[].result.status.`,
  );
}

export async function readQaSuiteFailedOrSkippedScenarioCountFromFile(
  summaryPath: string,
  options?: { optionalScenarioNames?: ReadonlySet<string>; requireExecutedScenario?: boolean },
): Promise<number> {
  const payload = await readCompletedQaSuiteSummaryFile(summaryPath);
  assertQaSuiteSummaryHasExecutedScenarios(
    payload,
    summaryPath,
    "summary_blocking_count_missing",
    options?.optionalScenarioNames,
    options?.requireExecutedScenario,
  );
  const blockingScenarioCount = readQaSuiteFailedOrSkippedScenarioCountFromSummary(payload);
  if (blockingScenarioCount !== null) {
    const optionalScenarioNames = options?.optionalScenarioNames;
    if (!optionalScenarioNames?.size || !isRecord(payload)) {
      return blockingScenarioCount;
    }
    const { scenarios } = payload as {
      scenarios?: QaSuiteReportOnlyScenario[];
    };
    const reportOnlyOptionalSkips = Array.isArray(scenarios)
      ? scenarios.filter((scenario) =>
          isQaSuiteReportOnlyOptionalScenario(scenario, optionalScenarioNames),
        ).length
      : 0;
    // Optional skips may offset only their independently verified scenario results.
    // Declared failures and count disagreements stay fail-closed.
    return Math.max(
      readQaSuiteFailedScenarioCountFromSummary(payload) ?? 0,
      blockingScenarioCount - reportOnlyOptionalSkips,
    );
  }
  throw new QaSuiteArtifactError(
    "summary_blocking_count_missing",
    `QA summary at ${summaryPath} did not include counts.failed, counts.skipped, scenarios[].status, or entries[].result.status.`,
  );
}
