import { randomUUID } from "node:crypto";
import {
  observeAgentRunApprovalWait,
  type AgentRunApprovalWait,
} from "./agent-run-approval-wait.js";
import { codeModeReplayIdForToolCall } from "./code-mode-bridge.js";
import {
  createCodeModeCatalogProjection,
  type CodeModeCatalogProjection,
} from "./code-mode-catalog.js";
import { awaitCodeModeDeadline } from "./code-mode-deadline.js";
import { boundCodeModeResult } from "./code-mode-json.js";
import {
  createCodeModeNamespaceRuntime,
  type CodeModeNamespaceRuntime,
} from "./code-mode-namespaces.js";
import { registerRepairableCodeModeFailure } from "./code-mode-repair-provenance.js";
import {
  CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
  codeModeFailureCode,
  codeModeFailureMessage,
  createCodeModeApiFilesForRun,
  boundOutputToLimit,
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
  cancelPendingBridgeStatesById,
  codeModeWaitingReason,
  createCodeModeBridgeDispatchState,
  createPendingBridgeStates,
  disposeCodeModeRun,
  isCodeModeBridgeRepairEligible,
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
  type CodeModeBridgeDispatchState,
} from "./code-mode-state.js";
import { normalizeCodeModeWorkerResult, runCodeModeWorker } from "./code-mode-worker.js";
import type { AgentToolUpdateCallback } from "./runtime/index.js";
import { resolveSwarmConfig } from "./subagents/swarm/swarm-config.js";
import { ToolSearchRuntime, type ToolSearchToolContext } from "./tool-search.js";
import { ToolInputError } from "./tools/common.js";

export async function runCodeModeExec(params: {
  toolCallId: string;
  ctx: ToolSearchToolContext;
  code: string;
  assistantTurnId?: string;
  language?: CodeModeLanguage;
  restartSafe: boolean;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
  onRuntime?: (runtime: ToolSearchRuntime) => void;
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
    prepareInput: true,
  });
  params.onRuntime?.(runtime);
  const bridgeDispatch = createCodeModeBridgeDispatchState();
  if (params.signal?.aborted) {
    return {
      status: "failed" as const,
      error: "code mode execution aborted",
      code: "aborted" as const,
      failurePhase: "host" as const,
      bridgeDispatchStarted: false,
      output: [],
      replaySafe: params.restartSafe,
      telemetry: telemetry(runtime),
    };
  }
  const deadlineMs = Date.now() + config.timeoutMs;
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
  const catalogProjection = createCodeModeCatalogProjection(runtime.all({ includeMcp: false }), {
    reservedNames: namespaceRuntime.descriptors.map((descriptor) => descriptor.globalName),
  });
  const apiFiles = createCodeModeApiFilesForRun(namespaceRuntime, swarmEnabled);
  const approvalWait = observeAgentRunApprovalWait(params.ctx);
  try {
    const source = await awaitCodeModeDeadline({
      operation: () => prepareSource({ code: params.code, language: params.language, config }),
      remainingMs: deadlineMs - Date.now(),
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
          catalog: catalogProjection.guestBindings,
          apiFiles,
          namespaces: namespaceRuntime.descriptors,
          swarmEnabled,
        },
        remainingMs + CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
        undefined,
        params.signal,
      ),
    );
    return await settleCodeModeResult({
      result,
      output: result.output,
      replaySafe: params.restartSafe,
      deadlineMs,
      parentToolCallId: params.toolCallId,
      codeModeReplayId,
      ctx: params.ctx,
      config,
      runtime,
      catalogProjection,
      namespaceRuntime,
      bridgeDispatch,
      approvalWait,
      signal: params.signal,
      onUpdate: params.onUpdate,
    });
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
      replaySafe: params.restartSafe,
      telemetry: telemetry(runtime),
    };
  } finally {
    approvalWait.dispose();
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
  approvalWait: AgentRunApprovalWait,
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
        let remainingMs = timeoutMs;
        let resumedAtMs = Date.now();
        const arm = () => {
          resumedAtMs = Date.now();
          timer = setTimeout(() => resolve(false), Math.max(1, remainingMs));
        };
        approvalWait.onChange = (approvalPending) => {
          if (approvalPending) {
            // Preserve the unused guest budget while its owning approval remains inline.
            clearTimeout(timer);
            remainingMs = Math.max(1, remainingMs - (Date.now() - resumedAtMs));
          } else {
            arm();
          }
        };
        if (!approvalWait.pending) {
          arm();
        }
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
    approvalWait.onChange = undefined;
  }
}

