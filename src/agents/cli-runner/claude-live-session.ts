/**
 * Manages reusable Claude CLI stdio sessions for CLI-backed agent turns.
 */
import crypto from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ReplyBackendHandle } from "../../auto-reply/reply/reply-run-registry.js";
import { createAbortError as createNamedAbortError } from "../../infra/abort-signal.js";
import {
  emitTrustedDiagnosticEvent,
  type DiagnosticToolParamsSummary,
  type DiagnosticToolSource,
  type DiagnosticToolExecutionErrorEvent,
} from "../../infra/diagnostic-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  loadExecApprovals,
  maxAsk,
  minSecurity,
  normalizeExecAsk,
  resolveExecApprovalsFromFile,
  resolveExecModePolicy,
  type ExecAsk,
  type ExecSecurity,
} from "../../infra/exec-approvals.js";
import { BLOCKED_TOOL_CALL_ABORT_FLOOR_MS } from "../../logging/diagnostic-run-activity.js";
import type { CliBackendConfig } from "../../plugins/cli-backend.types.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS,
  createCliJsonlStreamingParser,
  extractCliErrorMessage,
  parseCliOutput,
  type CliOutput,
  type CliUsage,
  type CliStreamJsonOutputLimits,
  type CliStreamingDelta,
  type CliThinkingDelta,
  type CliThinkingProgress,
  type CliToolResultDelta,
  type CliToolUseStartDelta,
  resolveCliStreamJsonOutputLimits,
} from "../cli-output.js";
import { classifyFailoverReason } from "../embedded-agent-helpers.js";
import {
  type CliTimeoutContext,
  FailoverError,
  isTimeoutError,
  resolveFailoverStatus,
} from "../failover-error.js";
import { resolveCliToolTerminalReason } from "../run-termination.js";
import { prepareCliBundleMcpCaptureAttempt } from "./bundle-mcp.js";
import { LIVE_SESSION_LIMITS, resolveClaudeLiveMode } from "./claude-live-session-policy.js";
import {
  requestClaudeNativeToolApproval,
  resolveClaudeNativeToolApprovalPlan,
} from "./claude-live-tool-approval.js";
import { buildClaudeOwnerKey } from "./helpers.js";
import { cliBackendLog, formatCliBackendOutputDigest } from "./log.js";
import { createCliOutputFailoverError } from "./output-error.js";
import type { PreparedCliRunContext } from "./types.js";

type ProcessSupervisor = ReturnType<
  typeof import("../../process/supervisor/index.js").getProcessSupervisor
>;
type ManagedRun = Awaited<ReturnType<ProcessSupervisor["spawn"]>>;
type ClaudeLiveTurn = {
  backend: CliBackendConfig;
  diagnosticRefs: ClaudeLiveDiagnosticRefs;
  /** Enclosing run abort signal; authoritative for tool terminal reason on turn failure. */
  abortSignal?: AbortSignal;
  outputLimits: ClaudeLiveOutputLimits;
  startedAtMs: number;
  rawLines: string[];
  rawChars: number;
  sessionId?: string;
  noOutputTimer: NodeJS.Timeout | null;
  /** Last stdout/stderr time; null until the process emits anything this turn. */
  lastOutputAtMs: number | null;
  timeoutTimer: NodeJS.Timeout | null;
  activeTools: Map<string, ClaudeLiveActiveTool>;
  observedStdout: boolean;
  /**
   * Claude consumed queued session notifications before processing this turn.
   * The following empty result is provisional; the same process can emit the
   * real answer later, so a bounded grace observes whether output continues.
   */
  pendingSyntheticPlaceholder: boolean;
  allowSyntheticContinuationGrace: boolean;
  deferredSyntheticOutput: CliOutput | null;
  syntheticContinuationTimer: NodeJS.Timeout | null;
  completedToolCallIds: Set<string>;
  toolEventCount: number;
  streamingParser: ReturnType<typeof createCliJsonlStreamingParser>;
  onCliOutput?: (chunk: string, stream: "stderr" | "stdout") => void;
  onPhase?: (phase: "send" | "resolve") => void;
  execPermission: ClaudeLiveExecPermission;
  resolve: (output: CliOutput) => void;
  reject: (error: unknown) => void;
};
type ClaudeLiveSession = {
  key: string;
  generation: string;
  fingerprint: string;
  managedRun: ManagedRun;
  providerId: string;
  modelId: string;
  sessionId?: string;
  noOutputTimeoutMs: number;
  stderr: string;
  stdoutBuffer: string;
  currentTurn: ClaudeLiveTurn | null;
  idleTimer: NodeJS.Timeout | null;
  cleanup: () => Promise<void>;
  cleanupPromise: Promise<void> | null;
  closing: boolean;
  mcpCaptureKey?: string;
  /**
   * Native-tool allow-always grants are process-session scoped and in-memory only.
   * They must not survive the Claude CLI process, so persistence is intentionally absent.
   */
  nativeToolApprovalGrants: Set<string>;
  /**
   * Subagent/workflow task ids from the latest background_tasks_changed event.
   * That event lists all CLI background work, but only local_agent and
   * local_workflow hold the final result (local_bash is killed at exit).
   */
  outstandingBackgroundTaskIds: Set<string>;
};
type ClaudeLiveSessionCreate = {
  generation: string;
  promise: Promise<ClaudeLiveSession>;
};
type ClaudeLiveRunResult = {
  output: CliOutput;
};
type ClaudeLiveOutputLimits = CliStreamJsonOutputLimits;
type ClaudeLiveExecPermission = {
  security: ExecSecurity;
  ask: ExecAsk;
  permissionMode: "bypassPermissions" | "default";
};
type ClaudeLiveDiagnosticRefs = {
  runId: string;
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
};
type ClaudeLiveActiveTool = {
  toolName: string;
  toolCallId: string;
  kind: CliToolUseStartDelta["kind"];
  startedAt: number;
};
type ClaudeLiveToolTerminalOutcome =
  | { outcome: "blocked"; deniedReason: string; reason?: string }
  | { outcome: "cancelled" | "failed" | "timed_out" | "unknown" };
const CLAUDE_LIVE_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;
const CLAUDE_LIVE_CLOSE_WAIT_TIMEOUT_MS = 5_000;
// The observed queued-notification resume emits new process activity within
// seconds. Cap this below the normal resumed no-output watchdog so terminal
// placeholders still reach existing empty-response handling promptly.
const CLAUDE_LIVE_SYNTHETIC_CONTINUATION_GRACE_MS = 30_000;
// Claude Code uses these exact <synthetic> messages while draining internal
// session work. Matching both the model sentinel and full text avoids treating
// user-authored lookalikes as lifecycle signals.
const CLAUDE_LIVE_PROVISIONAL_SYNTHETIC_PLACEHOLDERS = new Set([
  "No response requested.",
  "Continue from where you left off.",
]);
const liveSessions = new Map<string, ClaudeLiveSession>();
const liveSessionCreates = new Map<string, ClaudeLiveSessionCreate>();

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Closes all live Claude CLI sessions and clears creation promises for tests. */
function resetClaudeLiveSessionsForTest(): void {
  for (const session of liveSessions.values()) {
    closeLiveSession(session, "restart");
  }
  liveSessions.clear();
  liveSessionCreates.clear();
}

/** Returns whether this owner still has an in-process Claude stdio session. */
export function hasClaudeLiveSessionForOwner(owner: ClaudeLiveSessionOwner): boolean {
  return getClaudeLiveSessionGenerationForOwner(owner) !== undefined;
}

/** Returns the opaque generation of this owner's current or pending Claude stdio session. */
export function getClaudeLiveSessionGenerationForOwner(
  owner: ClaudeLiveSessionOwner,
): string | undefined {
  const key = buildClaudeLiveOwnerKey(owner);
  return liveSessions.get(key)?.generation ?? liveSessionCreates.get(key)?.generation;
}

