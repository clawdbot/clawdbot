import { types } from "node:util";
import type { AgentExecTraceMetric } from "../../src/commands/agent-exec-trace-metrics.js";
import {
  normalizeAgentExecInvocationReceipt,
  normalizeAgentExecTrace,
  verifyAgentExecInvocationReceipt,
  verifyAgentExecTrace,
  type AgentExecTrace,
} from "../../src/commands/agent-exec-trace.js";
import {
  canonicalJson,
  digestFrontierEvidence,
  sameFrozenIdentity,
  type EvidenceSource,
  type FrontierMatrixMode,
  type FrontierTraceMetrics,
  type FrozenFrontierMatrixCell,
  type FrozenFrontierMatrixIdentity,
  type FrozenFrontierMatrixPlan,
  type Sha256,
} from "./code-mode-frontier-matrix-plan.js";

const MAX_INPUT_DEPTH = 32;
const MAX_INPUT_NODES = 100_000;
const MAX_INPUT_WIDTH = 4_096;
const FRONTIER_AUDIT_DIGEST_KEYS = new Set([
  "bundleSha256",
  "envelopeBytesSha256",
  "envelopeOutcomeSha256",
  "executionReceiptSha256",
  "invocationReceiptSha256",
  "oracleResultSha256",
  "taskIdentitySha256",
  "traceSha256",
  "traceSourceSha256",
]);

export type FrontierCellOracle = {
  passed: boolean;
};

export type FrontierMatrixCellObservation = {
  envelope: unknown;
  oracle: FrontierCellOracle;
  receipt: FrontierObservedCellReceipt;
};

export type FrontierMatrixFailure =
  | "cleanup_failed"
  | "envelope_invalid"
  | "execution_receipt_mismatch"
  | "frozen_identity_mismatch"
  | "identity_observation_failed"
  | "infrastructure_failed"
  | "runner_clock_invalid"
  | "runner_failed"
  | "session_reused"
  | "not_run"
  | "task_error"
  | "task_failed"
  | "timeout"
  | "trace_invalid"
  | "trace_mode_mismatch"
  | "trace_route_mismatch";

export type FrontierMatrixCellExecution = {
  campaignId: string;
  blockId: string;
  identitySha256: Sha256;
  cellId: string;
  cellStateKey: Sha256;
  observed: FrontierObservedCellReceipt;
  source: FrozenFrontierMatrixIdentity;
  sessionSha256: Sha256;
  harnessAttempt: 1;
  concurrency: 1;
  evidenceSource: EvidenceSource;
  startedAtUtc: string;
  endedAtUtc: string;
  wallLatencyMs: number;
};

export type FrontierEnvelopeOutcome = {
  status: "ok" | "error" | "timeout";
  ok: boolean;
  errorPhase: "task" | "infrastructure" | "cleanup" | null;
  cleanupFailed: boolean;
  model: string | null;
  provider: string | null;
  sessionSha256: Sha256;
};

export type FrontierObservedCellReceipt = {
  cellId: string;
  cellStateKey: Sha256;
  taskId: string;
  taskIndex: number;
  taskSha256: Sha256;
  fixtureSha256: Sha256;
  promptSha256: Sha256;
  oracleSha256: Sha256;
  modeConfigSha256: Sha256;
};

export type FrontierMatrixAuditBundle = {
  campaign: {
    id: string;
    blockId: string;
    identitySha256: Sha256;
  };
  cell: FrozenFrontierMatrixCell;
  execution: FrontierMatrixCellExecution;
  oracle: {
    passed: boolean;
    sha256: Sha256;
  };
  envelope: FrontierEnvelopeOutcome;
  trace: AgentExecTrace;
  verdict: {
    failure: FrontierMatrixFailure | null;
    passed: boolean;
  };
  digests: {
    envelopeBytesSha256: Sha256;
    envelopeOutcomeSha256: Sha256;
    executionReceiptSha256: Sha256;
    invocationReceiptSha256: Sha256;
    oracleResultSha256: Sha256;
    taskIdentitySha256: Sha256;
    traceSourceSha256: Sha256;
    traceSha256: Sha256;
    bundleSha256: Sha256;
  };
};

