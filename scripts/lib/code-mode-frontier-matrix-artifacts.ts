import fs from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";
import {
  readFrontierTraceMetrics,
  verifyFrontierAuditBundle,
  type FrontierMatrixFailure,
  type FrozenFrontierMatrixCellResult,
} from "./code-mode-frontier-matrix-evidence.js";
import {
  canonicalJson,
  compareUtf8,
  digestFrontierEvidence,
  digestJson,
  frontierMatrixPreflightBlockers,
  FRONTIER_MATRIX_SCHEMA_VERSION,
  verifyFrozenFrontierMatrixPlan,
  type EvidenceSource,
  type FrontierMatrixMode,
  type FrontierTraceMetrics,
  type FrozenFrontierMatrixCell,
  type FrozenFrontierMatrixPlan,
  type Sha256,
} from "./code-mode-frontier-matrix-plan.js";
import { redactForDevToolLog } from "./dev-tooling-safety.js";

const MAX_ARTIFACT_DEPTH = 32;
const MAX_ARTIFACT_NODES = 100_000;
const MAX_ARTIFACT_WIDTH = 4_096;
const FORBIDDEN_ARTIFACT_KEY =
  /^(?:raw.*|payloads?|stdout|stderr|authorization|apiKey|credential|secret|password|cookie|final|diagnostics)$/iu;

export type FrontierMatrixSummary = {
  schemaVersion: typeof FRONTIER_MATRIX_SCHEMA_VERSION;
  identitySha256: Sha256;
  evidenceAuthority: "agent_exec_trace_v2";
  evidenceSource: EvidenceSource;
  evidenceValid: boolean;
  betaEligible: boolean;
  comparability: {
    state: "comparable" | "blocked";
    reasons: string[];
  };
  observedWindow: { startedAtUtc: string; endedAtUtc: string } | null;
  direct: {
    cells: number;
    passed: number;
    validTraces: number;
    totals: FrontierTraceMetrics | null;
  };
  code: {
    cells: number;
    passed: number;
    validTraces: number;
    totals: FrontierTraceMetrics | null;
  };
  bars: {
    allTasksPassed: boolean;
    accuracyNonRegression: boolean;
    fewerEffectiveTurns: boolean;
    fewerTokens: boolean;
    inputTokensNonRegression: boolean;
    totalCallsNonRegression: boolean;
    wallLatencyNonRegression: boolean;
    auditableMatchedTraces: boolean;
  };
  summarySha256: Sha256;
};

function emptyTotals(): FrontierTraceMetrics {
  return {
    effectiveTurns: 0,
    logicalModelCalls: 0,
    modelFacingApiCalls: 0,
    retries: 0,
    authRecoveries: 0,
    payloadRecoveries: 0,
    transportFallbacks: 0,
    toolCalls: 0,
    underlyingTotalCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    agentTimeMs: 0,
    commandExecutionDurationMs: 0,
    wallLatencyMs: 0,
  };
}

function summarizeMode(
  mode: FrontierMatrixMode,
  plan: FrozenFrontierMatrixPlan,
  results: readonly FrozenFrontierMatrixCellResult[],
  evidenceSource: EvidenceSource,
) {
  const selected = results.filter((result) => result.mode === mode);
  const valid = selected.filter(
    (result) =>
      verifyResult(result, plan, evidenceSource) &&
      result.auditBundle?.trace.audit.state === "valid" &&
      verifyFrontierAuditBundle(result.auditBundle, plan),
  );
  const totals =
    selected.length > 0 && valid.length === selected.length
      ? valid.reduce((sum, result) => {
          const metrics = readFrontierTraceMetrics(
            result.auditBundle!.trace,
            result.auditBundle!.execution.wallLatencyMs,
          );
          for (const key of Object.keys(metrics) as Array<keyof FrontierTraceMetrics>) {
            sum[key] += metrics[key];
          }
          return sum;
        }, emptyTotals())
      : null;
  return {
    cells: selected.length,
    passed: selected.filter((result) => result.passed).length,
    validTraces: valid.length,
    totals,
  };
}

