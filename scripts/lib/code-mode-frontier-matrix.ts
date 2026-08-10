import {
  reserveCodeModeMatrixOutputDir,
  resolveCodeModeMatrixOutputDir,
} from "../code-mode-model-matrix.js";
import {
  assertSafeFrontierArtifact,
  frontierFailureResult,
  sealFrontierResult,
  verifyFrontierResultSequence,
  writeFrontierArtifacts,
} from "./code-mode-frontier-matrix-artifacts.js";
import {
  buildFrontierAuditBundle,
  buildFrontierExecution,
  classifyFrontierEnvelope,
  frontierTraceFailure,
  normalizeFrontierEnvelope,
  observedCellReceiptMatchesPlan,
  type FrontierMatrixCellObservation,
  type FrozenFrontierMatrixCellResult,
} from "./code-mode-frontier-matrix-evidence.js";
import {
  digestFrontierEvidence,
  digestJson,
  frontierMatrixPreflightBlockers,
  FRONTIER_MATRIX_ABBA,
  sameFrozenIdentity,
  sha256,
  verifyFrozenFrontierMatrixPlan,
  type EvidenceSource,
  type FrozenFrontierMatrixCell,
  type FrozenFrontierMatrixIdentity,
  type FrozenFrontierMatrixPlan,
} from "./code-mode-frontier-matrix-plan.js";

export {
  buildFrontierModeConfigProof,
  buildFrozenFrontierMatrixPlan,
  createFrozenFrontierMatrixChildIsolation,
  digestJson,
  sha256,
  verifyFrozenFrontierMatrixPlan,
  type FrontierExecutionProof,
  type FrontierModeConfigProof,
  type FrontierRunnerConfig,
  type FrontierTaskDescriptor,
  type FrozenFrontierMatrixCell,
  type FrozenFrontierMatrixIdentity,
  type FrozenFrontierMatrixPlan,
} from "./code-mode-frontier-matrix-plan.js";
export {
  verifyFrontierAuditBundle,
  type FrontierMatrixAuditBundle,
  type FrontierMatrixCellExecution,
  type FrontierMatrixCellObservation,
  type FrontierObservedCellReceipt,
  type FrozenFrontierMatrixCellResult,
} from "./code-mode-frontier-matrix-evidence.js";

type FrozenFrontierMatrixDependencies = {
  readIdentity: () => Promise<FrozenFrontierMatrixIdentity>;
  runCell: (
    cell: FrozenFrontierMatrixCell,
    plan: FrozenFrontierMatrixPlan,
  ) => Promise<FrontierMatrixCellObservation>;
  evidenceSource?: EvidenceSource;
  wallNow?: () => Date;
  monotonicNow?: () => number;
};

