import os from "node:os";
import path from "node:path";
import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import {
  diagnosticErrorCategory,
  diagnosticHttpStatusCode,
} from "../infra/diagnostic-error-metadata.js";
import {
  emitTrustedDiagnosticEvent,
  type DiagnosticToolParamsSummary,
  type DiagnosticToolSource,
} from "../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import {
  DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS,
  MAX_PLUGIN_APPROVAL_TIMEOUT_MS,
} from "../infra/plugin-approvals.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { deriveToolParams } from "../plugins/host-tool-param-parsers.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { copyPluginToolMeta, getPluginToolMeta } from "../plugins/tools.js";
import { hasTrustedToolPolicies, runTrustedToolPolicies } from "../plugins/trusted-tool-policy.js";
import {
  PluginApprovalResolutions,
  type PluginApprovalResolution,
  type PluginHookBeforeToolCallResult,
  type PluginHookToolInputKind,
  type PluginHookToolKind,
} from "../plugins/types.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import {
  resolveSkillTelemetrySource,
  resolveSkillTelemetrySourceValue,
} from "../skills/loading/source.js";
import type { SkillSnapshot, SkillTelemetrySource } from "../skills/types.js";
import { resolveSkillWorkshopToolApproval } from "../skills/workshop/policy.js";
import { isPlainObject } from "../utils.js";
import { adjustedParamsByToolCallId } from "./agent-tools.before-tool-call.state.js";
import { copyChannelAgentToolMeta, getChannelAgentToolMeta } from "./channel-tools.js";
import {
  getCodeModeExecBeforeHookMetadata,
  getCodeModeExecBeforeHookMetadataForToolKind,
  normalizeCodeModeExecBeforeHookParams,
  normalizeCodeModeExecBeforeHookParamsForToolKind,
  reconcileCodeModeExecBeforeHookParams,
} from "./code-mode-control-tools.js";
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
  /** Host workspace used to resolve relative tool params for diagnostics only. */
  workspaceDir?: string;
  sessionKey?: string;
  /** Ephemeral session UUID — regenerated on /new and /reset. */
  sessionId?: string;
  runId?: string;
  trace?: DiagnosticTraceContext;
  channelId?: string;
  loopDetection?: ToolLoopDetectionConfig;
  onToolOutcome?: ToolOutcomeObserver;
  skillsSnapshot?: SkillSnapshot;
  skillCommand?: {
    commandName: string;
    skillName: string;
    skillSource?: SkillTelemetrySource;
    toolName?: string;
  };
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
  | {
      blocked: false;
      params: unknown;
      approvalResolution?: PluginApprovalResolution;
      deferredApproval?: DeferredPluginToolApproval;
    };
type PluginApprovalRequest = NonNullable<PluginHookBeforeToolCallResult["requireApproval"]>;

function resolvePluginToolApprovalTimeoutMs(approval: PluginApprovalRequest): number {
  if (
    typeof approval.timeoutMs !== "number" ||
    !Number.isFinite(approval.timeoutMs) ||
    approval.timeoutMs <= 0
  ) {
    return DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS;
  }
  return Math.min(Math.floor(approval.timeoutMs), MAX_PLUGIN_APPROVAL_TIMEOUT_MS);
}

function resolvePluginToolApprovalGatewayTimeoutMs(timeoutMs: number): number {
  return addTimerTimeoutGraceMs(timeoutMs, 10_000) ?? DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS + 10_000;
}

export type DeferredPluginToolApproval = {
  approval: PluginApprovalRequest;
  toolName: string;
  toolCallId?: string;
  ctx?: HookContext;
  baseParams: unknown;
  overrideParams?: unknown;
};

type BeforeToolCallWrapperOptions = {
  approvalMode?: "request" | "report" | "defer";
  emitDiagnostics: boolean;
};

export type BeforeToolCallPolicyDiagnosticState = {
  hasBeforeToolCallHook: boolean;
  trustedToolPolicies: Array<{
    id: string;
    pluginId: string;
    pluginName?: string;
  }>;
};