async function waitForManagedRunExit(managedRun: ManagedRun): Promise<void> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      managedRun.wait().then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, CLAUDE_LIVE_CLOSE_WAIT_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/** Closes the live Claude session associated with a prepared run context, if one exists. */
export async function closeClaudeLiveSessionForContext(
  context: PreparedCliRunContext,
): Promise<void> {
  const key = buildClaudeLiveKey(context);
  const session = liveSessions.get(key);
  if (session) {
    closeLiveSession(session, "restart");
    await waitForManagedRunExit(session.managedRun);
  }
  liveSessionCreates.delete(key);
}

/** Close a tainted live process so its replacement gets a fresh MCP capture key. */
export async function rotateClaudeLiveMcpCaptureKeyForContext(
  context: PreparedCliRunContext,
): Promise<void> {
  await closeClaudeLiveSessionForContext(context);
}

/** Returns whether a prepared backend context is eligible for Claude live stdio reuse. */
export function shouldUseClaudeLiveSession(context: PreparedCliRunContext): boolean {
  return (
    context.params.sessionEntry?.execHost !== "node" &&
    context.backendResolved.id === "claude-cli" &&
    context.preparedBackend.backend.liveSession === "claude-stdio" &&
    context.preparedBackend.backend.output === "jsonl" &&
    context.preparedBackend.backend.input === "stdin"
  );
}

function upsertArgValue(args: string[], flag: string, value: string): string[] {
  const normalized: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === flag) {
      i += 1;
      continue;
    }
    if (arg.startsWith(`${flag}=`)) {
      continue;
    }
    normalized.push(arg);
  }
  normalized.push(flag, value);
  return normalized;
}

function appendArg(args: string[], flag: string): string[] {
  return args.includes(flag) ? args : [...args, flag];
}

function stripLiveProcessArgs(
  args: string[],
  backend: CliBackendConfig,
  stripSystemPrompt: boolean,
): string[] {
  const liveProcessFlags = new Set(
    [
      "--session-id",
      stripSystemPrompt ? backend.systemPromptArg : undefined,
      stripSystemPrompt ? backend.systemPromptFileArg : undefined,
    ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  );
  const stripped: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (liveProcessFlags.has(arg)) {
      i += 1;
      continue;
    }
    if ([...liveProcessFlags].some((flag) => arg.startsWith(`${flag}=`))) {
      continue;
    }
    stripped.push(arg);
  }
  return stripped;
}

/** Builds Claude CLI args for stream-json live sessions, stripping one-shot session flags. */
function buildClaudeLiveArgs(params: {
  args: string[];
  backend: CliBackendConfig;
  systemPrompt: string;
  useResume: boolean;
  permissionMode?: string;
}): string[] {
  const liveArgs = appendArg(
    upsertArgValue(
      upsertArgValue(
        upsertArgValue(
          stripLiveProcessArgs(
            params.args,
            params.backend,
            params.useResume && params.backend.systemPromptWhen !== "always",
          ),
          "--input-format",
          "stream-json",
        ),
        "--output-format",
        "stream-json",
      ),
      "--permission-prompt-tool",
      "stdio",
    ),
    "--replay-user-messages",
  );
  // Live sessions always speak stream-json over stdin/stdout. Strip stale one-shot args above, then
  // force the live protocol flags so resume and non-resume turns share the same process contract.
  return params.permissionMode
    ? upsertArgValue(liveArgs, "--permission-mode", params.permissionMode)
    : liveArgs;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.claudeLiveSessionTestApi")] = {
    buildClaudeLiveArgs,
    resetClaudeLiveSessionsForTest,
  };
}

type ClaudeLiveSessionOwner = {
  backendId: string;
  agentAccountId?: string;
  agentId?: string;
  authProfileId?: string;
  sessionId?: string;
  sessionKey?: string;
};

function buildClaudeLiveOwnerKey(owner: ClaudeLiveSessionOwner): string {
  return `${owner.backendId}:${buildClaudeOwnerKey(owner)}`;
}

function buildClaudeLiveKey(context: PreparedCliRunContext): string {
  return buildClaudeLiveOwnerKey({
    backendId: context.backendResolved.id,
    agentAccountId: context.params.agentAccountId,
    agentId: context.params.agentId,
    authProfileId: context.effectiveAuthProfileId,
    sessionId: context.params.sessionId,
    sessionKey: context.params.sessionKey,
  });
}

function buildClaudeLiveFingerprint(params: {
  context: PreparedCliRunContext;
  argv: string[];
  env: Record<string, string>;
}): string {
  const normalizeMcpConfigPath = Boolean(params.context.preparedBackend.mcpConfigHash);
  const skillSnapshot = params.context.params.skillsSnapshot;
  const skillsFingerprint = skillSnapshot
    ? sha256(
        JSON.stringify({
          promptHash: sha256(skillSnapshot.prompt),
          skillFilter: skillSnapshot.skillFilter,
          skills: skillSnapshot.skills,
          resolvedSkills: (skillSnapshot.resolvedSkills ?? []).map((skill) => ({
            name: skill.name,
            description: skill.description,
            filePath: skill.filePath,
            sourceInfo: skill.sourceInfo,
          })),
          version: skillSnapshot.version,
        }),
      )
    : undefined;
  const normalizePluginDir = Boolean(skillsFingerprint);
  const omittedValueFlags = new Set(
    [
      params.context.preparedBackend.backend.systemPromptArg,
      params.context.preparedBackend.backend.systemPromptFileArg,
      "--resume",
      "-r",
    ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  );
  const unstableValueFlags = new Set(
    [
      "--session-id",
      normalizeMcpConfigPath ? "--mcp-config" : undefined,
      normalizePluginDir ? "--plugin-dir" : undefined,
    ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  );
  const stableArgv: string[] = [];
  for (let i = 0; i < params.argv.length; i += 1) {
    const entry = params.argv[i] ?? "";
    if (omittedValueFlags.has(entry)) {
      i += 1;
      continue;
    }
    if ([...omittedValueFlags].some((flag) => entry.startsWith(`${flag}=`))) {
      continue;
    }
    if (unstableValueFlags.has(entry)) {
      stableArgv.push("<unstable>");
      i += 1;
      continue;
    }
    if ([...unstableValueFlags].some((flag) => entry.startsWith(`${flag}=`))) {
      stableArgv.push("<unstable>");
      continue;
    }
    stableArgv.push(entry);
  }
  return JSON.stringify({
    command: params.argv[0],
    workspaceDirHash: sha256(params.context.workspaceDir),
    cwdHash: params.context.cwdHash ?? sha256(params.context.cwd ?? params.context.workspaceDir),
    provider: params.context.params.provider,
    model: params.context.normalizedModel,
    systemPromptHash: sha256(params.context.systemPrompt),
    authProfileIdHash: params.context.effectiveAuthProfileId
      ? sha256(params.context.effectiveAuthProfileId)
      : undefined,
    authEpochHash: params.context.authEpoch ? sha256(params.context.authEpoch) : undefined,
    extraSystemPromptHash: params.context.extraSystemPromptHash,
    promptToolNamesHash: params.context.promptToolNamesHash,
    mcpConfigHash: params.context.preparedBackend.mcpConfigHash,
    credentialFingerprint: params.context.preparedBackend.secretInput?.fingerprint,
    skillsFingerprint,
    argv: stableArgv,
    env: Object.keys(params.env)
      .toSorted()
      .map((key) => [key, params.env[key] ? sha256(params.env[key]) : ""]),
  });
}

// Preserve timeout identity and abort reasons so audit terminal outcomes
// can distinguish timed_out from cancelled runs.
function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error && isTimeoutError(reason)) {
    return reason;
  }
  if (reason === undefined) {
    return createNamedAbortError("CLI run aborted");
  }
  const error = new Error(
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : "CLI run aborted",
    reason instanceof Error ? { cause: reason } : undefined,
  );
  error.name = "AbortError";
  return error;
}

function clearTurnTimers(turn: ClaudeLiveTurn): void {
  if (turn.noOutputTimer) {
    clearTimeout(turn.noOutputTimer);
    turn.noOutputTimer = null;
  }
  if (turn.timeoutTimer) {
    clearTimeout(turn.timeoutTimer);
    turn.timeoutTimer = null;
  }
  if (turn.syntheticContinuationTimer) {
    clearTimeout(turn.syntheticContinuationTimer);
    turn.syntheticContinuationTimer = null;
  }
  turn.deferredSyntheticOutput = null;
}

