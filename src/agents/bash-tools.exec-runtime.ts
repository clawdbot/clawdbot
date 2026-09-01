import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { emitDiagnosticEventWithTrustedTraceContext } from "../infra/diagnostic-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  type EventSessionRoutingPolicy,
  resolveEventSessionKeyForPolicy,
  scopedHeartbeatWakeOptionsForPolicy,
} from "../infra/event-session-routing.js";
import {
  DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
  resolveExecApprovalAllowedDecisions,
  type ExecHost,
  type ExecApprovalDecision,
  type ExecTarget,
} from "../infra/exec-approvals.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import { findPathKey, mergePathPrepend, removePathPrepend } from "../infra/path-prepend.js";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import { enqueueSystemEventWithReceipt } from "../infra/system-events.js";
import { logWarn } from "../logger.js";
import { redactToolPayloadText } from "../logging/redact.js";
import type { ManagedRun } from "../process/supervisor/index.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import type { RunExit, SpawnInput, TerminationReason } from "../process/supervisor/types.js";
import { isSubagentSessionKey } from "../sessions/session-key-utils.js";
/**
 * Bash exec runtime.
 * Spawns host/sandbox processes, manages session updates/backgrounding,
 * approval messaging constants, environment safety, and exit outcome shaping.
 */
import { formatFencedCodeBlock } from "../shared/markdown-code.js";
import {
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import { resolveSafeTimeoutDelayMs } from "../utils/timer-delay.js";
import type { ProcessSession } from "./bash-process-registry.js";
import {
  addSession,
  appendOutput,
  isProcessSessionIdTaken,
  markExited,
  recordNotifyOnExitRemoval,
  tail,
} from "./bash-process-registry.js";
import {
  appendExecTimeoutRetryGuidance,
  renderExecExitLabel,
  renderExecUpdateText,
} from "./bash-tools.exec-output.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
import { chunkString, clampWithDefault, readEnvInt } from "./bash-tools.shared.js";
import { buildGitHubExecLaunchArgv } from "./github-exec-launch.js";
import { buildCursorPositionResponse, stripDsrRequests } from "./pty-dsr.js";
import type { AgentToolResult } from "./runtime/index.js";
import { createSessionSlug } from "./session-slug.js";
import { maybeWrapCommandWithShellSnapshot } from "./shell-snapshot.js";
import { createStreamingBinaryOutputSanitizer, getShellConfig } from "./shell-utils.js";
import { registerTrustedToolNoStartError } from "./tool-result-error.js";
import { withoutGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
export { applyPathPrepend, normalizePathPrepend } from "../infra/path-prepend.js";

export { execSchema } from "./bash-tools.schemas.js";

export class ExecProcessPreflightError extends Error {
  constructor(readonly result: AgentToolResult<ExecToolDetails>) {
    super("exec denied by final preflight");
  }

  static unwrap(error: unknown): AgentToolResult<ExecToolDetails> {
    if (error instanceof ExecProcessPreflightError) {
      return error.result;
    }
    throw error;
  }
}

const SMKX = "\x1b[?1h";
const RMKX = "\x1b[?1l";

function resolveExecTimeoutMs(timeoutSec: number | null | undefined): number | undefined {
  if (typeof timeoutSec !== "number" || !Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    return undefined;
  }
  return resolveSafeTimeoutDelayMs(timeoutSec * 1000);
}

/**
 * Detect cursor key mode from PTY output chunk.
 * Uses lastIndexOf to find the *last* toggle in the chunk.
 * Returns "application" if smkx is the last toggle, "normal" if rmkx is last,
 * or null if no toggle is found.
 */
function detectCursorKeyMode(raw: string): "application" | "normal" | null {
  const lastSmkx = raw.lastIndexOf(SMKX);
  const lastRmkx = raw.lastIndexOf(RMKX);
  if (lastSmkx === -1 && lastRmkx === -1) {
    return null;
  }
  // Whichever appears later in the chunk wins.
  return lastSmkx > lastRmkx ? "application" : "normal";
}

/** Default retained aggregate output cap for exec sessions. */
export const DEFAULT_MAX_OUTPUT = clampWithDefault(
  readEnvInt("OPENCLAW_BASH_MAX_OUTPUT_CHARS", "PI_BASH_MAX_OUTPUT_CHARS"),
  200_000,
  1_000,
  200_000,
);
/** Default pending output cap for poll/update buffers. */
export const DEFAULT_PENDING_MAX_OUTPUT = clampWithDefault(
  readEnvInt("OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS"),
  30_000,
  1_000,
  200_000,
);
/** Fallback PATH used when the process environment has no PATH. */
export const DEFAULT_PATH =
  process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** Tail length used in background completion notifications. */
const DEFAULT_NOTIFY_TAIL_CHARS = 400;
const DEFAULT_NOTIFY_SNIPPET_CHARS = 180;
/** Default time an approval can remain pending. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;
/** Gateway request timeout for approval registration/wait calls. */
export const DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS = DEFAULT_APPROVAL_TIMEOUT_MS + 10_000;
const DEFAULT_APPROVAL_RUNNING_NOTICE_MS = 10_000;
const APPROVAL_SLUG_LENGTH = 8;

/** Failure categories used to explain exec process exits. */
type ExecProcessFailureKind =
  | "shell-command-not-found"
  | "shell-not-executable"
  | "overall-timeout"
  | "no-output-timeout"
  | "signal"
  | "aborted"
  | "runtime-error";

type ExecExitFailureKind = Exclude<ExecProcessFailureKind, "runtime-error">;

/** Normalized result of a spawned exec process. */
export type ExecProcessOutcome =
  | {
      status: "completed";
      exitCode: number;
      exitSignal: NodeJS.Signals | number | null;
      exitReason?: TerminationReason;
      durationMs: number;
      aggregated: string;
      timedOut: false;
      noOutputTimedOut?: boolean;
    }
  | {
      status: "failed";
      exitCode: number | null;
      exitSignal: NodeJS.Signals | number | null;
      exitReason?: TerminationReason;
      durationMs: number;
      aggregated: string;
      timedOut: boolean;
      noOutputTimedOut?: boolean;
      failureKind: ExecProcessFailureKind;
      oomScoreWrapperSelected?: boolean;
      reason: string;
    };

/** Live handle returned after an exec process has started. */
export type ExecProcessHandle = {
  session: ProcessSession;
  startedAt: number;
  pid?: number;
  promise: Promise<ExecProcessOutcome>;
  kill: () => void;
  /** Immediately suppress all future `onUpdate` calls for this handle. */
  disableUpdates: () => void;
};

function normalizeExecExitSignal(signal: NodeJS.Signals | number | null): string | undefined {
  if (signal === null) {
    return undefined;
  }
  return String(signal);
}

function emitExecProcessCompleted(params: {
  command: string;
  mode: "child" | "pty";
  outcome: ExecProcessOutcome;
  sessionKey?: string;
  target: "host" | "sandbox";
}): void {
  const exitSignal = normalizeExecExitSignal(params.outcome.exitSignal);
  // Payload stays untrusted, but the ambient trace context is the OpenClaw run
  // scope, so exporters may use it to nest the exec span under its run.
  emitDiagnosticEventWithTrustedTraceContext({
    type: "exec.process.completed",
    target: params.target,
    mode: params.mode,
    outcome: params.outcome.status,
    durationMs: params.outcome.durationMs,
    commandLength: params.command.length,
    ...(params.sessionKey?.trim() ? { sessionKey: params.sessionKey.trim() } : {}),
    ...(typeof params.outcome.exitCode === "number" ? { exitCode: params.outcome.exitCode } : {}),
    ...(exitSignal ? { exitSignal } : {}),
    ...(params.outcome.status === "failed"
      ? {
          timedOut: params.outcome.timedOut,
          failureKind: params.outcome.failureKind,
        }
      : {}),
  });
}

/** Renders a host label for user-facing exec policy messages. */
function renderExecHostLabel(host: ExecHost) {
  return host === "sandbox" ? "sandbox" : host === "gateway" ? "gateway" : "node";
}

/** Renders an exec target label, preserving `auto`. */
export function renderExecTargetLabel(target: ExecTarget) {
  return target === "auto" ? "auto" : renderExecHostLabel(target);
}

/** Returns true when a per-call target override is allowed by configured policy. */
export function isRequestedExecTargetAllowed(params: {
  configuredTarget: ExecTarget;
  requestedTarget: ExecTarget;
  sandboxAvailable?: boolean;
}) {
  if (params.requestedTarget === params.configuredTarget) {
    return true;
  }
  if (params.configuredTarget === "auto") {
    if (
      params.sandboxAvailable &&
      (params.requestedTarget === "gateway" || params.requestedTarget === "node")
    ) {
      return false;
    }
    return true;
  }
  return false;
}

/** Resolves configured/requested/elevated exec target into an effective host. */
export function resolveExecTarget(params: {
  configuredTarget?: ExecTarget;
  requestedTarget?: ExecTarget | null;
  elevatedRequested: boolean;
  sandboxAvailable: boolean;
  sandboxRequired?: boolean;
}) {
  const sandboxRequired = params.sandboxRequired === true;
  if (sandboxRequired && !params.sandboxAvailable) {
    throw registerTrustedToolNoStartError(
      new Error("This session requires a sandbox, but its sandbox runtime is unavailable."),
    );
  }
  if (sandboxRequired && params.elevatedRequested) {
    throw registerTrustedToolNoStartError(
      new Error("Elevated execution is unavailable because this session requires a sandbox."),
    );
  }
  // Session isolation outranks every agent, session, and request-scoped host preference.
  const configuredTarget = sandboxRequired ? "auto" : (params.configuredTarget ?? "auto");
  const requestedTarget =
    params.requestedTarget === "auto" ? null : (params.requestedTarget ?? null);
  if (sandboxRequired && (requestedTarget === "gateway" || requestedTarget === "node")) {
    throw registerTrustedToolNoStartError(
      new Error(
        `exec host not allowed (requested ${renderExecTargetLabel(requestedTarget)}; this session requires a sandbox).`,
      ),
    );
  }
  if (
    requestedTarget &&
    !isRequestedExecTargetAllowed({
      configuredTarget,
      requestedTarget,
      sandboxAvailable: params.sandboxAvailable,
    })
  ) {
    const allowedConfig = Array.from(
      new Set(
        configuredTarget === "auto" &&
          params.sandboxAvailable &&
          (requestedTarget === "gateway" || requestedTarget === "node")
          ? [renderExecTargetLabel(requestedTarget)]
          : requestedTarget === "gateway" && !params.sandboxAvailable
            ? ["gateway", "auto"]
            : [renderExecTargetLabel(requestedTarget), "auto"],
      ),
    ).join(" or ");
    throw registerTrustedToolNoStartError(
      new Error(
        `exec host not allowed (requested ${renderExecTargetLabel(requestedTarget)}; ` +
          `configured host is ${renderExecTargetLabel(configuredTarget)}; ` +
          `set tools.exec.host=${allowedConfig} to allow this override).`,
      ),
    );
  }
  const selectedTarget = requestedTarget ?? configuredTarget;
  const resolvedTarget = params.elevatedRequested
    ? selectedTarget === "node"
      ? "node"
      : "gateway"
    : selectedTarget;
  const effectiveHost =
    resolvedTarget === "auto" ? (params.sandboxAvailable ? "sandbox" : "gateway") : resolvedTarget;
  return {
    configuredTarget,
    requestedTarget,
    selectedTarget: resolvedTarget,
    effectiveHost,
  };
}

/** Normalizes notification snippets to a compact single-line form. */
export function normalizeNotifyOutput(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function compactNotifyOutput(value: string, maxChars = DEFAULT_NOTIFY_SNIPPET_CHARS) {
  const normalized = normalizeNotifyOutput(value);
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const safe = Math.max(1, maxChars - 1);
  return `${truncateUtf16Safe(normalized, safe)}…`;
}

/** Merges shell-discovered PATH entries into an exec environment. */
export function applyShellPath(env: Record<string, string>, shellPath?: string | null) {
  if (!shellPath) {
    return;
  }
  const entries = normalizeStringEntries(shellPath.split(path.delimiter));
  if (entries.length === 0) {
    return;
  }
  const pathKey = findPathKey(env);
  const merged = mergePathPrepend(env[pathKey], entries);
  if (merged) {
    env[pathKey] = merged;
  }
}

function maybeNotifyOnExit(session: ProcessSession, status: "completed" | "failed") {
  if (
    !session.backgrounded ||
    !session.notifyOnExit ||
    session.exitNotified ||
    session.terminalPollObserved
  ) {
    return;
  }
  const sessionKey = session.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  session.exitNotified = true;
  const exitLabel = renderExecExitLabel(session);
  const output = compactNotifyOutput(
    tail(session.tail || session.aggregated || "", DEFAULT_NOTIFY_TAIL_CHARS),
  );
  if (status === "failed" && session.exitReason === "manual-cancel" && !output) {
    return;
  }
  if (
    status === "completed" &&
    session.exitCode === 0 &&
    !output &&
    session.notifyOnExitEmptySuccess !== true
  ) {
    return;
  }
  const summary = output
    ? `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel}) :: ${output}`
    : `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel})`;
  const eventText = appendExecTimeoutRetryGuidance(summary, session.exitReason);
  const eventRouting = session.eventRouting ?? {
    mainKey: session.mainKey,
    sessionScope: session.sessionScope,
  };
  const eventSessionKey = resolveEventSessionKeyForPolicy(sessionKey, eventRouting);
  const eventOptions = {
    sessionKey: eventSessionKey,
    contextKey: `exec:${session.id}`,
    deliveryContext: session.notifyDeliveryContext,
  };
  const remove = enqueueSystemEventWithReceipt(
    eventText,
    eventSessionKey === "global" && session.agentId
      ? withSystemEventOwner(eventOptions, session.agentId)
      : eventOptions,
    { allowDuplicate: true },
  );
  if (remove) {
    recordNotifyOnExitRemoval(session, remove);
  }
  // Subagent sessions receive exec results via process poll and announce flow;
  // the heartbeat would fall back to the main session and cause spurious wakes.
  if (!isSubagentSessionKey(sessionKey)) {
    const wakeOptions = scopedHeartbeatWakeOptionsForPolicy(
      sessionKey,
      {
        source: "exec-event" as const,
        intent: "event" as const,
        reason: "exec-event",
        coalesceMs: 0,
      },
      eventRouting,
    );
    requestHeartbeat(
      sessionKey === "global" && session.agentId
        ? { ...wakeOptions, agentId: session.agentId }
        : wakeOptions,
    );
  }
}

/** Creates the short approval id shown in `/approve` prompts. */
export function createApprovalSlug(id: string) {
  return id.slice(0, APPROVAL_SLUG_LENGTH);
}

/** Builds the user-facing approval-pending message for foreground exec. */
export function buildApprovalPendingMessage(params: {
  warningText?: string;
  approvalSlug: string;
  approvalId: string;
  allowedDecisions?: readonly ExecApprovalDecision[];
  command: string;
  cwd: string | undefined;
  host: "gateway" | "node";
  nodeId?: string;
  processContinuationAvailable?: boolean;
}) {
  const commandBlock = formatFencedCodeBlock(params.command, "sh");
  const lines: string[] = [];
  const allowedDecisions = params.allowedDecisions ?? resolveExecApprovalAllowedDecisions();
  const decisionText = allowedDecisions.join("|");
  const warningText = params.warningText?.trim();
  if (warningText) {
    lines.push(warningText, "");
  }
  lines.push(`Approval required (id ${params.approvalSlug}, full ${params.approvalId}).`);
  lines.push(`Host: ${params.host}`);
  if (params.nodeId) {
    lines.push(`Node: ${params.nodeId}`);
  }
  lines.push(`CWD: ${params.cwd ?? "(node default)"}`);
  lines.push("Command:");
  lines.push(commandBlock);
  lines.push("Mode: foreground (interactive approvals available).");
  if (params.processContinuationAvailable !== false) {
    lines.push(
      allowedDecisions.includes("allow-always")
        ? "Background mode requires pre-approved policy (allow-always or ask=off)."
        : "Background mode requires an effective policy that allows pre-approval (for example ask=off).",
    );
  }
  lines.push(`Reply with: /approve ${params.approvalSlug} ${decisionText}`);
  if (!allowedDecisions.includes("allow-always")) {
    lines.push("Allow Always is unavailable for this command.");
  }
  lines.push("If the short code is ambiguous, use the full id in /approve.");
  return lines.join("\n");
}

/** Normalizes the delay before showing a running approval notice. */
export function resolveApprovalRunningNoticeMs(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_APPROVAL_RUNNING_NOTICE_MS;
  }
  if (value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function joinExecFailureOutput(aggregated: string, reason: string) {
  return aggregated ? `${aggregated}\n\n${reason}` : reason;
}

function classifyExecFailureKind(params: {
  exitReason: TerminationReason;
  exitCode: number;
  isShellFailure: boolean;
  exitSignal: NodeJS.Signals | number | null;
}): ExecExitFailureKind {
  if (params.isShellFailure) {
    return params.exitCode === 127 ? "shell-command-not-found" : "shell-not-executable";
  }
  if (params.exitReason === "overall-timeout") {
    return "overall-timeout";
  }
  if (params.exitReason === "no-output-timeout") {
    return "no-output-timeout";
  }
  if (params.exitSignal != null) {
    return "signal";
  }
  return "aborted";
}

/** Formats a user-facing reason for a failed exec process exit. */
function formatExecFailureReason(params: {
  failureKind: ExecExitFailureKind;
  exitSignal: NodeJS.Signals | number | null;
  timeoutSec: number | null | undefined;
  processContinuationAvailable: boolean;
}): string {
  switch (params.failureKind) {
    case "shell-command-not-found":
      return "Command not found";
    case "shell-not-executable":
      return "Command not executable (permission denied)";
    case "overall-timeout": {
      const timeoutText =
        typeof params.timeoutSec === "number" && params.timeoutSec > 0
          ? `Command timed out after ${params.timeoutSec} seconds.`
          : "Command timed out.";
      const retryGuidance = appendExecTimeoutRetryGuidance(timeoutText, params.failureKind);
      return params.processContinuationAvailable
        ? `${retryGuidance}\n\nIf it should keep running, start it with exec background=true or yieldMs so OpenClaw can register a pollable process session. Do not rely on shell backgrounding with a trailing &.`
        : retryGuidance;
    }
    case "no-output-timeout":
      return appendExecTimeoutRetryGuidance(
        "Command timed out waiting for output.",
        params.failureKind,
      );
    case "signal":
      return `Command aborted by signal ${params.exitSignal}`;
    case "aborted":
      return "Command aborted before exit code was captured";
  }
  throw new Error("Unsupported exec failure kind");
}

/** Converts a supervisor exit record into a normalized exec process outcome. */
function buildExecExitOutcome(params: {
  exit: RunExit;
  aggregated: string;
  durationMs: number;
  timeoutSec: number | null | undefined;
  processContinuationAvailable: boolean;
}): ExecProcessOutcome {
  const exitCode = params.exit.exitCode ?? 0;
  const isNormalExit = params.exit.reason === "exit";
  const isShellFailure = exitCode === 126 || exitCode === 127;
  const status: ExecProcessOutcome["status"] =
    isNormalExit && !isShellFailure ? "completed" : "failed";
  if (status === "completed") {
    const exitMsg = exitCode !== 0 ? `\n\n(Command exited with code ${exitCode})` : "";
    return {
      status: "completed",
      exitCode,
      exitSignal: params.exit.exitSignal,
      exitReason: params.exit.reason,
      durationMs: params.durationMs,
      aggregated: params.aggregated + exitMsg,
      timedOut: false,
      noOutputTimedOut: params.exit.noOutputTimedOut,
    };
  }
  const failureKind = classifyExecFailureKind({
    exitReason: params.exit.reason,
    exitCode,
    isShellFailure,
    exitSignal: params.exit.exitSignal,
  });
  const reason = formatExecFailureReason({
    failureKind,
    exitSignal: params.exit.exitSignal,
    timeoutSec: params.timeoutSec,
    processContinuationAvailable: params.processContinuationAvailable,
  });
  return {
    status: "failed",
    exitCode: params.exit.exitCode,
    exitSignal: params.exit.exitSignal,
    exitReason: params.exit.reason,
    durationMs: params.durationMs,
    aggregated: params.aggregated,
    timedOut: params.exit.timedOut,
    noOutputTimedOut: params.exit.noOutputTimedOut,
    failureKind,
    oomScoreWrapperSelected: params.exit.oomScoreWrapperSelected,
    reason: joinExecFailureOutput(params.aggregated, reason),
  };
}

/** Converts spawn/runtime errors into a normalized failed exec outcome. */
export function buildExecRuntimeErrorOutcome(params: {
  error: unknown;
  aggregated: string;
  durationMs: number;
}): ExecProcessOutcome {
  return {
    status: "failed",
    exitCode: null,
    exitSignal: null,
    durationMs: params.durationMs,
    aggregated: params.aggregated,
    timedOut: false,
    failureKind: "runtime-error",
    reason: joinExecFailureOutput(params.aggregated, String(params.error)),
  };
}

/**
 * Apply PATH prepends inside the shell command.
 * This ensures our paths take precedence even if user RC files (e.g. ~/.zshenv)
 * prepend their own entries to PATH during shell startup.
 */
function wrapPosixCommandWithPathPrepend(
  command: string,
  env: Record<string, string>,
  pathPrepend?: string[],
): string {
  if (process.platform === "win32") {
    return command;
  }

  if (!pathPrepend || pathPrepend.length === 0) {
    return command;
  }

  // Strip prepended entries from the base env.PATH to avoid duplicate segments.
  // The wrapper will re-apply them after shell startup.
  const pathKey = findPathKey(env);
  const currentPath = env[pathKey];
  if (currentPath) {
    const newPath = removePathPrepend(currentPath, pathPrepend);
    if (newPath !== undefined) {
      env[pathKey] = newPath;
    }
  }

  // Pass the prepend string safely via a temporary environment variable.
  env.OPENCLAW_PREPEND_PATH = pathPrepend.join(path.delimiter);

  return `export PATH="\${OPENCLAW_PREPEND_PATH}\${PATH:+:$PATH}"; unset OPENCLAW_PREPEND_PATH; ${command}`;
}

/** Starts a host or sandbox exec process and registers it for polling/backgrounding. */
export async function runExecProcess({
  startupSignal: initialStartupSignal,
  onUpdate: initialOnUpdate,
  beforeSpawn: initialBeforeSpawn,
  onSettledBeforeNotify: initialOnSettledBeforeNotify,
  ...opts
}: {
  command: string;
  // Execute this instead of `command` (which is kept for display/session/logging).
  // Used to sanitize safeBins execution while preserving the original user input.
  execCommand?: string;
  workdir: string;
  env: Record<string, string>;
  /** Host-selected managed profile; never inferred from the requested environment. */
  githubProfileDir?: string;
  pathPrepend?: string[];
  sandbox?: BashSandboxConfig;
  containerWorkdir?: string | null;
  usePty: boolean;
  warnings: string[];
  maxOutput: number;
  pendingMaxOutput: number;
  notifyOnExit: boolean;
  notifyOnExitEmptySuccess?: boolean;
  scopeKey?: string;
  sessionKey?: string;
  agentId?: string;
  /** `session.mainKey` from the runtime config; snapshotted onto the
   *  ProcessSession so background-exit notifications can remap cron-run
   *  keys without an ambient config load. Long-running background exits use
   *  this start-time value even if config changes while the process runs. */
  mainKey?: string;
  /** `session.scope` from the runtime config; snapshotted alongside
   *  `mainKey` so the cron-run remap can route global-scope agents to
   *  the "global" queue instead of agent-main. */
  sessionScope?: "per-sender" | "global";
  /** Start-time routing policy for detached exec system events. */
  eventRouting?: EventSessionRoutingPolicy;
  notifyDeliveryContext?: DeliveryContext;
  timeoutSec: number | null;
  /** Whether exec may return a supervised session for later continuation. */
  processContinuationAvailable?: boolean;
  /** Cancels startup only; background process lifetime belongs to the supervisor. */
  startupSignal?: AbortSignal;
  onUpdate?: (partialResult: AgentToolResult<ExecToolDetails>) => void;
  /** Runs after process finalization and before the exit wake is queued. */
  onSettledBeforeNotify?: (outcome: ExecProcessOutcome) => void;
  /** Revalidates authorization after async preparation, immediately before each spawn attempt. */
  beforeSpawn?: () => Promise<AgentToolResult<ExecToolDetails> | undefined>;
}): Promise<ExecProcessHandle> {
  const startedAt = Date.now();
  const sessionId = createSessionSlug(isProcessSessionIdTaken);
  const execCommand = opts.execCommand ?? opts.command;
  const diagnosticTarget = opts.sandbox ? "sandbox" : "host";
  const supervisor = getProcessSupervisor();
  const shellRuntimeEnv: Record<string, string> = {
    ...opts.env,
    OPENCLAW_SHELL: "exec",
  };

  const session: ProcessSession = {
    id: sessionId,
    command: opts.command,
    scopeKey: opts.scopeKey,
    sessionKey: opts.sessionKey,
    agentId: opts.agentId,
    mainKey: opts.mainKey,
    sessionScope: opts.sessionScope,
    eventRouting: opts.eventRouting,
    notifyDeliveryContext: normalizeDeliveryContext(opts.notifyDeliveryContext),
    notifyOnExit: opts.notifyOnExit,
    notifyOnExitEmptySuccess: opts.notifyOnExitEmptySuccess === true,
    exitNotified: false,
    stdin: undefined,
    pid: undefined,
    startedAt,
    cwd: opts.workdir,
    maxOutputChars: opts.maxOutput,
    pendingMaxOutputChars: opts.pendingMaxOutput,
    totalOutputChars: 0,
    pendingOutput: [],
    pendingStdoutChars: 0,
    pendingStderrChars: 0,
    pendingOutputDropped: false,
    aggregated: "",
    tail: "",
    exited: false,
    exitCode: undefined as number | null | undefined,
    exitSignal: undefined as NodeJS.Signals | number | null | undefined,
    truncated: false,
    backgrounded: false,
    cursorKeyMode: opts.usePty ? "unknown" : "normal",
  };
  withoutGatewayToolCallerIdentity(() => addSession(session));

  // Foreground delivery keeps its caller context only until yield, abort, or exit.
  // Clearing the callback also releases the completed turn's captured authority.
  let onUpdate = initialOnUpdate && AsyncLocalStorage.bind(initialOnUpdate);
  let startupSignal = initialStartupSignal;
  let beforeSpawn = initialBeforeSpawn;
  let onSettledBeforeNotify = initialOnSettledBeforeNotify;

  const emitUpdate = () => {
    if (!onUpdate || session.backgrounded || session.exited) {
      return;
    }
    const tailText = session.tail || session.aggregated;
    onUpdate({
      content: [
        { type: "text", text: renderExecUpdateText({ tailText, warnings: opts.warnings }) },
      ],
      details: {
        status: "running",
        sessionId,
        pid: session.pid ?? undefined,
        startedAt,
        cwd: session.cwd,
        tail: session.tail,
      },
    });
  };

  // One parser per stream so ESC sequences split across chunks are not mangled.
  const sanitizeStdout = createStreamingBinaryOutputSanitizer();
  const sanitizeStderr = createStreamingBinaryOutputSanitizer();

  const handleStdout = (data: string) => {
    const raw = data;
    // Detect smkx/rmkx BEFORE the sanitizer strips ESC sequences.
    // Note: PTY chunking is arbitrary, but smkx/rmkx sequences are typically short (4-5 bytes)
    // and sent atomically by terminals. Split across chunks is rare in practice.
    const mode = detectCursorKeyMode(raw);
    if (mode) {
      session.cursorKeyMode = mode;
    }
    const str = sanitizeStdout(raw);
    for (const chunk of chunkString(str)) {
      appendOutput(session, "stdout", chunk);
      emitUpdate();
    }
  };

  const handleStderr = (data: string) => {
    const str = sanitizeStderr(data);
    for (const chunk of chunkString(str)) {
      appendOutput(session, "stderr", chunk);
      emitUpdate();
    }
  };

  const timeoutMs = resolveExecTimeoutMs(opts.timeoutSec);
  let sandboxFinalizeToken: unknown;
  let sandboxPrepared = false;
  let sandboxFinalized = false;
  const finalizeSandboxExec = async (params: {
    status: "completed" | "failed";
    exitCode: number | null;
    timedOut: boolean;
  }) => {
    if (!sandboxPrepared || sandboxFinalized || !opts.sandbox?.finalizeExec) {
      return;
    }
    sandboxFinalized = true;
    await opts.sandbox.finalizeExec({
      ...params,
      token: sandboxFinalizeToken,
    });
  };
  const finalizeAndSettleSession = async (
    outcome: ExecProcessOutcome,
  ): Promise<ExecProcessOutcome> => {
    let finalOutcome = outcome;
    session.finalizing = true;
    try {
      await finalizeSandboxExec({
        status: outcome.status,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
      });
    } catch (error) {
      if (outcome.status === "completed") {
        finalOutcome = buildExecRuntimeErrorOutcome({
          error,
          aggregated: session.aggregated.trim(),
          durationMs: Date.now() - startedAt,
        });
        // Background observers need the finalizer failure in the same bounded, redacted output.
        appendOutput(session, "stderr", `\n${redactToolPayloadText(formatErrorMessage(error))}\n`);
      } else {
        logWarn(`exec: sandbox finalize after process failure failed (${String(error)}).`);
      }
    } finally {
      // Finalization can release remote process/session resources. Keep the
      // background-work blocker until that owner transition has settled.
      session.finalizing = false;
      try {
        const shouldNotify = !session.exited;
        if (shouldNotify) {
          markExited(
            session,
            finalOutcome.exitCode,
            finalOutcome.exitSignal,
            finalOutcome.status,
            finalOutcome.exitReason,
            finalOutcome.noOutputTimedOut,
          );
        }
        onSettledBeforeNotify?.(finalOutcome);
        if (shouldNotify) {
          maybeNotifyOnExit(session, finalOutcome.status);
        }
      } catch (error) {
        // Recover before yielding: scope joins queued by markExited must not
        // outrun the task's failed outcome or restore its environment state.
        finalOutcome = buildExecRuntimeErrorOutcome({
          error,
          aggregated: session.aggregated.trim(),
          durationMs: Date.now() - startedAt,
        });
        onSettledBeforeNotify?.(finalOutcome);
      } finally {
        // Notifications need start-time routing, but completed logs must not
        // retain it, including when a task callback or notification throws.
        delete session.sessionKey;
        delete session.agentId;
        delete session.mainKey;
        delete session.sessionScope;
        delete session.eventRouting;
        delete session.notifyDeliveryContext;
        delete session.notifyOnExit;
        delete session.notifyOnExitEmptySuccess;
      }
    }
    return finalOutcome;
  };

  const prepareSpawnSpec = async () => {
    if (opts.sandbox) {
      if (!opts.sandbox.buildExecSpec) {
        throw new Error("sandbox backend does not provide buildExecSpec");
      }
      const backendExecSpec = await opts.sandbox.buildExecSpec({
        command: execCommand,
        workdir: opts.containerWorkdir ?? opts.sandbox.containerWorkdir,
        env: shellRuntimeEnv,
        usePty: opts.usePty,
      });
      sandboxFinalizeToken = backendExecSpec.finalizeToken;
      // Cleanup ownership transfers only after buildExecSpec resolves: moving this earlier can
      // double-finalize backend failures, while removing it leaks the registered exec session.
      sandboxPrepared = true;
      return {
        mode: "child" as const,
        argv: backendExecSpec.argv,
        env: backendExecSpec.env,
        stdinMode: backendExecSpec.stdinMode,
      };
    }
    const { shell, args: shellArgs } = getShellConfig();

    // Wrap the command to enforce PATH prepend precedence over shell RC overrides.
    const commandWithPathPrepend = wrapPosixCommandWithPathPrepend(
      execCommand,
      shellRuntimeEnv,
      opts.pathPrepend,
    );
    const commandWithShellSnapshot = await maybeWrapCommandWithShellSnapshot({
      command: commandWithPathPrepend,
      shell,
      shellArgs,
      cwd: opts.workdir,
      env: shellRuntimeEnv,
    });

    const shellArgv = [shell, ...shellArgs, commandWithShellSnapshot];
    const argv = opts.githubProfileDir
      ? buildGitHubExecLaunchArgv(shellArgv, opts.githubProfileDir)
      : shellArgv;
    return {
      mode: opts.usePty ? ("pty" as const) : ("child" as const),
      argv,
      env: shellRuntimeEnv,
      stdinMode: opts.usePty ? ("pipe-open" as const) : ("pipe-closed" as const),
    };
  };

  let managedRun: ManagedRun | null = null;
  let usingPty = opts.usePty && !opts.sandbox;
  const cursorResponse = buildCursorPositionResponse();

  const onSupervisorStdout = (chunk: string) => {
    if (usingPty) {
      const { cleaned, requests } = stripDsrRequests(chunk);
      if (requests > 0 && managedRun?.stdin) {
        for (let i = 0; i < requests; i += 1) {
          managedRun.stdin.write(cursorResponse);
        }
      }
      handleStdout(cleaned);
      return;
    }
    handleStdout(chunk);
  };

  const assertPreSpawnAuthorized = async () => {
    startupSignal?.throwIfAborted();
    const denied = await beforeSpawn?.();
    startupSignal?.throwIfAborted();
    if (denied) {
      throw new ExecProcessPreflightError(denied);
    }
  };
  const spawn = (input: SpawnInput) => {
    // No await between the final cancellation check and supervisor admission.
    startupSignal?.throwIfAborted();
    return withoutGatewayToolCallerIdentity(() => supervisor.spawn(input));
  };

  try {
    startupSignal?.throwIfAborted();
    const spawnSpec = await prepareSpawnSpec();
    usingPty = spawnSpec.mode === "pty";
    const spawnBase = {
      runId: sessionId,
      sessionId: opts.sessionKey?.trim() || sessionId,
      backendId: opts.sandbox ? "exec-sandbox" : "exec-host",
      scopeKey: opts.scopeKey,
      cwd: opts.workdir,
      env: spawnSpec.env,
      timeoutMs,
      captureOutput: false,
      onStdout: onSupervisorStdout,
      onStderr: handleStderr,
    };
    await assertPreSpawnAuthorized();
    if (spawnSpec.mode === "pty") {
      try {
        managedRun = await spawn({
          ...spawnBase,
          mode: "pty",
          argv: spawnSpec.argv,
        });
      } catch (err) {
        startupSignal?.throwIfAborted();
        const warning = `Warning: PTY spawn failed (${String(err)}); retrying without PTY for \`${opts.command}\`.`;
        logWarn(
          `exec: PTY spawn failed (${String(err)}); retrying without PTY for "${opts.command}".`,
        );
        opts.warnings.push(warning);
        usingPty = false;
        await assertPreSpawnAuthorized();
      }
    }
    if (!managedRun) {
      managedRun = await spawn({
        ...spawnBase,
        mode: "child",
        argv: spawnSpec.argv,
        stdinMode: spawnSpec.stdinMode,
      });
    }
  } catch (error) {
    onUpdate = undefined;
    const outcome = await finalizeAndSettleSession(
      buildExecRuntimeErrorOutcome({
        error,
        aggregated: session.aggregated.trim(),
        durationMs: Date.now() - startedAt,
      }),
    ).finally(() => {
      onSettledBeforeNotify = undefined;
    });
    emitExecProcessCompleted({
      command: opts.command,
      mode: usingPty ? "pty" : "child",
      outcome,
      sessionKey: opts.sessionKey,
      target: diagnosticTarget,
    });
    throw error;
  } finally {
    startupSignal = undefined;
    beforeSpawn = undefined;
  }
  session.stdin = managedRun.stdin;
  session.pid = managedRun.pid;

  const startedRun = managedRun;
  const promise = withoutGatewayToolCallerIdentity(async (): Promise<ExecProcessOutcome> => {
    try {
      let outcome: ExecProcessOutcome;
      try {
        const exit = await startedRun.wait();
        outcome = buildExecExitOutcome({
          exit,
          aggregated: session.aggregated.trim(),
          durationMs: Date.now() - startedAt,
          timeoutSec: opts.timeoutSec,
          processContinuationAvailable: opts.processContinuationAvailable !== false,
        });
      } catch (error) {
        outcome = buildExecRuntimeErrorOutcome({
          error,
          aggregated: session.aggregated.trim(),
          durationMs: Date.now() - startedAt,
        });
      } finally {
        // Release foreground delivery before finalization marks the record exited.
        onUpdate = undefined;
      }
      const finalOutcome = await finalizeAndSettleSession(outcome);
      emitExecProcessCompleted({
        command: opts.command,
        mode: usingPty ? "pty" : "child",
        outcome: finalOutcome,
        sessionKey: opts.sessionKey,
        target: diagnosticTarget,
      });
      return finalOutcome;
    } finally {
      onSettledBeforeNotify = undefined;
    }
  });

  return {
    session,
    startedAt,
    pid: session.pid ?? undefined,
    promise,
    kill: () => {
      managedRun?.cancel("manual-cancel");
    },
    disableUpdates: () => {
      onUpdate = undefined;
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