export function getBeforeToolCallPolicyDiagnosticState(): BeforeToolCallPolicyDiagnosticState {
  const trustedToolPolicies = (getActivePluginRegistry()?.trustedToolPolicies ?? []).map(
    (entry) => {
      const policy = {
        id: entry.policy.id,
        pluginId: entry.pluginId,
      } as BeforeToolCallPolicyDiagnosticState["trustedToolPolicies"][number];
      if (entry.pluginName) {
        policy.pluginName = entry.pluginName;
      }
      return policy;
    },
  );
  return {
    hasBeforeToolCallHook: getGlobalHookRunner()?.hasHooks("before_tool_call") === true,
    trustedToolPolicies,
  };
}

export function hasBeforeToolCallPolicy(): boolean {
  const state = getBeforeToolCallPolicyDiagnosticState();
  return state.hasBeforeToolCallHook || state.trustedToolPolicies.length > 0;
}

const log = createSubsystemLogger("agents/tools");
const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
const BEFORE_TOOL_CALL_DIAGNOSTIC_OPTIONS = Symbol("beforeToolCallDiagnosticOptions");
const BEFORE_TOOL_CALL_SOURCE_TOOL = Symbol("beforeToolCallSourceTool");
const BEFORE_TOOL_CALL_HOOK_CONTEXT = Symbol("beforeToolCallHookContext");
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

export function recordAdjustedParamsForToolCall(
  toolCallId: string | undefined,
  params: unknown,
  runId?: string,
): void {
  if (!toolCallId) {
    return;
  }
  const adjustedParamsKey = buildAdjustedParamsKey({ runId, toolCallId });
  adjustedParamsByToolCallId.set(adjustedParamsKey, params);
  if (adjustedParamsByToolCallId.size > MAX_TRACKED_ADJUSTED_PARAMS) {
    const oldest = adjustedParamsByToolCallId.keys().next().value;
    if (oldest) {
      adjustedParamsByToolCallId.delete(oldest);
    }
  }
}

/**
 * Returns true when an error represents an intentional before_tool_call veto.
 */
export function isBeforeToolCallBlockedError(err: unknown): err is BeforeToolCallBlockedError {
  return err instanceof BeforeToolCallBlockedError;
}

const loadBeforeToolCallRuntime = createLazyRuntimeSurface(
  () => import("./agent-tools.before-tool-call.runtime.js"),
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

type ToolDiagnosticIdentity = {
  toolSource: DiagnosticToolSource;
  toolOwner?: string;
};

function resolveToolDiagnosticIdentity(tool: AnyAgentTool): ToolDiagnosticIdentity {
  const pluginMeta = getPluginToolMeta(tool);
  if (pluginMeta) {
    return pluginMeta.pluginId === "bundle-mcp"
      ? { toolSource: "mcp", toolOwner: pluginMeta.pluginId }
      : { toolSource: "plugin", toolOwner: pluginMeta.pluginId };
  }
  const channelMeta = getChannelAgentToolMeta(tool as never);
  if (channelMeta) {
    return { toolSource: "channel", toolOwner: channelMeta.channelId };
  }
  return { toolSource: "core" };
}

type SkillUsageMatch = {
  skillName: string;
  skillSource: SkillTelemetrySource;
  activation: "command" | "read";
};

function resolveRelativeToolPath(candidate: string, ctx?: HookContext): string | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.resolve(os.homedir(), trimmed.slice(2));
  }
  if (path.isAbsolute(trimmed)) {
    return path.resolve(trimmed);
  }
  const base = ctx?.workspaceDir ?? ctx?.cwd;
  return base ? path.resolve(base, trimmed) : undefined;
}

function readToolPathCandidates(params: unknown, ctx?: HookContext): string[] {
  if (!isPlainObject(params)) {
    return [];
  }
  const candidates = typeof params.path === "string" ? [params.path] : [];
  return candidates
    .map((candidate) => resolveRelativeToolPath(candidate, ctx))
    .filter((candidate): candidate is string => Boolean(candidate));
}

