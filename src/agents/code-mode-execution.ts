import { randomUUID } from "node:crypto";
import { codeModeReplayIdForToolCall } from "./code-mode-bridge.js";
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
  type CodeModeWorkerResult,
  type SettledBridgeRequest,
} from "./code-mode-runtime.js";
import {
  activeRuns,
  codeModeWaitingReason,
  createPendingBridgeStates,
  disposeCodeModeRun,
  pendingBridgeRequestsReplaySafe,
  pendingToolCalls,
  removeExpiredRuns,
  reserveActiveRunSlot,
  resumingRunIds,
  snapshotState,
  storeSnapshotState,
  telemetry,
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
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}) {
  removeExpiredRuns();
  const config = resolveCodeModeConfig(
    params.ctx.runtimeConfig ?? params.ctx.config,
    params.ctx.agentId,
  );
  if (!config.enabled) {
    throw new ToolInputError("code mode is disabled.");
  }
  const runtime = new ToolSearchRuntime(params.ctx, toToolSearchConfig(config));
  if (params.signal?.aborted) {
    return {
      status: "failed" as const,
      error: "code mode execution aborted",
      code: "aborted" as const,
      output: [],
      replaySafe: params.restartSafe,
      telemetry: telemetry(runtime),
    };
  }
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
  const apiFiles = createCodeModeApiFilesForRun(namespaceCatalog, swarmEnabled);
  let source: string;
  try {
    source = await prepareSource({ code: params.code, language: params.language, config });
  } catch (error) {
    return {
      status: "failed" as const,
      error: codeModeFailureMessage(error),
      code: codeModeFailureCode(error),
      output: [],
      replaySafe: params.restartSafe,
      telemetry: telemetry(runtime),
    };
  }
  const deadlineMs = Date.now() + config.timeoutMs;
  try {
    const result = normalizeCodeModeWorkerResult(
      await runCodeModeWorker(
        {
          kind: "exec",
          source,
          config,
          catalog,
          apiFiles,
          namespaces: namespaceRuntime.descriptors,
          swarmEnabled,
        },
        config.timeoutMs + CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
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
      namespaceRuntime,
      signal: params.signal,
      onUpdate: params.onUpdate,
    });
  } catch (error) {
    return {
      status: "failed" as const,
      error: codeModeFailureMessage(error),
      code: codeModeFailureCode(error),
      output: [],
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
  pending: PendingBridgeState[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  // Abort wins even over already-settled requests: callers treat `false` as
  // "do not resume the guest", which is what a cancelled exec/wait needs.
  if (signal?.aborted) {
    return false;
  }
  const pendingPromises = pending.filter((entry) => !entry.settled).map((entry) => entry.promise);
  if (pendingPromises.length === 0) {
    return true;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.all(pendingPromises).then(() => true),
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
  parentToolCallId: string;
  codeModeReplayId: string;
  ctx: ToolSearchToolContext;
  config: CodeModeConfig;
  runtime: ToolSearchRuntime;
  namespaceRuntime: CodeModeNamespaceRuntime;
  deadlineMs: number;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}) {
  let result = params.result;
  const output = params.output;
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
    output,
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
        return {
          status: "failed" as const,
          error: "restart-safe code mode cannot call namespace tools.",
          code: "invalid_input" as const,
          output,
          replaySafe: true,
          telemetry: telemetry(params.runtime),
        };
      }
      break;
    }
    const remainingMs = settleDeadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    if (params.signal?.aborted) {
      return abortedResult();
    }
    enforceSnapshotPayloadLimits({
      snapshotBytes: result.snapshotBytes,
      config: params.config,
      output,
    });
    const releaseReservation = reserveActiveRunSlot();
    try {
      const activeRunId = `cm_${randomUUID()}`;
      const pending = createPendingBridgeStates({
        pendingRequests: result.pendingRequests,
        runtime: params.runtime,
        namespaceRuntime: params.namespaceRuntime,
        parentToolCallId: params.parentToolCallId,
        codeModeRunId: params.codeModeReplayId,
        activeRunId,
        ctx: params.ctx,
        signal: params.signal,
        onUpdate: params.onUpdate,
      });
      const ready = await waitForPending(pending, remainingMs, params.signal);
      const resumeBudgetMs = ready
        ? usableResumeBudgetMs(settleDeadline, params.config)
        : undefined;
      if (!ready || resumeBudgetMs === undefined) {
        // Abort drops the run instead of parking it: a suspended snapshot for a
        // cancelled call could never be waited on and would pin one of the
        // process-global active-run slots until TTL expiry.
        if (params.signal?.aborted) {
          return abortedResult();
        }
        // Parked rather than resumed: without a usable budget the restore alone
        // would burn the remaining deadline and fail a recoverable run.
        return storeSnapshotState({
          runId: activeRunId,
          replayId: params.codeModeReplayId,
          pending,
          replaySafe: false,
          snapshotBytes: result.snapshotBytes,
          parentToolCallId: params.parentToolCallId,
          ctx: params.ctx,
          config: params.config,
          runtime: params.runtime,
          namespaceRuntime: params.namespaceRuntime,
          output,
        });
      }
      const settledRequests: SettledBridgeRequest[] = [];
      for (const entry of pending) {
        settledRequests.push(entry.settled ?? (await entry.promise));
      }
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
          },
          resumeBudgetMs + CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
          undefined,
          params.signal,
        ),
      );
    } finally {
      releaseReservation();
    }
    output.push(...result.output);
    enforceOutputLimit(output, params.config);
  }
  if (result.status === "waiting") {
    if (params.signal?.aborted) {
      return abortedResult();
    }
    const pendingReplaySafe = pendingBridgeRequestsReplaySafe(
      result.pendingRequests,
      params.runtime,
    );
    if (params.replaySafe && !pendingReplaySafe) {
      return {
        status: "failed" as const,
        error: "restart-safe code mode cannot call side-effecting tools.",
        code: "invalid_input" as const,
        output,
        replaySafe: true,
        telemetry: telemetry(params.runtime),
      };
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
      replaySafe: params.replaySafe,
      signal: params.signal,
      onUpdate: params.onUpdate,
    });
  }
  enforceResultLimit({
    output,
    value: result.status === "completed" ? result.value : undefined,
    config: params.config,
  });
  return {
    ...result,
    output,
    replaySafe: params.replaySafe,
    telemetry: telemetry(params.runtime),
  };
}

