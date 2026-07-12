/**
 * before_tool_call policy runtime for agent tools.
 * Runs plugin hooks, trusted tool policies, approvals, diagnostics, loop
 * detection, skill-use telemetry, and adjusted parameter tracking.
 */
import os from "node:os";
import path from "node:path";
import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import {
  diagnosticErrorCategory,
  diagnosticHttpStatusCode,
} from "../infra/diagnostic-error-metadata.js";
import {
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  emitTrustedSkillUsedDiagnosticEvent,
  emitTrustedSecurityEvent,
  type DiagnosticEventPrivateData,
  type DiagnosticToolParamsSummary,
  type DiagnosticToolSource,
  type DiagnosticToolTerminalReason,
} from "../infra/diagnostic-events.js";
import {
  cloneDiagnosticContentValue,
  resolveDiagnosticModelContentCapturePolicy,
  type DiagnosticModelContentCapturePolicy,
} from "../infra/diagnostic-llm-content.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { isEmbeddedMode } from "../infra/embedded-mode.js";
import { getEmbeddedPluginApprovalBroker } from "../infra/embedded-plugin-approval-broker.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  describeNativePluginApprovalClientSetup,
  resolveApprovalInitiatingSurfaceState,
} from "../infra/exec-approval-surface.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "../infra/plugin-approval-canonical-decisions.js";
import {
  DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS,
  MAX_PLUGIN_APPROVAL_TIMEOUT_MS,
} from "../infra/plugin-approvals.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import { redactToolDetail } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunnerRegistry } from "../plugins/hook-runner-global-state.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { deriveToolParams } from "../plugins/host-tool-param-parsers.js";
import { copyPluginToolMeta, getPluginToolMeta } from "../plugins/tools.js";
import {
  getTrustedToolPolicyDiagnosticEntries,
  hasTrustedToolPolicies,
  runTrustedToolPolicies,
} from "../plugins/trusted-tool-policy.js";
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
import type { SkillSnapshot, SkillTelemetrySource, SkillUsagePath } from "../skills/types.js";
import { resolveSkillWorkshopToolApproval } from "../skills/workshop/policy.js";
import { isPlainObject, truncateUtf16Safe } from "../utils.js";
import {
  adjustedParamsByToolCallId,
  buildAdjustedParamsKey,
  preExecutionBlockedToolCallIds,
  recordStructuredReplaySafeToolCall,
  structuredReplaySafeToolCallIds,
} from "./agent-tools.before-tool-call.state.js";
import { normalizeFileToolPathParam } from "./agent-tools.params.js";
import { resolveAgentRunAbortLifecycleFields } from "./run-termination.js";
export {
  consumeAdjustedParamsForToolCall,
  consumePreExecutionBlockedToolCall,
  peekAdjustedParamsForToolCall,
} from "./agent-tools.before-tool-call.state.js";
import {
  BEFORE_TOOL_CALL_DIAGNOSTIC_OPTIONS,
  BEFORE_TOOL_CALL_HOOK_CONTEXT,
  BEFORE_TOOL_CALL_SOURCE_TOOL,
  BEFORE_TOOL_CALL_WRAPPED,
  type BeforeToolCallDiagnosticOptions,
} from "./before-tool-call-metadata.js";
export {
  copyBeforeToolCallHookMarker,
  isToolWrappedWithBeforeToolCallHook,
  setBeforeToolCallDiagnosticsEnabled,
} from "./before-tool-call-metadata.js";
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
import {
  formatToolExecutionErrorMessage,
  resolveToolExecutionErrorKind,
  resolveToolResultFailureKind,
} from "./tool-result-error.js";
import { copyToolTerminalPresentation } from "./tool-terminal-presentation.js";
import { getToolTerminalPresentation } from "./tool-terminal-presentation.js";
import type { AnyAgentTool } from "./tools/common.js";
import { callGatewayTool } from "./tools/gateway.js";
import { canonicalizePath } from "./utils/paths.js";

export type ToolOutcomeObservation = {
  toolName: string;
  argsHash: string;
  resultHash: string;
  /** Monotonic model-call order within the owning embedded run. */
  toolCallOrdinal?: number;
  terminalPresentation?: string;
  presentationOnly?: boolean;
};

export type ToolOutcomeObserver = (observation: ToolOutcomeObservation) => void;

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
  /** Device-scoped operator session allowed to review approvals initiated by this run. */
  approvalReviewerDeviceId?: string;
  trace?: DiagnosticTraceContext;
  channelId?: string;
  /** Originating channel for approval delivery routing; mirrors exec approval turn-source fields. */
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  loopDetection?: ToolLoopDetectionConfig;
  onToolOutcome?: ToolOutcomeObserver;
  allocateToolOutcomeOrdinal?: (toolCallId?: string) => number;
  skillsSnapshot?: SkillSnapshot;
  skillUsagePaths?: SkillUsagePath[];
  skillCommand?: {
    commandName: string;
    skillFile?: string;
    skillName: string;
    skillSource?: SkillTelemetrySource;
    toolName?: string;
  };
  sandbox?: {
    root: string;
    bridge: SandboxFsBridge;
  };
};

