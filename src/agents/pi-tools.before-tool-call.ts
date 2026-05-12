import type { OpenClawConfig } from "../config/types.openclaw.js";
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
import { deriveToolParams } from "../plugins/host-tool-param-parsers.js";
import { copyPluginToolMeta } from "../plugins/tools.js";
import { hasTrustedToolPolicies, runTrustedToolPolicies } from "../plugins/trusted-tool-policy.js";
import {
  PluginApprovalResolutions,
  type PluginApprovalResolution,
  type PluginHookBeforeToolCallResult,
} from "../plugins/types.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import { isPlainObject } from "../utils.js";
import { copyChannelAgentToolMeta } from "./channel-tools.js";
import { adjustedParamsByToolCallId } from "./pi-tools.before-tool-call.state.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { normalizeToolName } from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";
import { callGatewayTool } from "./tools/gateway.js";

export type ToolOutcomeObservation = {
  toolName: string;
  argsHash: string;
  resultHash: string;
};

export type ToolOutcomeObserver = (observation: ToolOutcomeObservation) => void;

export function isAbortSignalCancellation(err: unknown, signal?: AbortSignal): boolean {
  if (!signal?.aborted) {
    return false;
  }
  if (err === signal.reason) {
    return true;
  }
  return err instanceof Error && err.name === "AbortError";
}

export type HookContext = {
  agentId?: string;
  config?: OpenClawConfig;
  /** Tool execution cwd for host-derived path facts. */
  cwd?: string;
  sessionKey?: string;
  /** Ephemeral session UUID — regenerated on /new and /reset. */
  sessionId?: string;
  runId?: string;
  trace?: DiagnosticTraceContext;
  channelId?: string;
  loopDetection?: ToolLoopDetectionConfig;
  onToolOutcome?: ToolOutcomeObserver;
  sandbox?: {
    root: string;
    bridge: SandboxFsBridge;
  };
};

type HookBlockedKind = "veto" | "failure";
type HookBlockedReason = "plugin-before-tool-call" | "plugin-approval" | "tool-loop";
type HookOutcome =
  | {
      blocked: true;
      kind?: HookBlockedKind;
      deniedReason?: HookBlockedReason;
      reason: string;
      params?: unknown;
    }
  | { blocked: false; params: unknown };
type PluginApprovalRequest = NonNullable<PluginHookBeforeToolCallResult["requireApproval"]>;

const log = createSubsystemLogger("agents/tools");
const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
const BEFORE_TOOL_CALL_HOOK_FAILURE_REASON =
  "Tool call blocked because before_tool_call hook failed";
const MAX_TRACKED_ADJUSTED_PARAMS = 1024;
const LOOP_WARNING_BUCKET_SIZE = 10;
const MAX_LOOP_WARNING_KEYS = 256;

/**
 * Error used when before_tool_call intentionally vetoes a tool call.
 */
export class BeforeToolCallBlockedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "BeforeToolCallBlockedError";
  }
}

/**
 * Returns true when an error represents an intentional before_tool_call veto.
 */
export function isBeforeToolCallBlockedError(err: unknown): err is BeforeToolCallBlockedError {
  return err instanceof BeforeToolCallBlockedError;
}

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

