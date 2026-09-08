import type { AgentRunApprovalWait } from "./agent-run-approval-wait.js";
import { codeModeReplayIdForToolCall, isCodeModeSwarmAvailable } from "./code-mode-bridge.js";
import {
  createCodeModeCatalogProjection,
  type CodeModeCatalogProjection,
} from "./code-mode-catalog.js";
import { CodeModeOutputState } from "./code-mode-json.js";
import {
  createCodeModeNamespaceRuntime,
  type CodeModeNamespaceRuntime,
} from "./code-mode-namespaces.js";
import { createPreflightDeclarations } from "./code-mode-preflight-declarations.js";
import {
  CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
  codeModeFailureCode,
  codeModeFailureMessage,
  createCodeModeApiFilesForRun,
  toToolSearchConfig,
  type CodeModeConfig,
  type CodeModeLanguage,
  type CodeModeSettlementMode,
  type CodeModeWorkerResult,
  type PendingBridgeRequest,
} from "./code-mode-runtime.js";
import {
  activeRuns,
  cancelPendingBridgeStates,
  cancelPendingBridgeStatesById,
  codeModeAbortedResult,
  codeModeWaitingReason,
  createCodeModeBridgeDispatchState,
  createCodeModeRunOwner,
  createPendingBridgeStates,
  disposeCodeModeRun,
  pendingBridgeRequestsReplaySafe,
  pendingBridgeStatesForSettlement,
  pendingToolCalls,
  removeExpiredRuns,
  reserveActiveRunSlot,
  resumingRunIds,
  takeSettledBridgeRequests,
  storeSnapshotState,
  telemetry,
  waitForPendingBridgeSettlement,
  type PendingBridgeState,
  type CodeModeBridgeDispatchState,
  type CodeModeRunOwner,
} from "./code-mode-state.js";
import { runCodeModeWorker, type CodeModeWorkerInlineHost } from "./code-mode-worker.js";
import type { AgentToolUpdateCallback } from "./runtime/index.js";
import type { ToolResultBudget } from "./tool-result-limits.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import type { ToolSearchToolContext } from "./tool-search-types.js";
import { ToolInputError } from "./tools/common.js";

type CodeModeCallBudget = { deadlineMs: number };

export async function runCodeModeExec(params: {
  toolCallId: string;
  ctx: ToolSearchToolContext;
  config: CodeModeConfig;
  resultBudget?: ToolResultBudget;
  code: string;
  assistantTurnId?: string;
  language?: CodeModeLanguage;
  typecheck?: boolean;
  restartSafe: boolean;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
  onRuntime?: (runtime: ToolSearchRuntime) => void;
}) {
  removeExpiredRuns();
  const { config } = params;
  const runtime = new ToolSearchRuntime(params.ctx, toToolSearchConfig(config), {
    prepareInput: true,
    validateInput: true,
  });
  params.onRuntime?.(runtime);
  const bridgeDispatch = createCodeModeBridgeDispatchState();
  const budget: CodeModeCallBudget = { deadlineMs: performance.now() + config.timeoutMs };
  const namespaceCatalog = runtime.namespaceEntries();
  const swarmEnabled = isCodeModeSwarmAvailable(params.ctx, namespaceCatalog);
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
  const owner = createCodeModeRunOwner(params.ctx, config);
  const { approvalWait } = owner;
  const signal = owner.bindCall(params.signal);
  const output = new CodeModeOutputState(config.maxOutputBytes, params.resultBudget);
  const pending: PendingBridgeState[] = [];
  let releaseReservation: (() => void) | undefined;
  const context = {
    owner,
    output,
    replaySafe: params.restartSafe,
    budget,
    parentToolCallId: params.toolCallId,
    codeModeReplayId,
    ctx: params.ctx,
    config,
    runtime,
    catalogProjection,
    namespaceRuntime,
    bridgeDispatch,
    approvalWait,
    signal,
    onUpdate: params.onUpdate,
  };
  const inlineHost = createInlineHost(context, pending, () => {
    releaseReservation ??= reserveActiveRunSlot();
  });
  try {
    const preflightDeclarations = params.typecheck
      ? await createPreflightDeclarations(
          runtime,
          catalogProjection,
          apiFiles,
          namespaceRuntime,
          config.memoryLimitBytes,
        )
      : undefined;
    const remainingMs = budget.deadlineMs - performance.now();
    if (remainingMs <= 0) {
      throw new Error("interrupted");
    }
    const result = await runCodeModeWorker(
      {
        kind: "exec",
        source: params.code,
        preflightDeclarations,
        language: params.language,
        config: { ...config, timeoutMs: remainingMs },
        catalog: catalogProjection.guestBindings,
        apiFiles,
        namespaces: namespaceRuntime.descriptors,
        swarmEnabled,
      },
      remainingMs + CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
      undefined,
      signal,
      inlineHost,
    );
    output.append(result.output);
    return await settleCodeModeResult({
      owner,
      pending,
      reservedActiveRunSlot: releaseReservation !== undefined,
      result,
      output,
      replaySafe: params.restartSafe,
      budget,
      parentToolCallId: params.toolCallId,
      codeModeReplayId,
      ctx: params.ctx,
      config,
      runtime,
      catalogProjection,
      namespaceRuntime,
      bridgeDispatch,
      approvalWait,
      signal,
      onUpdate: params.onUpdate,
    });
  } catch (error) {
    const code = signal.aborted ? ("aborted" as const) : codeModeFailureCode(error);
    return output.takeResult(
      {
        status: "failed" as const,
        code,
        failurePhase: bridgeDispatch.started
          ? ("bridge" as const)
          : code === "invalid_input"
            ? ("input" as const)
            : ("host" as const),
        bridgeDispatchStarted: bridgeDispatch.started,
        replaySafe: params.restartSafe,
        telemetry: telemetry(runtime),
      },
      { error: signal.aborted ? "code mode execution aborted" : codeModeFailureMessage(error) },
      runtime.hasNetworkContent(),
    );
  } finally {
    releaseReservation?.();
    approvalWait.onChange = undefined;
    if (!activeRuns.has(owner.runId)) {
      owner.close();
    }
  }
}