export type FrozenFrontierMatrixCellResult = {
  cellId: string;
  taskId: string;
  taskIndex: number;
  taskSha256: Sha256;
  slot: FrozenFrontierMatrixCell["slot"];
  mode: FrontierMatrixMode;
  repetition: 1 | 2;
  sequence: number;
  stateKey: Sha256;
  failure: FrontierMatrixFailure | null;
  passed: boolean;
  auditBundle?: FrontierMatrixAuditBundle;
  resultSha256: Sha256;
};

function validStoredEnvelopeOutcome(value: FrontierEnvelopeOutcome): boolean {
  if (
    (value.status !== "ok" && value.status !== "error" && value.status !== "timeout") ||
    typeof value.ok !== "boolean" ||
    typeof value.cleanupFailed !== "boolean" ||
    (value.errorPhase !== null &&
      value.errorPhase !== "task" &&
      value.errorPhase !== "infrastructure" &&
      value.errorPhase !== "cleanup") ||
    typeof value.model !== "string" ||
    typeof value.provider !== "string" ||
    typeof value.sessionSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sessionSha256)
  ) {
    return false;
  }
  if (value.status === "ok") {
    return value.ok && value.errorPhase === null && !value.cleanupFailed;
  }
  if (value.ok || value.errorPhase === null) {
    return false;
  }
  return value.cleanupFailed === (value.errorPhase === "cleanup");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parsePersistedJson(value: string): unknown {
  // This is the evidence boundary: reparse bytes so trusted in-memory brands
  // and non-enumerable properties cannot cross into persisted audit artifacts.
  return JSON.parse(value);
}

function assertPlainInput(value: unknown, label: string): void {
  if (typeof value === "string") {
    return;
  }
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (entry: unknown, depth: number): void => {
    nodes += 1;
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry))
    ) {
      return;
    }
    if (!entry || typeof entry !== "object") {
      throw new Error(`${label} contains non-JSON data`);
    }
    if (
      depth > MAX_INPUT_DEPTH ||
      nodes > MAX_INPUT_NODES ||
      seen.has(entry) ||
      types.isProxy(entry)
    ) {
      throw new Error(`${label} is cyclic or too deep`);
    }
    seen.add(entry);
    const prototype = Object.getPrototypeOf(entry);
    if (
      (Array.isArray(entry) && prototype !== Array.prototype) ||
      (!Array.isArray(entry) && prototype !== Object.prototype && prototype !== null)
    ) {
      throw new Error(`${label} must contain plain JSON data`);
    }
    const keys = Reflect.ownKeys(entry);
    const dataKeys = Array.isArray(entry) ? keys.filter((key) => key !== "length") : keys;
    if (
      dataKeys.some((key) => typeof key !== "string") ||
      dataKeys.length > MAX_INPUT_WIDTH ||
      (Array.isArray(entry) &&
        (dataKeys.length !== entry.length || dataKeys.some((key, index) => key !== String(index))))
    ) {
      throw new Error(`${label} contains unsupported keys`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    for (const key of dataKeys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new Error(`${label} contains an accessor or hidden property`);
      }
      visit(descriptor.value, depth + 1);
    }
  };
  visit(value, 0);
}

