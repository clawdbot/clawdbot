import crypto from "node:crypto";
import { stripSystemPromptCacheBoundary } from "@openclaw/ai/internal/shared";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatErrorMessage } from "../../infra/errors.js";
import type {
  CliOutput,
  CliStreamingDelta,
  CliThinkingDelta,
  CliThinkingProgress,
  CliToolResultDelta,
  CliToolUseStartDelta,
  CliUsage,
} from "../cli-output-contracts.js";
import { resolveExecDefaults } from "../exec-defaults.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import { prepareCliBundleMcpCaptureAttempt } from "./bundle-mcp.js";
import { LIVE_SESSION_LIMITS, resolveClaudeLiveMode } from "./claude-live-session-policy.js";
import {
  requestClaudeNativeToolApproval,
  resolveClaudeNativeToolApprovalPlan,
} from "./claude-live-tool-approval.js";
import { resetClaudeNoOutputTimer } from "./claude-live-turn-timeouts.js";
import {
  acceptClaudeExit,
  acceptClaudeStdout,
  createClaudeOutputLimitError,
  createClaudeTurn,
  failClaudeTurn,
  markClaudeLiveToolDenied,
  type ClaudeLiveExecPermission,
  type ClaudeLiveToolTerminalOutcome,
  type ClaudeLiveTurn,
  type ClaudeLiveTurnHost,
} from "./claude-live-turn.js";
import { cliBackendLog } from "./log.js";
import type { PreparedCliRunContext } from "./types.js";

type ProcessSupervisor = ReturnType<
  typeof import("../../process/supervisor/index.js").getProcessSupervisor
>;
type ManagedRun = Awaited<ReturnType<ProcessSupervisor["spawn"]>>;

type ClaudeLivePendingControlRequest = {
  requestId: string;
  timer: NodeJS.Timeout;
  resolve: (response: ClaudeLiveControlResponse | null) => void;
};
type ClaudeLiveControlResponse = { subtype: string; error?: string };

const CLAUDE_LIVE_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;
const CLAUDE_LIVE_CONTROL_TIMEOUT_MS = 3_000;
const CLAUDE_LIVE_CLOSE_WAIT_TIMEOUT_MS = 5_000;
const CLAUDE_LIVE_SYSTEM_PROMPT_PROBE_ERROR =
  "set_model: system_prompt must be a non-empty string when present";

export type ClaudeLiveProcess = ClaudeLiveTurnHost & {
  key: string;
  generation: string;
  fingerprint: string;
  systemPromptHash: string;
  systemPromptSwitchCapability: "unknown" | "supported" | "unsupported";
  liveSessionRequirement?: import("../../plugins/cli-backend.types.js").CliBackendLiveSessionRequirement;
  managedRun: ManagedRun;
  sessionId?: string;
  idleTimer: NodeJS.Timeout | null;
  cleanup: () => Promise<void>;
  cleanupPromise: Promise<void> | null;
  pendingControlRequest: ClaudeLivePendingControlRequest | null;
  mcpCaptureKey?: string;
  nativeToolApprovalGrants: Set<string>;
  isIdle(): boolean;
  waitForExit(): Promise<void>;
  cleanupResources(): Promise<void>;
};

type BeginClaudeTurnParams = {
  context: PreparedCliRunContext;
  inputUuid: string;
  useResume: boolean;
  execPermission: ClaudeLiveExecPermission;
  onAssistantDelta: (delta: CliStreamingDelta) => void;
  onThinkingDelta?: (delta: CliThinkingDelta) => void;
  onThinkingProgress?: (progress: CliThinkingProgress) => void;
  onToolUseStart?: (delta: CliToolUseStartDelta) => void;
  onToolUseUpdate?: (delta: CliToolUseStartDelta) => void;
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
};

function settlePendingControlRequest(
  session: ClaudeLiveProcess,
  response: ClaudeLiveControlResponse | null,
): void {
  const pending = session.pendingControlRequest;
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  session.pendingControlRequest = null;
  pending.resolve(response);
}

