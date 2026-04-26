import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import {
  diagnosticErrorCategory,
  diagnosticHttpStatusCode,
} from "../infra/diagnostic-error-metadata.js";
import {
  emitTrustedDiagnosticEvent,
  type DiagnosticToolParamsSummary,
} from "../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { copyPluginToolMeta } from "../plugins/tools.js";
import { PluginApprovalResolutions, type PluginApprovalResolution } from "../plugins/types.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import { isPlainObject } from "../utils.js";
import { copyChannelAgentToolMeta } from "./channel-tools.js";
import { normalizeToolName } from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";
import { callGatewayTool } from "./tools/gateway.js";

export type HookContext = {
  agentId?: string;
  sessionKey?: string;
  /** Ephemeral session UUID — regenerated on /new and /reset. */
  sessionId?: string;
  runId?: string;
  trace?: DiagnosticTraceContext;
  loopDetection?: ToolLoopDetectionConfig;
};

type HookOutcome = { blocked: true; reason: string } | { blocked: false; params: unknown };

const log = createSubsystemLogger("agents/tools");
const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
const BEFORE_TOOL_CALL_HOOK_FAILURE_REASON =
  "Tool call blocked because before_tool_call hook failed";
const adjustedParamsByToolCallId = new Map<string, unknown>();
const MAX_TRACKED_ADJUSTED_PARAMS = 1024;
const LOOP_WARNING_BUCKET_SIZE = 10;
const MAX_LOOP_WARNING_KEYS = 256;

const loadBeforeToolCallRuntime = createLazyRuntimeSurface(
  () => import("./pi-tools.before-tool-call.runtime.js"),
  ({ beforeToolCallRuntime }) => beforeToolCallRuntime,
);

function buildAdjustedParamsKey(params: { runId?: string; toolCallId: string }): string {
  if (params.runId && params.runId.trim()) {
    return `${params.runId}:${params.toolCallId}`;
  }
  return params.toolCallId;
}

function mergeParamsWithApprovalOverrides(
  originalParams: unknown,
  approvalParams?: unknown,
): unknown {
  if (approvalParams && isPlainObject(approvalParams)) {
    if (isPlainObject(originalParams)) {
      return { ...originalParams, ...approvalParams };
    }
    return approvalParams;
  }
  return originalParams;
}

function isAbortSignalCancellation(err: unknown, signal?: AbortSignal): boolean {
  if (!signal?.aborted) {
    return false;
  }
  if (err === signal.reason) {
    return true;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return true;
  }
  return false;
}

function unwrapErrorCause(err: unknown): unknown {
  try {
    if (!(err instanceof Error)) {
      return err;
    }
    const cause = Object.getOwnPropertyDescriptor(err, "cause");
    if (cause && "value" in cause && cause.value !== undefined) {
      return cause.value;
    }
  } catch {
    return err;
  }
  return err;
}

function summarizeToolParams(params: unknown): DiagnosticToolParamsSummary {
  if (params === null) {
    return { kind: "null" };
  }
  if (params === undefined) {
    return { kind: "undefined" };
  }
  if (Array.isArray(params)) {
    return { kind: "array", length: params.length };
  }
  if (typeof params === "object") {
    return { kind: "object" };
  }
  if (typeof params === "string") {
    return { kind: "string", length: params.length };
  }
  if (typeof params === "number") {
    return { kind: "number" };
  }
  if (typeof params === "boolean") {
    return { kind: "boolean" };
  }
  return { kind: "other" };
}

function shouldEmitLoopWarning(state: SessionState, warningKey: string, count: number): boolean {
  if (!state.toolLoopWarningBuckets) {
    state.toolLoopWarningBuckets = new Map();
  }
  const bucket = Math.floor(count / LOOP_WARNING_BUCKET_SIZE);
  const lastBucket = state.toolLoopWarningBuckets.get(warningKey) ?? 0;
  if (bucket <= lastBucket) {
    return false;
  }
  state.toolLoopWarningBuckets.set(warningKey, bucket);
  if (state.toolLoopWarningBuckets.size > MAX_LOOP_WARNING_KEYS) {
    const oldest = state.toolLoopWarningBuckets.keys().next().value;
    if (oldest) {
      state.toolLoopWarningBuckets.delete(oldest);
    }
  }
  return true;
}

