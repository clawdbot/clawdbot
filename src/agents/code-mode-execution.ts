import { randomUUID } from "node:crypto";
import { codeModeReplayIdForToolCall } from "./code-mode-bridge.js";
import { awaitCodeModeDeadline } from "./code-mode-deadline.js";
import {
  createCodeModeNamespaceRuntime,
  type CodeModeNamespaceRuntime,
} from "./code-mode-namespaces.js";
import {
  CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
  codeModeFailureCode,
  codeModeFailureMessage,
  createCodeModeApiFilesForRun,
  enforceOutputLimit,
  enforceResultLimit,
  enforceSnapshotPayloadLimits,
  prepareSource,
  resolveCodeModeConfig,
  toToolSearchConfig,
  type CodeModeConfig,
  type CodeModeLanguage,
  type CodeModeSettlementMode,
  type CodeModeWorkerResult,
  type SettledBridgeRequest,
} from "./code-mode-runtime.js";
import {
  activeRuns,
  cancelPendingBridgeStates,
  codeModeWaitingReason,
  createPendingBridgeStates,
  disposeCodeModeRun,
  mergePendingBridgeSideEffectFree,
  pendingBridgeRequestsSideEffectFree,
  pendingBridgeRequestsReplaySafe,
  pendingBridgeStatesForSettlement,
  pendingToolCalls,
  removeExpiredRuns,
  reserveActiveRunSlot,
  resumingRunIds,
  settledBridgeRequestsInCompletionOrder,
  snapshotState,
  storeSnapshotState,
  takeUndeliveredCodeModeRunOutput,
  telemetry,
  waitForPendingBridgeSettlement,
  type PendingBridgeState,
} from "./code-mode-state.js";
import { normalizeCodeModeWorkerResult, runCodeModeWorker } from "./code-mode-worker.js";
import type { AgentToolUpdateCallback } from "./runtime/index.js";
import { resolveSwarmConfig } from "./swarm-config.js";
import { ToolSearchRuntime, type ToolSearchToolContext } from "./tool-search.js";
import { ToolInputError } from "./tools/common.js";