export async function runWait(params: {
  toolCallId: string;
  ctx: ToolSearchToolContext;
  runId: string;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}) {
  removeExpiredRuns();
  const state = activeRuns.get(params.runId);
  if (!state) {
    throw new ToolInputError("code mode run is unavailable or expired.");
  }
  if (state.ctx.runId && params.ctx.runId && state.ctx.runId !== params.ctx.runId) {
    throw new ToolInputError("code mode run belongs to a different agent run.");
  }
  if (
    (state.ctx.sessionId && params.ctx.sessionId && state.ctx.sessionId !== params.ctx.sessionId) ||
    (state.ctx.sessionKey &&
      params.ctx.sessionKey &&
      state.ctx.sessionKey !== params.ctx.sessionKey) ||
    (state.ctx.agentId && params.ctx.agentId && state.ctx.agentId !== params.ctx.agentId)
  ) {
    throw new ToolInputError("code mode run belongs to a different session.");
  }
  if (resumingRunIds.has(state.runId)) {
    throw new ToolInputError("code mode run is already being resumed.");
  }
  resumingRunIds.add(state.runId);
  // One wait call shares a single wall-clock deadline across draining the prior
  // pending calls, the resume worker, and the inline settle phase.
  const deadlineMs = Date.now() + state.config.timeoutMs;
  try {
    const ready = await waitForPending(
      state.pending,
      Math.max(1, deadlineMs - Date.now()),
      params.signal,
    );
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
          output: state.output,
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
        output: state.output,
        telemetry: telemetry(state.runtime),
      };
    }

    disposeCodeModeRun(state.runId);
    const settledRequests: SettledBridgeRequest[] = [];
    for (const entry of state.pending) {
      settledRequests.push(entry.settled ?? (await entry.promise));
    }
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
        },
        resumeBudgetMs + CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
        undefined,
        params.signal,
      ),
    );
    const output = [...state.output, ...result.output];
    enforceOutputLimit(output, state.config);
    return await settleCodeModeResult({
      result,
      output,
      replaySafe: state.replaySafe,
      deadlineMs,
      parentToolCallId: params.toolCallId,
      codeModeReplayId: state.replayId,
      ctx: state.ctx,
      config: state.config,
      runtime: state.runtime,
      namespaceRuntime: state.namespaceRuntime,
      signal: params.signal,
      onUpdate: params.onUpdate,
    });
  } catch (error) {
    return {
      status: "failed" as const,
      error: codeModeFailureMessage(error),
      code: codeModeFailureCode(error),
      output: state.output,
      replaySafe: state.replaySafe,
      telemetry: telemetry(state.runtime),
    };
  } finally {
    resumingRunIds.delete(state.runId);
  }
}

/** Create the exec/wait control tools for one Code Mode run context. */