function skillInstructionPaths(snapshot: SkillSnapshot | undefined): Map<string, SkillUsageMatch> {
  const matches = new Map<string, SkillUsageMatch>();
  for (const skill of snapshot?.resolvedSkills ?? []) {
    const skillName = typeof skill.name === "string" ? skill.name.trim() : "";
    if (!skillName) {
      continue;
    }
    const match = {
      skillName,
      skillSource: resolveSkillTelemetrySource(skill),
      activation: "read" as const,
    };
    const filePath = typeof skill.filePath === "string" ? skill.filePath.trim() : "";
    if (filePath && path.isAbsolute(filePath)) {
      matches.set(path.resolve(filePath), match);
    }
    const baseDir = typeof skill.baseDir === "string" ? skill.baseDir.trim() : "";
    if (baseDir && path.isAbsolute(baseDir)) {
      matches.set(path.resolve(baseDir, "SKILL.md"), match);
    }
  }
  return matches;
}

function findSkillUsageMatch(params: {
  toolName: string;
  toolParams: unknown;
  ctx?: HookContext;
}): SkillUsageMatch | undefined {
  const command = params.ctx?.skillCommand;
  if (command) {
    const commandToolName = normalizeToolName(command.toolName ?? params.toolName);
    if (!commandToolName || commandToolName === params.toolName) {
      return {
        skillName: command.skillName,
        skillSource: resolveSkillTelemetrySourceValue(command.skillSource),
        activation: "command",
      };
    }
  }

  if (params.toolName !== "read" || !params.ctx?.skillsSnapshot?.resolvedSkills?.length) {
    return undefined;
  }
  const skillPaths = skillInstructionPaths(params.ctx.skillsSnapshot);
  for (const candidate of readToolPathCandidates(params.toolParams, params.ctx)) {
    const match = skillPaths.get(candidate);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function emitSkillUsedDiagnostic(params: {
  ctx?: HookContext;
  match: SkillUsageMatch;
  toolName: string;
  toolCallId?: string;
}): void {
  const trace = params.ctx?.trace
    ? freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(params.ctx.trace))
    : undefined;
  emitTrustedDiagnosticEvent({
    type: "skill.used",
    ...(params.ctx?.runId && { runId: params.ctx.runId }),
    ...(params.ctx?.sessionKey && { sessionKey: params.ctx.sessionKey }),
    ...(params.ctx?.sessionId && { sessionId: params.ctx.sessionId }),
    ...(params.ctx?.agentId && { agentId: params.ctx.agentId }),
    ...(trace && { trace }),
    skillName: params.match.skillName,
    skillSource: params.match.skillSource,
    activation: params.match.activation,
    toolName: params.toolName,
    ...(params.toolCallId && { toolCallId: params.toolCallId }),
  });
}

function notifyPluginApprovalResolution(
  approval: PluginApprovalRequest,
  resolution: PluginApprovalResolution,
): void {
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
  const timeoutMs = resolvePluginToolApprovalTimeoutMs(approval);
  const gatewayTimeoutMs = resolvePluginToolApprovalGatewayTimeoutMs(timeoutMs);
  try {
    const requestResult: {
      id?: string;
      status?: string;
      decision?: string | null;
    } = await callGatewayTool(
      "plugin.approval.request",
      // Buffer beyond the approval timeout so the gateway can clean up
      // and respond before the client-side RPC timeout fires.
      { timeoutMs: gatewayTimeoutMs },
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
        timeoutMs,
        twoPhase: true,
      },
      { expectFinal: false },
    );
    const id = requestResult?.id;
    if (!id) {
      notifyPluginApprovalResolution(approval, PluginApprovalResolutions.CANCELLED);
      return {
        blocked: true,
        kind: "failure",
        deniedReason: "plugin-approval",
        reason: approval.description || "Plugin approval request failed",
        params: params.baseParams,
      };
    }
    const hasImmediateDecision = Object.hasOwn(requestResult ?? {}, "decision");
    let decision: string | null | undefined;
    if (hasImmediateDecision) {
      decision = requestResult?.decision;
      if (decision === null) {
        notifyPluginApprovalResolution(approval, PluginApprovalResolutions.CANCELLED);
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
        { timeoutMs: gatewayTimeoutMs },
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
    notifyPluginApprovalResolution(approval, resolution);
    if (
      decision === PluginApprovalResolutions.ALLOW_ONCE ||
      decision === PluginApprovalResolutions.ALLOW_ALWAYS
    ) {
      return {
        blocked: false,
        params: mergeParamsWithApprovalOverrides(params.baseParams, params.overrideParams),
        approvalResolution: resolution,
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
        approvalResolution: resolution,
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
    notifyPluginApprovalResolution(approval, PluginApprovalResolutions.CANCELLED);
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

export async function requestDeferredPluginToolApproval(params: {
  deferredApproval: DeferredPluginToolApproval;
  signal?: AbortSignal;
}): Promise<HookOutcome> {
  const deferred = params.deferredApproval;
  return requestPluginToolApproval({
    approval: deferred.approval,
    toolName: deferred.toolName,
    ...(deferred.toolCallId ? { toolCallId: deferred.toolCallId } : {}),
    ...(deferred.ctx ? { ctx: deferred.ctx } : {}),
    signal: params.signal,
    baseParams: deferred.baseParams,
    overrideParams: deferred.overrideParams,
  });
}

export function cancelDeferredPluginToolApproval(
  deferredApproval: DeferredPluginToolApproval,
): void {
  notifyPluginApprovalResolution(deferredApproval.approval, PluginApprovalResolutions.CANCELLED);
}

async function resolveBeforeToolCallApprovalOutcome(params: {
  result: PluginHookBeforeToolCallResult | undefined;
  approvalMode?: "request" | "report" | "defer";
  toolName: string;
  toolCallId?: string;
  ctx?: HookContext;
  signal?: AbortSignal;
  baseParams: unknown;
}): Promise<HookOutcome | undefined> {
  const approval = params.result?.requireApproval;
  if (!approval) {
    return undefined;
  }
  if (params.approvalMode === "defer") {
    return {
      blocked: false,
      params: params.baseParams,
      deferredApproval: {
        approval,
        toolName: params.toolName,
        ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
        ...(params.ctx ? { ctx: params.ctx } : {}),
        baseParams: params.baseParams,
        overrideParams: params.result?.params,
      },
    };
  }
  if (params.approvalMode === "report") {
    notifyPluginApprovalResolution(approval, PluginApprovalResolutions.CANCELLED);
    return {
      blocked: true,
      kind: "failure",
      deniedReason: "plugin-approval",
      reason: approval.description || approval.title || "Plugin approval required",
      params: params.baseParams,
    };
  }
  return await requestPluginToolApproval({
    approval,
    toolName: params.toolName,
    ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
    ...(params.ctx ? { ctx: params.ctx } : {}),
    signal: params.signal,
    baseParams: params.baseParams,
    overrideParams: params.result?.params,
  });
}

async function resolveSkillWorkshopApprovalForFinalParams(params: {
  toolName: string;
  params: unknown;
  approvalMode?: "request" | "report" | "defer";
  toolCallId?: string;
  ctx?: HookContext;
  signal?: AbortSignal;
}): Promise<HookOutcome | undefined> {
  const result = resolveSkillWorkshopToolApproval({
    toolName: params.toolName,
    toolParams: isPlainObject(params.params) ? params.params : {},
    ...(params.ctx?.config ? { config: params.ctx.config } : {}),
  });
  return await resolveBeforeToolCallApprovalOutcome({
    result,
    approvalMode: params.approvalMode,
    toolName: params.toolName,
    ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
    ...(params.ctx ? { ctx: params.ctx } : {}),
    signal: params.signal,
    baseParams: params.params,
  });
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
  toolKind?: PluginHookToolKind;
  toolInputKind?: PluginHookToolInputKind;
  toolCallId?: string;
  ctx?: HookContext;
  signal?: AbortSignal;
  approvalMode?: "request" | "report" | "defer";
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
    const normalizedParams = isPlainObject(params) ? params : {};
    const initialCorePolicyResult = resolveSkillWorkshopToolApproval({
      toolName,
      toolParams: normalizedParams,
      ...(args.ctx?.config ? { config: args.ctx.config } : {}),
    });
    if (!initialCorePolicyResult && !shouldRunTrustedPolicies && !hasBeforeToolCallHooks) {
      return { blocked: false, params };
    }
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
    const toolIdentity = {
      ...(args.toolKind && { toolKind: args.toolKind }),
      ...(args.toolInputKind && { toolInputKind: args.toolInputKind }),
    };
    const buildToolContext = (identity: typeof toolIdentity) => ({
      toolName,
      ...identity,
      ...(args.ctx?.agentId && { agentId: args.ctx.agentId }),
      ...(args.ctx?.sessionKey && { sessionKey: args.ctx.sessionKey }),
      ...(args.ctx?.sessionId && { sessionId: args.ctx.sessionId }),
      ...(args.ctx?.runId && { runId: args.ctx.runId }),
      ...(args.ctx?.trace && { trace: freezeDiagnosticTraceContext(args.ctx.trace) }),
      ...(args.toolCallId && { toolCallId: args.toolCallId }),
      ...(args.ctx?.channelId && { channelId: args.ctx.channelId }),
    });
    const toolContext = buildToolContext(toolIdentity);
    const trustedPolicyResult = shouldRunTrustedPolicies
      ? await runTrustedToolPolicies(
          {
            toolName,
            params: normalizedParams,
            ...toolIdentity,
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
            normalizeEvent(eventValue) {
              const normalizedEventParams = normalizeCodeModeExecBeforeHookParamsForToolKind({
                toolKind: eventValue.toolKind,
                params: eventValue.params,
              });
              if (!isPlainObject(normalizedEventParams)) {
                return undefined;
              }
              const normalizedEventIdentity = getCodeModeExecBeforeHookMetadataForToolKind({
                toolKind: eventValue.toolKind,
                params: normalizedEventParams,
              });
              return {
                params: normalizedEventParams,
                ...(normalizedEventIdentity
                  ? { event: normalizedEventIdentity, ctx: normalizedEventIdentity }
                  : {}),
              };
            },
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
    let trustedApprovalParams: unknown;
    let trustedApprovalResolution: PluginApprovalResolution | undefined;
    if (trustedPolicyResult?.requireApproval) {
      const approvalOutcome = await resolveBeforeToolCallApprovalOutcome({
        result: trustedPolicyResult,
        approvalMode: args.approvalMode,
        toolName,
        ...(args.toolCallId ? { toolCallId: args.toolCallId } : {}),
        ...(args.ctx ? { ctx: args.ctx } : {}),
        signal: args.signal,
        baseParams: params,
      });
      if (approvalOutcome) {
        if (approvalOutcome.blocked) {
          return approvalOutcome;
        }
        if (approvalOutcome.deferredApproval) {
          return approvalOutcome;
        }
        trustedApprovalParams = approvalOutcome.params;
        trustedApprovalResolution = approvalOutcome.approvalResolution;
      }
    }
    const rawPolicyAdjustedParams = trustedApprovalParams ?? trustedPolicyResult?.params ?? params;
    const policyAdjustedParams = normalizeCodeModeExecBeforeHookParamsForToolKind({
      toolKind: args.toolKind,
      params: rawPolicyAdjustedParams,
    });
    const policyAdjustedToolIdentity =
      getCodeModeExecBeforeHookMetadataForToolKind({
        toolKind: args.toolKind,
        params: policyAdjustedParams,
      }) ?? toolIdentity;
    const policyAdjustedToolContext = buildToolContext(policyAdjustedToolIdentity);
    const policyAdjustedDerivedToolParams =
      trustedPolicyResult?.params && isPlainObject(policyAdjustedParams)
        ? deriveToolParams(toolName, policyAdjustedParams, deriveOptions)
        : derivedToolParams;
    if (!hasBeforeToolCallHooks) {
      const finalApprovalOutcome = await resolveSkillWorkshopApprovalForFinalParams({
        toolName,
        params: policyAdjustedParams,
        approvalMode: args.approvalMode,
        ...(args.toolCallId ? { toolCallId: args.toolCallId } : {}),
        ...(args.ctx ? { ctx: args.ctx } : {}),
        signal: args.signal,
      });
      if (finalApprovalOutcome) {
        return finalApprovalOutcome;
      }
      const allowed: HookOutcome = {
        blocked: false as const,
        params: policyAdjustedParams,
      };
      if (trustedApprovalResolution) {
        allowed.approvalResolution = trustedApprovalResolution;
      }
      return allowed;
    }
    const hookEventParams = isPlainObject(policyAdjustedParams) ? policyAdjustedParams : {};
    const hookResult = await hookRunner.runBeforeToolCall(
      {
        toolName,
        params: hookEventParams,
        ...policyAdjustedToolIdentity,
        ...(args.ctx?.runId && { runId: args.ctx.runId }),
        ...(args.toolCallId && { toolCallId: args.toolCallId }),
        ...(policyAdjustedDerivedToolParams.derivedPaths
          ? { derivedPaths: policyAdjustedDerivedToolParams.derivedPaths }
          : {}),
      },
      policyAdjustedToolContext,
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

    let finalParams = policyAdjustedParams;
    let finalApprovalResolution = trustedApprovalResolution;
    if (hookResult?.requireApproval) {
      const approvalOutcome = await resolveBeforeToolCallApprovalOutcome({
        result: hookResult,
        approvalMode: args.approvalMode,
        toolName,
        ...(args.toolCallId ? { toolCallId: args.toolCallId } : {}),
        ...(args.ctx ? { ctx: args.ctx } : {}),
        signal: args.signal,
        baseParams: policyAdjustedParams,
      });
      if (approvalOutcome) {
        if (approvalOutcome.blocked) {
          return approvalOutcome;
        }
        if (approvalOutcome.deferredApproval) {
          return approvalOutcome;
        }
        finalParams = approvalOutcome.params;
        finalApprovalResolution = approvalOutcome.approvalResolution ?? finalApprovalResolution;
      }
    }

    if (hookResult?.params) {
      finalParams = mergeParamsWithApprovalOverrides(finalParams, hookResult.params);
    }
    const finalApprovalOutcome = await resolveSkillWorkshopApprovalForFinalParams({
      toolName,
      params: finalParams,
      approvalMode: args.approvalMode,
      ...(args.toolCallId ? { toolCallId: args.toolCallId } : {}),
      ...(args.ctx ? { ctx: args.ctx } : {}),
      signal: args.signal,
    });
    if (finalApprovalOutcome) {
      return finalApprovalOutcome;
    }
    const allowed: HookOutcome = {
      blocked: false as const,
      params: finalParams,
    };
    if (finalApprovalResolution) {
      allowed.approvalResolution = finalApprovalResolution;
    }
    return allowed;
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
  options: { approvalMode?: "request" | "report"; emitDiagnostics?: boolean } = {},
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
  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const hookParams = normalizeCodeModeExecBeforeHookParams({ tool, params });
      const hookMetadata = getCodeModeExecBeforeHookMetadata({ tool, params });
      const outcome = await runBeforeToolCallHook({
        toolName,
        params: hookParams,
        ...hookMetadata,
        toolCallId,
        ctx,
        signal,
        approvalMode: hookOptions.approvalMode,
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
          ...diagnosticIdentity,
          ...(toolCallId && { toolCallId }),
          paramsSummary: summarizeToolParams(outcome.params ?? hookParams),
        };
        if (hookOptions.emitDiagnostics) {
          emitTrustedDiagnosticEvent({
            type: "tool.execution.blocked",
            ...eventBase,
            reason: outcome.reason,
            deniedReason: outcome.deniedReason ?? "plugin-before-tool-call",
          });
        }
        const blockedResult = buildBlockedToolResult({
          reason: outcome.reason,
          deniedReason: outcome.deniedReason ?? "plugin-before-tool-call",
        });
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params ?? hookParams,
          toolCallId,
          result: blockedResult,
        });
        return blockedResult;
      }
      const executeParams = reconcileCodeModeExecBeforeHookParams({
        tool,
        originalParams: params,
        hookParams,
        adjustedParams: outcome.params,
      });
      recordAdjustedParamsForToolCall(toolCallId, executeParams, ctx?.runId);
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
        ...diagnosticIdentity,
        ...(toolCallId && { toolCallId }),
        paramsSummary: summarizeToolParams(executeParams),
      };
      if (hookOptions.emitDiagnostics) {
        emitTrustedDiagnosticEvent({
          type: "tool.execution.started",
          ...eventBase,
        });
      }
      const startedAt = Date.now();
      try {
        const result = await execute(toolCallId, executeParams, signal, onUpdate);
        const durationMs = Date.now() - startedAt;
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: executeParams,
          toolCallId,
          result,
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
          emitTrustedDiagnosticEvent({
            type: "tool.execution.completed",
            ...eventBase,
            durationMs,
          });
        }
        return result;
      } catch (err) {
        const cause = unwrapErrorCause(err);
        const errorCode = diagnosticHttpStatusCode(cause);
        if (hookOptions.emitDiagnostics) {
          emitTrustedDiagnosticEvent({
            type: "tool.execution.error",
            ...eventBase,
            durationMs: Date.now() - startedAt,
            errorCategory: diagnosticErrorCategory(cause),
            ...(errorCode ? { errorCode } : {}),
          });
        }
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: executeParams,
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
  Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_DIAGNOSTIC_OPTIONS, {
    value: hookOptions,
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

export function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean {
  const taggedTool = tool as unknown as Record<symbol, unknown>;
  return taggedTool[BEFORE_TOOL_CALL_WRAPPED] === true;
}

export function setBeforeToolCallDiagnosticsEnabled(tool: AnyAgentTool, enabled: boolean): void {
  const taggedTool = tool as unknown as Record<symbol, unknown>;
  const options = taggedTool[BEFORE_TOOL_CALL_DIAGNOSTIC_OPTIONS];
  if (options && typeof options === "object" && "emitDiagnostics" in options) {
    (options as { emitDiagnostics: boolean }).emitDiagnostics = enabled;
  }
}

export function rewrapToolWithBeforeToolCallHook(
  tool: AnyAgentTool,
  ctx?: HookContext,
  options: { approvalMode?: "request" | "report"; emitDiagnostics?: boolean } = {},
): AnyAgentTool {
  const taggedTool = tool as unknown as Record<symbol, unknown>;
  const source = taggedTool[BEFORE_TOOL_CALL_SOURCE_TOOL];
  const wrappedContext = taggedTool[BEFORE_TOOL_CALL_HOOK_CONTEXT];
  const preservedContext =
    wrappedContext && typeof wrappedContext === "object"
      ? (wrappedContext as HookContext)
      : undefined;
  return wrapToolWithBeforeToolCallHook(
    source && typeof source === "object" ? (source as AnyAgentTool) : tool,
    ctx ?? preservedContext,
    options,
  );
}

export function copyBeforeToolCallHookMarker(source: AnyAgentTool, target: AnyAgentTool): void {
  if (!isToolWrappedWithBeforeToolCallHook(source)) {
    return;
  }
  Object.defineProperty(target, BEFORE_TOOL_CALL_WRAPPED, {
    value: true,
    enumerable: true,
  });
  const taggedSource = source as unknown as Record<symbol, unknown>;
  const sourceTool = taggedSource[BEFORE_TOOL_CALL_SOURCE_TOOL];
  if (sourceTool && typeof sourceTool === "object") {
    Object.defineProperty(target, BEFORE_TOOL_CALL_SOURCE_TOOL, {
      value: sourceTool,
      enumerable: false,
    });
  }
  const hookContext = taggedSource[BEFORE_TOOL_CALL_HOOK_CONTEXT];
  Object.defineProperty(target, BEFORE_TOOL_CALL_HOOK_CONTEXT, {
    value: hookContext,
    enumerable: false,
  });
}

export function consumeAdjustedParamsForToolCall(toolCallId: string, runId?: string): unknown {
  const adjustedParamsKey = buildAdjustedParamsKey({ runId, toolCallId });
  const params = adjustedParamsByToolCallId.get(adjustedParamsKey);
  adjustedParamsByToolCallId.delete(adjustedParamsKey);
  return params;
}

export const testing = {
  BEFORE_TOOL_CALL_DIAGNOSTIC_OPTIONS,
  BEFORE_TOOL_CALL_HOOK_CONTEXT,
  BEFORE_TOOL_CALL_SOURCE_TOOL,
  BEFORE_TOOL_CALL_WRAPPED,
  buildAdjustedParamsKey,
  adjustedParamsByToolCallId,
  runBeforeToolCallHook,
  mergeParamsWithApprovalOverrides,
  isPlainObject,
};
export { testing as __testing };