export function summarizeFrontierMatrix(
  plan: FrozenFrontierMatrixPlan,
  results: readonly FrozenFrontierMatrixCellResult[],
  evidenceSource: EvidenceSource,
  additionalBlockers: readonly string[],
): FrontierMatrixSummary {
  const direct = summarizeMode("direct", plan, results, evidenceSource);
  const code = summarizeMode("code", plan, results, evidenceSource);
  const reasons = new Set([...frontierMatrixPreflightBlockers(plan), ...additionalBlockers]);
  if (!verifyFrontierResultSequence(plan, results, evidenceSource)) {
    reasons.add("result_sequence_invalid");
  }
  if (evidenceSource !== "production") {
    reasons.add("simulated_or_test_fixture");
  }
  if (
    results.length !== plan.cells.length ||
    results.some((result) => result.failure === "not_run")
  ) {
    reasons.add("matched_schedule_incomplete");
  }
  if (
    results.some(
      (result) =>
        !result.auditBundle ||
        !verifyFrontierAuditBundle(result.auditBundle, plan) ||
        result.auditBundle.trace.audit.state !== "valid",
    )
  ) {
    reasons.add("auditable_trace_incomplete");
  }
  for (const result of results) {
    if (
      result.failure !== null &&
      result.failure !== "task_failed" &&
      result.failure !== "task_error"
    ) {
      reasons.add(`non_task_failure:${result.failure}`);
    }
  }
  const observedTimes = results.flatMap((result) =>
    result.auditBundle
      ? [result.auditBundle.execution.startedAtUtc, result.auditBundle.execution.endedAtUtc]
      : [],
  );
  const bars = {
    allTasksPassed:
      results.length === plan.cells.length && results.every((result) => result.passed),
    accuracyNonRegression:
      direct.cells > 0 &&
      code.cells > 0 &&
      code.passed / code.cells >= direct.passed / direct.cells,
    fewerEffectiveTurns:
      code.totals !== null &&
      direct.totals !== null &&
      code.totals.effectiveTurns < direct.totals.effectiveTurns,
    fewerTokens:
      code.totals !== null &&
      direct.totals !== null &&
      code.totals.totalTokens < direct.totals.totalTokens,
    inputTokensNonRegression:
      code.totals !== null &&
      direct.totals !== null &&
      code.totals.inputTokens <= direct.totals.inputTokens,
    totalCallsNonRegression:
      code.totals !== null &&
      direct.totals !== null &&
      code.totals.underlyingTotalCalls <= direct.totals.underlyingTotalCalls,
    wallLatencyNonRegression:
      code.totals !== null &&
      direct.totals !== null &&
      code.totals.wallLatencyMs <= direct.totals.wallLatencyMs,
    auditableMatchedTraces: reasons.size === 0,
  };
  const summaryContents = {
    schemaVersion: FRONTIER_MATRIX_SCHEMA_VERSION,
    identitySha256: plan.identitySha256,
    evidenceAuthority: plan.campaign.evidenceAuthority,
    evidenceSource,
    evidenceValid: reasons.size === 0,
    betaEligible: reasons.size === 0 && Object.values(bars).every(Boolean),
    comparability: {
      state: reasons.size === 0 ? ("comparable" as const) : ("blocked" as const),
      reasons: [...reasons].toSorted(compareUtf8),
    },
    observedWindow:
      observedTimes.length > 0
        ? {
            startedAtUtc: observedTimes.toSorted()[0]!,
            endedAtUtc: observedTimes.toSorted().at(-1)!,
          }
        : null,
    direct,
    code,
    bars,
  };
  return { ...summaryContents, summarySha256: digestJson(summaryContents) };
}