async function settleCodeModeResult(params: {
  result: CodeModeWorkerResult;
  output: unknown[];
  replaySafe: boolean;
  parentToolCallId: string;
  codeModeReplayId: string;
  ctx: ToolSearchToolContext;
  config: CodeModeConfig;
  runtime: ToolSearchRuntime;
  catalogProjection: CodeModeCatalogProjection;
  namespaceRuntime: CodeModeNamespaceRuntime;
  deadlineMs: number;
  deliveredOutputCount?: number;
  pending?: PendingBridgeState[];
  activeRunId?: string;
  reservedActiveRunSlot?: boolean;
  bridgeDispatch: CodeModeBridgeDispatchState;
  approvalWait: AgentRunApprovalWait;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}) {
  let result = params.result;
  let pending = params.pending ?? [];
  if (result.status === "waiting") {
    cancelPendingBridgeStatesById(pending, result.canceledRequestIds);
  }
  const activeRunId = params.activeRunId ?? `cm_${randomUUID()}`;
  const output = params.output;
  let deliveredOutputCount = params.deliveredOutputCount ?? 0;
  // One exec/wait call shares a single wall-clock deadline across its initial
  // worker run and this inline settle phase, so auto-draining bridge calls
  // cannot stack a second full `timeoutMs` budget on top of the run that
  // produced them. The deadline is also the only bound on sequential drain
  // rounds; maxPendingToolCalls stays a per-batch concurrency cap enforced in
  // the worker.
  const settleDeadline = () => params.deadlineMs + params.approvalWait.pausedMs;
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
    if (params.replaySafe) {
      // Replay-safe runs never inline-drain: namespace calls stay a hard error
      // and other pending work falls through to the replay-safe snapshot check.
      if (result.pendingRequests.every((request) => request.method === "namespace")) {
        cancelPendingBridgeStates(pending);
        return {
          status: "failed" as const,
          error: "restart-safe code mode cannot call namespace tools.",
          code: "invalid_input" as const,
          failurePhase: params.bridgeDispatch.started ? ("bridge" as const) : ("input" as const),
          bridgeDispatchStarted: params.bridgeDispatch.started,
          output: output.slice(deliveredOutputCount),
          replaySafe: true,
          telemetry: telemetry(params.runtime),
        };
      }
      break;
    }
    const remainingMs = settleDeadline() - Date.now();
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
      });
      if (!params.reservedActiveRunSlot) {
        releaseReservation = reserveActiveRunSlot();
      }
      const pendingIds = new Set(pending.map((entry) => entry.id));
      const newPendingRequests = result.pendingRequests.filter(
        (request) => !pendingIds.has(request.id),
      );
      pending.push(
        ...createPendingBridgeStates({
          pendingRequests: newPendingRequests,
          config: params.config,
          runtime: params.runtime,
          catalogProjection: params.catalogProjection,
          namespaceRuntime: params.namespaceRuntime,
          parentToolCallId: params.parentToolCallId,
          codeModeRunId: params.codeModeReplayId,
          remainingMs: settleDeadline() - Date.now(),
          activeRunId,
          ctx: params.ctx,
          signal: params.signal,
          onUpdate: params.onUpdate,
          bridgeDispatch: params.bridgeDispatch,
        }),
      );
      const ready = await waitForPending(
        pending,
        result.settlementMode,
        remainingMs,
        params.approvalWait,
        params.signal,
      );
      const resumeBudgetMs = ready
        ? usableResumeBudgetMs(settleDeadline(), params.config)
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
          replaySafe: false,
          settlementMode: result.settlementMode,
          snapshotBytes: result.snapshotBytes,
          parentToolCallId: params.parentToolCallId,
          ctx: params.ctx,
          config: params.config,
          runtime: params.runtime,
          catalogProjection: params.catalogProjection,
          namespaceRuntime: params.namespaceRuntime,
          output,
          deliveredOutputCount,
          bridgeDispatch: params.bridgeDispatch,
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
      if (result.status === "waiting") {
        cancelPendingBridgeStatesById(pending, result.canceledRequestIds);
      }
      output.push(...result.output);
      if (boundOutputToLimit(output, params.config)) {
        deliveredOutputCount = 0;
      }
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
      params.catalogProjection,
    );
    if (params.replaySafe && !pendingReplaySafe) {
      cancelPendingBridgeStates(pending);
      return {
        status: "failed" as const,
        error:
          "restart-safe code mode cannot call tool surfaces that are not proven replay-safe; recovery runs must use audited read, grep, or find tools.",
        code: "invalid_input" as const,
        failurePhase: params.bridgeDispatch.started ? ("bridge" as const) : ("input" as const),
        bridgeDispatchStarted: params.bridgeDispatch.started,
        output: output.slice(deliveredOutputCount),
        replaySafe: true,
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
        pending.push(
          ...createPendingBridgeStates({
            pendingRequests: newPendingRequests,
            config: params.config,
            runtime: params.runtime,
            catalogProjection: params.catalogProjection,
            namespaceRuntime: params.namespaceRuntime,
            parentToolCallId: params.parentToolCallId,
            codeModeRunId: params.codeModeReplayId,
            remainingMs: settleDeadline() - Date.now(),
            activeRunId,
            ctx: params.ctx,
            signal: params.signal,
            onUpdate: params.onUpdate,
            bridgeDispatch: params.bridgeDispatch,
          }),
        );
        return storeSnapshotState({
          runId: activeRunId,
          replayId: params.codeModeReplayId,
          pending,
          replaySafe: params.replaySafe && pendingReplaySafe,
          settlementMode: result.settlementMode,
          snapshotBytes: result.snapshotBytes,
          parentToolCallId: params.parentToolCallId,
          ctx: params.ctx,
          config: params.config,
          runtime: params.runtime,
          catalogProjection: params.catalogProjection,
          namespaceRuntime: params.namespaceRuntime,
          output,
          deliveredOutputCount,
          bridgeDispatch: params.bridgeDispatch,
        });
      } catch (error) {
        cancelPendingBridgeStates(pending);
        throw error;
      } finally {
        releaseReservation?.();
      }
    }
    return snapshotState({
      pendingRequests: result.pendingRequests,
      snapshotBytes: result.snapshotBytes,
      parentToolCallId: params.parentToolCallId,
      codeModeReplayId: params.codeModeReplayId,
      ctx: params.ctx,
      config: params.config,
      runtime: params.runtime,
      catalogProjection: params.catalogProjection,
      namespaceRuntime: params.namespaceRuntime,
      output,
      remainingMs: settleDeadline() - Date.now(),
      deliveredOutputCount,
      reservedActiveRunSlot: params.reservedActiveRunSlot,
      replaySafe: params.replaySafe,
      settlementMode: result.settlementMode,
      signal: params.signal,
      onUpdate: params.onUpdate,
      bridgeDispatch: params.bridgeDispatch,
    });
  }
  // Defensive cleanup covers aborts or terminal failures; successful runs have
  // already drained every dispatched call before releasing their snapshot.
  cancelPendingBridgeStates(pending);
  const bounded = boundCodeModeResult({
    output,
    ...(result.status === "completed" ? { value: result.value } : {}),
    maxOutputBytes: params.config.maxOutputBytes,
  });
  const finalized = {
    ...result,
    ...(result.status === "completed" ? { value: bounded.value } : {}),
    ...(result.status === "failed"
      ? {
          failurePhase: params.bridgeDispatch.started ? ("bridge" as const) : result.failurePhase,
          bridgeDispatchStarted: params.bridgeDispatch.started,
        }
      : {}),
    output: bounded.output.slice(bounded.truncated ? 0 : deliveredOutputCount),
    replaySafe: params.replaySafe,
    telemetry: telemetry(params.runtime),
  };
  if (finalized.status === "failed" && isCodeModeBridgeRepairEligible(params.bridgeDispatch)) {
    registerRepairableCodeModeFailure(finalized);
  }
  return finalized;
}