type HookBlockedReason = "plugin-before-tool-call" | "plugin-approval" | "tool-loop";
export type BeforeToolCallFailureDisposition = "blocked" | DiagnosticToolTerminalReason;
type HookBlockedOutcome = {
  blocked: true;
  deniedReason?: HookBlockedReason;
  reason: string;
  params?: unknown;
};
type HookOutcome =
  | (HookBlockedOutcome & { kind: "veto" })
  | (HookBlockedOutcome & {
      kind: "failure";
      disposition: BeforeToolCallFailureDisposition;
    })
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
type BeforeToolCallPreparingTool = AnyAgentTool & {
  prepareBeforeToolCallParams?: (
    params: unknown,
    ctx: { toolCallId?: string; hookContext?: HookContext; signal?: AbortSignal },
  ) => unknown;
  finalizeBeforeToolCallParams?: (params: unknown, preparedParams: unknown) => unknown;
};

export type BeforeToolCallPolicyDiagnosticState = {
  hasBeforeToolCallHook: boolean;
  trustedToolPolicies: Array<{
    id: string;
    pluginId: string;
    pluginName?: string;
  }>;
};

/** Return whether before_tool_call hooks or trusted policies are active. */
export function getBeforeToolCallPolicyDiagnosticState(): BeforeToolCallPolicyDiagnosticState {
  const policyRegistry = getGlobalHookRunnerRegistry() ?? undefined;
  return {
    hasBeforeToolCallHook: getGlobalHookRunner()?.hasHooks("before_tool_call") === true,
    trustedToolPolicies: getTrustedToolPolicyDiagnosticEntries(policyRegistry),
  };
}

/** Return true when any before_tool_call policy could affect tool execution. */
export function hasBeforeToolCallPolicy(): boolean {
  const state = getBeforeToolCallPolicyDiagnosticState();
  return state.hasBeforeToolCallHook || state.trustedToolPolicies.length > 0;
}

const log = createSubsystemLogger("agents/tools");
const BEFORE_TOOL_CALL_HOOK_FAILURE_REASON =
  "Tool call blocked because before_tool_call hook failed";
const MAX_TRACKED_ADJUSTED_PARAMS = 1024;
const MAX_PENDING_TERMINAL_PRESENTATIONS = 1024;
const LOOP_WARNING_BUCKET_SIZE = 10;
const MAX_LOOP_WARNING_KEYS = 256;
const MAX_TERMINAL_PRESENTATION_CHARS = 2_000;
const pendingTerminalPresentationByToolCall = new Map<
  string,
  {
    observer: ToolOutcomeObserver;
    tool: AnyAgentTool;
    toolParams: unknown;
    toolCallOrdinal?: number;
  }
>();

function resolveToolTerminalPresentation(params: {
  tool: AnyAgentTool;
  toolParams: unknown;
  result: Awaited<ReturnType<AnyAgentTool["execute"]>>;
}): string | undefined {
  try {
    const taggedTool = params.tool as unknown as Record<symbol, unknown>;
    const sourceTool = taggedTool[BEFORE_TOOL_CALL_SOURCE_TOOL];
    const presentationTool =
      sourceTool && typeof sourceTool === "object" ? (sourceTool as AnyAgentTool) : params.tool;
    const text = getToolTerminalPresentation(presentationTool)?.(
      params.toolParams,
      params.result,
    )?.text.trim();
    if (!text) {
      return undefined;
    }
    return truncateUtf16Safe(redactToolDetail(text), MAX_TERMINAL_PRESENTATION_CHARS);
  } catch (err) {
    log.warn(
      `terminal tool presentation failed: tool=${params.tool.name || "tool"} error=${String(err)}`,
    );
    return undefined;
  }
}

function rememberPendingTerminalPresentation(params: {
  ctx?: HookContext;
  tool: AnyAgentTool;
  toolParams: unknown;
  toolCallId?: string;
  toolCallOrdinal?: number;
}): void {
  if (!params.toolCallId || !params.ctx?.onToolOutcome) {
    return;
  }
  const key = buildAdjustedParamsKey({
    runId: params.ctx.runId,
    toolCallId: params.toolCallId,
  });
  pendingTerminalPresentationByToolCall.set(key, {
    observer: params.ctx.onToolOutcome,
    tool: params.tool,
    toolParams: structuredClone(params.toolParams),
    toolCallOrdinal: params.toolCallOrdinal,
  });
  while (pendingTerminalPresentationByToolCall.size > MAX_PENDING_TERMINAL_PRESENTATIONS) {
    const oldestKey = pendingTerminalPresentationByToolCall.keys().next().value;
    if (!oldestKey) {
      break;
    }
    pendingTerminalPresentationByToolCall.delete(oldestKey);
  }
}