export function assertSafeFrontierArtifact(value: unknown): void {
  const seen = new WeakSet<object>();
  const state = { nodes: 0 };
  const visit = (entry: unknown, depth: number): void => {
    state.nodes += 1;
    if (state.nodes > MAX_ARTIFACT_NODES || depth > MAX_ARTIFACT_DEPTH) {
      throw new Error("frontier matrix artifact exceeds structural bounds");
    }
    if (
      entry === null ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry))
    ) {
      return;
    }
    if (typeof entry === "string") {
      if (redactForDevToolLog(entry) !== entry) {
        throw new Error("frontier matrix artifact contains redacted sensitive text");
      }
      return;
    }
    if (!entry || typeof entry !== "object") {
      throw new Error("frontier matrix artifact contains non-JSON data");
    }
    if (seen.has(entry)) {
      throw new Error("frontier matrix artifact contains a cycle");
    }
    if (types.isProxy(entry)) {
      throw new Error("frontier matrix artifact contains a proxy");
    }
    seen.add(entry);
    const prototype = Object.getPrototypeOf(entry);
    if (
      (Array.isArray(entry) && prototype !== Array.prototype) ||
      (!Array.isArray(entry) && prototype !== Object.prototype && prototype !== null)
    ) {
      throw new Error("frontier matrix artifact contains a non-plain object");
    }
    const keys = Reflect.ownKeys(entry);
    const dataKeys = Array.isArray(entry) ? keys.filter((key) => key !== "length") : keys;
    if (
      dataKeys.length > MAX_ARTIFACT_WIDTH ||
      dataKeys.some((key) => typeof key !== "string") ||
      (Array.isArray(entry) &&
        (dataKeys.length !== entry.length || dataKeys.some((key, index) => key !== String(index))))
    ) {
      throw new Error("frontier matrix artifact exceeds key bounds");
    }
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    for (const key of dataKeys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new Error(`frontier matrix artifact contains accessor or hidden key ${key}`);
      }
      if (FORBIDDEN_ARTIFACT_KEY.test(key)) {
        throw new Error(`frontier matrix artifact rejected key ${key}`);
      }
      visit(descriptor.value, depth + 1);
    }
  };
  visit(value, 0);
}

function verifyResult(
  result: FrozenFrontierMatrixCellResult,
  plan: FrozenFrontierMatrixPlan,
  evidenceSource: EvidenceSource,
): boolean {
  const { resultSha256, ...contents } = result;
  const cell = plan.cells.find((entry) => entry.id === result.cellId);
  if (!cell) {
    return false;
  }
  return (
    resultSha256 === digestFrontierEvidence("frontier.cell-result.v2", contents) &&
    result.taskId === cell.taskId &&
    result.taskIndex === cell.taskIndex &&
    result.taskSha256 === cell.taskSha256 &&
    result.slot === cell.slot &&
    result.mode === cell.mode &&
    result.repetition === cell.repetition &&
    result.sequence === cell.sequence &&
    result.stateKey === cell.stateKey &&
    result.passed === (result.failure === null) &&
    (result.auditBundle === undefined
      ? result.failure !== null
      : result.auditBundle.cell.id === result.cellId &&
        result.auditBundle.cell.taskId === result.taskId &&
        result.auditBundle.cell.taskIndex === result.taskIndex &&
        result.auditBundle.cell.taskSha256 === result.taskSha256 &&
        result.auditBundle.cell.slot === result.slot &&
        result.auditBundle.cell.mode === result.mode &&
        result.auditBundle.cell.repetition === result.repetition &&
        result.auditBundle.cell.sequence === result.sequence &&
        result.auditBundle.cell.stateKey === result.stateKey &&
        verifyFrontierAuditBundle(result.auditBundle, plan) &&
        result.auditBundle.execution.evidenceSource === evidenceSource &&
        result.auditBundle.verdict.failure === result.failure)
  );
}

export function verifyFrontierResultSequence(
  plan: FrozenFrontierMatrixPlan,
  results: readonly FrozenFrontierMatrixCellResult[],
  evidenceSource: EvidenceSource,
): boolean {
  const sessionHashes = results.flatMap((result) =>
    result.auditBundle ? [result.auditBundle.execution.sessionSha256] : [],
  );
  const executions = results.flatMap((result) =>
    result.auditBundle ? [result.auditBundle.execution] : [],
  );
  const firstStart = executions[0]?.startedAtUtc;
  const timelineValid = executions.every((execution, index) => {
    if (index === 0) {
      return true;
    }
    return Date.parse(execution.startedAtUtc) >= Date.parse(executions[index - 1]!.endedAtUtc);
  });
  return (
    results.length === plan.cells.length &&
    results.every((result, index) => result.cellId === plan.cells[index]?.id) &&
    results.every((result) => verifyResult(result, plan, evidenceSource)) &&
    new Set(sessionHashes).size === sessionHashes.length &&
    timelineValid &&
    (firstStart === undefined ||
      new Date(Date.parse(firstStart)).toISOString().slice(0, 10) === plan.runDate)
  );
}