export async function runExec(params: {
  toolCallId: string;
  ctx: ToolSearchToolContext;
  code: string;
  assistantTurnId?: string;
  language?: CodeModeLanguage;
  restartSafe: boolean;
  readOnly: boolean;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}) {
  removeExpiredRuns();
  const config = resolveCodeModeConfig(
    params.ctx.runtimeConfig ?? params.ctx.config,
    params.ctx.agentId,
  );
  // The exec/wait tools only exist when the run gate engaged code mode, so
  // "auto" counts as enabled here; only a hard `false` rejects execution.
  if (config.enabled === false) {
    throw new ToolInputError("code mode is disabled.");
  }
  const runtime = new ToolSearchRuntime(params.ctx, toToolSearchConfig(config), {
    enforceSideEffectFree: params.readOnly,
    repairInput: true,
    // Reject malformed core-tool inputs before the execution boundary. This
    // preserves proof that a failed mutating call had no observable effects.
    validateInput: "core",
  });
  const bridgeDispatch = { started: false };
  if (params.signal?.aborted) {
    return {
      status: "failed" as const,
      error: "code mode execution aborted",
      code: "aborted" as const,
      failurePhase: "host" as const,
      bridgeDispatchStarted: false,
      output: [],
      readOnly: params.readOnly,
      replaySafe: params.restartSafe,
      telemetry: telemetry(runtime),
    };
  }
  const deadlineMs = Date.now() + config.timeoutMs;
  const catalog = runtime.all({ includeMcp: false });
  const namespaceCatalog = runtime.namespaceEntries();
  const swarmEnabled = resolveSwarmConfig(
    params.ctx.runtimeConfig ?? params.ctx.config,
    params.ctx.agentId,
  ).enabled;
  const codeModeReplayId = codeModeReplayIdForToolCall(
    params.ctx,
    params.toolCallId,
    params.code,
    params.assistantTurnId,
  );
  const namespaceRuntime = createCodeModeNamespaceRuntime(namespaceCatalog);
  const apiFiles = createCodeModeApiFilesForRun(namespaceRuntime, swarmEnabled);
  try {
    const source = await awaitCodeModeDeadline({
      operation: () => prepareSource({ code: params.code, language: params.language, config }),
      deadlineMs,
      signal: params.signal,
      createTimeoutError: () => new Error("interrupted"),
      createAbortError: () => new Error("code mode execution aborted"),
    });
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new Error("interrupted");
    }
    const result = normalizeCodeModeWorkerResult(
      await runCodeModeWorker(
        {
          kind: "exec",
          source,
          config: { ...config, timeoutMs: remainingMs },
          catalog,
          apiFiles,
          namespaces: namespaceRuntime.descriptors,
          swarmEnabled,
        },
        remainingMs + CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
        undefined,
        params.signal,
      ),
    );
    const settled = await settleCodeModeResult({
      result,
      output: result.output,
      replaySafe: params.restartSafe,
      readOnly: params.readOnly,
      sideEffectFree: true,
      deadlineMs,
      parentToolCallId: params.toolCallId,
      codeModeReplayId,
      ctx: params.ctx,
      config,
      runtime,
      namespaceRuntime,
      bridgeDispatch,
      signal: params.signal,
      onUpdate: params.onUpdate,
    });
    return { ...settled, readOnly: params.readOnly };
  } catch (error) {
    const code = params.signal?.aborted ? ("aborted" as const) : codeModeFailureCode(error);
    return {
      status: "failed" as const,
      error: params.signal?.aborted ? "code mode execution aborted" : codeModeFailureMessage(error),
      code,
      failurePhase: bridgeDispatch.started
        ? ("bridge" as const)
        : code === "invalid_input"
          ? ("input" as const)
          : ("host" as const),
      bridgeDispatchStarted: bridgeDispatch.started,
      output: [],
      readOnly: params.readOnly,
      replaySafe: params.restartSafe,
      telemetry: telemetry(runtime),
    };
  }
}

function usableResumeBudgetMs(deadlineMs: number, config: CodeModeConfig): number | undefined {
  // VM restore costs tens of ms and counts against the guest interrupt budget;
  // resuming with less than this floor converts an otherwise successful run
  // into an immediate interrupt timeout, so callers park the snapshot instead.
  const minimum = Math.min(250, Math.max(1, Math.floor(config.timeoutMs / 2)));
  const remaining = deadlineMs - Date.now();
  return remaining >= minimum ? remaining : undefined;
}