export function normalizeFrontierEnvelope(
  raw: unknown,
): { outcome: FrontierEnvelopeOutcome; trace: AgentExecTrace } | undefined {
  try {
    assertPlainInput(raw, "agent-exec envelope");
  } catch {
    return undefined;
  }
  let serialized: string;
  try {
    serialized = typeof raw === "string" ? raw : JSON.stringify(raw);
  } catch {
    return undefined;
  }
  if (!serialized || serialized.length > 8 * 1024 * 1024) {
    return undefined;
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(serialized);
  } catch {
    return undefined;
  }
  try {
    assertPlainInput(envelope, "persisted agent-exec envelope");
  } catch {
    return undefined;
  }
  if (!isPlainRecord(envelope)) {
    return undefined;
  }
  const allowed = new Set([
    "ok",
    "status",
    "final",
    "payloads",
    "usage",
    "costUsd",
    "codeModeEngaged",
    "assistantTurns",
    "bridgeCalls",
    "codeModeStats",
    "toolSummary",
    "trace",
    "model",
    "provider",
    "sessionId",
    "error",
    "cleanup",
  ]);
  if (
    Object.keys(envelope).some((key) => !allowed.has(key)) ||
    typeof envelope.ok !== "boolean" ||
    (envelope.status !== "ok" && envelope.status !== "error" && envelope.status !== "timeout") ||
    typeof envelope.final !== "string" ||
    !Array.isArray(envelope.payloads) ||
    (typeof envelope.model !== "string" && envelope.model !== null) ||
    (typeof envelope.provider !== "string" && envelope.provider !== null) ||
    typeof envelope.sessionId !== "string" ||
    !envelope.sessionId ||
    envelope.trace === undefined
  ) {
    return undefined;
  }
  const traceJson = JSON.stringify(envelope.trace);
  const trace = normalizeAgentExecTrace(traceJson);
  if (!trace || !verifyAgentExecTrace(traceJson)) {
    return undefined;
  }
  const error = envelope.error;
  const errorPhase =
    isPlainRecord(error) &&
    (error.phase === "task" || error.phase === "infrastructure" || error.phase === "cleanup")
      ? error.phase
      : null;
  if (
    (envelope.status === "ok" && (!envelope.ok || envelope.error !== undefined)) ||
    (envelope.status !== "ok" && envelope.ok) ||
    (envelope.status !== "ok" && errorPhase === null)
  ) {
    return undefined;
  }
  const cleanupFailed =
    isPlainRecord(envelope.cleanup) &&
    envelope.cleanup.status === "failed" &&
    isPlainRecord(envelope.cleanup.error) &&
    envelope.cleanup.error.phase === "cleanup";
  if (envelope.cleanup !== undefined && !cleanupFailed) {
    return undefined;
  }
  const outcome: FrontierEnvelopeOutcome = {
    status: envelope.status,
    ok: envelope.ok,
    errorPhase,
    cleanupFailed,
    model: envelope.model,
    provider: envelope.provider,
    sessionSha256: digestFrontierEvidence("frontier.session-id.v2", envelope.sessionId),
  };
  return validStoredEnvelopeOutcome(outcome)
    ? {
        outcome,
        trace,
      }
    : undefined;
}

function exactValue(metric: AgentExecTraceMetric): number {
  if (metric.state !== "exact") {
    throw new Error("frontier matrix accepted a non-exact trace metric");
  }
  return metric.value;
}

export function readFrontierTraceMetrics(
  trace: AgentExecTrace,
  wallLatencyMs: number,
): FrontierTraceMetrics {
  const metrics = trace.projection.metrics;
  return {
    effectiveTurns: exactValue(metrics.effectiveTurns),
    logicalModelCalls: exactValue(metrics.logicalModelCalls),
    modelFacingApiCalls: exactValue(metrics.modelFacingApiCalls),
    retries: exactValue(metrics.providerAttempts.retries),
    authRecoveries: exactValue(metrics.providerAttempts.authRecoveries),
    payloadRecoveries: exactValue(metrics.providerAttempts.payloadRecoveries),
    transportFallbacks: exactValue(metrics.providerAttempts.transportFallbacks),
    toolCalls: exactValue(metrics.totalToolOperations),
    underlyingTotalCalls: exactValue(metrics.underlyingTotalCalls),
    inputTokens: exactValue(metrics.tokens.input),
    outputTokens: exactValue(metrics.tokens.output),
    totalTokens: exactValue(metrics.tokens.total),
    agentTimeMs: exactValue(metrics.agentDurationMs),
    commandExecutionDurationMs: exactValue(metrics.commandExecutionDurationMs),
    wallLatencyMs,
  };
}