function clearOutstandingBackgroundTasks(session: ClaudeLiveSession): void {
  session.outstandingBackgroundTaskIds.clear();
}

function finishTurn(session: ClaudeLiveSession, output: CliOutput): void {
  const turn = session.currentTurn;
  if (!turn) {
    return;
  }
  cliBackendLog.info(
    `claude live session turn: provider=${session.providerId} model=${session.modelId} durationMs=${Date.now() - turn.startedAtMs} rawLines=${turn.rawLines.length} ${formatCliBackendOutputDigest(output.text)}`,
  );
  turn.streamingParser.finish();
  failActiveClaudeLiveTools(turn, new Error("Tool result missing before turn completed"));
  clearTurnTimers(turn);
  clearOutstandingBackgroundTasks(session);
  session.currentTurn = null;
  turn.resolve(output);
  scheduleIdleClose(session);
}

function failTurn(session: ClaudeLiveSession, error: unknown): void {
  const turn = session.currentTurn;
  if (!turn) {
    return;
  }
  const errorKind = error instanceof Error ? error.name : typeof error;
  cliBackendLog.warn(
    `claude live session turn failed: provider=${session.providerId} model=${session.modelId} durationMs=${Date.now() - turn.startedAtMs} error=${errorKind}`,
  );
  turn.streamingParser.finish();
  failActiveClaudeLiveTools(turn, error);
  clearTurnTimers(turn);
  clearOutstandingBackgroundTasks(session);
  session.currentTurn = null;
  turn.reject(error);
}

function abortTurn(session: ClaudeLiveSession, error: Error): void {
  const turn = session.currentTurn;
  if (!turn) {
    return;
  }
  closeLiveSession(session, "abort", error);
}

function cleanupLiveSession(session: ClaudeLiveSession): Promise<void> {
  if (!session.cleanupPromise) {
    session.cleanupPromise = session.cleanup().catch((error: unknown) => {
      cliBackendLog.warn(`Claude live session cleanup failed: ${formatErrorMessage(error)}`);
    });
  }
  return session.cleanupPromise;
}

function closeLiveSession(
  session: ClaudeLiveSession,
  reason: "idle" | "restart" | "abort",
  error?: unknown,
): void {
  if (session.closing) {
    return;
  }
  cliBackendLog.info(
    `claude live session close: provider=${session.providerId} model=${session.modelId} reason=${reason}`,
  );
  session.closing = true;
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  if (liveSessions.get(session.key) === session) {
    liveSessions.delete(session.key);
  }
  if (error) {
    failTurn(session, error);
  } else {
    clearOutstandingBackgroundTasks(session);
  }
  session.managedRun.cancel("manual-cancel");
  void cleanupLiveSession(session);
}

function scheduleIdleClose(session: ClaudeLiveSession): void {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
  }
  session.idleTimer = setTimeout(() => {
    if (!session.currentTurn) {
      closeLiveSession(session, "idle");
    }
  }, CLAUDE_LIVE_IDLE_TIMEOUT_MS);
}

function createTimeoutError(
  session: ClaudeLiveSession,
  message: string,
  code?: string,
  cliTimeout?: CliTimeoutContext,
): FailoverError {
  return new FailoverError(message, {
    reason: "timeout",
    provider: session.providerId,
    model: session.modelId,
    status: resolveFailoverStatus("timeout"),
    code,
    cliTimeout,
  });
}

function createOutputLimitError(session: ClaudeLiveSession, message: string): FailoverError {
  return new FailoverError(message, {
    reason: "format",
    provider: session.providerId,
    model: session.modelId,
    status: resolveFailoverStatus("format"),
  });
}

function diagnosticToolSourceForClaudeLiveTool(toolName: string): DiagnosticToolSource {
  return toolName.startsWith("mcp__") ? "mcp" : "core";
}

function claudeLiveDiagnosticBase(turn: ClaudeLiveTurn) {
  return {
    runId: turn.diagnosticRefs.runId,
    sessionId: turn.diagnosticRefs.sessionId,
    ...(turn.diagnosticRefs.sessionKey ? { sessionKey: turn.diagnosticRefs.sessionKey } : {}),
    ...(turn.diagnosticRefs.agentId ? { agentId: turn.diagnosticRefs.agentId } : {}),
  };
}

function emitClaudeLiveProgress(turn: ClaudeLiveTurn, reason: string): void {
  emitTrustedDiagnosticEvent({
    type: "run.progress",
    ...claudeLiveDiagnosticBase(turn),
    reason,
  });
}

function summarizeClaudeLiveToolInput(input: unknown): DiagnosticToolParamsSummary | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (input === null) {
    return { kind: "null" };
  }
  if (Array.isArray(input)) {
    return { kind: "array", length: input.length };
  }
  switch (typeof input) {
    case "object":
      return { kind: "object" };
    case "string":
      return { kind: "string", length: input.length };
    case "number":
      return { kind: "number" };
    case "boolean":
      return { kind: "boolean" };
    case "undefined":
      return { kind: "undefined" };
    default:
      return { kind: "other" };
  }
}

function markClaudeLiveToolStarted(turn: ClaudeLiveTurn, tool: CliToolUseStartDelta): void {
  if (turn.completedToolCallIds.has(tool.toolCallId) || turn.activeTools.has(tool.toolCallId)) {
    return;
  }
  const now = Date.now();
  turn.activeTools.set(tool.toolCallId, {
    toolName: tool.name,
    toolCallId: tool.toolCallId,
    kind: tool.kind,
    startedAt: now,
  });
  turn.toolEventCount += 1;
  emitTrustedDiagnosticEvent({
    type: "tool.execution.started",
    ...claudeLiveDiagnosticBase(turn),
    toolName: tool.name,
    toolSource: diagnosticToolSourceForClaudeLiveTool(tool.name),
    toolOwner: "claude-cli",
    toolCallId: tool.toolCallId,
    paramsSummary: summarizeClaudeLiveToolInput(tool.args),
  });
  emitClaudeLiveProgress(turn, "cli_live:tool_started");
}

function markClaudeLiveToolCompleted(
  turn: ClaudeLiveTurn,
  result: CliToolResultDelta,
  terminalOutcome?: ClaudeLiveToolTerminalOutcome,
): void {
  if (turn.completedToolCallIds.has(result.toolCallId)) {
    return;
  }
  turn.toolEventCount += 1;
  const activeTool = turn.activeTools.get(result.toolCallId);
  if (!activeTool) {
    emitClaudeLiveProgress(turn, "cli_live:tool_result");
    return;
  }
  turn.activeTools.delete(result.toolCallId);
  turn.completedToolCallIds.add(result.toolCallId);
  const event = {
    ...claudeLiveDiagnosticBase(turn),
    toolName: activeTool.toolName,
    toolSource: diagnosticToolSourceForClaudeLiveTool(activeTool.toolName),
    toolOwner: "claude-cli",
    toolCallId: activeTool.toolCallId,
    durationMs: Math.max(0, Date.now() - activeTool.startedAt),
  };
  if (terminalOutcome?.outcome === "blocked") {
    emitTrustedDiagnosticEvent({
      type: "tool.execution.blocked",
      ...event,
      deniedReason: terminalOutcome.deniedReason,
      reason: terminalOutcome.reason ?? "blocked by before-tool policy",
    });
  } else if (terminalOutcome?.outcome === "unknown") {
    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      ...event,
      errorCategory: "cli_tool_ambiguous",
      errorCode: "tool_outcome_unknown",
    });
  } else if (terminalOutcome || result.isError) {
    const terminalReason = terminalOutcome?.outcome ?? "failed";
    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      ...event,
      errorCategory: terminalReason === "cancelled" ? "aborted" : "tool_failed",
      terminalReason,
    });
  } else {
    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      ...event,
    });
  }
  emitClaudeLiveProgress(turn, "cli_live:tool_result");
}

function markClaudeLiveToolDenied(turn: ClaudeLiveTurn, tool: CliToolUseStartDelta): void {
  markClaudeLiveToolStarted(turn, tool);
  markClaudeLiveToolCompleted(
    turn,
    { toolCallId: tool.toolCallId, name: tool.name, isError: true },
    {
      outcome: "blocked",
      deniedReason: "cli_live_exec_policy",
      reason: "blocked by CLI live execution policy",
    },
  );
}