async function recordLoopOutcome(args: {
  ctx?: HookContext;
  toolName: string;
  toolParams: unknown;
  toolCallId?: string;
  result?: unknown;
  error?: unknown;
}): Promise<void> {
  if (!args.ctx?.sessionKey) {
    return;
  }
  try {
    const { getDiagnosticSessionState, recordToolCallOutcome } = await loadBeforeToolCallRuntime();
    const sessionState = getDiagnosticSessionState({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx?.agentId,
    });
    recordToolCallOutcome(sessionState, {
      toolName: args.toolName,
      toolParams: args.toolParams,
      toolCallId: args.toolCallId,
      result: args.result,
      error: args.error,
      config: args.ctx.loopDetection,
    });
  } catch (err) {
    log.warn(`tool loop outcome tracking failed: tool=${args.toolName} error=${String(err)}`);
  }
}

export async function runBeforeToolCallHook(args: {
  toolName: string;
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
  signal?: AbortSignal;
}): Promise<HookOutcome> {
  const toolName = normalizeToolName(args.toolName || "tool");
  const params = args.params;

  if (args.ctx?.sessionKey) {
    const { getDiagnosticSessionState, logToolLoopAction, detectToolCallLoop, recordToolCall } =
      await loadBeforeToolCallRuntime();
    const sessionState = getDiagnosticSessionState({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx?.agentId,
    });

    const loopResult = detectToolCallLoop(sessionState, toolName, params, args.ctx.loopDetection);

    if (loopResult.stuck) {
      if (loopResult.level === "critical") {
        log.error(`Blocking ${toolName} due to critical loop: ${loopResult.message}`);
        logToolLoopAction({
          sessionKey: args.ctx.sessionKey,
          sessionId: args.ctx?.agentId,
          toolName,
          level: "critical",
          action: "block",
          detector: loopResult.detector,
          count: loopResult.count,
          message: loopResult.message,
          pairedToolName: loopResult.pairedToolName,
        });
        return {
          blocked: true,
          reason: loopResult.message,
        };
      }
      const warningKey = loopResult.warningKey ?? `${loopResult.detector}:${toolName}`;
      if (shouldEmitLoopWarning(sessionState, warningKey, loopResult.count)) {
        log.warn(`Loop warning for ${toolName}: ${loopResult.message}`);
        logToolLoopAction({
          sessionKey: args.ctx.sessionKey,
          sessionId: args.ctx?.agentId,
          toolName,
          level: "warning",
          action: "warn",
          detector: loopResult.detector,
          count: loopResult.count,
          message: loopResult.message,
          pairedToolName: loopResult.pairedToolName,
        });
      }
    }

    recordToolCall(sessionState, toolName, params, args.toolCallId, args.ctx.loopDetection);
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_tool_call")) {
    return { blocked: false, params: args.params };
  }

  try {
    const normalizedParams = isPlainObject(params) ? params : {};
    const toolContext = {
      toolName,
      ...(args.ctx?.agentId && { agentId: args.ctx.agentId }),
      ...(args.ctx?.sessionKey && { sessionKey: args.ctx.sessionKey }),
      ...(args.ctx?.sessionId && { sessionId: args.ctx.sessionId }),
      ...(args.ctx?.runId && { runId: args.ctx.runId }),
      ...(args.ctx?.trace && { trace: freezeDiagnosticTraceContext(args.ctx.trace) }),
      ...(args.toolCallId && { toolCallId: args.toolCallId }),
    };
    const hookResult = await hookRunner.runBeforeToolCall(
      {
        toolName,
        params: normalizedParams,
        ...(args.ctx?.runId && { runId: args.ctx.runId }),
        ...(args.toolCallId && { toolCallId: args.toolCallId }),
      },
      toolContext,
    );

    if (hookResult?.block) {
      return {
        blocked: true,
        reason: hookResult.blockReason || "Tool call blocked by plugin hook",
      };
    }

    if (hookResult?.requireApproval) {
      const approval = hookResult.requireApproval;
      const safeOnResolution = (resolution: PluginApprovalResolution): void => {
        const onResolution = approval.onResolution;
        if (typeof onResolution !== "function") {
          return;
        }
        try {
          void Promise.resolve(onResolution(resolution)).catch((err) => {
            log.warn(`plugin onResolution callback failed: ${String(err)}`);
          });
        } catch (err) {
          log.warn(`plugin onResolution callback failed: ${String(err)}`);
        }
      };
      try {
        const requestResult: {
          id?: string;
          status?: string;
          decision?: string | null;
        } = await callGatewayTool(
          "plugin.approval.request",
          // Buffer beyond the approval timeout so the gateway can clean up
          // and respond before the client-side RPC timeout fires.
          { timeoutMs: (approval.timeoutMs ?? 120_000) + 10_000 },
          {
            pluginId: approval.pluginId,
            title: approval.title,
            description: approval.description,
            severity: approval.severity,
            toolName,
            toolCallId: args.toolCallId,
            agentId: args.ctx?.agentId,
            sessionKey: args.ctx?.sessionKey,
            timeoutMs: approval.timeoutMs ?? 120_000,
            twoPhase: true,
          },
          { expectFinal: false },
        );
        const id = requestResult?.id;
        if (!id) {
          safeOnResolution(PluginApprovalResolutions.CANCELLED);
          return {
            blocked: true,
            reason: approval.description || "Plugin approval request failed",
          };
        }
        const hasImmediateDecision = Object.prototype.hasOwnProperty.call(
          requestResult ?? {},
          "decision",
        );
        let decision: string | null | undefined;
        if (hasImmediateDecision) {
          decision = requestResult?.decision;
          if (decision === null) {
            safeOnResolution(PluginApprovalResolutions.CANCELLED);
            return {
              blocked: true,
              reason: "Plugin approval unavailable (no approval route)",
            };
          }
        } else {
          // Wait for the decision, but abort early if the agent run is cancelled
          // so the user isn't blocked for the full approval timeout.
          const waitPromise: Promise<{
            id?: string;
            decision?: string | null;
          }> = callGatewayTool(
            "plugin.approval.waitDecision",
            // Buffer beyond the approval timeout so the gateway can clean up
            // and respond before the client-side RPC timeout fires.
            { timeoutMs: (approval.timeoutMs ?? 120_000) + 10_000 },
            { id },
          );
          let waitResult: { id?: string; decision?: string | null } | undefined;
          if (args.signal) {
            let onAbort: (() => void) | undefined;
            const abortPromise = new Promise<never>((_, reject) => {
              if (args.signal!.aborted) {
                reject(args.signal!.reason);
                return;
              }
              onAbort = () => reject(args.signal!.reason);
              args.signal!.addEventListener("abort", onAbort, { once: true });
            });
            try {
              waitResult = await Promise.race([waitPromise, abortPromise]);
            } finally {
              if (onAbort) {
                args.signal.removeEventListener("abort", onAbort);
              }
            }
          } else {
            waitResult = await waitPromise;
          }
          decision = waitResult?.decision;
        }
        const resolution: PluginApprovalResolution =
          decision === PluginApprovalResolutions.ALLOW_ONCE ||
          decision === PluginApprovalResolutions.ALLOW_ALWAYS ||
          decision === PluginApprovalResolutions.DENY
            ? decision
            : PluginApprovalResolutions.TIMEOUT;
        safeOnResolution(resolution);
        if (
          decision === PluginApprovalResolutions.ALLOW_ONCE ||
          decision === PluginApprovalResolutions.ALLOW_ALWAYS
        ) {
          return {
            blocked: false,
            params: mergeParamsWithApprovalOverrides(params, hookResult.params),
          };
        }
        if (decision === PluginApprovalResolutions.DENY) {
          return { blocked: true, reason: "Denied by user" };
        }
        const timeoutBehavior = approval.timeoutBehavior ?? "deny";
        if (timeoutBehavior === "allow") {
          return {
            blocked: false,
            params: mergeParamsWithApprovalOverrides(params, hookResult.params),
          };
        }
        return { blocked: true, reason: "Approval timed out" };
      } catch (err) {
        safeOnResolution(PluginApprovalResolutions.CANCELLED);
        if (isAbortSignalCancellation(err, args.signal)) {
          log.warn(`plugin approval wait cancelled by run abort: ${String(err)}`);
          return {
            blocked: true,
            reason: "Approval cancelled (run aborted)",
          };
        }
        log.warn(`plugin approval gateway request failed; blocking tool call: ${String(err)}`);
        return {
          blocked: true,
          reason: "Plugin approval required (gateway unavailable)",
        };
      }
    }

    if (hookResult?.params) {
      return {
        blocked: false,
        params: mergeParamsWithApprovalOverrides(params, hookResult.params),
      };
    }
  } catch (err) {
    const toolCallId = args.toolCallId ? ` toolCallId=${args.toolCallId}` : "";
    const cause = unwrapErrorCause(err);
    log.error(`before_tool_call hook failed: tool=${toolName}${toolCallId} error=${String(cause)}`);
    return {
      blocked: true,
      reason: BEFORE_TOOL_CALL_HOOK_FAILURE_REASON,
    };
  }

  return { blocked: false, params };
}

