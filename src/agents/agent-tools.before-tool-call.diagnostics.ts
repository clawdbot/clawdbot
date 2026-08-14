/**
 * Diagnostics, skill telemetry, terminal presentation, and loop outcomes for
 * before_tool_call execution.
 */
import os from "node:os";
import path from "node:path";
import {
  diagnosticErrorCategory,
  diagnosticHttpStatusCode,
} from "../infra/diagnostic-error-metadata.js";
import {
  emitTrustedSkillUsedDiagnosticEvent,
  emitTrustedSecurityEvent,
  type DiagnosticEventPrivateData,
  type DiagnosticToolParamsSummary,
  type DiagnosticToolSource,
  type DiagnosticToolTerminalReason,
} from "../infra/diagnostic-events.js";
import {
  cloneDiagnosticContentValue,
  type DiagnosticModelContentCapturePolicy,
} from "../infra/diagnostic-llm-content.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import { redactToolDetail } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import {
  resolveSkillTelemetrySource,
  resolveSkillTelemetrySourceValue,
} from "../skills/loading/source.js";
import type { SkillSnapshot, SkillTelemetrySource, SkillUsagePath } from "../skills/types.js";
import { isPlainObject, truncateUtf16Safe } from "../utils.js";
import { buildAdjustedParamsKey } from "./agent-tools.before-tool-call.state.js";
import type {
  HookBlockedReason,
  HookContext,
  ToolOutcomeObservation,
  ToolOutcomeObserver,
} from "./agent-tools.before-tool-call.types.js";
import { normalizeFileToolPathParam } from "./agent-tools.params.js";
import { BEFORE_TOOL_CALL_SOURCE_TOOL } from "./before-tool-call-metadata.js";
import { getChannelAgentToolMeta } from "./channel-tools.js";
import { resolveAgentRunAbortLifecycleFields } from "./run-termination.js";
import { normalizeToolPolicyName } from "./tool-policy.js";
import {
  resolveToolExecutionErrorKind,
  resolveToolResultFailureKind,
} from "./tool-result-error.js";
import { getToolTerminalPresentation } from "./tool-terminal-presentation.js";
import type { AnyAgentTool } from "./tools/common.js";
import { canonicalizePath } from "./utils/paths.js";

export const beforeToolCallLog = createSubsystemLogger("agents/tools");
const log = beforeToolCallLog;
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

export function resolveToolTerminalPresentation(params: {
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

export function rememberPendingTerminalPresentation(params: {
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
  pruneMapToMaxSize(pendingTerminalPresentationByToolCall, MAX_PENDING_TERMINAL_PRESENTATIONS);
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

export const loadBeforeToolCallRuntime = createLazyRuntimeSurface(
  () => import("./agent-tools.before-tool-call.runtime.js"),
  ({ beforeToolCallRuntime }) => beforeToolCallRuntime,
);

export function unwrapErrorCause(err: unknown): unknown {
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

export function resolveToolErrorDiagnostic(
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

export function resolveToolResultTerminalDiagnostic(
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

export function resolveToolDiagnosticIdentity(tool: AnyAgentTool): ToolDiagnosticIdentity {
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

export function findSkillUsageMatch(params: {
  toolName: string;
  toolParams: unknown;
  ctx?: HookContext;
}): SkillUsageMatch | undefined {
  const command = params.ctx?.skillCommand;
  if (command) {
    const commandToolName = normalizeToolPolicyName(command.toolName ?? params.toolName);
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

export function emitSkillUsedDiagnostic(params: {
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

export function emitToolBlockedSecurityEvent(params: {
  ctx?: HookContext;
  deniedReason: HookBlockedReason;
  toolIdentity: ToolDiagnosticIdentity;
  toolName: string;
  trace?: DiagnosticTraceContext;
  paramsSummary?: DiagnosticToolParamsSummary;
}): void {
  const control =
    params.deniedReason === "client-voice-confirmation"
      ? ({
          policyId: "talk-client-voice-confirmation",
          controlId: "talk-client-voice-confirmation",
          family: "approval",
        } as const)
      : params.deniedReason === "tool-loop"
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

export function buildToolContentPrivateData(
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

export function summarizeToolParams(params: unknown): DiagnosticToolParamsSummary {
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

export function shouldEmitLoopWarning(
  state: SessionState,
  warningKey: string,
  count: number,
): boolean {
  if (!state.toolLoopWarningBuckets) {
    state.toolLoopWarningBuckets = new Map();
  }
  const bucket = Math.floor(count / LOOP_WARNING_BUCKET_SIZE);
  const lastBucket = state.toolLoopWarningBuckets.get(warningKey) ?? 0;
  if (bucket <= lastBucket) {
    return false;
  }
  state.toolLoopWarningBuckets.set(warningKey, bucket);
  pruneMapToMaxSize(state.toolLoopWarningBuckets, MAX_LOOP_WARNING_KEYS);
  return true;
}

/** Reconcile loop liveness with the final post-policy arguments before execution. */
export async function reconcileLoopCallExecutionParams(args: {
  ctx?: HookContext;
  toolName: string;
  toolParams: unknown;
  toolCallId?: string;
}): Promise<void> {
  if ((!args.ctx?.sessionKey && !args.ctx?.sessionId) || args.ctx.loopDetection?.enabled !== true) {
    return;
  }
  try {
    const {
      getDiagnosticSessionState,
      markDiagnosticArgumentChurnObservation,
      reconcileToolCallExecutionParams,
      resolveToolLoopWarningThreshold,
    } = await loadBeforeToolCallRuntime();
    const sessionState = getDiagnosticSessionState({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx.sessionId,
    });
    const churn = reconcileToolCallExecutionParams(sessionState, {
      toolName: args.toolName,
      toolParams: args.toolParams,
      toolCallId: args.toolCallId,
      runId: args.ctx.runId,
      warningThreshold: resolveToolLoopWarningThreshold(),
    });
    markDiagnosticArgumentChurnObservation({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx.sessionId,
      runId: args.ctx.runId,
      active: churn.active,
    });
  } catch (err) {
    log.warn(
      `tool loop execution-param reconciliation failed: tool=${args.toolName} error=${String(err)}`,
    );
  }
}

export async function recordLoopOutcome(args: {
  ctx?: HookContext;
  toolName: string;
  toolParams: unknown;
  toolCallId?: string;
  result?: unknown;
  error?: unknown;
  resultContentSource?: AnyAgentTool["resultContentSource"];
  toolCallOrdinal?: number;
  terminalPresentation?: string;
}): Promise<void> {
  if (!args.ctx?.sessionKey && !args.ctx?.sessionId) {
    return;
  }
  let recordedOutcome: ToolOutcomeObservation | undefined;
  try {
    const {
      getArgumentChurnNoProgressStreak,
      getDiagnosticSessionState,
      markDiagnosticArgumentChurnObservation,
      recordToolCallOutcome,
    } = await loadBeforeToolCallRuntime();
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
    const churnContinues =
      record !== undefined &&
      getArgumentChurnNoProgressStreak(
        (sessionState.toolCallHistory ?? []).filter((call) => call.runId === record.runId),
        record.toolName,
        record.argsHash,
      ).count > 0;
    markDiagnosticArgumentChurnObservation({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx.sessionId,
      runId: args.ctx.runId,
      active: churnContinues,
      existingOnly: true,
    });
    if (record?.resultHash && args.ctx.onToolOutcome) {
      recordedOutcome = {
        toolName: record.toolName,
        argsHash: record.argsHash,
        resultHash: record.resultHash,
        ...(args.resultContentSource ? { resultContentSource: args.resultContentSource } : {}),
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