function failActiveClaudeLiveTools(turn: ClaudeLiveTurn, error: unknown): void {
  const terminalReason = resolveCliToolTerminalReason({
    error,
    abortSignal: turn.abortSignal,
  });
  const errorCategory =
    terminalReason === "timed_out"
      ? "timeout"
      : terminalReason === "cancelled"
        ? "aborted"
        : "error";
  for (const activeTool of turn.activeTools.values()) {
    const event: Omit<DiagnosticToolExecutionErrorEvent, "seq" | "ts" | "type" | "errorCategory"> =
      {
        ...claudeLiveDiagnosticBase(turn),
        toolName: activeTool.toolName,
        toolSource: diagnosticToolSourceForClaudeLiveTool(activeTool.toolName),
        toolOwner: "claude-cli",
        toolCallId: activeTool.toolCallId,
        durationMs: Math.max(0, Date.now() - activeTool.startedAt),
      };
    if (activeTool.kind === "server_tool_use") {
      emitTrustedDiagnosticEvent({
        type: "tool.execution.error",
        ...event,
        errorCategory: "cli_tool_ambiguous",
        errorCode: "tool_outcome_unknown",
      });
      continue;
    }
    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      ...event,
      errorCategory,
      terminalReason,
    });
  }
  turn.activeTools.clear();
}

function noteClaudeLiveProgress(
  turn: ClaudeLiveTurn,
  parsed: Record<string, unknown>,
  sawToolEvent: boolean,
): void {
  if (parsed.type === "result") {
    emitClaudeLiveProgress(turn, "cli_live:result");
    return;
  }
  if (sawToolEvent) {
    return;
  }
  emitClaudeLiveProgress(turn, "cli_live:stream_progress");
}

// The CLI emits a tool_use line, then nothing until the tool result, so a
// quiet long-running tool is indistinguishable from a wedged process at the
// stdout level. While observed tool calls or CLI-reported background tasks
// (background_tasks_changed) are outstanding, extend the quiet window to the
// blocked-tool floor instead of killing mid-work.
function armNoOutputTimer(session: ClaudeLiveSession, turn: ClaudeLiveTurn, delayMs: number): void {
  if (turn.noOutputTimer) {
    clearTimeout(turn.noOutputTimer);
  }
  turn.noOutputTimer = setTimeout(() => {
    const quietSinceMs = turn.lastOutputAtMs ?? turn.startedAtMs;
    const hasOutstandingBackgroundWork =
      turn.activeTools.size > 0 || session.outstandingBackgroundTaskIds.size > 0;
    if (hasOutstandingBackgroundWork) {
      const quietBudgetMs = Math.max(session.noOutputTimeoutMs, BLOCKED_TOOL_CALL_ABORT_FLOOR_MS);
      const remainingMs = quietSinceMs + quietBudgetMs - Date.now();
      if (remainingMs > 0) {
        armNoOutputTimer(session, turn, remainingMs);
        return;
      }
    }
    closeLiveSession(
      session,
      "abort",
      createTimeoutError(
        session,
        `CLI produced no output for ${Math.round((Date.now() - quietSinceMs) / 1000)}s and was terminated.`,
        // Retryable only when the process never produced any output this turn.
        turn.lastOutputAtMs === null ? "cli_no_output_timeout" : undefined,
        {
          mode: "no-output",
          timeoutSeconds: Math.round((Date.now() - quietSinceMs) / 1000),
          observedActivity:
            turn.lastOutputAtMs !== null || turn.toolEventCount > 0 || turn.rawLines.length > 0,
          activeToolCount: turn.activeTools.size,
          backgroundTaskCount: session.outstandingBackgroundTaskIds.size,
        },
      ),
    );
  }, delayMs);
}

// Claude Code holds its final output for background subagents AND workflows
// (headless "Background tasks at exit" contract); both continue the parent and
// emit a post-drain result. Dropping either type here would finalize the turn
// early and strand that work; the turn timeout stays the explicit hard bound.
const CLAUDE_LIVE_RESULT_HOLDING_BACKGROUND_TASK_TYPES = new Set(["local_agent", "local_workflow"]);

/** Replace outstanding subagent/workflow task ids from background_tasks_changed. */
function applyBackgroundTasksChanged(
  session: ClaudeLiveSession,
  parsed: Record<string, unknown>,
): void {
  if (parsed.type !== "system" || parsed.subtype !== "background_tasks_changed") {
    return;
  }
  // tasks is the full authoritative list (not a delta). Only subagent/workflow
  // types hold the final result; e.g. local_bash is listed but killed at exit.
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  session.outstandingBackgroundTaskIds.clear();
  for (const task of tasks) {
    if (!isRecord(task)) {
      continue;
    }
    const taskType = typeof task.task_type === "string" ? task.task_type.trim() : "";
    if (!CLAUDE_LIVE_RESULT_HOLDING_BACKGROUND_TASK_TYPES.has(taskType)) {
      continue;
    }
    const taskId = typeof task.task_id === "string" ? task.task_id.trim() : "";
    if (taskId) {
      session.outstandingBackgroundTaskIds.add(taskId);
    }
  }
}

function isClaudeLiveProvisionalSyntheticPlaceholder(parsed: Record<string, unknown>): boolean {
  if (parsed.type !== "assistant" || !isRecord(parsed.message)) {
    return false;
  }
  const message = parsed.message;
  if (message.model !== "<synthetic>") {
    return false;
  }
  const content = Array.isArray(message.content) ? message.content : [];
  const text = content
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("")
    .trim();
  return CLAUDE_LIVE_PROVISIONAL_SYNTHETIC_PLACEHOLDERS.has(text);
}

function isClaudeLiveSubstantiveAssistantProgress(parsed: Record<string, unknown>): boolean {
  if (parsed.type === "assistant" && isRecord(parsed.message)) {
    return parsed.message.model !== "<synthetic>";
  }
  if (parsed.type !== "stream_event" || !isRecord(parsed.event)) {
    return false;
  }
  const event = parsed.event;
  return (
    event.type === "content_block_delta" &&
    isRecord(event.delta) &&
    event.delta.type === "text_delta" &&
    typeof event.delta.text === "string" &&
    event.delta.text.length > 0
  );
}

function deferClaudeLiveSyntheticResult(
  session: ClaudeLiveSession,
  turn: ClaudeLiveTurn,
  output: CliOutput,
): void {
  turn.pendingSyntheticPlaceholder = false;
  turn.deferredSyntheticOutput = output;
  if (turn.noOutputTimer) {
    clearTimeout(turn.noOutputTimer);
    turn.noOutputTimer = null;
  }
  if (turn.syntheticContinuationTimer) {
    clearTimeout(turn.syntheticContinuationTimer);
  }
  const graceMs = Math.min(CLAUDE_LIVE_SYNTHETIC_CONTINUATION_GRACE_MS, session.noOutputTimeoutMs);
  turn.syntheticContinuationTimer = setTimeout(() => {
    if (session.currentTurn !== turn || !turn.deferredSyntheticOutput) {
      return;
    }
    const terminalOutput = turn.deferredSyntheticOutput;
    turn.syntheticContinuationTimer = null;
    turn.deferredSyntheticOutput = null;
    emitClaudeLiveProgress(turn, "cli_live:synthetic_placeholder_grace_expired");
    finishTurn(session, terminalOutput);
  }, graceMs);
  emitClaudeLiveProgress(turn, "cli_live:result_deferred_synthetic_placeholder");
}

function noteClaudeLiveContinuationAfterSyntheticPlaceholder(
  session: ClaudeLiveSession,
  turn: ClaudeLiveTurn,
): void {
  if (!turn.deferredSyntheticOutput) {
    return;
  }
  if (turn.syntheticContinuationTimer) {
    clearTimeout(turn.syntheticContinuationTimer);
    turn.syntheticContinuationTimer = null;
  }
  turn.deferredSyntheticOutput = null;
  armNoOutputTimer(session, turn, session.noOutputTimeoutMs);
  emitClaudeLiveProgress(turn, "cli_live:synthetic_placeholder_continuation");
}