export function frontierTraceFailure(
  trace: AgentExecTrace,
  cell: FrozenFrontierMatrixCell,
  plan: FrozenFrontierMatrixPlan,
  envelope: FrontierEnvelopeOutcome,
): FrontierMatrixFailure | null {
  const receipt = trace.source.invocationReceipt;
  const persistedReceipt = receipt
    ? normalizeAgentExecInvocationReceipt(JSON.stringify(receipt))
    : undefined;
  if (
    trace.schemaVersion !== 2 ||
    trace.source.kind !== "agent_exec_source_facts" ||
    trace.audit.state !== "valid" ||
    !receipt ||
    !persistedReceipt ||
    !verifyAgentExecInvocationReceipt(JSON.stringify(receipt)) ||
    !receipt.complete ||
    receipt.truncated ||
    receipt.incompleteReasons.length !== 0
  ) {
    return "trace_invalid";
  }
  try {
    readFrontierTraceMetrics(trace, 0);
  } catch {
    return "trace_invalid";
  }
  const mode = trace.source.mode;
  if (
    (cell.mode === "direct" && (mode.configured !== false || mode.engaged !== false)) ||
    (cell.mode === "code" && (mode.configured !== true || mode.engaged !== true))
  ) {
    return "trace_mode_mismatch";
  }
  const route = trace.source.route;
  if (
    !route ||
    route.provider !== plan.model.provider ||
    route.model !== plan.model.model ||
    route.api !== plan.model.api ||
    envelope.provider !== route.provider ||
    envelope.model !== route.model
  ) {
    return "trace_route_mismatch";
  }
  return null;
}

export function classifyFrontierEnvelope(
  envelope: FrontierEnvelopeOutcome,
  oracle: FrontierCellOracle,
): FrontierMatrixFailure | null {
  if (envelope.cleanupFailed || envelope.errorPhase === "cleanup") {
    return "cleanup_failed";
  }
  if (envelope.status === "timeout") {
    return "timeout";
  }
  if (envelope.errorPhase === "infrastructure") {
    return "infrastructure_failed";
  }
  if (envelope.errorPhase === "task") {
    return "task_error";
  }
  return oracle.passed ? null : "task_failed";
}

export function buildFrontierExecution(params: {
  cell: FrozenFrontierMatrixCell;
  evidenceSource: EvidenceSource;
  endedAtUtc: string;
  observed: FrontierObservedCellReceipt;
  plan: FrozenFrontierMatrixPlan;
  source: FrozenFrontierMatrixIdentity;
  startedAtUtc: string;
  sessionSha256: Sha256;
  wallLatencyMs: number;
}): FrontierMatrixCellExecution {
  return {
    campaignId: params.plan.campaign.id,
    blockId: params.plan.campaign.blockId,
    identitySha256: params.plan.identitySha256,
    cellId: params.cell.id,
    cellStateKey: params.cell.stateKey,
    observed: structuredClone(params.observed),
    source: structuredClone(params.source),
    sessionSha256: params.sessionSha256,
    harnessAttempt: 1,
    concurrency: 1,
    evidenceSource: params.evidenceSource,
    startedAtUtc: params.startedAtUtc,
    endedAtUtc: params.endedAtUtc,
    wallLatencyMs: params.wallLatencyMs,
  };
}

export function observedCellReceiptMatchesPlan(
  receipt: FrontierObservedCellReceipt,
  cell: FrozenFrontierMatrixCell,
  plan: FrozenFrontierMatrixPlan,
): boolean {
  const task = plan.task.manifest[cell.taskIndex];
  if (!task) {
    return false;
  }
  const expected: FrontierObservedCellReceipt = {
    cellId: cell.id,
    cellStateKey: cell.stateKey,
    taskId: cell.taskId,
    taskIndex: cell.taskIndex,
    taskSha256: cell.taskSha256,
    fixtureSha256: task.fixtureSha256,
    promptSha256: task.promptSha256,
    oracleSha256: task.oracleSha256,
    modeConfigSha256:
      cell.mode === "direct"
        ? plan.execution.modeConfigProof.directSha256
        : plan.execution.modeConfigProof.codeSha256,
  };
  return canonicalJson(receipt) === canonicalJson(expected);
}