export function sealFrontierResult(
  result: Omit<FrozenFrontierMatrixCellResult, "resultSha256">,
): FrozenFrontierMatrixCellResult {
  return {
    ...result,
    resultSha256: digestFrontierEvidence("frontier.cell-result.v2", result),
  };
}

export function frontierFailureResult(
  cell: FrozenFrontierMatrixCell,
  failure: FrontierMatrixFailure,
): FrozenFrontierMatrixCellResult {
  return sealFrontierResult({
    cellId: cell.id,
    taskId: cell.taskId,
    taskIndex: cell.taskIndex,
    taskSha256: cell.taskSha256,
    slot: cell.slot,
    mode: cell.mode,
    repetition: cell.repetition,
    sequence: cell.sequence,
    stateKey: cell.stateKey,
    failure,
    passed: false,
  });
}

export async function writeFrontierArtifacts(params: {
  additionalBlockers?: readonly string[];
  evidenceSource: EvidenceSource;
  outputDir: string;
  plan: FrozenFrontierMatrixPlan;
  results: readonly FrozenFrontierMatrixCellResult[];
}): Promise<FrontierMatrixSummary> {
  if (
    !verifyFrozenFrontierMatrixPlan(params.plan) ||
    !verifyFrontierResultSequence(params.plan, params.results, params.evidenceSource)
  ) {
    throw new Error("frontier matrix artifact verification failed before write");
  }
  const summary = summarizeFrontierMatrix(
    params.plan,
    params.results,
    params.evidenceSource,
    params.additionalBlockers ?? [],
  );
  assertSafeFrontierArtifact(params.plan);
  assertSafeFrontierArtifact(params.results);
  assertSafeFrontierArtifact(summary);
  await fs.writeFile(
    path.join(params.outputDir, "manifest.json"),
    `${JSON.stringify(params.plan, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(params.outputDir, "results.jsonl"),
    params.results.map((result) => JSON.stringify(result)).join("\n") +
      (params.results.length > 0 ? "\n" : ""),
    "utf8",
  );
  await fs.writeFile(
    path.join(params.outputDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );

  const persistedPlan = JSON.parse(
    await fs.readFile(path.join(params.outputDir, "manifest.json"), "utf8"),
  ) as FrozenFrontierMatrixPlan;
  const persistedResultsText = await fs.readFile(
    path.join(params.outputDir, "results.jsonl"),
    "utf8",
  );
  const persistedResults = persistedResultsText.trim()
    ? (persistedResultsText
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)) as FrozenFrontierMatrixCellResult[])
    : [];
  const persistedSummary = JSON.parse(
    await fs.readFile(path.join(params.outputDir, "summary.json"), "utf8"),
  ) as FrontierMatrixSummary;
  assertSafeFrontierArtifact(persistedPlan);
  assertSafeFrontierArtifact(persistedResults);
  assertSafeFrontierArtifact(persistedSummary);
  const { summarySha256, ...summaryContents } = persistedSummary;
  if (
    !verifyFrozenFrontierMatrixPlan(persistedPlan) ||
    !verifyFrontierResultSequence(persistedPlan, persistedResults, params.evidenceSource) ||
    summarySha256 !== digestJson(summaryContents) ||
    canonicalJson(persistedSummary) !==
      canonicalJson(
        summarizeFrontierMatrix(
          persistedPlan,
          persistedResults,
          params.evidenceSource,
          params.additionalBlockers ?? [],
        ),
      )
  ) {
    throw new Error("frontier matrix artifact verification failed after write");
  }
  return persistedSummary;
}