function usableResumeBudgetMs(deadlineMs: number, config: CodeModeConfig): number | undefined {
  // VM restore costs tens of ms and counts against the guest interrupt budget;
  // resuming with less than this floor converts an otherwise successful run
  // into an immediate interrupt timeout, so callers park the snapshot instead.
  const minimum = Math.min(250, Math.max(1, Math.floor(config.timeoutMs / 2)));
  const remaining = deadlineMs - performance.now();
  return remaining >= minimum ? remaining : undefined;
}

async function waitForPending(
  pending: readonly PendingBridgeState[],
  settlementMode: CodeModeSettlementMode,
  budget: CodeModeCallBudget,
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
  const pausedAtMs = approvalWait.pausedMs;
  const timeoutMs = Math.max(1, budget.deadlineMs - performance.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const bridgeReady = waitForPendingBridgeSettlement(pending, settlementMode).then(() => true);
    return await Promise.race([
      bridgeReady,
      new Promise<boolean>((resolve) => {
        let remainingMs = timeoutMs;
        let resumedAtMs = performance.now();
        const arm = () => {
          resumedAtMs = performance.now();
          timer = setTimeout(() => resolve(false), Math.max(1, remainingMs));
        };
        approvalWait.onChange = (approvalPending) => {
          if (approvalPending) {
            // Preserve the unused guest budget while its owning approval remains inline.
            clearTimeout(timer);
            remainingMs = Math.max(1, remainingMs - (performance.now() - resumedAtMs));
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
    // Credit only approval time actually spent blocked here. A live sibling
    // approval must not refund guest computation, worker restore, or parked time.
    budget.deadlineMs += Math.max(0, approvalWait.pausedMs - pausedAtMs);
    if (timer) {
      clearTimeout(timer);
    }
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
    approvalWait.onChange = undefined;
  }
}

type CodeModeSettlementContext = {
  owner: CodeModeRunOwner;
  result: CodeModeWorkerResult;
  output: CodeModeOutputState;
  replaySafe: boolean;
  parentToolCallId: string;
  codeModeReplayId: string;
  ctx: ToolSearchToolContext;
  config: CodeModeConfig;
  runtime: ToolSearchRuntime;
  catalogProjection: CodeModeCatalogProjection;
  namespaceRuntime: CodeModeNamespaceRuntime;
  budget: CodeModeCallBudget;
  pending?: PendingBridgeState[];
  reservedActiveRunSlot?: boolean;
  bridgeDispatch: CodeModeBridgeDispatchState;
  approvalWait: AgentRunApprovalWait;
  signal: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
};

function dispatchCodeModeRequests(
  params: Omit<CodeModeSettlementContext, "result">,
  pending: PendingBridgeState[],
  requests: PendingBridgeRequest[],
): void {
  const pendingIds = new Set(pending.map((entry) => entry.id));
  const newPendingRequests = requests.filter((request) => !pendingIds.has(request.id));
  // Watchdog grace permits checkpoint/cleanup, never admission of new effects.
  if (newPendingRequests.length > 0 && params.budget.deadlineMs <= performance.now()) {
    throw new Error("interrupted");
  }
  pending.push(
    ...createPendingBridgeStates(newPendingRequests, {
      config: params.config,
      inbox: params.owner.inbox,
      runtime: params.runtime,
      catalogProjection: params.catalogProjection,
      namespaceRuntime: params.namespaceRuntime,
      parentToolCallId: params.parentToolCallId,
      codeModeRunId: params.codeModeReplayId,
      remainingMs: params.budget.deadlineMs - performance.now(),
      activeRunId: params.owner.runId,
      ctx: params.ctx,
      signal: params.signal,
      onUpdate: params.onUpdate,
      bridgeDispatch: params.bridgeDispatch,
    }),
  );
}

function createInlineHost(
  params: Omit<CodeModeSettlementContext, "result">,
  pending: PendingBridgeState[],
  reserve: () => void,
  onInputConsumed?: () => void,
): CodeModeWorkerInlineHost {
  return {
    onInputConsumed,
    onBoundary: async (boundary, context) => {
      params.output.append(boundary.output);
      cancelPendingBridgeStatesById(pending, boundary.canceledRequestIds);
      if (
        boundary.pendingRequests.some((request) => request.method === "yield") ||
        (params.replaySafe &&
          !pendingBridgeRequestsReplaySafe(
            boundary.pendingRequests,
            params.runtime,
            params.catalogProjection,
          ))
      ) {
        return { kind: "checkpoint" };
      }
      // Own an existing run slot before any host effect, through internal parking.
      reserve();
      dispatchCodeModeRequests(params, pending, boundary.pendingRequests);
      // Pressure parks the VM, never the cell-owned host operations.
      const signal = AbortSignal.any([params.signal, context.signal, context.yieldSignal]);
      const ready = await waitForPending(
        pending,
        boundary.settlementMode,
        params.budget,
        params.approvalWait,
        signal,
      );
      // The host timer owns exhaustion; do not open a second wait after checkpointing.
      if (!ready && !signal.aborted) {
        params.budget.deadlineMs = performance.now();
      }
      const timeoutMs = params.budget.deadlineMs - performance.now();
      if (!ready || signal.aborted || timeoutMs <= 0) {
        return { kind: "checkpoint" };
      }
      const delivery = takeSettledBridgeRequests(pending);
      const unresolved = pending.filter((entry) => !entry.settled);
      pending.splice(0, pending.length, ...unresolved);
      return {
        kind: "continue",
        timeoutMs,
        settledRequests: delivery.requests,
        pendingRequests: pending.map(({ id, method, args }) => ({ id, method, args })),
        onConsumed: delivery.release,
      };
    },
  };
}

async function settleCodeModeResult(params: CodeModeSettlementContext) {
  let result = params.result;
  let pending = params.pending ?? [];
  if (result.status === "waiting") {
    cancelPendingBridgeStatesById(pending, result.canceledRequestIds);
  }
  const output = params.output;
  // One exec/wait call shares a single monotonic deadline across its initial
  // worker run and this inline settle phase, so auto-draining bridge calls
  // cannot stack a second full `timeoutMs` budget on top of the run that
  // produced them. The deadline is also the only bound on sequential drain
  // rounds; maxPendingToolCalls stays a per-batch concurrency cap enforced in
  // the worker.
  const abortedResult = () => codeModeAbortedResult(params);
  const parkSnapshot = (
    waiting: Extract<CodeModeWorkerResult, { status: "waiting" }>,
    replaySafe: boolean,
  ) =>
    storeSnapshotState({
      owner: params.owner,
      replayId: params.codeModeReplayId,
      pending,
      replaySafe,
      settlementMode: waiting.settlementMode,
      snapshot: waiting.snapshot,
      parentToolCallId: params.parentToolCallId,
      ctx: params.ctx,
      config: params.config,
      runtime: params.runtime,
      catalogProjection: params.catalogProjection,
      namespaceRuntime: params.namespaceRuntime,
      output,
      bridgeDispatch: params.bridgeDispatch,
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
    if (
      params.replaySafe &&
      !pendingBridgeRequestsReplaySafe(
        result.pendingRequests,
        params.runtime,
        params.catalogProjection,
      )
    ) {
      break;
    }
    const remainingMs = params.budget.deadlineMs - performance.now();
    if (remainingMs <= 0) {
      break;
    }
    if (params.signal?.aborted) {
      cancelPendingBridgeStates(pending);
      return abortedResult();
    }
    let releaseReservation: (() => void) | undefined;
    try {
      if (!params.reservedActiveRunSlot) {
        releaseReservation = reserveActiveRunSlot();
      }
      dispatchCodeModeRequests(params, pending, result.pendingRequests);
      const ready = await waitForPending(
        pending,
        result.settlementMode,
        params.budget,
        params.approvalWait,
        params.signal,
      );
      const resumeBudgetMs = ready
        ? usableResumeBudgetMs(params.budget.deadlineMs, params.config)
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
        return parkSnapshot(result, params.replaySafe);
      }
      // Deliver the settled frontier only. Unresolved sibling promises remain
      // attached to their original bridge ids across the restored snapshot.
      const delivery = takeSettledBridgeRequests(pending);
      pending = pending.filter((entry) => !entry.settled);
      // The resumed guest inherits only the remaining shared budget as its
      // QuickJS interrupt deadline; the extra host margin is watchdog grace,
      // not extra guest run time.
      try {
        result = await runCodeModeWorker(
          {
            kind: "resume",
            snapshot: result.snapshot,
            config: {
              ...params.config,
              timeoutMs: resumeBudgetMs,
            },
            settledRequests: delivery.requests,
            pendingRequests: pending.map(({ id, method, args }) => ({ id, method, args })),
          },
          resumeBudgetMs + CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
          undefined,
          params.signal,
          createInlineHost(params, pending, () => {}, delivery.release),
        );
      } finally {
        delivery.release();
      }
      output.append(result.output);
      if (result.status === "waiting") {
        cancelPendingBridgeStatesById(pending, result.canceledRequestIds);
      }
    } catch (error) {
      cancelPendingBridgeStates(pending);
      throw error;
    } finally {
      releaseReservation?.();
    }
  }
  if (params.signal?.aborted) {
    cancelPendingBridgeStates(pending);
    return abortedResult();
  }
  if (result.status === "waiting") {
    const pendingReplaySafe = pendingBridgeRequestsReplaySafe(
      result.pendingRequests,
      params.runtime,
      params.catalogProjection,
    );
    if (params.replaySafe && !pendingReplaySafe) {
      cancelPendingBridgeStates(pending);
      return output.takeResult(
        {
          status: "failed" as const,
          code: "invalid_input" as const,
          failurePhase: params.bridgeDispatch.started ? ("bridge" as const) : ("input" as const),
          bridgeDispatchStarted: params.bridgeDispatch.started,
          replaySafe: true,
          telemetry: telemetry(params.runtime),
        },
        {
          error: result.pendingRequests.every((request) => request.method === "namespace")
            ? "restart-safe code mode cannot call namespace tools."
            : "restart-safe code mode cannot call tool surfaces that are not proven replay-safe; use audited read, grep, or find tools.",
        },
        params.runtime.hasNetworkContent(),
      );
    }
    let releaseReservation: (() => void) | undefined;
    try {
      // Reserve before launching fresh work; transferred snapshots must
      // obey the same process-wide active-run cap as initial suspensions.
      if (!params.reservedActiveRunSlot) {
        releaseReservation = reserveActiveRunSlot();
      }
      dispatchCodeModeRequests(params, pending, result.pendingRequests);
      return parkSnapshot(result, params.replaySafe && pendingReplaySafe);
    } catch (error) {
      cancelPendingBridgeStates(pending);
      throw error;
    } finally {
      releaseReservation?.();
    }
  }
  // Defensive cleanup covers aborts or terminal failures; successful runs have
  // already drained every dispatched call before releasing their snapshot.
  cancelPendingBridgeStates(pending);
  const channels = {
    ...(result.status === "completed" ? { value: result.value } : {}),
    ...(result.status === "failed" ? { error: result.error } : {}),
  };
  const metadata = {
    ...(result.status === "failed"
      ? {
          status: result.status,
          code: result.code,
          failurePhase: params.bridgeDispatch.started ? ("bridge" as const) : result.failurePhase,
          bridgeDispatchStarted: params.bridgeDispatch.started,
        }
      : { status: result.status }),
    replaySafe: params.replaySafe,
    telemetry: telemetry(params.runtime),
  };
  return output.takeResult(metadata, channels, params.runtime.hasNetworkContent());
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
  // One wait call shares a single monotonic deadline across draining the prior
  // pending calls, the resume worker, and the inline settle phase.
  const budget: CodeModeCallBudget = { deadlineMs: performance.now() + state.config.timeoutMs };
  const { approvalWait } = state.owner;
  const signal = state.owner.bindCall(
    params.ctx.abortSignal && params.signal
      ? AbortSignal.any([params.ctx.abortSignal, params.signal])
      : (params.signal ?? params.ctx.abortSignal),
  );
  let releaseActiveRunSlot: (() => void) | undefined;
  try {
    const ready = await waitForPending(
      state.pending,
      state.settlementMode,
      budget,
      approvalWait,
      signal,
    );
    const resumeBudgetMs = ready
      ? usableResumeBudgetMs(budget.deadlineMs, state.config)
      : undefined;
    if (!ready || resumeBudgetMs === undefined) {
      // An aborted wait drops the suspended run: nothing will resume it, and
      // parking it would pin a process-global active-run slot until TTL expiry.
      if (signal.aborted) {
        disposeCodeModeRun(state.runId);
        return { ...codeModeAbortedResult(state), failurePhase: "bridge" as const };
      }
      // Not ready, or ready without a usable resume budget: keep the snapshot
      // so the next wait can resume with a fresh deadline instead of losing
      // the run to a restore-only interrupt timeout.
      const pending = state.pending.filter((entry) => !entry.settled);
      return state.output.takeResult(
        {
          status: "waiting" as const,
          runId: state.runId,
          reason: codeModeWaitingReason(pending.length > 0 ? pending : state.pending),
          pendingToolCalls: pendingToolCalls(pending.length > 0 ? pending : state.pending),
          replaySafe: state.replaySafe,
          telemetry: telemetry(state.runtime),
        },
        {},
        state.runtime.hasNetworkContent(),
      );
    }

    const pending = state.pending.filter((entry) => !entry.settled);
    // Keep the run's existing slot reserved while its live sibling calls and
    // snapshot move through the worker; a new exec must not claim this slot.
    releaseActiveRunSlot = reserveActiveRunSlot(state.runId);
    const delivery = takeSettledBridgeRequests(state.pending);
    // The resumed guest inherits only the remaining shared budget as its QuickJS
    // interrupt deadline; the extra host margin is watchdog grace only.
    let result: CodeModeWorkerResult;
    try {
      result = await runCodeModeWorker(
        {
          kind: "resume",
          snapshot: state.snapshot,
          config: {
            ...state.config,
            timeoutMs: resumeBudgetMs,
          },
          settledRequests: delivery.requests,
          pendingRequests: pending.map(({ id, method, args }) => ({ id, method, args })),
        },
        resumeBudgetMs + CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
        undefined,
        signal,
        createInlineHost(
          {
            owner: state.owner,
            output: state.output,
            replaySafe: state.replaySafe,
            budget,
            parentToolCallId: state.parentToolCallId,
            codeModeReplayId: state.replayId,
            ctx: state.ctx,
            config: state.config,
            runtime: state.runtime,
            catalogProjection: state.catalogProjection,
            namespaceRuntime: state.namespaceRuntime,
            bridgeDispatch: state.bridgeDispatch,
            approvalWait,
            signal,
            onUpdate: params.onUpdate,
          },
          pending,
          () => {},
          delivery.release,
        ),
      );
    } finally {
      delivery.release();
    }
    state.output.append(result.output);
    return await settleCodeModeResult({
      owner: state.owner,
      result,
      output: state.output,
      replaySafe: state.replaySafe,
      budget,
      parentToolCallId: state.parentToolCallId,
      codeModeReplayId: state.replayId,
      ctx: state.ctx,
      config: state.config,
      runtime: state.runtime,
      catalogProjection: state.catalogProjection,
      namespaceRuntime: state.namespaceRuntime,
      bridgeDispatch: state.bridgeDispatch,
      approvalWait,
      pending,
      reservedActiveRunSlot: true,
      signal,
      onUpdate: params.onUpdate,
    });
  } catch (error) {
    const aborted = signal.aborted;
    state.owner.close();
    cancelPendingBridgeStates(state.pending);
    return state.output.takeResult(
      {
        status: "failed" as const,
        code: aborted ? ("aborted" as const) : codeModeFailureCode(error),
        failurePhase: "bridge" as const,
        bridgeDispatchStarted: state.bridgeDispatch.started,
        replaySafe: state.replaySafe,
        telemetry: telemetry(state.runtime),
      },
      { error: aborted ? "code mode execution aborted" : codeModeFailureMessage(error) },
      state.runtime.hasNetworkContent(),
    );
  } finally {
    approvalWait.onChange = undefined;
    releaseActiveRunSlot?.();
    resumingRunIds.delete(state.runId);
    if (!activeRuns.has(state.runId)) {
      state.owner.close();
    }
  }
}
