/**
 * Wrapped before_tool_call execution boundary.
 * Owns tool preparation/finalization, adjusted-param replay state, terminal
 * results, diagnostics around execution, and wrapper metadata.
 */
import {
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
} from "../infra/diagnostic-events.js";
import { resolveDiagnosticModelContentCapturePolicy } from "../infra/diagnostic-llm-content.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { copyPluginToolMeta, getPluginToolMeta } from "../plugins/tools.js";
import {
  buildToolContentPrivateData,
  emitSkillUsedDiagnostic,
  emitToolBlockedSecurityEvent,
  findSkillUsageMatch,
  reconcileLoopCallExecutionParams,
  recordLoopOutcome,
  rememberPendingTerminalPresentation,
  resolveToolDiagnosticIdentity,
  resolveToolErrorDiagnostic,
  resolveToolResultTerminalDiagnostic,
  resolveToolTerminalPresentation,
  summarizeToolParams,
} from "./agent-tools.before-tool-call.diagnostics.js";
import {
  consumeFinalClientVoiceToolConfirmation,
  runBeforeToolCallHook,
} from "./agent-tools.before-tool-call.policy.js";
import {
  adjustedParamsByToolCallId,
  buildAdjustedParamsKey,
  clearTrackedToolExecution,
  preExecutionBlockedToolCallIds,
  recordStructuredReplaySafeToolCall,
  recordToolExecutionStarted,
  recordToolExecutionTracked,
  structuredReplaySafeToolCallIds,
} from "./agent-tools.before-tool-call.state.js";
import type {
  BeforeToolCallFailureDisposition,
  HookBlockedReason,
  HookContext,
  HookOutcome,
} from "./agent-tools.before-tool-call.types.js";
import {
  createInternalExecutionPreparer,
  readInternalExecutionControl,
} from "./agent-tools.execution-preparer.js";
import { validateToolExecutionParams } from "./agent-tools.execution-validation.js";
import {
  BEFORE_TOOL_CALL_DIAGNOSTIC_OPTIONS,
  BEFORE_TOOL_CALL_HOOK_CONTEXT,
  BEFORE_TOOL_CALL_SOURCE_TOOL,
  BEFORE_TOOL_CALL_WRAPPED,
  type BeforeToolCallDiagnosticOptions,
} from "./before-tool-call-metadata.js";
import { copyChannelAgentToolMeta, getChannelAgentToolMeta } from "./channel-tools.js";
import {
  getCodeModeExecBeforeHookMetadata,
  normalizeCodeModeExecBeforeHookParams,
  reconcileCodeModeExecBeforeHookParams,
} from "./code-mode-control-tools.js";
import { attachInternalToolExecutionPreparer } from "./runtime/internal-hooks.js";
import { buildToolMutationState } from "./tool-mutation.js";
import { normalizeToolName } from "./tool-policy.js";
import {
  formatToolExecutionErrorMessage,
  isTrustedToolExecutionPreflightError,
  protectNetworkToolExecutionError,
} from "./tool-result-error.js";
import { copyToolTerminalPresentation } from "./tool-terminal-presentation.js";
import type { AnyAgentTool } from "./tools/common.js";

type BeforeToolCallWrapperOptions = {
  approvalMode?: "request" | "report" | "deny";
  emitDiagnostics: boolean;
};
type ForwardedToolExecution = (...args: unknown[]) => ReturnType<AnyAgentTool["execute"]>;
const MAX_TRACKED_ADJUSTED_PARAMS = 1024;
const INTERNAL_DISPOSED_RESULT = {
  content: [],
  details: { status: "skipped", deniedReason: "internal-dispose" },
};