async function requestPluginToolApproval(params: {
  approval: PluginApprovalRequest;
  toolName: string;
  toolCallId?: string;
  ctx?: HookContext;
  signal?: AbortSignal;
  baseParams: unknown;
  overrideParams?: unknown;
}): Promise<HookOutcome> {
  const approval = params.approval;
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
        allowedDecisions: approval.allowedDecisions,
        toolName: params.toolName,
        toolCallId: params.toolCallId,
        agentId: params.ctx?.agentId,
        sessionKey: params.ctx?.sessionKey,
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
        kind: "failure",
        deniedReason: "plugin-approval",
        reason: approval.description || "Plugin approval request failed",
        params: params.baseParams,
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
          kind: "failure",
          deniedReason: "plugin-approval",
          reason: "Plugin approval unavailable (no approval route)",
          params: params.baseParams,
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
      if (params.signal) {
        let onAbort: (() => void) | undefined;
        const abortPromise = new Promise<never>((_, reject) => {
          if (params.signal!.aborted) {
            reject(params.signal!.reason);
            return;
          }
          onAbort = () => reject(params.signal!.reason);
          params.signal!.addEventListener("abort", onAbort, { once: true });
        });
        try {
          waitResult = await Promise.race([waitPromise, abortPromise]);
        } finally {
          if (onAbort) {
            params.signal.removeEventListener("abort", onAbort);
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
        params: mergeParamsWithApprovalOverrides(params.baseParams, params.overrideParams),
      };
    }
    if (decision === PluginApprovalResolutions.DENY) {
      return {
        blocked: true,
        kind: "failure",
        deniedReason: "plugin-approval",
        reason: "Denied by user",
        params: params.baseParams,
      };
    }
    const timeoutBehavior = approval.timeoutBehavior ?? "deny";
    if (timeoutBehavior === "allow") {
      return {
        blocked: false,
        params: mergeParamsWithApprovalOverrides(params.baseParams, params.overrideParams),
      };
    }
    return {
      blocked: true,
      kind: "failure",
      deniedReason: "plugin-approval",
      reason: "Approval timed out",
      params: params.baseParams,
    };
  } catch (err) {
    safeOnResolution(PluginApprovalResolutions.CANCELLED);
    if (isAbortSignalCancellation(err, params.signal)) {
      log.warn(`plugin approval wait cancelled by run abort: ${String(err)}`);
      return {
        blocked: true,
        kind: "failure",
        deniedReason: "plugin-approval",
        reason: "Approval cancelled (run aborted)",
        params: params.baseParams,
      };
    }
    log.warn(`plugin approval gateway request failed; blocking tool call: ${String(err)}`);
    return {
      blocked: true,
      kind: "failure",
      deniedReason: "plugin-approval",
      reason: "Plugin approval required (gateway unavailable)",
      params: params.baseParams,
    };
  }
}

export function buildBlockedToolResult(params: {
  reason: string;
  deniedReason?: HookBlockedReason;
}) {
  return {
    content: [{ type: "text" as const, text: params.reason }],
    details: {
      status: "blocked",
      deniedReason: params.deniedReason ?? "plugin-before-tool-call",
      reason: params.reason,
    },
  };
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
  if (!args.ctx?.sessionKey && !args.ctx?.sessionId) {
    return;
  }
  let recordedOutcome: ToolOutcomeObservation | undefined;
  try {
    const { getDiagnosticSessionState, recordToolCallOutcome } = await loadBeforeToolCallRuntime();
    const sessionState = getDiagnosticSessionState({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx.sessionId,
    });
    const record = recordToolCallOutcome(sessionState, {
      toolName: args.toolName,
      toolParams: args.toolParams,
      toolCallId: args.toolCallId,
      result: args.result,
      error: args.error,
      config: args.ctx.loopDetection,
      ...(args.ctx.runId && { runId: args.ctx.runId }),
    });
    if (record?.resultHash && args.ctx.onToolOutcome) {
      recordedOutcome = {
        toolName: record.toolName,
        argsHash: record.argsHash,
        resultHash: record.resultHash,
      };
    }
  } catch (err) {
    log.warn(`tool loop outcome tracking failed: tool=${args.toolName} error=${String(err)}`);
  }
  if (recordedOutcome) {
    args.ctx.onToolOutcome?.(recordedOutcome);
  }
}