/** Finalizes a trusted terminal summary after harness result middleware. */
export function finalizeToolTerminalPresentation(params: {
  toolCallId: string;
  runId?: string;
  result: Awaited<ReturnType<AnyAgentTool["execute"]>>;
  isError: boolean;
  observer?: ToolOutcomeObserver;
  toolName?: string;
  toolCallOrdinal?: number;
}): void {
  const key = buildAdjustedParamsKey({
    runId: params.runId,
    toolCallId: params.toolCallId,
  });
  const pending = pendingTerminalPresentationByToolCall.get(key);
  pendingTerminalPresentationByToolCall.delete(key);
  const observer = pending?.observer ?? params.observer;
  if (!observer) {
    return;
  }
  const toolCallOrdinal = pending?.toolCallOrdinal ?? params.toolCallOrdinal;
  observer({
    toolName: pending?.tool.name || params.toolName || "tool",
    argsHash: "",
    resultHash: "",
    ...(toolCallOrdinal !== undefined ? { toolCallOrdinal } : {}),
    terminalPresentation: params.isError
      ? undefined
      : pending
        ? resolveToolTerminalPresentation({
            tool: pending.tool,
            toolParams: pending.toolParams,
            result: params.result,
          })
        : undefined,
    presentationOnly: true,
  });
}

/**
 * Error used when before_tool_call intentionally vetoes a tool call.
 */
export class BeforeToolCallBlockedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "BeforeToolCallBlockedError";
  }
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
  if (adjustedParamsByToolCallId.size > MAX_TRACKED_ADJUSTED_PARAMS) {
    const oldest = adjustedParamsByToolCallId.keys().next().value;
    if (oldest) {
      adjustedParamsByToolCallId.delete(oldest);
    }
  }
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

const loadBeforeToolCallRuntime = createLazyRuntimeSurface(
  () => import("./agent-tools.before-tool-call.runtime.js"),
  ({ beforeToolCallRuntime }) => beforeToolCallRuntime,
);

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

function resolveToolErrorDiagnostic(
  err: unknown,
  signal?: AbortSignal,
  errorCategory?: string,
): {
  errorCategory: string;
  errorCode?: string;
  terminalReason: DiagnosticToolTerminalReason;
} {
  const cause = unwrapErrorCause(err);
  const errorCode = diagnosticHttpStatusCode(cause);
  const abortFields = resolveAgentRunAbortLifecycleFields(signal);
  const terminalReason = !abortFields.aborted
    ? resolveToolExecutionErrorKind(cause)
    : abortFields.stopReason === "timeout"
      ? "timed_out"
      : "cancelled";
  return {
    errorCategory:
      terminalReason === "cancelled"
        ? "aborted"
        : (errorCategory ?? diagnosticErrorCategory(cause)),
    terminalReason,
    ...(errorCode ? { errorCode } : {}),
  };
}

type ResolvedToolTerminalDiagnostic =
  | {
      type: "tool.execution.blocked";
      deniedReason: "tool_result_blocked";
      reason: "tool_result_blocked";
    }
  | {
      type: "tool.execution.completed";
      durationMs: number;
    }
  | {
      type: "tool.execution.error";
      durationMs: number;
      errorCategory: "tool_result_error";
      terminalReason: DiagnosticToolTerminalReason;
    };

function resolveToolResultTerminalDiagnostic(
  result: unknown,
  durationMs: number,
): ResolvedToolTerminalDiagnostic {
  // Tool execution may resolve with a structured failure. Classify that here
  // so every diagnostic consumer sees one canonical terminal outcome.
  const failureKind = resolveToolResultFailureKind(result);
  if (!failureKind) {
    return { type: "tool.execution.completed", durationMs };
  }
  if (failureKind === "blocked") {
    return {
      type: "tool.execution.blocked",
      deniedReason: "tool_result_blocked",
      reason: "tool_result_blocked",
    };
  }
  return {
    type: "tool.execution.error",
    durationMs,
    errorCategory: "tool_result_error",
    terminalReason: failureKind,
  };
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
  skillFile?: string;
  skillName: string;
  skillSource: SkillTelemetrySource;
  activation: "command" | "read";
};

function canonicalSkillFile(value: string | undefined): string | undefined {
  const skillFile = value?.trim();
  return skillFile && path.isAbsolute(skillFile)
    ? canonicalizePath(path.resolve(skillFile))
    : undefined;
}