/** Run tool-owned preparation while retaining the exact prepared object. */
export async function prepareBeforeToolCallExecutionParams(params: {
  tool: AnyAgentTool;
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
  signal?: AbortSignal;
}): Promise<unknown> {
  const prepare = params.tool.prepareBeforeToolCallParams;
  return prepare
    ? await prepare(params.params, {
        ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
        ...(params.ctx ? { hookContext: params.ctx } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      })
    : params.params;
}

/** Reconcile hook rewrites and restore tool-owned state before execution. */
export function finalizeBeforeToolCallExecutionParams(params: {
  tool: AnyAgentTool;
  preparedParams: unknown;
  hookParams: unknown;
  adjustedParams: unknown;
  finalizerMode: "adapter" | "wrapped";
}): unknown {
  const reconciledParams = reconcileCodeModeExecBeforeHookParams({
    tool: params.tool,
    originalParams: params.preparedParams,
    hookParams: params.hookParams,
    adjustedParams: params.adjustedParams,
  });
  // Tool preparation may key private state in a WeakMap by this exact object.
  // Keep the original identity until finalization transfers valid state to rewrites.
  const finalize = params.tool.finalizeBeforeToolCallParams;
  if (!finalize) {
    return reconciledParams;
  }
  if (params.finalizerMode === "adapter") {
    return finalize(reconciledParams, params.preparedParams);
  }
  return finalize.call(params.tool, reconciledParams, params.preparedParams) ?? reconciledParams;
}

class BeforeToolCallBlockedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "BeforeToolCallBlockedError";
  }
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.beforeToolCallBlockedErrorTestApi")
  ] = {
    create(message: string): Error {
      return new BeforeToolCallBlockedError(message);
    },
  };
}

class BeforeToolCallFailureError extends Error {
  constructor(
    message: string,
    readonly disposition: BeforeToolCallFailureDisposition,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BeforeToolCallFailureError";
  }
}

function tagBeforeToolCallFailure(
  error: unknown,
  signal?: AbortSignal,
): BeforeToolCallFailureError {
  try {
    if (error instanceof BeforeToolCallFailureError) {
      return error;
    }
  } catch {
    // Continue through the guarded formatter and classifier for hostile values.
  }
  const message = formatToolExecutionErrorMessage(error, "before_tool_call failed");
  const disposition = resolveToolErrorDiagnostic(error, signal).terminalReason;
  return new BeforeToolCallFailureError(message, disposition, error);
}

/** Return the closed terminal disposition carried by a before-tool failure. */
export function getBeforeToolCallFailureDisposition(
  error: unknown,
): BeforeToolCallFailureDisposition | undefined {
  try {
    return error instanceof BeforeToolCallFailureError ? error.disposition : undefined;
  } catch {
    return undefined;
  }
}

/** Remember hook-adjusted params for later adapter-side execution. */
export function recordAdjustedParamsForToolCall(
  toolCallId: string | undefined,
  params: unknown,
  runId?: string,
): void {
  if (!toolCallId) {
    return;
  }
  const cloneResult = cloneParamsForAdjustedReplay(params);
  if (!cloneResult.ok) {
    return;
  }
  const adjustedParamsKey = buildAdjustedParamsKey({ runId, toolCallId });
  adjustedParamsByToolCallId.set(adjustedParamsKey, cloneResult.value);
  pruneMapToMaxSize(adjustedParamsByToolCallId, MAX_TRACKED_ADJUSTED_PARAMS);
}

function cloneParamsForAdjustedReplay(
  params: unknown,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: structuredClone(params) };
  } catch {
    return { ok: false };
  }
}

/** Record that one concrete core-owned tool call may use structured replay classification. */
export function recordStructuredReplayTrustForToolCall(
  toolCallId: string | undefined,
  tool: AnyAgentTool,
  runId?: string,
): void {
  if (!toolCallId || getPluginToolMeta(tool) || getChannelAgentToolMeta(tool as never)) {
    return;
  }
  recordStructuredReplaySafeToolCall(toolCallId, runId);
  while (structuredReplaySafeToolCallIds.size > MAX_TRACKED_ADJUSTED_PARAMS) {
    const oldest = structuredReplaySafeToolCallIds.values().next().value;
    if (!oldest) {
      break;
    }
    structuredReplaySafeToolCallIds.delete(oldest);
  }
}