function resetNoOutputTimer(session: ClaudeLiveSession): void {
  const turn = session.currentTurn;
  if (!turn) {
    return;
  }
  turn.lastOutputAtMs = Date.now();
  armNoOutputTimer(session, turn, session.noOutputTimeoutMs);
}

function parseSessionId(parsed: Record<string, unknown>): string | undefined {
  const sessionId =
    typeof parsed.session_id === "string"
      ? parsed.session_id.trim()
      : typeof parsed.sessionId === "string"
        ? parsed.sessionId.trim()
        : "";
  return sessionId || undefined;
}

function readConfiguredExecPolicy(context: PreparedCliRunContext): {
  security: ExecSecurity;
  ask: ExecAsk;
  agentId: string;
} {
  const agentId = context.params.agentId ?? resolveAgentIdFromSessionKey(context.params.sessionKey);
  const agentExec = context.params.config?.agents?.list?.find((agent) => agent.id === agentId)
    ?.tools?.exec;
  const exec = agentExec ?? context.params.config?.tools?.exec;
  const configured = resolveExecModePolicy({
    mode: exec?.mode,
    security: exec?.security ?? "full",
    ask: exec?.ask ?? "off",
  });
  const security = configured.security;
  const configuredAsk = configured.ask;
  const sessionAsk = normalizeExecAsk(context.params.sessionEntry?.execAsk);
  return {
    agentId,
    security,
    ask: sessionAsk ? maxAsk(configuredAsk, sessionAsk) : configuredAsk,
  };
}

function resolveClaudeLiveExecPermission(context: PreparedCliRunContext): ClaudeLiveExecPermission {
  const configured = readConfiguredExecPolicy(context);
  const approvals = resolveExecApprovalsFromFile({
    file: loadExecApprovals(),
    agentId: configured.agentId,
    overrides: {
      security: configured.security,
      ask: configured.ask,
    },
  });
  const security = minSecurity(configured.security, approvals.agent.security);
  const ask = maxAsk(configured.ask, approvals.agent.ask);
  return {
    security,
    ask,
    permissionMode: resolveClaudeLiveMode(security, ask, process.getuid?.()),
  };
}