function resolvedSkillUsageMatch(params: {
  activation: SkillUsageMatch["activation"];
  skill: NonNullable<SkillSnapshot["resolvedSkills"]>[number];
}): SkillUsageMatch {
  const skillFile = canonicalSkillFile(params.skill.filePath);
  return {
    skillName: params.skill.name.trim(),
    skillSource: resolveSkillTelemetrySource(params.skill),
    activation: params.activation,
    ...(skillFile ? { skillFile } : {}),
  };
}

function findResolvedSkillUsageMatch(params: {
  activation: SkillUsageMatch["activation"];
  skillName: string;
  skillSource: SkillTelemetrySource;
  snapshot?: SkillSnapshot;
}): SkillUsageMatch | undefined {
  const skillName = params.skillName.trim();
  const candidates = (params.snapshot?.resolvedSkills ?? []).filter(
    (skill) => skill.name.trim() === skillName,
  );
  const skill =
    candidates.find((candidate) => resolveSkillTelemetrySource(candidate) === params.skillSource) ??
    (candidates.length === 1 ? candidates[0] : undefined);
  return skill ? resolvedSkillUsageMatch({ activation: params.activation, skill }) : undefined;
}

function resolveRelativeToolPath(candidate: string, ctx?: HookContext): string | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("node://")) {
    return trimmed;
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
    .map((candidate) => resolveRelativeToolPath(normalizeFileToolPathParam(candidate), ctx))
    .filter((candidate): candidate is string => Boolean(candidate));
}

function skillInstructionPaths(snapshot: SkillSnapshot | undefined): Map<string, SkillUsageMatch> {
  const matches = new Map<string, SkillUsageMatch>();
  for (const skill of snapshot?.resolvedSkills ?? []) {
    const skillName = typeof skill.name === "string" ? skill.name.trim() : "";
    if (!skillName) {
      continue;
    }
    const match = resolvedSkillUsageMatch({ activation: "read", skill });
    const filePath = typeof skill.filePath === "string" ? skill.filePath.trim() : "";
    if (filePath) {
      if (filePath.startsWith("node://")) {
        matches.set(filePath, match);
      } else if (path.isAbsolute(filePath)) {
        matches.set(path.resolve(filePath), match);
      }
    }
    const baseDir = typeof skill.baseDir === "string" ? skill.baseDir.trim() : "";
    if (baseDir && path.isAbsolute(baseDir)) {
      matches.set(path.resolve(baseDir, "SKILL.md"), match);
    }
  }
  return matches;
}

function materializedSkillInstructionPaths(paths: SkillUsagePath[] | undefined) {
  const matches = new Map<string, SkillUsageMatch>();
  for (const entry of paths ?? []) {
    matches.set(path.resolve(entry.readPath), {
      skillFile: entry.skillFile,
      skillName: entry.skillName,
      skillSource: entry.skillSource,
      activation: "read",
    });
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
      const skillSource = resolveSkillTelemetrySourceValue(command.skillSource);
      const snapshotMatch = findResolvedSkillUsageMatch({
        activation: "command",
        skillName: command.skillName,
        skillSource,
        snapshot: params.ctx?.skillsSnapshot,
      });
      const skillFile = canonicalSkillFile(command.skillFile) ?? snapshotMatch?.skillFile;
      return {
        skillName: command.skillName,
        skillSource,
        activation: "command",
        ...(skillFile ? { skillFile } : {}),
      };
    }
  }

  if (params.toolName !== "read") {
    return undefined;
  }
  const skillPaths = params.ctx?.skillsSnapshot?.resolvedSkills?.length
    ? skillInstructionPaths(params.ctx.skillsSnapshot)
    : materializedSkillInstructionPaths(params.ctx?.skillUsagePaths);
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
  // Skill file paths are trusted-internal accounting data. Public diagnostic
  // payloads stay path-free even when diagnostics are enabled.
  emitTrustedSkillUsedDiagnosticEvent(
    {
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
    },
    params.match.skillFile ? { skillUsage: { skillFile: params.match.skillFile } } : undefined,
  );
}