export async function runBeforeToolCallHook(args: {
  toolName: string;
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
  signal?: AbortSignal;
  approvalMode?: "request" | "report";
}): Promise<HookOutcome> {
  const toolName = normalizeToolName(args.toolName || "tool");
  const params = args.params;

  if (args.ctx?.sessionKey) {
    const { getDiagnosticSessionState, logToolLoopAction, detectToolCallLoop, recordToolCall } =
      await loadBeforeToolCallRuntime();
    const sessionState = getDiagnosticSessionState({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx.sessionId,
    });

    const loopScope = args.ctx.runId ? { runId: args.ctx.runId } : undefined;
    const loopResult = detectToolCallLoop(
      sessionState,
      toolName,
      params,
      args.ctx.loopDetection,
      loopScope,
    );

    if (loopResult.stuck) {
      if (loopResult.level === "critical") {
        log.error(`Blocking ${toolName} due to critical loop: ${loopResult.message}`);
        logToolLoopAction({
          sessionKey: args.ctx.sessionKey,
          sessionId: args.ctx.sessionId,
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
          kind: "veto",
          deniedReason: "tool-loop",
          reason: loopResult.message,
          params,
        };
      }
      const baseWarningKey = loopResult.warningKey ?? `${loopResult.detector}:${toolName}`;
      const warningKey = args.ctx.runId ? `${args.ctx.runId}:${baseWarningKey}` : baseWarningKey;
      if (shouldEmitLoopWarning(sessionState, warningKey, loopResult.count)) {
        log.warn(`Loop warning for ${toolName}: ${loopResult.message}`);
        logToolLoopAction({
          sessionKey: args.ctx.sessionKey,
          sessionId: args.ctx.sessionId,
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

    if (args.ctx.loopDetection?.enabled !== false) {
      recordToolCall(
        sessionState,
        toolName,
        params,
        args.toolCallId,
        args.ctx.loopDetection,
        loopScope,
      );
    }
  }

  const hookRunner = getGlobalHookRunner();
  try {
    const hasBeforeToolCallHooks = hookRunner?.hasHooks("before_tool_call") === true;
    const shouldRunTrustedPolicies = hasTrustedToolPolicies();
    if (!shouldRunTrustedPolicies && !hasBeforeToolCallHooks) {
      return { blocked: false, params };
    }
    const normalizedParams = isPlainObject(params) ? params : {};
    const deriveOptions =
      args.ctx?.cwd || args.ctx?.sandbox
        ? {
            ...(args.ctx.cwd ? { cwd: args.ctx.cwd } : {}),
            ...(args.ctx.sandbox ? { sandbox: args.ctx.sandbox } : {}),
          }
        : undefined;
    const derivedToolParams = deriveToolParams(toolName, normalizedParams, deriveOptions);
    const deriveToolEventParams = (candidateParams: Record<string, unknown>) => {
      const derived = deriveToolParams(toolName, candidateParams, deriveOptions);
      return derived.derivedPaths ? { derivedPaths: derived.derivedPaths } : {};
    };
    const toolContext = {
      toolName,
      ...(args.ctx?.agentId && { agentId: args.ctx.agentId }),
      ...(args.ctx?.sessionKey && { sessionKey: args.ctx.sessionKey }),
      ...(args.ctx?.sessionId && { sessionId: args.ctx.sessionId }),
      ...(args.ctx?.runId && { runId: args.ctx.runId }),
      ...(args.ctx?.trace && { trace: freezeDiagnosticTraceContext(args.ctx.trace) }),
      ...(args.toolCallId && { toolCallId: args.toolCallId }),
      ...(args.ctx?.channelId && { channelId: args.ctx.channelId }),
    };
    const trustedPolicyResult = shouldRunTrustedPolicies
      ? await runTrustedToolPolicies(
          {
            toolName,
            params: normalizedParams,
            ...(args.ctx?.runId && { runId: args.ctx.runId }),
            ...(args.toolCallId && { toolCallId: args.toolCallId }),
            ...(derivedToolParams.derivedPaths
              ? { derivedPaths: derivedToolParams.derivedPaths }
              : {}),
          },
          toolContext,
          {
            ...(args.ctx?.config ? { config: args.ctx.config } : {}),
            deriveEvent: deriveToolEventParams,
          },
        )
      : undefined;
    if (trustedPolicyResult?.block) {
      return {
        blocked: true,
        kind: "veto",
        deniedReason: "plugin-before-tool-call",
        reason: trustedPolicyResult.blockReason || "Tool call blocked by trusted plugin policy",
        params,
      };
    }
    if (trustedPolicyResult?.requireApproval) {
      if (args.approvalMode === "report") {
        return {
          blocked: true,
          kind: "failure",
          deniedReason: "plugin-approval",
          reason:
            trustedPolicyResult.requireApproval.description ||
            trustedPolicyResult.requireApproval.title ||
            "Plugin approval required",
          params,
        };
      }
      return await requestPluginToolApproval({
        approval: trustedPolicyResult.requireApproval,
        toolName,
        toolCallId: args.toolCallId,
        ctx: args.ctx,
        signal: args.signal,
        baseParams: params,
        overrideParams: trustedPolicyResult.params,
      });
    }
    const policyAdjustedParams = trustedPolicyResult?.params ?? params;
    const policyAdjustedDerivedToolParams =
      trustedPolicyResult?.params && isPlainObject(policyAdjustedParams)
        ? deriveToolParams(toolName, policyAdjustedParams, deriveOptions)
        : derivedToolParams;
    if (!hasBeforeToolCallHooks) {
      return { blocked: false, params: policyAdjustedParams };
    }
    const hookEventParams = isPlainObject(policyAdjustedParams) ? policyAdjustedParams : {};
    const hookResult = await hookRunner.runBeforeToolCall(
      {
        toolName,
        params: hookEventParams,
        ...(args.ctx?.runId && { runId: args.ctx.runId }),
        ...(args.toolCallId && { toolCallId: args.toolCallId }),
        ...(policyAdjustedDerivedToolParams.derivedPaths
          ? { derivedPaths: policyAdjustedDerivedToolParams.derivedPaths }
          : {}),
      },
      toolContext,
    );

    if (hookResult?.block) {
      return {
        blocked: true,
        kind: "veto",
        deniedReason: "plugin-before-tool-call",
        reason: hookResult.blockReason || "Tool call blocked by plugin hook",
        params: policyAdjustedParams,
      };
    }

    if (hookResult?.requireApproval) {
      if (args.approvalMode === "report") {
        return {
          blocked: true,
          kind: "failure",
          deniedReason: "plugin-approval",
          reason:
            hookResult.requireApproval.description ||
            hookResult.requireApproval.title ||
            "Plugin approval required",
          params: policyAdjustedParams,
        };
      }
      return await requestPluginToolApproval({
        approval: hookResult.requireApproval,
        toolName,
        toolCallId: args.toolCallId,
        ctx: args.ctx,
        signal: args.signal,
        baseParams: policyAdjustedParams,
        overrideParams: hookResult.params,
      });
    }

    if (hookResult?.params) {
      return {
        blocked: false,
        params: mergeParamsWithApprovalOverrides(policyAdjustedParams, hookResult.params),
      };
    }
    return { blocked: false, params: policyAdjustedParams };
  } catch (err) {
    const toolCallId = args.toolCallId ? ` toolCallId=${args.toolCallId}` : "";
    const cause = unwrapErrorCause(err);
    log.error(`before_tool_call hook failed: tool=${toolName}${toolCallId} error=${String(cause)}`);
    return {
      blocked: true,
      kind: "failure",
      deniedReason: "plugin-before-tool-call",
      reason: BEFORE_TOOL_CALL_HOOK_FAILURE_REASON,
      params,
    };
  }
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
        if (outcome.kind !== "veto") {
          throw new Error(outcome.reason);
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
          paramsSummary: summarizeToolParams(outcome.params ?? params),
        };
        emitTrustedDiagnosticEvent({
          type: "tool.execution.blocked",
          ...eventBase,
          reason: outcome.reason,
          deniedReason: outcome.deniedReason ?? "plugin-before-tool-call",
        });
        const blockedResult = buildBlockedToolResult({
          reason: outcome.reason,
          deniedReason: outcome.deniedReason ?? "plugin-before-tool-call",
        });
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params ?? params,
          toolCallId,
          result: blockedResult,
        });
        return blockedResult;
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

export function copyBeforeToolCallHookMarker(source: AnyAgentTool, target: AnyAgentTool): void {
  if (!isToolWrappedWithBeforeToolCallHook(source)) {
    return;
  }
  Object.defineProperty(target, BEFORE_TOOL_CALL_WRAPPED, {
    value: true,
    enumerable: true,
  });
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