function parseClaudeLiveJsonLine(
  session: ClaudeLiveSession,
  trimmed: string,
): Record<string, unknown> | null {
  const maxPendingLineChars =
    session.currentTurn?.outputLimits.maxPendingLineChars ??
    CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS;
  if (trimmed.length > maxPendingLineChars) {
    closeLiveSession(
      session,
      "abort",
      createOutputLimitError(session, "Claude CLI JSONL line exceeded output limit."),
    );
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

function writeClaudeLiveControlResponse(session: ClaudeLiveSession, response: unknown): void {
  const stdin = session.managedRun.stdin;
  if (!stdin) {
    throw new Error("Claude CLI live session stdin is unavailable");
  }
  stdin.write(`${JSON.stringify(response)}\n`);
}

function writeClaudeLiveToolControlResponse(params: {
  session: ClaudeLiveSession;
  requestId: string;
  toolUseId?: string;
  toolInput: Record<string, unknown>;
  decision: { behavior: "allow" } | { behavior: "deny"; message: string };
}): void {
  writeClaudeLiveControlResponse(params.session, {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: params.requestId,
      response:
        params.decision.behavior === "allow"
          ? {
              behavior: "allow",
              updatedInput: params.toolInput,
              ...(params.toolUseId ? { toolUseID: params.toolUseId } : {}),
            }
          : {
              behavior: "deny",
              decisionClassification: "user_reject",
              message: params.decision.message,
            },
    },
  });
}

function markClaudeLiveControlToolDenied(params: {
  turn: ClaudeLiveTurn;
  toolUseId?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}): void {
  if (!params.toolUseId || !params.toolName) {
    return;
  }
  markClaudeLiveToolDenied(params.turn, {
    toolCallId: params.toolUseId,
    name: params.toolName,
    kind: "tool_use",
    args: params.toolInput,
  });
}

function handleClaudeLiveControlRequest(
  session: ClaudeLiveSession,
  turn: ClaudeLiveTurn,
  parsed: Record<string, unknown>,
): void {
  if (parsed.type !== "control_request" || !isRecord(parsed.request)) {
    return;
  }
  const request = parsed.request;
  if (request.subtype !== "can_use_tool") {
    return;
  }
  const requestId = typeof parsed.request_id === "string" ? parsed.request_id : "";
  if (!requestId) {
    return;
  }
  const toolUseId = typeof request.tool_use_id === "string" ? request.tool_use_id : undefined;
  const toolName = typeof request.tool_name === "string" ? request.tool_name.trim() : "";
  const toolInput = isRecord(request.input) ? request.input : {};
  const plan = resolveClaudeNativeToolApprovalPlan(turn.execPermission);
  if (
    plan === "allow" ||
    (plan === "prompt" &&
      turn.execPermission.ask !== "always" &&
      session.nativeToolApprovalGrants.has(toolName))
  ) {
    writeClaudeLiveToolControlResponse({
      session,
      requestId,
      toolUseId,
      toolInput,
      decision: { behavior: "allow" },
    });
    return;
  }
  if (plan === "deny") {
    markClaudeLiveControlToolDenied({ turn, toolUseId, toolName, toolInput });
    writeClaudeLiveToolControlResponse({
      session,
      requestId,
      toolUseId,
      toolInput,
      decision: {
        behavior: "deny",
        message: `OpenClaw exec policy denied Claude native tool use (security=${turn.execPermission.security}, ask=${turn.execPermission.ask}).`,
      },
    });
    return;
  }
  void (async () => {
    const outcome = await requestClaudeNativeToolApproval({
      toolName,
      toolInput,
      pluginId: session.providerId,
      sessionKey: turn.diagnosticRefs.sessionKey,
      agentId: turn.diagnosticRefs.agentId,
      toolCallId: toolUseId,
      abortSignal: turn.abortSignal,
      ask: turn.execPermission.ask,
    });
    const runAborted = turn.abortSignal?.aborted === true;
    const allowed = !runAborted && outcome.kind === "allow";
    if (!runAborted && outcome.kind === "allow" && outcome.grantAlways) {
      session.nativeToolApprovalGrants.add(toolName);
    }
    if (!allowed) {
      markClaudeLiveControlToolDenied({ turn, toolUseId, toolName, toolInput });
    }
    if (session.closing || !session.managedRun.stdin) {
      return;
    }
    try {
      writeClaudeLiveToolControlResponse({
        session,
        requestId,
        toolUseId,
        toolInput,
        decision: allowed
          ? { behavior: "allow" }
          : {
              behavior: "deny",
              message:
                outcome.kind === "deny" && outcome.reason === "policy-oversized"
                  ? "OpenClaw denied Claude native tool use (Bash): the command is too large to display for out-of-band approval. Split it into smaller commands and retry."
                  : outcome.kind === "deny" && outcome.reason === "user" && !runAborted
                    ? `OpenClaw user denied Claude native tool use (${toolName}).`
                    : `OpenClaw approval was not granted for Claude native tool use (${toolName}).`,
            },
      });
    } catch {
      // The live process may close while an out-of-band approval is pending.
    }
  })();
}

function handleClaudeLiveLine(session: ClaudeLiveSession, line: string): void {
  const turn = session.currentTurn;
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  const parsed = parseClaudeLiveJsonLine(session, trimmed);
  if (turn) {
    turn.observedStdout = true;
  }
  if (!parsed) {
    return;
  }
  const parsedSessionId = parseSessionId(parsed);
  if (parsedSessionId) {
    session.sessionId = parsedSessionId;
  }
  if (!turn) {
    return;
  }
  noteClaudeLiveContinuationAfterSyntheticPlaceholder(session, turn);
  turn.rawChars += trimmed.length + 1;
  if (
    turn.rawChars > turn.outputLimits.maxTurnRawChars ||
    turn.rawLines.length >= turn.outputLimits.maxTurnLines
  ) {
    closeLiveSession(
      session,
      "abort",
      createOutputLimitError(session, "Claude CLI turn output exceeded limit."),
    );
    return;
  }
  turn.rawLines.push(trimmed);
  applyBackgroundTasksChanged(session, parsed);
  if (turn.allowSyntheticContinuationGrace && isClaudeLiveProvisionalSyntheticPlaceholder(parsed)) {
    turn.pendingSyntheticPlaceholder = true;
  } else if (turn.pendingSyntheticPlaceholder && isClaudeLiveSubstantiveAssistantProgress(parsed)) {
    turn.pendingSyntheticPlaceholder = false;
  }
  const toolEventCountBefore = turn.toolEventCount;
  turn.streamingParser.push(`${trimmed}\n`);
  turn.sessionId = parsedSessionId ?? turn.sessionId;
  noteClaudeLiveProgress(turn, parsed, turn.toolEventCount !== toolEventCountBefore);
  handleClaudeLiveControlRequest(session, turn, parsed);
  if (parsed.type !== "result") {
    return;
  }
  turn.onPhase?.("resolve");
  const raw = turn.rawLines.join("\n");
  // Reuse the parser that classified pre-tool text as commentary. Reparsing the
  // transcript loses that boundary when Claude's terminal result is empty.
  const output =
    turn.streamingParser.getOutput() ??
    parseCliOutput({
      raw,
      backend: turn.backend,
      providerId: session.providerId,
      outputMode: "jsonl",
      fallbackSessionId: turn.sessionId,
    });
  if (output.errorText) {
    const error = createCliOutputFailoverError({
      output,
      provider: session.providerId,
      model: session.modelId,
      runId: turn.diagnosticRefs.runId,
      sessionId: turn.diagnosticRefs.sessionId,
    });
    if (error) {
      failTurn(session, error);
    }
    scheduleIdleClose(session);
    return;
  }
  // Interim success result while background_tasks_changed still reports
  // outstanding subagent/workflow tasks: keep the turn open for the final
  // post-drain result. Other listed types (e.g. local_bash) do not hold it.
  if (session.outstandingBackgroundTaskIds.size > 0) {
    // An interim result is not terminal; background work returns the run to send.
    turn.onPhase?.("send");
    emitClaudeLiveProgress(turn, "cli_live:result_deferred_background_tasks");
    return;
  }
  // A resumed Claude session can first consume queued task notifications and
  // emit an empty synthetic result, then continue the same user turn. Keep the
  // live process and watchdogs authoritative instead of racing it with fallback.
  if (turn.pendingSyntheticPlaceholder && !output.text.trim()) {
    deferClaudeLiveSyntheticResult(session, turn, output);
    return;
  }
  finishTurn(session, output);
}

function handleClaudeStdout(session: ClaudeLiveSession, chunk: string) {
  session.currentTurn?.onCliOutput?.(chunk, "stdout");
  resetNoOutputTimer(session);
  session.stdoutBuffer += chunk;
  const maxPendingLineChars =
    session.currentTurn?.outputLimits.maxPendingLineChars ??
    CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS;
  if (session.stdoutBuffer.length > maxPendingLineChars) {
    closeLiveSession(
      session,
      "abort",
      createOutputLimitError(session, "Claude CLI JSONL line exceeded output limit."),
    );
    return;
  }
  const lines = session.stdoutBuffer.split(/\r?\n/g);
  session.stdoutBuffer = lines.pop() ?? "";
  try {
    for (const line of lines) {
      handleClaudeLiveLine(session, line);
    }
  } catch (error) {
    closeLiveSession(session, "abort", error);
  }
}

function handleClaudeExit(session: ClaudeLiveSession, exitCode: number | null): void {
  session.closing = true;
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  if (liveSessions.get(session.key) === session) {
    liveSessions.delete(session.key);
  }
  void cleanupLiveSession(session);
  if (!session.currentTurn) {
    return;
  }
  if (session.stdoutBuffer.trim()) {
    try {
      handleClaudeLiveLine(session, session.stdoutBuffer);
    } catch (error) {
      session.stdoutBuffer = "";
      failTurn(session, error);
      return;
    }
    session.stdoutBuffer = "";
  }
  if (!session.currentTurn) {
    return;
  }
  const stderr = session.stderr.trim();
  const fallbackMessage =
    exitCode === 0 ? "Claude CLI exited before completing the turn." : "Claude CLI failed.";
  const message = extractCliErrorMessage(stderr) ?? (stderr || fallbackMessage);
  if (exitCode === 0 && !stderr) {
    const turn = session.currentTurn;
    const retryCode =
      turn && !turn.observedStdout && turn.rawLines.length === 0
        ? "cli_unknown_empty_failure"
        : undefined;
    failTurn(
      session,
      new FailoverError(message, {
        reason: "empty_response",
        provider: session.providerId,
        model: session.modelId,
        status: resolveFailoverStatus("empty_response"),
        code: retryCode,
      }),
    );
    return;
  }
  const reason = classifyFailoverReason(message, { provider: session.providerId }) ?? "unknown";
  const code = reason === "context_overflow" ? "cli_context_overflow" : undefined;
  failTurn(
    session,
    new FailoverError(message, {
      reason,
      provider: session.providerId,
      model: session.modelId,
      status: resolveFailoverStatus(reason),
      code,
    }),
  );
}

function createClaudeUserInputMessage(content: string): string {
  return `${JSON.stringify({
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content,
    },
  })}\n`;
}

async function writeTurnInput(session: ClaudeLiveSession, payload: string): Promise<void> {
  const stdin = session.managedRun.stdin;
  if (!stdin) {
    throw new Error("Claude CLI live session stdin is unavailable");
  }
  await new Promise<void>((resolve, reject) => {
    stdin.write(payload, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function createClaudeLiveSession(params: {
  context: PreparedCliRunContext;
  argv: string[];
  env: Record<string, string>;
  generation: string;
  fingerprint: string;
  key: string;
  mcpCaptureKey?: string;
  noOutputTimeoutMs: number;
  supervisor: ProcessSupervisor;
  cleanup: () => Promise<void>;
}): Promise<ClaudeLiveSession> {
  let session: ClaudeLiveSession | null = null;
  const mcpCaptureAttempt = await prepareCliBundleMcpCaptureAttempt({
    mode: params.context.backendResolved.bundleMcpMode,
    backend: params.context.preparedBackend.backend,
    env: params.env,
    captureKey: params.mcpCaptureKey,
  });
  let managedRun: ManagedRun;
  try {
    managedRun = await params.supervisor.spawn({
      sessionId: params.context.params.sessionId,
      backendId: params.context.backendResolved.id,
      scopeKey: `claude-live:${params.key}`,
      replaceExistingScope: true,
      mode: "child",
      argv: params.argv,
      cwd: params.context.cwd ?? params.context.workspaceDir,
      env: mcpCaptureAttempt.env ?? params.env,
      stdinMode: "pipe-open",
      secretInput: params.context.preparedBackend.secretInput,
      captureOutput: false,
      onStdout: (chunk) => {
        if (session) {
          handleClaudeStdout(session, chunk);
        }
      },
      onStderr: (chunk) => {
        if (session) {
          session.currentTurn?.onCliOutput?.(chunk, "stderr");
          session.stderr += chunk;
          if (session.stderr.length > LIVE_SESSION_LIMITS.maxStderrChars) {
            closeLiveSession(
              session,
              "abort",
              createOutputLimitError(session, "Claude CLI stderr exceeded limit."),
            );
            return;
          }
          resetNoOutputTimer(session);
        }
      },
    });
  } catch (error) {
    await mcpCaptureAttempt.cleanup?.();
    throw error;
  }
  session = {
    key: params.key,
    generation: params.generation,
    fingerprint: params.fingerprint,
    managedRun,
    providerId: params.context.params.provider,
    modelId: params.context.modelId,
    noOutputTimeoutMs: params.noOutputTimeoutMs,
    stderr: "",
    stdoutBuffer: "",
    currentTurn: null,
    idleTimer: null,
    cleanup: async () => {
      await mcpCaptureAttempt.cleanup?.();
      await params.cleanup();
    },
    cleanupPromise: null,
    closing: false,
    mcpCaptureKey: params.mcpCaptureKey,
    nativeToolApprovalGrants: new Set(),
    outstandingBackgroundTaskIds: new Set(),
  };
  void managedRun.wait().then(
    (exit) => handleClaudeExit(session, exit.exitCode),
    (error: unknown) => {
      if (session) {
        closeLiveSession(session, "abort", error);
      }
    },
  );
  liveSessions.set(params.key, session);
  cliBackendLog.info(
    `claude live session start: provider=${session.providerId} model=${session.modelId} activeSessions=${liveSessions.size}`,
  );
  return session;
}

function createTurn(params: {
  context: PreparedCliRunContext;
  noOutputTimeoutMs: number;
  allowSyntheticContinuationGrace: boolean;
  onAssistantDelta: (delta: CliStreamingDelta) => void;
  onThinkingDelta?: (delta: CliThinkingDelta) => void;
  onThinkingProgress?: (progress: CliThinkingProgress) => void;
  onToolUseStart?: (delta: CliToolUseStartDelta) => void;
  onToolResult?: (delta: CliToolResultDelta) => void;
  resolveToolResultTerminalOutcome?: (
    delta: CliToolResultDelta,
  ) => ClaudeLiveToolTerminalOutcome | undefined;
  onCommentaryText?: (text: string) => void;
  onSessionId?: (sessionId: string) => void;
  onAssistantMessage?: (message: unknown) => void;
  onUsage?: (usage: CliUsage, terminal: boolean) => void;
  onCliOutput?: (chunk: string, stream: "stderr" | "stdout") => void;
  onPhase?: (phase: "send" | "resolve") => void;
  session: ClaudeLiveSession;
  execPermission: ClaudeLiveExecPermission;
  resolve: (output: CliOutput) => void;
  reject: (error: unknown) => void;
}): ClaudeLiveTurn {
  const turn: ClaudeLiveTurn = {
    backend: params.context.preparedBackend.backend,
    diagnosticRefs: {
      runId: params.context.params.runId,
      sessionId: params.context.params.sessionId,
      ...(params.context.params.sessionKey ? { sessionKey: params.context.params.sessionKey } : {}),
      ...(params.context.params.agentId ? { agentId: params.context.params.agentId } : {}),
    },
    abortSignal: params.context.params.abortSignal,
    outputLimits: resolveCliStreamJsonOutputLimits(params.context.preparedBackend.backend),
    startedAtMs: Date.now(),
    rawLines: [],
    rawChars: 0,
    noOutputTimer: null,
    lastOutputAtMs: null,
    timeoutTimer: null,
    activeTools: new Map(),
    observedStdout: false,
    pendingSyntheticPlaceholder: false,
    allowSyntheticContinuationGrace: params.allowSyntheticContinuationGrace,
    deferredSyntheticOutput: null,
    syntheticContinuationTimer: null,
    completedToolCallIds: new Set(),
    toolEventCount: 0,
    streamingParser: createCliJsonlStreamingParser({
      backend: params.context.preparedBackend.backend,
      providerId: params.context.backendResolved.id,
      onAssistantDelta: params.onAssistantDelta,
      onThinkingDelta: params.onThinkingDelta,
      onThinkingProgress: params.onThinkingProgress,
      onToolUseStart: (delta) => {
        markClaudeLiveToolStarted(turn, delta);
        params.onToolUseStart?.(delta);
      },
      onToolResult: (delta) => {
        markClaudeLiveToolCompleted(turn, delta, params.resolveToolResultTerminalOutcome?.(delta));
        params.onToolResult?.(delta);
      },
      onCommentaryText: params.onCommentaryText,
      onSessionId: params.onSessionId,
      onAssistantMessage: params.onAssistantMessage,
      onUsage: params.onUsage,
    }),
    onCliOutput: params.onCliOutput,
    onPhase: params.onPhase,
    execPermission: params.execPermission,
    resolve: params.resolve,
    reject: params.reject,
  };
  armNoOutputTimer(params.session, turn, params.noOutputTimeoutMs);
  turn.timeoutTimer = setTimeout(() => {
    closeLiveSession(
      params.session,
      "abort",
      createTimeoutError(
        params.session,
        `CLI exceeded timeout (${Math.round(params.context.params.timeoutMs / 1000)}s) and was terminated.`,
        "cli_overall_timeout",
        {
          mode: "overall",
          timeoutSeconds: Math.round(params.context.params.timeoutMs / 1000),
          observedActivity:
            turn.observedStdout || turn.rawLines.length > 0 || turn.toolEventCount > 0,
          activeToolCount: turn.activeTools.size,
          backgroundTaskCount: params.session.outstandingBackgroundTaskIds.size,
        },
      ),
    );
  }, params.context.params.timeoutMs);
  return turn;
}

function closeOldestIdleSession(): boolean {
  for (const session of liveSessions.values()) {
    if (!session.currentTurn) {
      closeLiveSession(session, "idle");
      return true;
    }
  }
  return false;
}

function ensureLiveSessionCapacity(key: string, context: PreparedCliRunContext): void {
  if (
    liveSessions.has(key) ||
    liveSessionCreates.has(key) ||
    liveSessions.size + liveSessionCreates.size < LIVE_SESSION_LIMITS.maxSessions
  ) {
    return;
  }
  if (closeOldestIdleSession()) {
    return;
  }
  throw new FailoverError("Too many Claude CLI live sessions are active.", {
    reason: "rate_limit",
    provider: context.params.provider,
    model: context.modelId,
    status: resolveFailoverStatus("rate_limit"),
  });
}

function createRequiredLiveSessionError(params: {
  context: PreparedCliRunContext;
  code: "cli_live_session_changed" | "cli_live_session_missing";
  cause?: unknown;
}): FailoverError {
  return new FailoverError("Managed Claude live session is no longer reusable.", {
    reason: "session_expired",
    provider: params.context.params.provider,
    model: params.context.modelId,
    status: resolveFailoverStatus("session_expired"),
    code: params.code,
    cause: params.cause,
  });
}

/** Runs one prompt through a reusable Claude CLI live session. */
export async function runClaudeLiveSessionTurn(params: {
  context: PreparedCliRunContext;
  args: string[];
  executableCommand?: string;
  executableLeadingArgv?: readonly string[];
  env: Record<string, string>;
  prompt: string;
  useResume: boolean;
  forceNewSession?: boolean;
  requiredSessionGeneration?: string;
  noOutputTimeoutMs: number;
  getProcessSupervisor: () => ProcessSupervisor;
  onAssistantDelta: (delta: CliStreamingDelta) => void;
  onThinkingDelta?: (delta: CliThinkingDelta) => void;
  onThinkingProgress?: (progress: CliThinkingProgress) => void;
  onToolUseStart?: (delta: CliToolUseStartDelta) => void;
  onToolResult?: (delta: CliToolResultDelta) => void;
  resolveToolResultTerminalOutcome?: (
    delta: CliToolResultDelta,
  ) => ClaudeLiveToolTerminalOutcome | undefined;
  onCommentaryText?: (text: string) => void;
  onMcpCaptureReady?: (captureKey: string) => void;
  onSessionId?: (sessionId: string) => void;
  onAssistantMessage?: (message: unknown) => void;
  onUsage?: (usage: CliUsage, terminal: boolean) => void;
  onCliOutput?: (chunk: string, stream: "stderr" | "stdout") => void;
  onRequestPayload?: (payload: string) => void;
  onPhase?: (phase: "send" | "resolve") => void;
  cleanup: () => Promise<void>;
}): Promise<ClaudeLiveRunResult> {
  const key = buildClaudeLiveKey(params.context);
  const resumeCapable = Boolean(params.context.preparedBackend.backend.resumeArgs?.length);
  const execPermission = resolveClaudeLiveExecPermission(params.context);
  const argv = [
    params.executableCommand ?? params.context.preparedBackend.backend.command,
    ...(params.executableLeadingArgv ?? []),
    ...buildClaudeLiveArgs({
      args: params.args,
      backend: params.context.preparedBackend.backend,
      systemPrompt: params.context.systemPrompt,
      useResume: params.useResume,
      permissionMode: execPermission.permissionMode,
    }),
  ];
  const fingerprint = buildClaudeLiveFingerprint({
    context: params.context,
    argv,
    env: params.env,
  });
  let cleanupDone = false;
  let createdSessionForTurn = false;
  const cleanup = async () => {
    if (cleanupDone) {
      return;
    }
    cleanupDone = true;
    await params.cleanup();
  };
  let session = liveSessions.get(key) ?? null;
  if (
    session &&
    params.requiredSessionGeneration &&
    session.generation !== params.requiredSessionGeneration
  ) {
    await cleanup();
    throw createRequiredLiveSessionError({
      context: params.context,
      code: "cli_live_session_changed",
    });
  }
  if (session && params.forceNewSession) {
    closeLiveSession(session, "restart");
    session = null;
  }
  if (session && resumeCapable && !params.useResume) {
    // Non-resume turns must start from a fresh process when the backend supports resume; otherwise
    // Claude could inherit conversation state from the previous live turn.
    closeLiveSession(session, "restart");
    session = null;
  }
  if (session && session.fingerprint !== fingerprint) {
    if (params.requiredSessionGeneration) {
      await cleanup();
      throw createRequiredLiveSessionError({
        context: params.context,
        code: "cli_live_session_changed",
      });
    }
    closeLiveSession(session, "restart");
    session = null;
  }
  if (!session && params.requiredSessionGeneration) {
    const pendingGeneration = liveSessionCreates.get(key)?.generation;
    if (pendingGeneration !== params.requiredSessionGeneration) {
      await cleanup();
      throw createRequiredLiveSessionError({
        context: params.context,
        code: pendingGeneration ? "cli_live_session_changed" : "cli_live_session_missing",
      });
    }
  }
  let cleanupTurnArtifacts = Boolean(session);
  let notifiedMcpCaptureKey: string | undefined;
  const notifyMcpCaptureReady = (captureKey: string | undefined) => {
    if (!captureKey || notifiedMcpCaptureKey === captureKey) {
      return;
    }
    params.onMcpCaptureReady?.(captureKey);
    notifiedMcpCaptureKey = captureKey;
  };
  try {
    ensureLiveSessionCapacity(key, params.context);
  } catch (error) {
    await cleanup();
    throw error;
  }
  if (!session) {
    const pendingSession = liveSessionCreates.get(key);
    if (pendingSession) {
      try {
        session = await pendingSession.promise;
      } catch (error) {
        await cleanup();
        if (params.requiredSessionGeneration) {
          throw createRequiredLiveSessionError({
            context: params.context,
            code: "cli_live_session_missing",
            cause: error,
          });
        }
        throw error;
      }
      if (
        params.requiredSessionGeneration &&
        session.generation !== params.requiredSessionGeneration
      ) {
        await cleanup();
        throw createRequiredLiveSessionError({
          context: params.context,
          code: "cli_live_session_changed",
        });
      }
      if (params.forceNewSession) {
        closeLiveSession(session, "restart");
        session = null;
      } else if (session.fingerprint !== fingerprint) {
        if (params.requiredSessionGeneration) {
          await cleanup();
          throw createRequiredLiveSessionError({
            context: params.context,
            code: "cli_live_session_changed",
          });
        }
        closeLiveSession(session, "restart");
        session = null;
      } else if (resumeCapable && !params.useResume) {
        closeLiveSession(session, "restart");
        session = null;
      } else {
        cleanupTurnArtifacts = true;
      }
    }
    if (!session) {
      if (params.requiredSessionGeneration) {
        await cleanup();
        throw createRequiredLiveSessionError({
          context: params.context,
          code: "cli_live_session_missing",
        });
      }
      const generation = crypto.randomUUID();
      const mcpCaptureKey = params.context.mcpDeliveryCapture ? crypto.randomUUID() : undefined;
      if (mcpCaptureKey) {
        // Fence the Gateway grant before the capture-bearing child can issue
        // its first loopback request during process startup.
        try {
          notifyMcpCaptureReady(mcpCaptureKey);
        } catch (error) {
          await cleanup();
          throw error;
        }
      }
      const createSession = createClaudeLiveSession({
        context: params.context,
        argv,
        env: params.env,
        generation,
        fingerprint,
        key,
        mcpCaptureKey,
        noOutputTimeoutMs: params.noOutputTimeoutMs,
        supervisor: params.getProcessSupervisor(),
        cleanup,
      }).finally(() => {
        if (liveSessionCreates.get(key)?.promise === createSession) {
          liveSessionCreates.delete(key);
        }
      });
      liveSessionCreates.set(key, { generation, promise: createSession });
      try {
        session = await createSession;
        createdSessionForTurn = true;
      } catch (error) {
        await cleanup();
        throw error;
      }
    }
  }
  if (cleanupTurnArtifacts && session) {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    await cleanup();
    cliBackendLog.info(
      `claude live session reuse: provider=${session.providerId} model=${session.modelId}`,
    );
  }
  if (session.closing || liveSessions.get(key) !== session) {
    await cleanup();
    if (params.requiredSessionGeneration) {
      throw createRequiredLiveSessionError({
        context: params.context,
        code: "cli_live_session_missing",
      });
    }
    throw new Error("Claude CLI live session closed before handling the turn");
  }
  if (session.currentTurn) {
    throw new Error("Claude CLI live session is already handling a turn");
  }
  const liveSession = session;
  if (liveSession.sessionId) {
    params.onSessionId?.(liveSession.sessionId);
  }
  notifyMcpCaptureReady(liveSession.mcpCaptureKey);
  liveSession.noOutputTimeoutMs = params.noOutputTimeoutMs;
  liveSession.stderr = "";

  const outputPromise = new Promise<CliOutput>((resolve, reject) => {
    liveSession.currentTurn = createTurn({
      context: params.context,
      noOutputTimeoutMs: params.noOutputTimeoutMs,
      allowSyntheticContinuationGrace: params.useResume && createdSessionForTurn,
      onAssistantDelta: params.onAssistantDelta,
      onThinkingDelta: params.onThinkingDelta,
      onThinkingProgress: params.onThinkingProgress,
      onToolUseStart: params.onToolUseStart,
      onToolResult: params.onToolResult,
      resolveToolResultTerminalOutcome: params.resolveToolResultTerminalOutcome,
      onCommentaryText: params.onCommentaryText,
      onSessionId: params.onSessionId,
      onAssistantMessage: params.onAssistantMessage,
      onUsage: params.onUsage,
      onCliOutput: params.onCliOutput,
      onPhase: params.onPhase,
      session: liveSession,
      execPermission,
      resolve,
      reject,
    });
  });
  // Timeout/abort can reject the turn while stdin is backpressured. Keep the
  // rejection handled until the final await below rethrows the canonical result.
  void outputPromise.catch(() => undefined);
  const abort = () =>
    abortTurn(liveSession, createAbortError(params.context.params.abortSignal?.reason));
  let replyBackendCompleted = false;
  const replyBackendHandle: ReplyBackendHandle | undefined = params.context.params.replyOperation
    ? {
        kind: "cli",
        cancel: abort,
        isStreaming: () => !replyBackendCompleted,
      }
    : undefined;
  params.context.params.abortSignal?.addEventListener("abort", abort, { once: true });
  if (replyBackendHandle) {
    params.context.params.replyOperation?.attachBackend(replyBackendHandle);
  }
  try {
    if (params.context.params.abortSignal?.aborted) {
      abort();
    } else {
      try {
        const requestPayload = createClaudeUserInputMessage(params.prompt);
        params.onRequestPayload?.(requestPayload);
        await Promise.race([writeTurnInput(liveSession, requestPayload), outputPromise]);
      } catch (error) {
        closeLiveSession(liveSession, "abort", error);
      }
    }
    return { output: await outputPromise };
  } finally {
    replyBackendCompleted = true;
    params.context.params.abortSignal?.removeEventListener("abort", abort);
    try {
      if (replyBackendHandle) {
        params.context.params.replyOperation?.detachBackend(replyBackendHandle);
      }
    } finally {
      if (liveSession.mcpCaptureKey) {
        // The capture key is process environment, so a captured turn must end its
        // process before the attempt releases that key to avoid cross-turn sends.
        closeLiveSession(liveSession, "restart");
        await waitForManagedRunExit(liveSession.managedRun);
        await cleanupLiveSession(liveSession);
      }
    }
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
