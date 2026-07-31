// Qa Lab plugin module implements suite summary behavior.
import fs from "node:fs/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { QaSuiteArtifactError } from "./errors.js";
import type { QaEvidenceSummaryJson, QaEvidenceTiming } from "./evidence-summary.js";
import type { QaProviderMode } from "./model-selection.js";
import type { RuntimeId, RuntimeParityResult } from "./runtime-parity.js";
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
type QaEvidenceEntryStatus = {
  result?: {
    status?: unknown;
  };
};

function isQaSuiteFailureStatus(status: unknown): boolean {
  return status !== "pass" && status !== "skip" && status !== "skipped";
}

async function readQaSuiteSummaryFile(summaryPath: string): Promise<unknown> {
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
    return JSON.parse(summaryText) as unknown;
  } catch (error) {
    throw new QaSuiteArtifactError(
      "summary_parse_failed",
      `Could not parse QA summary JSON at ${summaryPath}: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
}

function readNonNegativeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : null;
}

function assertQaSuiteSummaryHasExecutedScenarios(
  summary: unknown,
  summaryPath: string,
  errorCode: "summary_failure_count_missing" | "summary_blocking_count_missing",
  optionalScenarioNames?: ReadonlySet<string>,
): void {
  if (!summary || typeof summary !== "object") {
    return;
  }
  const payload = summary as {
    counts?: { total?: unknown; passed?: unknown; failed?: unknown; skipped?: unknown };
    scenarios?: unknown;
    entries?: unknown;
  };
  const total = readNonNegativeCount(payload.counts?.total);
  const passed = readNonNegativeCount(payload.counts?.passed);
  const failed = readNonNegativeCount(payload.counts?.failed);
  const skipped = readNonNegativeCount(payload.counts?.skipped);
  const scenarios = Array.isArray(payload.scenarios)
    ? (payload.scenarios as QaSuiteReportOnlyScenario[])
    : undefined;
  const entries = Array.isArray(payload.entries)
    ? (payload.entries as QaEvidenceEntryStatus[])
    : undefined;
  const hasExecutedScenario =
    scenarios?.some((scenario) => scenario.status === "pass" || scenario.status === "fail") ===
      true ||
    entries?.some((entry) => entry.result?.status === "pass" || entry.result?.status === "fail") ===
      true ||
    (passed ?? 0) > 0 ||
    (failed ?? 0) > 0 ||
    (total !== null && total > 0 && (skipped === null || total > skipped));
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
    entries?.some(
      (entry) =>
        typeof entry.result?.status === "string" &&
        (errorCode === "summary_blocking_count_missing"
          ? isQaSuiteBlockingStatus(entry.result.status)
          : isQaSuiteFailureStatus(entry.result.status)),
    ) === true;

  // Optional skips are not execution: only a real scenario, evidence result,
  // or positive legacy count may clear a zero-work suite. Unverified skips
  // remain blocking, including package runs that expose evidence entries only.
  if (
    total === 0 ||
    scenarios?.length === 0 ||
    (!hasExecutedScenario &&
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
  if (!summary || typeof summary !== "object") {
    return null;
  }
  const payload = summary as {
    counts?: {
      failed?: unknown;
    };
    entries?: QaEvidenceEntryStatus[];
    scenarios?: Array<QaSuiteScenarioStatus>;
  };
  const countedFailures = readNonNegativeCount(payload.counts?.failed);
  const scenarioFailures = Array.isArray(payload.scenarios)
    ? countQaSuiteFailedScenarios(payload.scenarios)
    : null;
  const evidenceFailures = Array.isArray(payload.entries)
    ? payload.entries.filter((entry) => isQaSuiteFailureStatus(entry.result?.status)).length
    : null;
  if (countedFailures !== null && scenarioFailures !== null) {
    return Math.max(countedFailures, scenarioFailures, evidenceFailures ?? 0);
  }
  if (countedFailures !== null && evidenceFailures !== null) {
    return Math.max(countedFailures, evidenceFailures);
  }
  if (scenarioFailures !== null) {
    return Math.max(scenarioFailures, evidenceFailures ?? 0);
  }
  if (evidenceFailures !== null) {
    return evidenceFailures;
  }
  return countedFailures;
}

function readQaSuiteFailedOrSkippedScenarioCountFromSummary(summary: unknown): number | null {
  if (!summary || typeof summary !== "object") {
    return null;
  }
  const payload = summary as {
    counts?: {
      failed?: unknown;
      skipped?: unknown;
    };
    entries?: QaEvidenceEntryStatus[];
    scenarios?: Array<QaSuiteScenarioStatus>;
  };
  const countedFailures = readNonNegativeCount(payload.counts?.failed);
  const countedSkipped = readNonNegativeCount(payload.counts?.skipped);
  const countedBlocking =
    countedFailures !== null || countedSkipped !== null
      ? (countedFailures ?? 0) + (countedSkipped ?? 0)
      : null;
  const scenarioBlocking = Array.isArray(payload.scenarios)
    ? countQaSuiteFailedOrSkippedScenarios(payload.scenarios)
    : null;
  const evidenceBlocking = Array.isArray(payload.entries)
    ? payload.entries.filter((entry) => isQaSuiteBlockingStatus(entry.result?.status)).length
    : null;
  if (countedBlocking !== null && scenarioBlocking !== null) {
    return Math.max(countedBlocking, scenarioBlocking, evidenceBlocking ?? 0);
  }
  if (countedBlocking !== null && evidenceBlocking !== null) {
    return Math.max(countedBlocking, evidenceBlocking);
  }
  if (scenarioBlocking !== null) {
    return Math.max(scenarioBlocking, evidenceBlocking ?? 0);
  }
  if (evidenceBlocking !== null) {
    return evidenceBlocking;
  }
  return countedBlocking;
}

export async function readQaSuiteFailedScenarioCountFromFile(summaryPath: string): Promise<number> {
  const payload = await readQaSuiteSummaryFile(summaryPath);
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
  options?: { optionalScenarioNames?: ReadonlySet<string> },
): Promise<number> {
  const payload = await readQaSuiteSummaryFile(summaryPath);
  assertQaSuiteSummaryHasExecutedScenarios(
    payload,
    summaryPath,
    "summary_blocking_count_missing",
    options?.optionalScenarioNames,
  );
  const blockingScenarioCount = readQaSuiteFailedOrSkippedScenarioCountFromSummary(payload);
  if (blockingScenarioCount !== null) {
    const optionalScenarioNames = options?.optionalScenarioNames;
    if (!optionalScenarioNames?.size || !payload || typeof payload !== "object") {
      return blockingScenarioCount;
    }
    const { scenarios, entries } = payload as {
      scenarios?: QaSuiteReportOnlyScenario[];
      entries?: QaEvidenceEntryStatus[];
    };
    const reportOnlyOptionalSkips = Array.isArray(scenarios)
      ? scenarios.filter((scenario) =>
          isQaSuiteReportOnlyOptionalScenario(scenario, optionalScenarioNames),
        ).length
      : 0;
    const evidenceBlocking = Array.isArray(entries)
      ? entries.filter((entry) => isQaSuiteBlockingStatus(entry.result?.status)).length
      : 0;
    // Optional skips may offset only their independently verified scenario results.
    // Declared failures, unknown evidence, and count disagreements stay fail-closed.
    return Math.max(
      readQaSuiteFailedScenarioCountFromSummary(payload) ?? 0,
      blockingScenarioCount - reportOnlyOptionalSkips,
      evidenceBlocking,
    );
  }
  throw new QaSuiteArtifactError(
    "summary_blocking_count_missing",
    `QA summary at ${summaryPath} did not include counts.failed, counts.skipped, scenarios[].status, or entries[].result.status.`,
  );
}