async function waitForPending(
  pending: readonly PendingBridgeState[],
  settlementMode: CodeModeSettlementMode,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  // Abort wins even over already-settled requests: callers treat `false` as
  // "do not resume the guest", which is what a cancelled exec/wait needs.
  if (signal?.aborted) {
    return false;
  }
  const required = pendingBridgeStatesForSettlement(pending, settlementMode);
  if (
    required.length === 0 ||
    (settlementMode.kind === "awaiting" && required.some((entry) => entry.settled)) ||
    required.every((entry) => entry.settled)
  ) {
    return true;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const bridgeReady = waitForPendingBridgeSettlement(pending, settlementMode).then(() => true);
    return await Promise.race([
      bridgeReady,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
      ...(signal
        ? [
            new Promise<boolean>((resolve) => {
              onAbort = () => resolve(false);
              signal.addEventListener("abort", onAbort, { once: true });
            }),
          ]
        : []),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

async function settleCodeModeResult(params: {
  result: CodeModeWorkerResult;
  output: unknown[];
  replaySafe: boolean;
  readOnly: boolean;
  sideEffectFree: boolean;
  parentToolCallId: string;
  codeModeReplayId: string;
  ctx: ToolSearchToolContext;
  config: CodeModeConfig;
  runtime: ToolSearchRuntime;
  namespaceRuntime: CodeModeNamespaceRuntime;
  deadlineMs: number;
  deliveredOutputCount?: number;
  pending?: PendingBridgeState[];
  activeRunId?: string;
  reservedActiveRunSlot?: boolean;
  bridgeDispatch: { started: boolean };
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}) {
  let result = params.result;
  let pending = params.pending ?? [];
  let sideEffectFree = params.sideEffectFree;
  const activeRunId = params.activeRunId ?? `cm_${randomUUID()}`;
  const output = params.output;
  const deliveredOutputCount = params.deliveredOutputCount ?? 0;
  // One exec/wait call shares a single wall-clock deadline across its initial
  // worker run and this inline settle phase, so auto-draining bridge calls
  // cannot stack a second full `timeoutMs` budget on top of the run that
  // produced them. The deadline is also the only bound on sequential drain
  // rounds; maxPendingToolCalls stays a per-batch concurrency cap enforced in
  // the worker.
  const settleDeadline = params.deadlineMs;
  const abortedResult = () => ({
    status: "failed" as const,
    error: "code mode execution aborted",
    code: "aborted" as const,
    failurePhase: params.bridgeDispatch.started ? ("bridge" as const) : ("host" as const),
    bridgeDispatchStarted: params.bridgeDispatch.started,
    output: output.slice(deliveredOutputCount),
    replaySafe: params.replaySafe,
    telemetry: telemetry(params.runtime),
  });
  // Bridge tool calls (search/describe/call/namespace) run through the same
  // policy-checked executor whether the model awaits them one at a time or in a
  // batch, so resolve them inline within the exec deadline and resume the VM
  // instead of forcing a `wait` round-trip per await. Only explicit
  // yield_control hands control back to the model; a call that outlives the
  // deadline still falls back to a suspended snapshot below.
  while (
    result.status === "waiting" &&
    result.pendingRequests.length > 0 &&
    result.pendingRequests.every((request) => request.method !== "yield")
  ) {
    if (params.readOnly) {
      if (!pendingBridgeRequestsSideEffectFree(result.pendingRequests, params.runtime)) {
        cancelPendingBridgeStates(pending);
        return {
          status: "failed" as const,
          error: "read-only code mode cannot call side-effecting tools.",
          code: "invalid_input" as const,
          failurePhase: params.bridgeDispatch.started ? ("bridge" as const) : ("input" as const),
          bridgeDispatchStarted: params.bridgeDispatch.started,
          output: output.slice(deliveredOutputCount),
          replaySafe: true,
          sideEffectFree,
          telemetry: telemetry(params.runtime),
        };
      }
    } else if (params.replaySafe) {
      // Restart-safe runs may drain only requests proven safe before dispatch.
      // This keeps ordinary reads inside exec instead of exposing a suspended
      // snapshot that a later outer continuation cannot reliably resume.
      if (result.pendingRequests.some((request) => request.method === "namespace")) {
        cancelPendingBridgeStates(pending);
        return {
          status: "failed" as const,
          error: "restart-safe code mode cannot call namespace tools.",
          code: "invalid_input" as const,
          failurePhase: params.bridgeDispatch.started ? ("bridge" as const) : ("input" as const),
          bridgeDispatchStarted: params.bridgeDispatch.started,
          output: output.slice(deliveredOutputCount),
          replaySafe: true,
          sideEffectFree,
          telemetry: telemetry(params.runtime),
        };
      }
      if (!pendingBridgeRequestsReplaySafe(result.pendingRequests, params.runtime)) {
        cancelPendingBridgeStates(pending);
        return {
          status: "failed" as const,
          error: "restart-safe code mode cannot call side-effecting tools.",
          code: "invalid_input" as const,
          failurePhase: params.bridgeDispatch.started ? ("bridge" as const) : ("input" as const),
          bridgeDispatchStarted: params.bridgeDispatch.started,
          output: output.slice(deliveredOutputCount),
          replaySafe: true,
          sideEffectFree,
          telemetry: telemetry(params.runtime),
        };
      }
    }
    const remainingMs = settleDeadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    if (params.signal?.aborted) {
      cancelPendingBridgeStates(pending);
      return abortedResult();
    }
    let releaseReservation: (() => void) | undefined;
    try {
      enforceSnapshotPayloadLimits({
        snapshotBytes: result.snapshotBytes,
        config: params.config,
        output,
      });
      if (!params.reservedActiveRunSlot) {
        releaseReservation = reserveActiveRunSlot();
      }
      const pendingIds = new Set(pending.map((entry) => entry.id));
      const newPendingRequests = result.pendingRequests.filter(
        (request) => !pendingIds.has(request.id),
      );
      if (newPendingRequests.length > 0) {
        // createPendingBridgeStates starts host calls synchronously. Flip the
        // evidence first so every later failure is permanently non-retryable.
        params.bridgeDispatch.started = true;
      }
      const newPendingStates = createPendingBridgeStates({
        pendingRequests: newPendingRequests,
        runtime: params.runtime,
        namespaceRuntime: params.namespaceRuntime,
        parentToolCallId: params.parentToolCallId,
        codeModeRunId: params.codeModeReplayId,
        activeRunId,
        ctx: params.ctx,
        signal: params.signal,
        onUpdate: params.onUpdate,
      });
      pending.push(...newPendingStates);
      const ready = await waitForPending(
        pending,
        result.settlementMode,
        remainingMs,
        params.signal,
      );
      sideEffectFree = mergePendingBridgeSideEffectFree(sideEffectFree, pending);
      const resumeBudgetMs = ready
        ? usableResumeBudgetMs(settleDeadline, params.config)
        : undefined;
      if (!ready || resumeBudgetMs === undefined) {
        // Abort drops the run instead of parking it: a suspended snapshot for a
        // cancelled call could never be waited on and would pin one of the
        // process-global active-run slots until TTL expiry.
        if (params.signal?.aborted) {
          cancelPendingBridgeStates(pending);
          return abortedResult();
        }
        // Parked rather than resumed: without a usable budget the restore alone
        // would burn the remaining deadline and fail a recoverable run.
        return storeSnapshotState({
          runId: activeRunId,
          replayId: params.codeModeReplayId,
          pending,
          replaySafe: params.readOnly || params.replaySafe,
          readOnly: params.readOnly,
          sideEffectFree,
          settlementMode: result.settlementMode,
          snapshotBytes: result.snapshotBytes,
          parentToolCallId: params.parentToolCallId,
          ctx: params.ctx,
          config: params.config,
          runtime: params.runtime,
          namespaceRuntime: params.namespaceRuntime,
          output,
          deliveredOutputCount,
        });
      }
      // Deliver the settled frontier only. Unresolved sibling promises remain
      // attached to their original bridge ids across the restored snapshot.
      const settledRequests: SettledBridgeRequest[] =
        settledBridgeRequestsInCompletionOrder(pending);
      pending = pending.filter((entry) => !entry.settled);
      // The resumed guest inherits only the remaining shared budget as its
      // QuickJS interrupt deadline; the extra host margin is watchdog grace,
      // not extra guest run time.
      result = normalizeCodeModeWorkerResult(
        await runCodeModeWorker(
          {
            kind: "resume",
            snapshotBytes: result.snapshotBytes,
            config: {
              ...params.config,
              timeoutMs: resumeBudgetMs,
            },
            settledRequests,
            pendingRequests: pending.map(({ id, method, args }) => ({ id, method, args })),
          },
          resumeBudgetMs + CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
          undefined,
          params.signal,
        ),
      );
      output.push(...result.output);
      enforceOutputLimit(output, params.config);
    } catch (error) {
      cancelPendingBridgeStates(pending);
      throw error;
    } finally {
      releaseReservation?.();
    }
  }
  if (result.status === "waiting") {
    if (params.signal?.aborted) {
      cancelPendingBridgeStates(pending);
      return abortedResult();
    }
    const pendingReplaySafe = pendingBridgeRequestsReplaySafe(
      result.pendingRequests,
      params.runtime,
    );
    const pendingSideEffectFree = pendingBridgeRequestsSideEffectFree(
      result.pendingRequests,
      params.runtime,
    );
    if (params.readOnly && !pendingSideEffectFree) {
      cancelPendingBridgeStates(pending);
      return {
        status: "failed" as const,
        error: "read-only code mode cannot call side-effecting tools.",
        code: "invalid_input" as const,
        failurePhase: params.bridgeDispatch.started ? ("bridge" as const) : ("input" as const),
        bridgeDispatchStarted: params.bridgeDispatch.started,
        output: output.slice(deliveredOutputCount),
        replaySafe: true,
        sideEffectFree,
        telemetry: telemetry(params.runtime),
      };
    }
    if (!params.readOnly && params.replaySafe && !pendingReplaySafe) {
      cancelPendingBridgeStates(pending);
      return {
        status: "failed" as const,
        error: "restart-safe code mode cannot call side-effecting tools.",
        code: "invalid_input" as const,
        failurePhase: params.bridgeDispatch.started ? ("bridge" as const) : ("input" as const),
        bridgeDispatchStarted: params.bridgeDispatch.started,
        output: output.slice(deliveredOutputCount),
        replaySafe: true,
        sideEffectFree,
        telemetry: telemetry(params.runtime),
      };
    }
    if (pending.length > 0) {
      let releaseReservation: (() => void) | undefined;
      try {
        // A resumed guest can grow its next snapshot before the shared deadline
        // expires; validate that new payload before reserving or parking it.
        enforceSnapshotPayloadLimits({
          snapshotBytes: result.snapshotBytes,
          config: params.config,
          output,
        });
        // Reserve before launching fresh work; transferred snapshots must
        // obey the same process-wide active-run cap as initial suspensions.
        if (!params.reservedActiveRunSlot) {
          releaseReservation = reserveActiveRunSlot();
        }
        const pendingIds = new Set(pending.map((entry) => entry.id));
        const newPendingRequests = result.pendingRequests.filter(
          (request) => !pendingIds.has(request.id),
        );
        if (newPendingRequests.length > 0) {
          params.bridgeDispatch.started = true;
        }
        const newPendingStates = createPendingBridgeStates({
          pendingRequests: newPendingRequests,
          runtime: params.runtime,
          namespaceRuntime: params.namespaceRuntime,
          parentToolCallId: params.parentToolCallId,
          codeModeRunId: params.codeModeReplayId,
          activeRunId,
          ctx: params.ctx,
          signal: params.signal,
          onUpdate: params.onUpdate,
        });
        pending.push(...newPendingStates);
        sideEffectFree = mergePendingBridgeSideEffectFree(sideEffectFree, pending);
        return storeSnapshotState({
          runId: activeRunId,
          replayId: params.codeModeReplayId,
          pending,
          replaySafe: params.readOnly || (params.replaySafe && pendingReplaySafe),
          readOnly: params.readOnly,
          sideEffectFree,
          settlementMode: result.settlementMode,
          snapshotBytes: result.snapshotBytes,
          parentToolCallId: params.parentToolCallId,
          ctx: params.ctx,
          config: params.config,
          runtime: params.runtime,
          namespaceRuntime: params.namespaceRuntime,
          output,
          deliveredOutputCount,
        });
      } catch (error) {
        cancelPendingBridgeStates(pending);
        throw error;
      } finally {
        releaseReservation?.();
      }
    }
    if (result.pendingRequests.length > 0) {
      params.bridgeDispatch.started = true;
    }
    return snapshotState({
      pendingRequests: result.pendingRequests,
      snapshotBytes: result.snapshotBytes,
      parentToolCallId: params.parentToolCallId,
      codeModeReplayId: params.codeModeReplayId,
      ctx: params.ctx,
      config: params.config,
      runtime: params.runtime,
      namespaceRuntime: params.namespaceRuntime,
      output,
      deliveredOutputCount,
      reservedActiveRunSlot: params.reservedActiveRunSlot,
      replaySafe: params.replaySafe,
      readOnly: params.readOnly,
      sideEffectFree,
      settlementMode: result.settlementMode,
      signal: params.signal,
      onUpdate: params.onUpdate,
    });
  }
  // Defensive cleanup covers aborts or terminal failures; successful runs have
  // already drained every dispatched call before releasing their snapshot.
  cancelPendingBridgeStates(pending);
  enforceResultLimit({
    output,
    value: result.status === "completed" ? result.value : undefined,
    config: params.config,
  });
  return {
    ...result,
    ...(result.status === "failed"
      ? {
          failurePhase: params.bridgeDispatch.started ? ("bridge" as const) : result.failurePhase,
          bridgeDispatchStarted: params.bridgeDispatch.started,
        }
      : {}),
    output: output.slice(deliveredOutputCount),
    replaySafe: params.replaySafe,
    sideEffectFree,
    telemetry: telemetry(params.runtime),
  };
}

export async function runWait(params: {
  toolCallId: string;
  ctx: ToolSearchToolContext;
  runId: string;
  requireRestartSafe?: boolean;
  requireReadOnly?: boolean;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}) {
  removeExpiredRuns();
  const state = activeRuns.get(params.runId);
  if (!state) {
    throw new ToolInputError("code mode run is unavailable or expired.");
  }
  if (state.ctx.runId && state.ctx.runId !== params.ctx.runId) {
    throw new ToolInputError("code mode run belongs to a different agent run.");
  }
  if (
    (state.ctx.sessionId && state.ctx.sessionId !== params.ctx.sessionId) ||
    (state.ctx.sessionKey && state.ctx.sessionKey !== params.ctx.sessionKey) ||
    (state.ctx.agentId && state.ctx.agentId !== params.ctx.agentId)
  ) {
    throw new ToolInputError("code mode run belongs to a different session.");
  }
  if (params.requireReadOnly && !state.readOnly) {
    throw new ToolInputError("code mode run was not created under the read-only policy.");
  }
  if (params.requireRestartSafe && !state.replaySafe) {
    throw new ToolInputError("code mode run was not created under the restart-safe policy.");
  }
  if (resumingRunIds.has(state.runId)) {
    throw new ToolInputError("code mode run is already being resumed.");
  }
  resumingRunIds.add(state.runId);
  // One wait call shares a single wall-clock deadline across draining the prior
  // pending calls, the resume worker, and the inline settle phase.
  const deadlineMs = Date.now() + state.config.timeoutMs;
  let releaseActiveRunSlot: (() => void) | undefined;
  try {
    const ready = await waitForPending(
      state.pending,
      state.settlementMode,
      Math.max(1, deadlineMs - Date.now()),
      params.signal,
    );
    state.sideEffectFree = mergePendingBridgeSideEffectFree(state.sideEffectFree, state.pending);
    const resumeBudgetMs = ready ? usableResumeBudgetMs(deadlineMs, state.config) : undefined;
    if (!ready || resumeBudgetMs === undefined) {
      // An aborted wait drops the suspended run: nothing will resume it, and
      // parking it would pin a process-global active-run slot until TTL expiry.
      if (params.signal?.aborted) {
        disposeCodeModeRun(state.runId);
        return {
          status: "failed" as const,
          error: "code mode execution aborted",
          code: "aborted" as const,
          failurePhase: "bridge" as const,
          bridgeDispatchStarted: true,
          output: takeUndeliveredCodeModeRunOutput(state),
          readOnly: state.readOnly,
          replaySafe: state.replaySafe,
          sideEffectFree: state.sideEffectFree,
          telemetry: telemetry(state.runtime),
        };
      }
      // Not ready, or ready without a usable resume budget: keep the snapshot
      // so the next wait can resume with a fresh deadline instead of losing
      // the run to a restore-only interrupt timeout.
      const pending = state.pending.filter((entry) => !entry.settled);
      return {
        status: "waiting" as const,
        runId: state.runId,
        reason: codeModeWaitingReason(pending.length > 0 ? pending : state.pending),
        pendingToolCalls: pendingToolCalls(pending.length > 0 ? pending : state.pending),
        readOnly: state.readOnly,
        replaySafe: state.replaySafe,
        sideEffectFree: state.sideEffectFree,
        output: takeUndeliveredCodeModeRunOutput(state),
        telemetry: telemetry(state.runtime),
      };
    }

    const settledRequests: SettledBridgeRequest[] = settledBridgeRequestsInCompletionOrder(
      state.pending,
    );
    const pending = state.pending.filter((entry) => !entry.settled);
    // Keep the run's existing slot reserved while its live sibling calls and
    // snapshot move through the worker; a new exec must not claim this slot.
    releaseActiveRunSlot = reserveActiveRunSlot(state.runId);
    // The resumed guest inherits only the remaining shared budget as its QuickJS
    // interrupt deadline; the extra host margin is watchdog grace only.
    const result = normalizeCodeModeWorkerResult(
      await runCodeModeWorker(
        {
          kind: "resume",
          snapshotBytes: state.snapshotBytes,
          config: {
            ...state.config,
            timeoutMs: resumeBudgetMs,
          },
          settledRequests,
          pendingRequests: pending.map(({ id, method, args }) => ({ id, method, args })),
        },
        resumeBudgetMs + CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
        undefined,
        params.signal,
      ),
    );
    const output = [...state.output, ...result.output];
    enforceOutputLimit(output, state.config);
    const settled = await settleCodeModeResult({
      result,
      output,
      replaySafe: state.replaySafe,
      readOnly: state.readOnly,
      sideEffectFree: state.sideEffectFree,
      deadlineMs,
      parentToolCallId: state.parentToolCallId,
      codeModeReplayId: state.replayId,
      ctx: state.ctx,
      config: state.config,
      runtime: state.runtime,
      namespaceRuntime: state.namespaceRuntime,
      bridgeDispatch: { started: true },
      deliveredOutputCount: state.deliveredOutputCount,
      pending,
      activeRunId: state.runId,
      reservedActiveRunSlot: true,
      signal: params.signal,
      onUpdate: params.onUpdate,
    });
    return { ...settled, readOnly: state.readOnly };
  } catch (error) {
    state.sideEffectFree = mergePendingBridgeSideEffectFree(state.sideEffectFree, state.pending);
    // After ownership leaves activeRuns, worker/limit failures must cancel
    // every transferred loser; there is no parked snapshot left to own it.
    if (!activeRuns.has(state.runId)) {
      cancelPendingBridgeStates(state.pending);
    }
    return {
      status: "failed" as const,
      error: codeModeFailureMessage(error),
      code: codeModeFailureCode(error),
      failurePhase: "bridge" as const,
      bridgeDispatchStarted: true,
      output: takeUndeliveredCodeModeRunOutput(state),
      readOnly: state.readOnly,
      replaySafe: state.replaySafe,
      sideEffectFree: state.sideEffectFree,
      telemetry: telemetry(state.runtime),
    };
  } finally {
    releaseActiveRunSlot?.();
    resumingRunIds.delete(state.runId);
  }
}

/** Create the exec/wait control tools for one Code Mode run context. */