async function readIdentityBounded(
  deps: FrozenFrontierMatrixDependencies,
  timeoutMs: number,
): Promise<FrozenFrontierMatrixIdentity> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      deps.readIdentity(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("frontier matrix identity observation timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function runFrozenFrontierMatrix(params: {
  deps: FrozenFrontierMatrixDependencies;
  outputDir: string;
  plan: FrozenFrontierMatrixPlan;
  repoRoot: string;
}) {
  if (!verifyFrozenFrontierMatrixPlan(params.plan)) {
    throw new Error("frontier matrix plan identity is invalid");
  }
  const resolvedOutput = resolveCodeModeMatrixOutputDir(
    params.repoRoot,
    params.outputDir,
    new Date(`${params.plan.runDate}T00:00:00.000Z`),
  );
  await reserveCodeModeMatrixOutputDir(params.repoRoot, resolvedOutput);
  const evidenceSource = params.deps.evidenceSource ?? "test_fixture";
  const initialBlockers = frontierMatrixPreflightBlockers(params.plan);
  const results: FrozenFrontierMatrixCellResult[] = [];
  if (initialBlockers.length === 0) {
    const sessionHashes = new Set<string>();
    let previousEndedAtMs: number | undefined;
    const wallNow = params.deps.wallNow ?? (() => new Date());
    const monotonicNow = params.deps.monotonicNow ?? (() => performance.now());
    for (const cell of params.plan.cells) {
      let preIdentity: FrozenFrontierMatrixIdentity;
      try {
        preIdentity = await readIdentityBounded(
          params.deps,
          params.plan.execution.identityObservationTimeoutMs,
        );
      } catch {
        results.push(frontierFailureResult(cell, "identity_observation_failed"));
        break;
      }
      if (!sameFrozenIdentity(preIdentity, params.plan.source)) {
        results.push(frontierFailureResult(cell, "frozen_identity_mismatch"));
        break;
      }
      const startedAt = wallNow();
      const startedMono = monotonicNow();
      let observation: FrontierMatrixCellObservation | undefined;
      let runnerFailed = false;
      try {
        observation = await params.deps.runCell(cell, params.plan);
      } catch {
        runnerFailed = true;
      }
      const endedMono = monotonicNow();
      const endedAt = wallNow();
      const wallLatencyMs = endedMono - startedMono;
      let postIdentity: FrozenFrontierMatrixIdentity;
      try {
        postIdentity = await readIdentityBounded(
          params.deps,
          params.plan.execution.identityObservationTimeoutMs,
        );
      } catch {
        results.push(frontierFailureResult(cell, "identity_observation_failed"));
        break;
      }
      if (!sameFrozenIdentity(postIdentity, params.plan.source)) {
        results.push(frontierFailureResult(cell, "frozen_identity_mismatch"));
        break;
      }
      if (runnerFailed || !observation) {
        results.push(frontierFailureResult(cell, "runner_failed"));
        break;
      }
      if (
        !Number.isFinite(startedAt.getTime()) ||
        !Number.isFinite(endedAt.getTime()) ||
        !Number.isFinite(wallLatencyMs) ||
        wallLatencyMs < 0 ||
        endedAt.getTime() < startedAt.getTime() ||
        (results.length === 0 && startedAt.toISOString().slice(0, 10) !== params.plan.runDate) ||
        (previousEndedAtMs !== undefined && startedAt.getTime() < previousEndedAtMs)
      ) {
        results.push(frontierFailureResult(cell, "runner_clock_invalid"));
        break;
      }
      previousEndedAtMs = endedAt.getTime();
      if (!observedCellReceiptMatchesPlan(observation.receipt, cell, params.plan)) {
        results.push(frontierFailureResult(cell, "execution_receipt_mismatch"));
        break;
      }
      const normalized = normalizeFrontierEnvelope(observation.envelope);
      if (!normalized || typeof observation.oracle?.passed !== "boolean") {
        results.push(frontierFailureResult(cell, "envelope_invalid"));
        break;
      }
      if (sessionHashes.has(normalized.outcome.sessionSha256)) {
        results.push(frontierFailureResult(cell, "session_reused"));
        break;
      }
      sessionHashes.add(normalized.outcome.sessionSha256);
      let failure = frontierTraceFailure(normalized.trace, cell, params.plan, normalized.outcome);
      failure ??= classifyFrontierEnvelope(normalized.outcome, observation.oracle);
      const execution = buildFrontierExecution({
        cell,
        evidenceSource,
        endedAtUtc: endedAt.toISOString(),
        observed: observation.receipt,
        plan: params.plan,
        sessionSha256: normalized.outcome.sessionSha256,
        source: postIdentity,
        startedAtUtc: startedAt.toISOString(),
        wallLatencyMs,
      });
      const bundle = buildFrontierAuditBundle({
        cell,
        envelope: normalized.outcome,
        execution,
        failure,
        oracle: observation.oracle,
        plan: params.plan,
        trace: normalized.trace,
      });
      results.push(
        sealFrontierResult({
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
          passed: failure === null,
          auditBundle: bundle,
        }),
      );
      if (failure !== null && failure !== "task_failed" && failure !== "task_error") {
        break;
      }
    }
  }
  while (results.length < params.plan.cells.length) {
    results.push(frontierFailureResult(params.plan.cells[results.length]!, "not_run"));
  }
  const summary = await writeFrontierArtifacts({
    evidenceSource,
    outputDir: resolvedOutput,
    plan: params.plan,
    results,
  });
  return {
    exitCode: summary.betaEligible ? (0 as const) : (1 as const),
    outputDir: resolvedOutput,
    results,
    summary,
  };
}

export const frozenFrontierMatrixTesting = {
  assertSafeArtifact: assertSafeFrontierArtifact,
  digestEvidence: digestFrontierEvidence,
  digestJson,
  normalizeEnvelope: normalizeFrontierEnvelope,
  preflightBlockers: frontierMatrixPreflightBlockers,
  schedule: FRONTIER_MATRIX_ABBA,
  sha256,
  verifyResultSequence: verifyFrontierResultSequence,
};