function emitToolBlockedSecurityEvent(params: {
  ctx?: HookContext;
  deniedReason: HookBlockedReason;
  toolIdentity: ToolDiagnosticIdentity;
  toolName: string;
  trace?: DiagnosticTraceContext;
  paramsSummary?: DiagnosticToolParamsSummary;
}): void {
  const control =
    params.deniedReason === "tool-loop"
      ? ({
          policyId: "tool-loop-detection",
          controlId: "tool-loop-detection",
          family: "authorization",
        } as const)
      : params.deniedReason === "plugin-approval"
        ? ({
            policyId: "plugin-tool-approval",
            controlId: "plugin-tool-approval",
            family: "approval",
          } as const)
        : ({
            policyId: "plugin-before-tool-call",
            controlId: "before-tool-call",
            family: "approval",
          } as const);
  emitTrustedSecurityEvent({
    category: "tool",
    action: "tool.execution.blocked",
    outcome: "denied",
    severity: "medium",
    reason: params.deniedReason,
    ...(params.trace ? { trace: params.trace } : {}),
    actor: {
      kind: "agent",
    },
    target: {
      kind: "tool",
      name: params.toolName,
      ...(params.toolIdentity.toolOwner ? { owner: params.toolIdentity.toolOwner } : {}),
    },
    policy: {
      id: control.policyId,
      decision: "deny",
      reason: params.deniedReason,
    },
    control: {
      id: control.controlId,
      family: control.family,
    },
    attributes: {
      tool_source: params.toolIdentity.toolSource,
      ...(params.paramsSummary ? { params_kind: params.paramsSummary.kind } : {}),
    },
  });
}

// Once-per-plugin-per-process deprecation signal; the field is ignored at
// runtime because unresolved approvals always fail closed on timeout.
const warnedDeprecatedTimeoutBehaviorPluginIds = new Set<string>();

function warnDeprecatedApprovalTimeoutBehavior(approval: PluginApprovalRequest): void {
  if (approval.timeoutBehavior !== "allow") {
    return;
  }
  const pluginId = approval.pluginId ?? "unknown-plugin";
  if (warnedDeprecatedTimeoutBehaviorPluginIds.has(pluginId)) {
    return;
  }
  warnedDeprecatedTimeoutBehaviorPluginIds.add(pluginId);
  log.warn(
    `plugin '${pluginId}' sets deprecated requireApproval.timeoutBehavior:"allow"; the field is ignored and approvals fail closed on timeout (see docs/plugins/plugin-permission-requests.md)`,
  );
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
    void Promise.resolve(onResolution(resolution)).catch((err: unknown) => {
      log.warn(`plugin onResolution callback failed: ${String(err)}`);
    });
  } catch (err) {
    log.warn(`plugin onResolution callback failed: ${String(err)}`);
  }
}

function resolvePermittedPluginApprovalResolution(
  decision: unknown,
  allowedDecisions: readonly string[],
): PluginApprovalResolution {
  if (
    (decision === PluginApprovalResolutions.ALLOW_ONCE ||
      decision === PluginApprovalResolutions.ALLOW_ALWAYS ||
      decision === PluginApprovalResolutions.DENY) &&
    allowedDecisions.includes(decision)
  ) {
    return decision;
  }
  return PluginApprovalResolutions.TIMEOUT;
}