export function buildFrontierAuditBundle(params: {
  cell: FrozenFrontierMatrixCell;
  envelope: FrontierEnvelopeOutcome;
  execution: FrontierMatrixCellExecution;
  failure: FrontierMatrixFailure | null;
  oracle: FrontierCellOracle;
  plan: FrozenFrontierMatrixPlan;
  trace: AgentExecTrace;
}): FrontierMatrixAuditBundle {
  const task = params.plan.task.manifest[params.cell.taskIndex]!;
  const persistedTrace = parsePersistedJson(JSON.stringify(params.trace)) as AgentExecTrace;
  const contents = {
    campaign: {
      id: params.plan.campaign.id,
      blockId: params.plan.campaign.blockId,
      identitySha256: params.plan.identitySha256,
    },
    cell: params.cell,
    execution: params.execution,
    oracle: {
      passed: params.oracle.passed,
      sha256: task.oracleSha256,
    },
    envelope: params.envelope,
    trace: persistedTrace,
    verdict: {
      failure: params.failure,
      passed: params.failure === null,
    },
  };
  const fieldDigests = {
    envelopeBytesSha256: digestFrontierEvidence(
      "frontier.envelope.bytes.v2",
      canonicalJson(params.envelope),
    ),
    envelopeOutcomeSha256: digestFrontierEvidence("frontier.envelope.outcome.v2", params.envelope),
    executionReceiptSha256: digestFrontierEvidence(
      "frontier.execution-receipt.v2",
      params.execution,
    ),
    invocationReceiptSha256: digestFrontierEvidence(
      "frontier.invocation-receipt.v2",
      persistedTrace.source.invocationReceipt,
    ),
    oracleResultSha256: digestFrontierEvidence("frontier.oracle-result.v2", contents.oracle),
    taskIdentitySha256: digestFrontierEvidence("frontier.task-identity.v2", {
      campaignIdentitySha256: params.plan.identitySha256,
      cell: params.cell,
      sessionSha256: params.envelope.sessionSha256,
      observed: params.execution.observed,
      task,
    }),
    traceSourceSha256: digestFrontierEvidence("frontier.trace-source.v2", persistedTrace.source),
    traceSha256: digestFrontierEvidence("frontier.trace.v2", persistedTrace),
  };
  return {
    ...contents,
    digests: {
      ...fieldDigests,
      bundleSha256: digestFrontierEvidence("frontier.audit-bundle.v2", {
        contents,
        fieldDigests,
      }),
    },
  };
}

function executionMatchesPlan(
  execution: FrontierMatrixCellExecution,
  cell: FrozenFrontierMatrixCell,
  plan: FrozenFrontierMatrixPlan,
): boolean {
  const startedAtMs = Date.parse(execution.startedAtUtc);
  const endedAtMs = Date.parse(execution.endedAtUtc);
  const expected = buildFrontierExecution({
    cell,
    evidenceSource: execution.evidenceSource,
    endedAtUtc: execution.endedAtUtc,
    observed: execution.observed,
    plan,
    source: execution.source,
    startedAtUtc: execution.startedAtUtc,
    sessionSha256: execution.sessionSha256,
    wallLatencyMs: execution.wallLatencyMs,
  });
  return (
    (execution.evidenceSource === "production" || execution.evidenceSource === "test_fixture") &&
    canonicalJson(expected) === canonicalJson(execution) &&
    observedCellReceiptMatchesPlan(execution.observed, cell, plan) &&
    sameFrozenIdentity(execution.source, plan.source) &&
    (execution.source as { sourceDirty?: unknown }).sourceDirty === false &&
    Number.isFinite(execution.wallLatencyMs) &&
    execution.wallLatencyMs >= 0 &&
    Number.isFinite(startedAtMs) &&
    Number.isFinite(endedAtMs) &&
    execution.startedAtUtc === new Date(startedAtMs).toISOString() &&
    execution.endedAtUtc === new Date(endedAtMs).toISOString() &&
    endedAtMs >= startedAtMs
  );
}