/**
 * Returns true when an error represents an intentional before_tool_call veto.
 */
export function isBeforeToolCallBlockedError(err: unknown): err is BeforeToolCallBlockedError {
  return err instanceof BeforeToolCallBlockedError;
}

const preExecutionBlockedToolResults = new WeakSet<object>();

export function isPreExecutionBlockedToolResult(result: unknown): boolean {
  return (
    result !== null && typeof result === "object" && preExecutionBlockedToolResults.has(result)
  );
}

/** Build the standard terminal result for vetoed tool calls. */
export function buildBlockedToolResult(params: {
  reason: string;
  deniedReason?: HookBlockedReason;
  toolCallId?: string;
  runId?: string;
}) {
  recordPreExecutionBlockedToolCall(params.toolCallId, params.runId);
  const result = {
    content: [{ type: "text" as const, text: params.reason }],
    details: {
      status: "blocked",
      deniedReason: params.deniedReason ?? "plugin-before-tool-call",
      reason: params.reason,
    },
  };
  preExecutionBlockedToolResults.add(result);
  return result;
}

// Build the private (trusted-listener-only) tool content payload for a tool
// execution diagnostic event. Raw args/results never ride the public event bus;
// consumers (e.g. diagnostics-otel) bound and redact before export.

export function wrapToolWithBeforeToolCallHook(
  tool: AnyAgentTool,
  ctx?: HookContext,
  options: { approvalMode?: "request" | "report" | "deny"; emitDiagnostics?: boolean } = {},
): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const toolName = tool.name || "tool";
  const diagnosticIdentity = resolveToolDiagnosticIdentity(tool);
  const hookOptions: BeforeToolCallWrapperOptions = {
    ...(options.approvalMode ? { approvalMode: options.approvalMode } : {}),
    emitDiagnostics: options.emitDiagnostics !== false,
  };
  const toolContentPolicy = resolveDiagnosticModelContentCapturePolicy(ctx?.config);
  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate, ...executionArgs: unknown[]) => {
      const prepareControl = readInternalExecutionControl(executionArgs.at(-1));
      if (prepareControl) {
        executionArgs.pop();
      }
      const toolCallOrdinal = ctx?.allocateToolOutcomeOrdinal?.(toolCallId);
      const preExecutionStartedAt = Date.now();
      const normalizedToolName = normalizeToolName(toolName || "tool");
      const trace =
        hookOptions.emitDiagnostics && ctx?.trace
          ? freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(ctx.trace))
          : undefined;
      const buildEventBase = (toolParams: unknown) => ({
        ...(ctx?.runId && { runId: ctx.runId }),
        ...(ctx?.sessionKey && { sessionKey: ctx.sessionKey }),
        ...(ctx?.sessionId && { sessionId: ctx.sessionId }),
        ...(ctx?.agentId && { agentId: ctx.agentId }),
        ...(trace && { trace }),
        toolName: normalizedToolName,
        ...diagnosticIdentity,
        ...(toolCallId && { toolCallId }),
        paramsSummary: summarizeToolParams(toolParams),
        mutatingAction: buildToolMutationState(normalizedToolName, toolParams).mutatingAction,
      });
      const recordPreExecutionError = (
        error: unknown,
        toolParams: unknown,
        errorCategory?: string,
      ) => {
        recordPreExecutionBlockedToolCall(toolCallId, ctx?.runId);
        if (!hookOptions.emitDiagnostics) {
          return;
        }
        emitTrustedDiagnosticEvent({
          type: "tool.execution.error",
          ...buildEventBase(toolParams),
          durationMs: Date.now() - preExecutionStartedAt,
          ...resolveToolErrorDiagnostic(error, signal, errorCategory),
        });
      };
      const recordPreExecutionDisposition = (
        toolParams: unknown,
        disposition: BeforeToolCallFailureDisposition,
        errorCategory: string,
        deniedReason?: HookBlockedReason,
      ) => {
        recordPreExecutionBlockedToolCall(toolCallId, ctx?.runId);
        if (!hookOptions.emitDiagnostics) {
          return;
        }
        const eventBase = buildEventBase(toolParams);
        if (disposition === "blocked") {
          const reason = deniedReason ?? "plugin-before-tool-call";
          emitTrustedDiagnosticEvent({
            type: "tool.execution.blocked",
            ...eventBase,
            deniedReason: reason,
            reason,
          });
          return;
        }
        emitTrustedDiagnosticEvent({
          type: "tool.execution.error",
          ...eventBase,
          durationMs: Date.now() - preExecutionStartedAt,
          errorCategory: disposition === "cancelled" ? "aborted" : errorCategory,
          terminalReason: disposition,
        });
      };
      const blockToolCall = async (blockedCall: {
        reason: string;
        deniedReason: HookBlockedReason;
        toolParams: unknown;
      }) => {
        const eventBase = buildEventBase(blockedCall.toolParams);
        if (hookOptions.emitDiagnostics) {
          emitTrustedDiagnosticEvent({
            type: "tool.execution.blocked",
            ...eventBase,
            reason: blockedCall.reason,
            deniedReason: blockedCall.deniedReason,
          });
          emitToolBlockedSecurityEvent({
            ctx,
            deniedReason: blockedCall.deniedReason,
            toolIdentity: diagnosticIdentity,
            toolName: normalizedToolName,
            trace,
            paramsSummary: eventBase.paramsSummary,
          });
        }
        const blockedResult = buildBlockedToolResult({
          reason: blockedCall.reason,
          deniedReason: blockedCall.deniedReason,
          toolCallId,
          runId: ctx?.runId,
        });
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: blockedCall.toolParams,
          toolCallId,
          result: blockedResult,
          toolCallOrdinal,
        });
        return blockedResult;
      };
      let preparedParams: unknown;
      try {
        preparedParams = await prepareBeforeToolCallExecutionParams({
          tool,
          params,
          toolCallId,
          ctx,
          signal,
        });
      } catch (error) {
        recordPreExecutionError(error, params, "tool_preparation");
        throw tagBeforeToolCallFailure(error, signal);
      }
      const hookParams = normalizeCodeModeExecBeforeHookParams({ tool, params: preparedParams });
      const hookMetadata = getCodeModeExecBeforeHookMetadata({ tool, params: preparedParams });
      let outcome: HookOutcome;
      try {
        outcome = await runBeforeToolCallHook({
          toolName,
          params: hookParams,
          ...hookMetadata,
          toolCallId,
          ctx,
          signal,
          approvalMode: hookOptions.approvalMode,
        });
      } catch (error) {
        recordPreExecutionError(error, hookParams, "before_tool_call");
        throw tagBeforeToolCallFailure(error, signal);
      }
      if (outcome.blocked) {
        if (outcome.kind !== "veto") {
          recordPreExecutionDisposition(
            outcome.params ?? hookParams,
            outcome.disposition,
            outcome.deniedReason === "plugin-approval" ? "plugin_approval" : "before_tool_call",
            outcome.deniedReason,
          );
          throw new BeforeToolCallFailureError(outcome.reason, outcome.disposition);
        }
        return await blockToolCall({
          reason: outcome.reason,
          deniedReason: outcome.deniedReason ?? "plugin-before-tool-call",
          toolParams: outcome.params ?? hookParams,
        });
      }
      let executeParams: unknown;
      try {
        // Stop cancellation-ignoring hooks before the synchronous mutation boundary.
        signal?.throwIfAborted();
        executeParams = finalizeBeforeToolCallExecutionParams({
          tool,
          preparedParams,
          hookParams,
          adjustedParams: outcome.params,
          finalizerMode: "wrapped",
        });
        // Hooks can repair or rewrite arguments; only the final execution
        // shape is safe to validate, after vetoes but before side effects.
        await validateToolExecutionParams(toolCallId, executeParams);
        await reconcileLoopCallExecutionParams({
          ctx,
          toolName: normalizedToolName,
          toolParams: executeParams,
          toolCallId,
        });
      } catch (error) {
        recordPreExecutionError(error, outcome.params ?? hookParams, "tool_preparation");
        throw tagBeforeToolCallFailure(error, signal);
      }
      let onImplementationStart: (() => void) | undefined;
      if (prepareControl) {
        const decision = await prepareControl.pause(executeParams);
        if (!decision.launch) {
          return INTERNAL_DISPOSED_RESULT;
        }
        onImplementationStart = decision.start;
      }
      // A voice grant binds the post-finalizer execution shape. Consume it only
      // after steering can no longer suppress the prepared call.
      const voiceConfirmation = consumeFinalClientVoiceToolConfirmation({
        toolName,
        params: executeParams,
        ctx,
      });
      if (!voiceConfirmation.allowed) {
        return await blockToolCall({
          reason: voiceConfirmation.reason,
          deniedReason: "client-voice-confirmation",
          toolParams: executeParams,
        });
      }
      onImplementationStart?.();
      recordAdjustedParamsForToolCall(toolCallId, executeParams, ctx?.runId);
      const eventBase = buildEventBase(executeParams);
      recordToolExecutionStarted(toolCallId, ctx?.runId);
      if (hookOptions.emitDiagnostics) {
        emitTrustedDiagnosticEvent({
          type: "tool.execution.started",
          ...eventBase,
        });
      }
      const startedAt = Date.now();
      try {
        let result: Awaited<ReturnType<ForwardedToolExecution>>;
        try {
          result = await (execute as ForwardedToolExecution)(
            toolCallId,
            executeParams,
            signal,
            onUpdate,
            ...executionArgs,
          );
        } catch (error) {
          throw tool.resultContentSource === "network" &&
            getBeforeToolCallFailureDisposition(error) === undefined
            ? protectNetworkToolExecutionError(error, "Tool execution failed.", signal)
            : error;
        }
        const durationMs = Date.now() - startedAt;
        const terminalPresentation = resolveToolTerminalPresentation({
          tool,
          toolParams: executeParams,
          result,
        });
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: executeParams,
          toolCallId,
          result,
          resultContentSource: tool.resultContentSource,
          toolCallOrdinal,
          terminalPresentation,
        });
        rememberPendingTerminalPresentation({
          ctx,
          tool,
          toolParams: executeParams,
          toolCallId,
          toolCallOrdinal,
        });
        const skillMatch = findSkillUsageMatch({
          toolName: normalizedToolName,
          toolParams: executeParams,
          ctx,
        });
        if (hookOptions.emitDiagnostics) {
          if (skillMatch) {
            emitSkillUsedDiagnostic({
              ctx,
              match: skillMatch,
              toolName: normalizedToolName,
              toolCallId,
            });
          }
          const terminalEvent = resolveToolResultTerminalDiagnostic(result, durationMs);
          emitTrustedDiagnosticEventWithPrivateData(
            {
              ...eventBase,
              ...terminalEvent,
            },
            buildToolContentPrivateData(toolContentPolicy, {
              input: executeParams,
              output: result,
              includeOutput: true,
            }),
          );
        }
        return result;
      } catch (err) {
        if (hookOptions.emitDiagnostics) {
          emitTrustedDiagnosticEventWithPrivateData(
            {
              type: "tool.execution.error",
              ...eventBase,
              durationMs: Date.now() - startedAt,
              ...resolveToolErrorDiagnostic(err, signal),
            },
            buildToolContentPrivateData(toolContentPolicy, {
              input: executeParams,
              includeOutput: false,
            }),
          );
        }
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: executeParams,
          toolCallId,
          error: err,
          resultContentSource:
            isTrustedToolExecutionPreflightError(err) || (signal?.aborted && err === signal.reason)
              ? undefined
              : tool.resultContentSource,
          toolCallOrdinal,
        });
        throw err;
      }
    },
  };
  const executeWithHooks = wrappedTool.execute;
  const prepareExecution = createInternalExecutionPreparer(async (params, control) => {
    recordToolExecutionTracked(params.toolCallId, ctx?.runId);
    try {
      return (await Reflect.apply(executeWithHooks, wrappedTool, [
        params.toolCallId,
        params.args,
        params.signal,
        params.onUpdate,
        ...(params.executionArgs ?? []),
        control,
      ])) as Awaited<ReturnType<AnyAgentTool["execute"]>>;
    } finally {
      // Timeout observers may consume this while the call is still pending.
      clearTrackedToolExecution(params.toolCallId, ctx?.runId);
    }
  });
  attachInternalToolExecutionPreparer(wrappedTool, prepareExecution);
  wrappedTool.execute = async (
    toolCallId,
    params,
    signal,
    onUpdate,
    ...executionArgs: unknown[]
  ) => {
    const prepared = await prepareExecution({
      toolCallId,
      args: params,
      signal,
      onUpdate,
      executionArgs,
    });
    try {
      if (prepared.kind === "immediate") {
        if (prepared.outcome.kind === "error") {
          throw prepared.outcome.error;
        }
        return prepared.outcome.result;
      }
      return await prepared.execute();
    } finally {
      prepared.dispose();
    }
  };
  copyPluginToolMeta(tool, wrappedTool);
  copyChannelAgentToolMeta(tool as never, wrappedTool as never);
  copyToolTerminalPresentation(tool, wrappedTool);
  Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_WRAPPED, {
    value: true,
    enumerable: true,
  });
  Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_DIAGNOSTIC_OPTIONS, {
    value: hookOptions satisfies BeforeToolCallDiagnosticOptions,
    enumerable: false,
  });
  Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_SOURCE_TOOL, {
    value: tool,
    enumerable: false,
  });
  Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_HOOK_CONTEXT, {
    value: ctx,
    enumerable: false,
  });
  return wrappedTool;
}