export async function runWait(params: {
  toolCallId: string;
  ctx: ToolSearchToolContext;
  runId: string;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
  onRuntime?: (runtime: ToolSearchRuntime) => void;
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
  if (resumingRunIds.has(state.runId)) {
    throw new ToolInputError("code mode run is already being resumed.");
  }
  params.onRuntime?.(state.runtime);
  resumingRunIds.add(state.runId);
  // One wait call shares a single wall-clock deadline across draining the prior
  // pending calls, the resume worker, and the inline settle phase.
  const deadlineMs = Date.now() + state.config.timeoutMs;
  const approvalWait = observeAgentRunApprovalWait(state.ctx);
  let releaseActiveRunSlot: (() => void) | undefined;
  try {
    const ready = await waitForPending(
      state.pending,
      state.settlementMode,
      Math.max(1, deadlineMs - Date.now()),
      approvalWait,
      params.signal,
    );
    const resumeBudgetMs = ready
      ? usableResumeBudgetMs(deadlineMs + approvalWait.pausedMs, state.config)
      : undefined;
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
          bridgeDispatchStarted: state.bridgeDispatch.started,
          output: takeUndeliveredCodeModeRunOutput(state),
          replaySafe: state.replaySafe,
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
        replaySafe: state.replaySafe,
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
    const outputTruncated = boundOutputToLimit(output, state.config);
    return await settleCodeModeResult({
      result,
      output,
      replaySafe: state.replaySafe,
      deadlineMs,
      parentToolCallId: state.parentToolCallId,
      codeModeReplayId: state.replayId,
      ctx: state.ctx,
      config: state.config,
      runtime: state.runtime,
      catalogProjection: state.catalogProjection,
      namespaceRuntime: state.namespaceRuntime,
      bridgeDispatch: state.bridgeDispatch,
      approvalWait,
      deliveredOutputCount: outputTruncated ? 0 : state.deliveredOutputCount,
      pending,
      activeRunId: state.runId,
      reservedActiveRunSlot: true,
      signal: params.signal,
      onUpdate: params.onUpdate,
    });
  } catch (error) {
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
      bridgeDispatchStarted: state.bridgeDispatch.started,
      output: takeUndeliveredCodeModeRunOutput(state),
      replaySafe: state.replaySafe,
      telemetry: telemetry(state.runtime),
    };
  } finally {
    approvalWait.dispose();
    releaseActiveRunSlot?.();
    resumingRunIds.delete(state.runId);
  }
}

/** Create the exec/wait control tools for one Code Mode run context. */