export function verifyFrontierAuditBundle(
  bundle: FrontierMatrixAuditBundle,
  plan: FrozenFrontierMatrixPlan,
): boolean {
  const cell = plan.cells.find((entry) => entry.id === bundle.cell.id);
  const task = plan.task.manifest[bundle.cell.taskIndex];
  const digestEntries = Object.entries(bundle.digests);
  if (
    !cell ||
    !task ||
    digestEntries.length !== FRONTIER_AUDIT_DIGEST_KEYS.size ||
    digestEntries.some(
      ([key, value]) =>
        !FRONTIER_AUDIT_DIGEST_KEYS.has(key) ||
        typeof value !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value),
    ) ||
    canonicalJson(cell) !== canonicalJson(bundle.cell) ||
    !executionMatchesPlan(bundle.execution, cell, plan) ||
    bundle.campaign.id !== plan.campaign.id ||
    bundle.campaign.blockId !== plan.campaign.blockId ||
    bundle.campaign.identitySha256 !== plan.identitySha256 ||
    typeof bundle.oracle.passed !== "boolean" ||
    bundle.oracle.sha256 !== task.oracleSha256 ||
    !validStoredEnvelopeOutcome(bundle.envelope) ||
    bundle.execution.sessionSha256 !== bundle.envelope.sessionSha256 ||
    bundle.verdict.passed !== (bundle.verdict.failure === null)
  ) {
    return false;
  }
  const traceJson = JSON.stringify(bundle.trace);
  const trace = normalizeAgentExecTrace(traceJson);
  const receiptJson = JSON.stringify(bundle.trace.source.invocationReceipt);
  const receipt = normalizeAgentExecInvocationReceipt(receiptJson);
  if (
    !trace ||
    !receipt ||
    !verifyAgentExecTrace(traceJson) ||
    !verifyAgentExecInvocationReceipt(receiptJson) ||
    canonicalJson(trace) !== canonicalJson(bundle.trace) ||
    canonicalJson(receipt) !== canonicalJson(bundle.trace.source.invocationReceipt) ||
    bundle.digests.envelopeBytesSha256 !==
      digestFrontierEvidence("frontier.envelope.bytes.v2", canonicalJson(bundle.envelope)) ||
    bundle.digests.envelopeOutcomeSha256 !==
      digestFrontierEvidence("frontier.envelope.outcome.v2", bundle.envelope) ||
    bundle.digests.executionReceiptSha256 !==
      digestFrontierEvidence("frontier.execution-receipt.v2", bundle.execution) ||
    bundle.digests.invocationReceiptSha256 !==
      digestFrontierEvidence("frontier.invocation-receipt.v2", receipt) ||
    bundle.digests.oracleResultSha256 !==
      digestFrontierEvidence("frontier.oracle-result.v2", bundle.oracle) ||
    bundle.digests.taskIdentitySha256 !==
      digestFrontierEvidence("frontier.task-identity.v2", {
        campaignIdentitySha256: plan.identitySha256,
        cell,
        sessionSha256: bundle.envelope.sessionSha256,
        observed: bundle.execution.observed,
        task,
      }) ||
    bundle.digests.traceSourceSha256 !==
      digestFrontierEvidence("frontier.trace-source.v2", trace.source) ||
    bundle.digests.traceSha256 !== digestFrontierEvidence("frontier.trace.v2", trace)
  ) {
    return false;
  }
  const expectedFailure =
    frontierTraceFailure(trace, cell, plan, bundle.envelope) ??
    classifyFrontierEnvelope(bundle.envelope, { passed: bundle.oracle.passed });
  if (bundle.verdict.failure !== expectedFailure) {
    return false;
  }
  const { digests, ...contents } = bundle;
  const { bundleSha256: _bundleSha256, ...fieldDigests } = digests;
  return (
    digests.bundleSha256 ===
    digestFrontierEvidence("frontier.audit-bundle.v2", { contents, fieldDigests })
  );
}