/** Rebuild a before_tool_call wrapper while preserving the original source tool. */
export function rewrapToolWithBeforeToolCallHook(
  tool: AnyAgentTool,
  ctx?: HookContext,
  options: { approvalMode?: "request" | "report" | "deny"; emitDiagnostics?: boolean } = {},
): AnyAgentTool {
  const taggedTool = tool as unknown as Record<symbol, unknown>;
  const source = taggedTool[BEFORE_TOOL_CALL_SOURCE_TOOL];
  const wrappedContext = taggedTool[BEFORE_TOOL_CALL_HOOK_CONTEXT];
  const preservedContext =
    wrappedContext && typeof wrappedContext === "object"
      ? (wrappedContext as HookContext)
      : undefined;
  const sourceTool = source && typeof source === "object" ? (source as AnyAgentTool) : tool;
  if (sourceTool === tool) {
    return wrapToolWithBeforeToolCallHook(tool, ctx ?? preservedContext, options);
  }
  // Preserve post-wrap schema/metadata while restoring the source execute function.
  const rewrapSource: AnyAgentTool = {
    ...tool,
    execute: sourceTool.execute,
  };
  delete (rewrapSource as unknown as Record<symbol, unknown>)[BEFORE_TOOL_CALL_WRAPPED];
  copyPluginToolMeta(tool, rewrapSource);
  copyChannelAgentToolMeta(tool as never, rewrapSource as never);
  copyToolTerminalPresentation(tool, rewrapSource);
  return wrapToolWithBeforeToolCallHook(rewrapSource, ctx ?? preservedContext, options);
}

function recordPreExecutionBlockedToolCall(toolCallId?: string, runId?: string): void {
  if (!toolCallId) {
    return;
  }
  preExecutionBlockedToolCallIds.add(buildAdjustedParamsKey({ runId, toolCallId }));
  while (preExecutionBlockedToolCallIds.size > MAX_TRACKED_ADJUSTED_PARAMS) {
    const oldest = preExecutionBlockedToolCallIds.values().next().value;
    if (!oldest) {
      break;
    }
    preExecutionBlockedToolCallIds.delete(oldest);
  }
}