export function wrapToolWithBeforeToolCallHook(
  tool: AnyAgentTool,
  ctx?: HookContext,
): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const toolName = tool.name || "tool";
  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const outcome = await runBeforeToolCallHook({
        toolName,
        params,
        toolCallId,
        ctx,
        signal,
      });
      if (outcome.blocked) {
        throw new Error(outcome.reason);
      }
      if (toolCallId) {
        const adjustedParamsKey = buildAdjustedParamsKey({ runId: ctx?.runId, toolCallId });
        adjustedParamsByToolCallId.set(adjustedParamsKey, outcome.params);
        if (adjustedParamsByToolCallId.size > MAX_TRACKED_ADJUSTED_PARAMS) {
          const oldest = adjustedParamsByToolCallId.keys().next().value;
          if (oldest) {
            adjustedParamsByToolCallId.delete(oldest);
          }
        }
      }
      const normalizedToolName = normalizeToolName(toolName || "tool");
      const trace = ctx?.trace
        ? freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(ctx.trace))
        : undefined;
      const eventBase = {
        ...(ctx?.runId && { runId: ctx.runId }),
        ...(ctx?.sessionKey && { sessionKey: ctx.sessionKey }),
        ...(ctx?.sessionId && { sessionId: ctx.sessionId }),
        ...(trace && { trace }),
        toolName: normalizedToolName,
        ...(toolCallId && { toolCallId }),
        paramsSummary: summarizeToolParams(outcome.params),
      };
      emitTrustedDiagnosticEvent({
        type: "tool.execution.started",
        ...eventBase,
      });
      const startedAt = Date.now();
      try {
        const result = await execute(toolCallId, outcome.params, signal, onUpdate);
        const durationMs = Date.now() - startedAt;
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params,
          toolCallId,
          result,
        });
        emitTrustedDiagnosticEvent({
          type: "tool.execution.completed",
          ...eventBase,
          durationMs,
        });
        return result;
      } catch (err) {
        const cause = unwrapErrorCause(err);
        const errorCode = diagnosticHttpStatusCode(cause);
        emitTrustedDiagnosticEvent({
          type: "tool.execution.error",
          ...eventBase,
          durationMs: Date.now() - startedAt,
          errorCategory: diagnosticErrorCategory(cause),
          ...(errorCode ? { errorCode } : {}),
        });
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params,
          toolCallId,
          error: err,
        });
        throw err;
      }
    },
  };
  copyPluginToolMeta(tool, wrappedTool);
  copyChannelAgentToolMeta(tool as never, wrappedTool as never);
  Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_WRAPPED, {
    value: true,
    enumerable: true,
  });
  return wrappedTool;
}

export function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean {
  const taggedTool = tool as unknown as Record<symbol, unknown>;
  return taggedTool[BEFORE_TOOL_CALL_WRAPPED] === true;
}

export function consumeAdjustedParamsForToolCall(toolCallId: string, runId?: string): unknown {
  const adjustedParamsKey = buildAdjustedParamsKey({ runId, toolCallId });
  const params = adjustedParamsByToolCallId.get(adjustedParamsKey);
  adjustedParamsByToolCallId.delete(adjustedParamsKey);
  return params;
}

export const __testing = {
  BEFORE_TOOL_CALL_WRAPPED,
  buildAdjustedParamsKey,
  adjustedParamsByToolCallId,
  runBeforeToolCallHook,
  mergeParamsWithApprovalOverrides,
  isPlainObject,
};