function buildPluginApprovalFailureReason(params: {
  fallbackReason: string;
  ctx?: HookContext;
}): string {
  const turnSourceChannel = params.ctx?.turnSourceChannel;
  if (!turnSourceChannel?.trim()) {
    return params.fallbackReason;
  }
  const nativePluginSurface = resolveApprovalInitiatingSurfaceState({
    channel: turnSourceChannel,
    accountId: params.ctx?.turnSourceAccountId,
    cfg: params.ctx?.config,
    approvalKind: "plugin",
  });
  const setupText = describeNativePluginApprovalClientSetup({
    channel: nativePluginSurface.channel,
    channelLabel: nativePluginSurface.channelLabel,
    accountId: nativePluginSurface.accountId,
  });
  if (!setupText) {
    return params.fallbackReason;
  }
  const nativeDeliverySurface =
    nativePluginSurface.kind === "disabled"
      ? nativePluginSurface
      : resolveApprovalInitiatingSurfaceState({
          channel: turnSourceChannel,
          accountId: params.ctx?.turnSourceAccountId,
          cfg: params.ctx?.config,
          approvalKind: "exec",
        });
  if (nativeDeliverySurface.kind !== "disabled") {
    return params.fallbackReason;
  }
  return `${params.fallbackReason}\n\n${setupText}`;
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
  const allowedDecisions = resolveCanonicalPluginApprovalRequestAllowedDecisions(approval);
  let gatewayApprovalPhase: "none" | "request" | "wait" = "none";
  try {
    const embeddedApprovalBroker = isEmbeddedMode() ? getEmbeddedPluginApprovalBroker() : null;
    if (embeddedApprovalBroker) {
      const result = await embeddedApprovalBroker.request({
        request: {
          pluginId: approval.pluginId,
          title: approval.title,
          description: approval.description,
          severity: approval.severity,
          allowedDecisions: approval.allowedDecisions,
          toolName: params.toolName,
          toolCallId: params.toolCallId,
          agentId: params.ctx?.agentId,
          sessionKey: params.ctx?.sessionKey,
          turnSourceChannel: params.ctx?.turnSourceChannel,
          turnSourceTo: params.ctx?.turnSourceTo,
          turnSourceAccountId: params.ctx?.turnSourceAccountId,
          turnSourceThreadId: params.ctx?.turnSourceThreadId,
        },
        timeoutMs,
        signal: params.signal,
      });
      const decision = result.decision;
      const resolution = resolvePermittedPluginApprovalResolution(decision, allowedDecisions);
      notifyPluginApprovalResolution(approval, resolution);
      if (
        resolution === PluginApprovalResolutions.ALLOW_ONCE ||
        resolution === PluginApprovalResolutions.ALLOW_ALWAYS
      ) {
        return {
          blocked: false,
          params: mergeParamsWithApprovalOverrides(params.baseParams, params.overrideParams),
          approvalResolution: resolution,
        };
      }
      if (resolution === PluginApprovalResolutions.DENY) {
        return {
          blocked: true,
          kind: "failure",
          disposition: "blocked",
          deniedReason: "plugin-approval",
          reason: "Denied by user",
          params: params.baseParams,
        };
      }
      // Veto carries the plugin-supplied reason; plain timeouts record a
      // timed_out failure disposition for the audit ledger.
      return approval.timeoutReason
        ? {
            blocked: true,
            kind: "veto",
            deniedReason: "plugin-approval",
            reason: approval.timeoutReason,
            params: params.baseParams,
          }
        : {
            blocked: true,
            kind: "failure",
            disposition: "timed_out",
            deniedReason: "plugin-approval",
            reason: "Approval timed out",
            params: params.baseParams,
          };
    }

    gatewayApprovalPhase = "request";
    const requestResult: {
      id?: string;
      status?: string;
      decision?: unknown;
      deliveryRoute?: string;
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
        ...(params.ctx?.approvalReviewerDeviceId
          ? { approvalReviewerDeviceIds: [params.ctx.approvalReviewerDeviceId] }
          : {}),
        turnSourceChannel: params.ctx?.turnSourceChannel,
        turnSourceTo: params.ctx?.turnSourceTo,
        turnSourceAccountId: params.ctx?.turnSourceAccountId,
        turnSourceThreadId: params.ctx?.turnSourceThreadId,
        timeoutMs,
        twoPhase: true,
      },
      { expectFinal: false },
    );
    gatewayApprovalPhase = "none";
    const id = requestResult?.id;
    if (!id) {
      notifyPluginApprovalResolution(approval, PluginApprovalResolutions.CANCELLED);
      return {
        blocked: true,
        kind: "failure",
        disposition: "failed",
        deniedReason: "plugin-approval",
        reason: approval.description || "Plugin approval request failed",
        params: params.baseParams,
      };
    }
    const hasImmediateDecision = Object.hasOwn(requestResult ?? {}, "decision");
    let decision: unknown;
    if (hasImmediateDecision) {
      decision = requestResult?.decision;
      if (decision === null) {
        notifyPluginApprovalResolution(approval, PluginApprovalResolutions.CANCELLED);
        return {
          blocked: true,
          kind: "failure",
          disposition: "failed",
          deniedReason: "plugin-approval",
          reason: buildPluginApprovalFailureReason({
            fallbackReason: "Plugin approval unavailable (no approval route)",
            ctx: params.ctx,
          }),
          params: params.baseParams,
        };
      }
    } else {
      // Wait for the decision, but abort early if the agent run is cancelled
      // so the user isn't blocked for the full approval timeout.
      gatewayApprovalPhase = "wait";
      const waitPromise: Promise<{
        id?: string;
        decision?: unknown;
      }> = callGatewayTool(
        "plugin.approval.waitDecision",
        // Buffer beyond the approval timeout so the gateway can clean up
        // and respond before the client-side RPC timeout fires.
        { timeoutMs: gatewayTimeoutMs },
        { id },
      );
      let waitResult: { id?: string; decision?: unknown } | undefined;
      if (params.signal) {
        let onAbort: (() => void) | undefined;
        const abortPromise = new Promise<never>((_, reject) => {
          if (params.signal!.aborted) {
            reject(toLintErrorObject(params.signal!.reason, "Non-Error rejection"));
            return;
          }
          onAbort = () => reject(toLintErrorObject(params.signal!.reason, "Non-Error rejection"));
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
      // Bind the verdict to the request that parked this call. A stale or
      // misrouted reply must never release a different tool gate.
      decision = waitResult?.id === id ? waitResult.decision : undefined;
    }
    const resolution = resolvePermittedPluginApprovalResolution(decision, allowedDecisions);
    notifyPluginApprovalResolution(approval, resolution);
    if (
      resolution === PluginApprovalResolutions.ALLOW_ONCE ||
      resolution === PluginApprovalResolutions.ALLOW_ALWAYS
    ) {
      return {
        blocked: false,
        params: mergeParamsWithApprovalOverrides(params.baseParams, params.overrideParams),
        approvalResolution: resolution,
      };
    }
    if (resolution === PluginApprovalResolutions.DENY) {
      return {
        blocked: true,
        kind: "failure",
        disposition: "blocked",
        deniedReason: "plugin-approval",
        reason: "Denied by user",
        params: params.baseParams,
      };
    }
    const fallbackTimeoutReason = approval.timeoutReason ?? "Approval timed out";
    const timeoutReason =
      requestResult?.deliveryRoute === "turn-source"
        ? buildPluginApprovalFailureReason({
            fallbackReason: fallbackTimeoutReason,
            ctx: params.ctx,
          })
        : fallbackTimeoutReason;
    return {
      blocked: true,
      kind: approval.timeoutReason ? "veto" : "failure",
      disposition: "timed_out",
      deniedReason: "plugin-approval",
      reason: timeoutReason,
      params: params.baseParams,
    };
  } catch (err) {
    notifyPluginApprovalResolution(approval, PluginApprovalResolutions.CANCELLED);
    const signal = params.signal;
    const abortCancelled =
      signal?.aborted === true &&
      (err === signal.reason ||
        (err instanceof Error &&
          (err.name === "AbortError" || ("cause" in err && err.cause === signal.reason))));
    if (abortCancelled) {
      log.warn(`plugin approval wait cancelled by run abort: ${String(err)}`);
      return {
        blocked: true,
        kind: "failure",
        disposition: resolveToolErrorDiagnostic(err, signal).terminalReason,
        deniedReason: "plugin-approval",
        reason: "Approval cancelled (run aborted)",
        params: params.baseParams,
      };
    }
    // INVALID_REQUEST means different things before and after registration.
    const invalidRequest =
      err instanceof GatewayClientRequestError && err.gatewayCode === "INVALID_REQUEST";
    const reason =
      invalidRequest && gatewayApprovalPhase === "request"
        ? `Plugin approval request rejected: ${formatErrorMessage(err)}`
        : invalidRequest && gatewayApprovalPhase === "wait"
          ? `Plugin approval no longer available: ${formatErrorMessage(err)}`
          : "Plugin approval required (gateway unavailable)";
    log.warn(`plugin approval gateway request failed; blocking tool call: ${String(err)}`);
    return {
      blocked: true,
      kind: "failure",
      disposition: resolveToolErrorDiagnostic(err, signal).terminalReason,
      deniedReason: "plugin-approval",
      reason,
      params: params.baseParams,
    };
  }
}

/** Resolve a deferred plugin approval request at the later execution boundary. */
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

/** Notify plugin approval callbacks that a deferred approval was cancelled. */
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
  warnDeprecatedApprovalTimeoutBehavior(approval);
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
      disposition: "blocked",
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
  const result = await resolveSkillWorkshopToolApproval({
    toolName: params.toolName,
    toolParams: isPlainObject(params.params) ? params.params : {},
    ...(params.ctx?.config ? { config: params.ctx.config } : {}),
    ...(params.ctx?.workspaceDir ? { workspaceDir: params.ctx.workspaceDir } : {}),
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

/** Build the standard terminal result for vetoed tool calls. */
export function buildBlockedToolResult(params: {
  reason: string;
  deniedReason?: HookBlockedReason;
  toolCallId?: string;
  runId?: string;
}) {
  recordPreExecutionBlockedToolCall(params.toolCallId, params.runId);
  return {
    content: [{ type: "text" as const, text: params.reason }],
    details: {
      status: "blocked",
      deniedReason: params.deniedReason ?? "plugin-before-tool-call",
      reason: params.reason,
    },
  };
}

// Build the private (trusted-listener-only) tool content payload for a tool
// execution diagnostic event. Raw args/results never ride the public event bus;
// consumers (e.g. diagnostics-otel) bound and redact before export.
function buildToolContentPrivateData(
  policy: DiagnosticModelContentCapturePolicy,
  args: { input: unknown; output?: unknown; includeOutput: boolean },
): DiagnosticEventPrivateData | undefined {
  if (!policy.toolInputs && !policy.toolOutputs) {
    return undefined;
  }
  const toolContent: { toolInput?: unknown; toolOutput?: unknown } = {};
  if (policy.toolInputs) {
    toolContent.toolInput = cloneDiagnosticContentValue(args.input);
  }
  if (args.includeOutput && policy.toolOutputs) {
    toolContent.toolOutput = cloneDiagnosticContentValue(args.output);
  }
  return Object.keys(toolContent).length > 0 ? { toolContent } : undefined;
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
  toolCallOrdinal?: number;
  terminalPresentation?: string;
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
        ...(args.toolCallOrdinal !== undefined ? { toolCallOrdinal: args.toolCallOrdinal } : {}),
        ...(args.terminalPresentation ? { terminalPresentation: args.terminalPresentation } : {}),
      };
    }
  } catch (err) {
    log.warn(`tool loop outcome tracking failed: tool=${args.toolName} error=${String(err)}`);
  }
  if (recordedOutcome) {
    args.ctx.onToolOutcome?.(recordedOutcome);
  }
}

/** Run the full before_tool_call policy chain for a pending tool call. */
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

  try {
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
    const hasBeforeToolCallHooks = hookRunner?.hasHooks("before_tool_call") === true;
    const policyRegistry = getGlobalHookRunnerRegistry() ?? undefined;
    const shouldRunTrustedPolicies = hasTrustedToolPolicies(policyRegistry);
    const normalizedParams = isPlainObject(params) ? params : {};
    const initialCorePolicyResult = await resolveSkillWorkshopToolApproval({
      toolName,
      toolParams: normalizedParams,
      ...(args.ctx?.config ? { config: args.ctx.config } : {}),
      ...(args.ctx?.workspaceDir ? { workspaceDir: args.ctx.workspaceDir } : {}),
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
            ...(policyRegistry ? { registry: policyRegistry } : {}),
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
      disposition: resolveToolErrorDiagnostic(cause, args.signal).terminalReason,
      reason: BEFORE_TOOL_CALL_HOOK_FAILURE_REASON,
      params,
    };
  }
}

/** Wrap a tool execute function with before_tool_call hooks and diagnostics. */
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
  // Resolved once per wrap from the same opt-in config gate the model-content
  // path uses; controls whether tool input/output rides the trusted private channel.
  const toolContentPolicy = resolveDiagnosticModelContentCapturePolicy(ctx?.config);
  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      // Allocate before any async preparation so parallel completions retain
      // the assistant message's tool-call order.
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
      const prepare = (tool as BeforeToolCallPreparingTool).prepareBeforeToolCallParams;
      let preparedParams: unknown;
      try {
        preparedParams = prepare
          ? await prepare(params, {
              ...(toolCallId ? { toolCallId } : {}),
              ...(ctx ? { hookContext: ctx } : {}),
              ...(signal ? { signal } : {}),
            })
          : params;
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
        const eventBase = buildEventBase(outcome.params ?? hookParams);
        if (hookOptions.emitDiagnostics) {
          emitTrustedDiagnosticEvent({
            type: "tool.execution.blocked",
            ...eventBase,
            reason: outcome.reason,
            deniedReason: outcome.deniedReason ?? "plugin-before-tool-call",
          });
          emitToolBlockedSecurityEvent({
            ctx,
            deniedReason: outcome.deniedReason ?? "plugin-before-tool-call",
            toolIdentity: diagnosticIdentity,
            toolName: normalizedToolName,
            trace,
            paramsSummary: eventBase.paramsSummary,
          });
        }
        const blockedResult = buildBlockedToolResult({
          reason: outcome.reason,
          deniedReason: outcome.deniedReason ?? "plugin-before-tool-call",
          toolCallId,
          runId: ctx?.runId,
        });
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params ?? hookParams,
          toolCallId,
          result: blockedResult,
          toolCallOrdinal,
        });
        return blockedResult;
      }
      let executeParams: unknown;
      try {
        executeParams = reconcileCodeModeExecBeforeHookParams({
          tool,
          originalParams: preparedParams,
          hookParams,
          adjustedParams: outcome.params,
        });
        executeParams =
          (tool as BeforeToolCallPreparingTool).finalizeBeforeToolCallParams?.(
            executeParams,
            preparedParams,
          ) ?? executeParams;
      } catch (error) {
        recordPreExecutionError(error, outcome.params ?? hookParams, "tool_preparation");
        throw tagBeforeToolCallFailure(error, signal);
      }
      recordAdjustedParamsForToolCall(toolCallId, executeParams, ctx?.runId);
      const eventBase = buildEventBase(executeParams);
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
          toolCallOrdinal,
        });
        throw err;
      }
    },
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
  options: { approvalMode?: "request" | "report"; emitDiagnostics?: boolean } = {},
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
  // Keep schema and metadata replacements applied after the original wrap while
  // restoring the unwrapped execute function for the new hook context.
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

/** Test-only access to before_tool_call internals. */
export const testing = {
  BEFORE_TOOL_CALL_DIAGNOSTIC_OPTIONS,
  BEFORE_TOOL_CALL_HOOK_CONTEXT,
  BEFORE_TOOL_CALL_SOURCE_TOOL,
  BEFORE_TOOL_CALL_WRAPPED,
  buildAdjustedParamsKey,
  adjustedParamsByToolCallId,
  preExecutionBlockedToolCallIds,
  structuredReplaySafeToolCallIds,
  runBeforeToolCallHook,
  mergeParamsWithApprovalOverrides,
  isPlainObject,
};

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value, { cause: value });
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