function cleanupProcess(session: ClaudeLiveProcess): Promise<void> {
  if (!session.cleanupPromise) {
    session.cleanupPromise = session.cleanup().catch((error: unknown) => {
      cliBackendLog.warn(`Claude live session cleanup failed: ${formatErrorMessage(error)}`);
    });
  }
  return session.cleanupPromise;
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

function writeControlResponse(session: ClaudeLiveProcess, response: unknown): void {
  const stdin = session.managedRun.stdin;
  if (!stdin) {
    throw new Error("Claude CLI live session stdin is unavailable");
  }
  stdin.write(`${JSON.stringify(response)}\n`);
}

function acceptControlResponse(
  session: ClaudeLiveProcess,
  parsed: Record<string, unknown>,
): boolean {
  const pending = session.pendingControlRequest;
  if (!pending || parsed.type !== "control_response" || !isRecord(parsed.response)) {
    return false;
  }
  const response = parsed.response;
  if (response.request_id !== pending.requestId) {
    return false;
  }
  settlePendingControlRequest(session, {
    subtype: typeof response.subtype === "string" ? response.subtype : "",
    ...(typeof response.error === "string" ? { error: response.error } : {}),
  });
  return true;
}

function writeToolControlResponse(params: {
  session: ClaudeLiveProcess;
  requestId: string;
  toolUseId?: string;
  toolInput: Record<string, unknown>;
  decision: { behavior: "allow" } | { behavior: "deny"; message: string };
}): void {
  writeControlResponse(params.session, {
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

function markControlToolDenied(params: {
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

function acceptControlRequest(
  session: ClaudeLiveProcess,
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
    writeToolControlResponse({
      session,
      requestId,
      toolUseId,
      toolInput,
      decision: { behavior: "allow" },
    });
    return;
  }
  if (plan === "deny") {
    markControlToolDenied({ turn, toolUseId, toolName, toolInput });
    writeToolControlResponse({
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
      cwd: turn.cwd,
      abortSignal: turn.abortSignal,
      ask: turn.execPermission.ask,
    });
    const runAborted = turn.abortSignal?.aborted === true;
    const allowed = !runAborted && outcome.kind === "allow";
    if (!runAborted && outcome.kind === "allow" && outcome.grantAlways) {
      session.nativeToolApprovalGrants.add(toolName);
    }
    if (!allowed) {
      markControlToolDenied({ turn, toolUseId, toolName, toolInput });
    }
    if (session.closing || !session.managedRun.stdin) {
      return;
    }
    try {
      writeToolControlResponse({
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
                  : outcome.kind === "deny" && outcome.reason === "operand-binding"
                    ? (outcome.message ??
                      "OpenClaw denied Claude native tool use (Bash): the command could not be bound to stable script bytes.")
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

function acceptSessionRequirement(
  session: ClaudeLiveProcess,
  parsed: Record<string, unknown>,
): boolean {
  const requirement = session.liveSessionRequirement;
  if (!requirement || parsed.type !== "system" || parsed.subtype !== "init") {
    return true;
  }
  const capabilities = Array.isArray(parsed.capabilities)
    ? parsed.capabilities.filter((value): value is string => typeof value === "string")
    : [];
  if (capabilities.includes(requirement.capability)) {
    session.liveSessionCapabilityReady = true;
    return true;
  }
  const version =
    typeof parsed.claude_code_version === "string"
      ? parsed.claude_code_version.trim() || undefined
      : undefined;
  const versionDetail = version ? ` (version ${version})` : "";
  session.close(
    "abort",
    new FailoverError(
      `The running Claude Code build${versionDetail} did not advertise the required ${requirement.capability} capability. Claude Code ${requirement.minimumVersion} is the first known compatible release. Run \`${requirement.updateCommand}\`, restart OpenClaw, and retry.`,
      {
        reason: "format",
        provider: session.providerId,
        model: session.modelId,
        status: resolveFailoverStatus("format"),
        code: "cli_live_session_unsupported",
      },
    ),
  );
  return false;
}

function requestModelUpdate(params: {
  session: ClaudeLiveProcess;
  model: string;
  systemPrompt: string;
}): Promise<ClaudeLiveControlResponse | null> {
  if (params.session.pendingControlRequest) {
    return Promise.resolve(null);
  }
  const requestId = crypto.randomUUID();
  const response = new Promise<ClaudeLiveControlResponse | null>((resolve) => {
    params.session.pendingControlRequest = {
      requestId,
      timer: setTimeout(
        () => settlePendingControlRequest(params.session, null),
        CLAUDE_LIVE_CONTROL_TIMEOUT_MS,
      ),
      resolve,
    };
  });
  return writeClaudeInput(
    params.session,
    `${JSON.stringify({
      type: "control_request",
      request_id: requestId,
      request: { subtype: "set_model", model: params.model, system_prompt: params.systemPrompt },
    })}\n`,
  )
    .catch(() => settlePendingControlRequest(params.session, null))
    .then(() => response);
}

async function supportsSystemPromptSwitch(
  session: ClaudeLiveProcess,
  model: string,
): Promise<boolean> {
  if (session.systemPromptSwitchCapability !== "unknown") {
    return session.systemPromptSwitchCapability === "supported";
  }
  const response = await requestModelUpdate({ session, model, systemPrompt: "" });
  const supported =
    response?.subtype === "error" && response.error === CLAUDE_LIVE_SYSTEM_PROMPT_PROBE_ERROR;
  session.systemPromptSwitchCapability = supported ? "supported" : "unsupported";
  return supported;
}

export async function refreshClaudePrompt(params: {
  session: ClaudeLiveProcess;
  context: PreparedCliRunContext;
  systemPromptHash: string;
}): Promise<boolean> {
  if (params.session.systemPromptHash === params.systemPromptHash) {
    return true;
  }
  const systemPrompt = stripSystemPromptCacheBoundary(params.context.systemPrompt);
  if (
    !systemPrompt.trim() ||
    !(await supportsSystemPromptSwitch(params.session, params.context.normalizedModel))
  ) {
    params.session.close("restart");
    return false;
  }
  const response = await requestModelUpdate({
    session: params.session,
    model: params.context.normalizedModel,
    systemPrompt,
  });
  if (response?.subtype === "success") {
    params.session.systemPromptHash = params.systemPromptHash;
    return true;
  }
  params.session.close("restart");
  return false;
}

export function resolveClaudeLiveExecPermission(
  context: PreparedCliRunContext,
): ClaudeLiveExecPermission {
  const { security, ask } = resolveExecDefaults({
    cfg: context.params.config,
    sessionEntry: context.params.sessionEntry,
    execOverrides: context.params.execOverrides,
    agentId: context.params.agentId,
    sessionKey: context.params.runtimePolicySessionKey ?? context.params.sessionKey,
  });
  return {
    security,
    ask,
    permissionMode: resolveClaudeLiveMode(security, ask, process.getuid?.()),
  };
}

export async function spawnClaudeProcess(params: {
  context: PreparedCliRunContext;
  argv: string[];
  env: Record<string, string>;
  generation: string;
  fingerprint: string;
  systemPromptHash: string;
  key: string;
  mcpCaptureKey?: string;
  noOutputTimeoutMs: number;
  supervisor: ProcessSupervisor;
  cleanup: () => Promise<void>;
  onSpawned: (session: ClaudeLiveProcess) => void;
  onClosed: (session: ClaudeLiveProcess) => void;
}): Promise<ClaudeLiveProcess> {
  let session: ClaudeLiveProcess | null = null;
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
          acceptClaudeStdout(session, chunk);
        }
      },
      onStderr: (chunk) => {
        if (!session) {
          return;
        }
        session.currentTurn?.onCliOutput?.(chunk, "stderr");
        if (session.currentTurn && chunk.trim()) {
          session.currentTurn.hasReplayUnsafeActivity = true;
        }
        session.stderr += chunk;
        if (session.stderr.length > LIVE_SESSION_LIMITS.maxStderrChars) {
          session.close(
            "abort",
            createClaudeOutputLimitError(session, "Claude CLI stderr exceeded limit."),
          );
          return;
        }
        resetClaudeNoOutputTimer(session, session.currentTurn);
      },
    });
  } catch (error) {
    await mcpCaptureAttempt.cleanup?.();
    throw error;
  }
  session = {
    backend: params.context.preparedBackend.backend,
    key: params.key,
    generation: params.generation,
    fingerprint: params.fingerprint,
    systemPromptHash: params.systemPromptHash,
    systemPromptSwitchCapability: "unknown",
    liveSessionRequirement: params.context.backendResolved.liveSessionRequirement,
    liveSessionCapabilityReady: !params.context.backendResolved.liveSessionRequirement,
    managedRun,
    providerId: params.context.params.provider,
    modelId: params.context.modelId,
    noOutputTimeoutMs: params.noOutputTimeoutMs,
    stderr: "",
    stdoutBuffer: { pending: "" },
    currentTurn: null,
    idleTimer: null,
    cleanup: async () => {
      await mcpCaptureAttempt.cleanup?.();
      await params.cleanup();
    },
    cleanupPromise: null,
    closing: false,
    pendingControlRequest: null,
    mcpCaptureKey: params.mcpCaptureKey,
    nativeToolApprovalGrants: new Set(),
    outstandingBackgroundTaskIds: new Set(),
    isIdle() {
      return this.currentTurn === null;
    },
    close(reason, error) {
      if (session?.closing) {
        return;
      }
      cliBackendLog.info(
        `claude live session close: provider=${this.providerId} model=${this.modelId} reason=${reason}`,
      );
      this.closing = true;
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
      params.onClosed(this);
      settlePendingControlRequest(this, null);
      if (error) {
        failClaudeTurn(this, error);
      } else {
        this.outstandingBackgroundTaskIds.clear();
      }
      this.managedRun.cancel("manual-cancel");
      void cleanupProcess(this);
    },
    scheduleIdleClose() {
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
      }
      this.idleTimer = setTimeout(() => {
        if (!this.currentTurn) {
          this.close("idle");
        }
      }, CLAUDE_LIVE_IDLE_TIMEOUT_MS);
    },
    acceptControlResponse(parsed) {
      return acceptControlResponse(this, parsed);
    },
    acceptControlRequest(turn, parsed) {
      acceptControlRequest(this, turn, parsed);
    },
    acceptSessionRequirement(parsed) {
      return acceptSessionRequirement(this, parsed);
    },
    acceptSessionId(sessionId) {
      this.sessionId = sessionId;
    },
    settleControlRequest() {
      settlePendingControlRequest(this, null);
    },
    cleanupAfterExit() {
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
      params.onClosed(this);
      void cleanupProcess(this);
    },
    waitForExit() {
      return waitForManagedRunExit(this.managedRun);
    },
    cleanupResources() {
      return cleanupProcess(this);
    },
  };
  params.onSpawned(session);
  void managedRun.wait().then(
    (exit) => {
      if (session) {
        acceptClaudeExit(session, exit.exitCode);
      }
    },
    (error: unknown) => {
      if (session) {
        session.close("abort", error);
      }
    },
  );
  return session;
}

export function beginClaudeTurn(
  session: ClaudeLiveProcess,
  params: BeginClaudeTurnParams,
): Promise<CliOutput> {
  return new Promise<CliOutput>((resolve, reject) => {
    session.currentTurn = createClaudeTurn({ ...params, host: session, resolve, reject });
  });
}

export function abortClaudeTurn(session: ClaudeLiveProcess, error: Error): void {
  if (session.currentTurn) {
    session.close("abort", error);
  }
}

export function createClaudeUserInputMessage(content: string, uuid: string): string {
  return `${JSON.stringify({
    type: "user",
    uuid,
    session_id: "",
    parent_tool_use_id: null,
    message: { role: "user", content },
  })}\n`;
}

export async function writeClaudeInput(session: ClaudeLiveProcess, payload: string): Promise<void> {
  const stdin = session.managedRun.stdin;
  if (!stdin) {
    throw new Error("Claude CLI live session stdin is unavailable");
  }
  await new Promise<void>((resolve, reject) => {
    stdin.write(payload, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
