import crypto from "node:crypto";
import type { ReplyBackendHandle } from "../../auto-reply/reply/reply-run-registry.js";
import type { CliBackendConfig } from "../../config/types.js";
import {
  createCliJsonlStreamingParser,
  extractCliErrorMessage,
  parseCliOutput,
  type CliOutput,
  type CliStreamingDelta,
} from "../cli-output.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import { classifyFailoverReason } from "../pi-embedded-helpers.js";
import { cliBackendLog } from "./log.js";
import type { PreparedCliRunContext } from "./types.js";

type ProcessSupervisor = ReturnType<
  typeof import("../../process/supervisor/index.js").getProcessSupervisor
>;
type ManagedRun = Awaited<ReturnType<ProcessSupervisor["spawn"]>>;
type ClaudeLiveTurn = {
  backend: CliBackendConfig;
  outputLimits: ClaudeLiveOutputLimits;
  startedAtMs: number;
  rawLines: string[];
  rawChars: number;
  sessionId?: string;
  noOutputTimer: NodeJS.Timeout | null;
  timeoutTimer: NodeJS.Timeout | null;
  streamingParser: ReturnType<typeof createCliJsonlStreamingParser>;
  resolve: (output: CliOutput) => void;
  reject: (error: unknown) => void;
};
type ClaudeLiveSession = {
  key: string;
  fingerprint: string;
  managedRun: ManagedRun;
  providerId: string;
  modelId: string;
  noOutputTimeoutMs: number;
  stderr: string;
  stdoutBuffer: string;
  currentTurn: ClaudeLiveTurn | null;
  drainTimer: NodeJS.Timeout | null;
  drainingAbortedTurn: boolean;
  idleTimer: NodeJS.Timeout | null;
  cleanup: () => Promise<void>;
  cleanupDone: boolean;
  closing: boolean;
};
type ClaudeLiveRunResult = {
  output: CliOutput;
};
type ClaudeLiveOutputLimits = {
  maxTurnRawChars: number;
  maxPendingLineChars: number;
  maxTurnLines: number;
};

const CLAUDE_LIVE_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;
const CLAUDE_LIVE_MAX_SESSIONS = 16;
const CLAUDE_LIVE_MAX_STDERR_CHARS = 64 * 1024;
const CLAUDE_LIVE_DEFAULT_MAX_TURN_RAW_CHARS = 8 * 1024 * 1024;
const CLAUDE_LIVE_MIN_TURN_RAW_CHARS = 1_024;
const CLAUDE_LIVE_MAX_CONFIGURABLE_TURN_RAW_CHARS = 64 * 1024 * 1024;
const CLAUDE_LIVE_DEFAULT_MAX_TURN_LINES = 20_000;
const CLAUDE_LIVE_MIN_TURN_LINES = 100;
const CLAUDE_LIVE_MAX_CONFIGURABLE_TURN_LINES = 100_000;
const CLAUDE_LIVE_CLOSE_WAIT_TIMEOUT_MS = 5_000;
const liveSessions = new Map<string, ClaudeLiveSession>();
const liveSessionCreates = new Map<string, Promise<ClaudeLiveSession>>();

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function resetClaudeLiveSessionsForTest(): void {
  for (const session of liveSessions.values()) {
    closeLiveSession(session, "restart");
  }
  liveSessions.clear();
  liveSessionCreates.clear();
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

export function shouldUseClaudeLiveSession(context: PreparedCliRunContext): boolean {
  return (
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
      backend.sessionArg,
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

export function buildClaudeLiveArgs(params: {
  args: string[];
  backend: CliBackendConfig;
  systemPrompt: string;
  useResume: boolean;
}): string[] {
  return appendArg(
    upsertArgValue(
      upsertArgValue(
        upsertArgValue(
          stripLiveProcessArgs(params.args, params.backend, params.useResume),
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
}

function buildClaudeLiveKey(context: PreparedCliRunContext): string {
  return `${context.backendResolved.id}:${sha256(
    JSON.stringify({
      agentAccountId: context.params.agentAccountId,
      agentId: context.params.agentId,
      authProfileId: context.effectiveAuthProfileId,
      sessionId: context.params.sessionId,
      sessionKey: context.params.sessionKey,
    }),
  )}`;
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
      params.context.preparedBackend.backend.sessionArg,
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
    command: params.context.preparedBackend.backend.command,
    workspaceDirHash: sha256(params.context.workspaceDir),
    provider: params.context.params.provider,
    model: params.context.normalizedModel,
    systemPromptHash: sha256(params.context.systemPrompt),
    authProfileIdHash: params.context.effectiveAuthProfileId
      ? sha256(params.context.effectiveAuthProfileId)
      : undefined,
    authEpochHash: params.context.authEpoch ? sha256(params.context.authEpoch) : undefined,
    extraSystemPromptHash: params.context.extraSystemPromptHash,
    mcpConfigHash: params.context.preparedBackend.mcpConfigHash,
    skillsFingerprint,
    argv: stableArgv,
    env: Object.keys(params.env)
      .toSorted()
      .map((key) => [key, params.env[key] ? sha256(params.env[key]) : ""]),
  });
}

function createAbortError(): Error {
  const error = new Error("CLI run aborted");
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
}

function clearDrainTimer(session: ClaudeLiveSession): void {
  if (session.drainTimer) {
    clearTimeout(session.drainTimer);
    session.drainTimer = null;
  }
}

function finishTurn(session: ClaudeLiveSession, output: CliOutput): void {
  const turn = session.currentTurn;
  if (!turn) {
    return;
  }
  cliBackendLog.info(
    `claude live session turn: provider=${session.providerId} model=${session.modelId} durationMs=${Date.now() - turn.startedAtMs} rawLines=${turn.rawLines.length}`,
  );
  clearTurnTimers(turn);
  turn.streamingParser.finish();
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
  clearTurnTimers(turn);
  turn.streamingParser.finish();
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

function cleanupLiveSession(session: ClaudeLiveSession): void {
  if (session.cleanupDone) {
    return;
  }
  session.cleanupDone = true;
  void session.cleanup();
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
  clearDrainTimer(session);
  if (liveSessions.get(session.key) === session) {
    liveSessions.delete(session.key);
  }
  if (error) {
    failTurn(session, error);
  }
  session.managedRun.cancel("manual-cancel");
  cleanupLiveSession(session);
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

function createTimeoutError(session: ClaudeLiveSession, message: string): FailoverError {
  return new FailoverError(message, {
    reason: "timeout",
    provider: session.providerId,
    model: session.modelId,
    status: resolveFailoverStatus("timeout"),
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

function resetNoOutputTimer(session: ClaudeLiveSession): void {
  const turn = session.currentTurn;
  if (!turn) {
    return;
  }
  if (turn.noOutputTimer) {
    clearTimeout(turn.noOutputTimer);
  }
  turn.noOutputTimer = setTimeout(() => {
    closeLiveSession(
      session,
      "abort",
      createTimeoutError(
        session,
        `CLI produced no output for ${Math.round(session.noOutputTimeoutMs / 1000)}s and was terminated.`,
      ),
    );
  }, session.noOutputTimeoutMs);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizePositiveInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
}

function resolveClaudeLiveOutputLimits(backend: CliBackendConfig): ClaudeLiveOutputLimits {
  const configured = backend.reliability?.outputLimits;
  const maxTurnRawChars = normalizePositiveInt(
    configured?.maxTurnRawChars,
    CLAUDE_LIVE_DEFAULT_MAX_TURN_RAW_CHARS,
    CLAUDE_LIVE_MIN_TURN_RAW_CHARS,
    CLAUDE_LIVE_MAX_CONFIGURABLE_TURN_RAW_CHARS,
  );
  return {
    maxTurnRawChars,
    maxPendingLineChars: maxTurnRawChars,
    maxTurnLines: normalizePositiveInt(
      configured?.maxTurnLines,
      CLAUDE_LIVE_DEFAULT_MAX_TURN_LINES,
      CLAUDE_LIVE_MIN_TURN_LINES,
      CLAUDE_LIVE_MAX_CONFIGURABLE_TURN_LINES,
    ),
  };
}

function parseClaudeLiveJsonLine(
  session: ClaudeLiveSession,
  trimmed: string,
): Record<string, unknown> | null {
  const maxPendingLineChars =
    session.currentTurn?.outputLimits.maxPendingLineChars ?? CLAUDE_LIVE_DEFAULT_MAX_TURN_RAW_CHARS;
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

function createResultError(
  session: ClaudeLiveSession,
  parsed: Record<string, unknown>,
  raw: string,
): FailoverError {
  const result = typeof parsed.result === "string" ? parsed.result.trim() : "";
  const message = extractCliErrorMessage(raw) ?? (result || "Claude CLI failed.");
  const reason = classifyFailoverReason(message, { provider: session.providerId }) ?? "unknown";
  return new FailoverError(message, {
    reason,
    provider: session.providerId,
    model: session.modelId,
    status: resolveFailoverStatus(reason),
  });
}

function handleClaudeLiveLine(session: ClaudeLiveSession, line: string): void {
  const turn = session.currentTurn;
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  const parsed = parseClaudeLiveJsonLine(session, trimmed);
  if (!parsed) {
    return;
  }
  if (session.drainingAbortedTurn) {
    if (parsed.type === "result") {
      const turnToClear = session.currentTurn;
      if (turnToClear) {
        clearTurnTimers(turnToClear);
        session.currentTurn = null;
      }
      session.drainingAbortedTurn = false;
      clearDrainTimer(session);
      scheduleIdleClose(session);
    }
    return;
  }
  if (!turn) {
    return;
  }
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
  turn.streamingParser.push(`${trimmed}\n`);
  turn.sessionId = parseSessionId(parsed) ?? turn.sessionId;
  if (parsed.type !== "result") {
    return;
  }
  const raw = turn.rawLines.join("\n");
  if (parsed.is_error === true) {
    failTurn(session, createResultError(session, parsed, raw));
    scheduleIdleClose(session);
    return;
  }
  finishTurn(
    session,
    parseCliOutput({
      raw,
      backend: turn.backend,
      providerId: session.providerId,
      outputMode: "jsonl",
      fallbackSessionId: turn.sessionId,
    }),
  );
}

function handleClaudeStdout(session: ClaudeLiveSession, chunk: string) {
  resetNoOutputTimer(session);
  session.stdoutBuffer += chunk;
  const maxPendingLineChars =
    session.currentTurn?.outputLimits.maxPendingLineChars ?? CLAUDE_LIVE_DEFAULT_MAX_TURN_RAW_CHARS;
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
  clearDrainTimer(session);
  if (liveSessions.get(session.key) === session) {
    liveSessions.delete(session.key);
  }
  cleanupLiveSession(session);
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
  if (exitCode === 0) {
    failTurn(session, new Error(message));
    return;
  }
  const reason = classifyFailoverReason(message, { provider: session.providerId }) ?? "unknown";
  failTurn(
    session,
    new FailoverError(message, {
      reason,
      provider: session.providerId,
      model: session.modelId,
      status: resolveFailoverStatus(reason),
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

async function writeTurnInput(session: ClaudeLiveSession, prompt: string): Promise<void> {
  const stdin = session.managedRun.stdin;
  if (!stdin) {
    throw new Error("Claude CLI live session stdin is unavailable");
  }
  await new Promise<void>((resolve, reject) => {
    stdin.write(createClaudeUserInputMessage(prompt), (error) => {
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
  fingerprint: string;
  key: string;
  noOutputTimeoutMs: number;
  supervisor: ProcessSupervisor;
  cleanup: () => Promise<void>;
}): Promise<ClaudeLiveSession> {
  let session: ClaudeLiveSession | null = null;
  const managedRun = await params.supervisor.spawn({
    sessionId: params.context.params.sessionId,
    backendId: params.context.backendResolved.id,
    scopeKey: `claude-live:${params.key}`,
    replaceExistingScope: true,
    mode: "child",
    argv: params.argv,
    cwd: params.context.workspaceDir,
    env: params.env,
    stdinMode: "pipe-open",
    captureOutput: false,
    onStdout: (chunk) => {
      if (session) {
        handleClaudeStdout(session, chunk);
      }
    },
    onStderr: (chunk) => {
      if (session) {
        session.stderr += chunk;
        if (session.stderr.length > CLAUDE_LIVE_MAX_STDERR_CHARS) {
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
  session = {
    key: params.key,
    fingerprint: params.fingerprint,
    managedRun,
    providerId: params.context.params.provider,
    modelId: params.context.modelId,
    noOutputTimeoutMs: params.noOutputTimeoutMs,
    stderr: "",
    stdoutBuffer: "",
    currentTurn: null,
    drainTimer: null,
    drainingAbortedTurn: false,
    idleTimer: null,
    cleanup: params.cleanup,
    cleanupDone: false,
    closing: false,
  };
  void managedRun.wait().then(
    (exit) => handleClaudeExit(session, exit.exitCode),
    (error) => {
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
  onAssistantDelta: (delta: CliStreamingDelta) => void;
  session: ClaudeLiveSession;
  resolve: (output: CliOutput) => void;
  reject: (error: unknown) => void;
}): ClaudeLiveTurn {
  const turn: ClaudeLiveTurn = {
    backend: params.context.preparedBackend.backend,
    outputLimits: resolveClaudeLiveOutputLimits(params.context.preparedBackend.backend),
    startedAtMs: Date.now(),
    rawLines: [],
    rawChars: 0,
    noOutputTimer: null,
    timeoutTimer: null,
    streamingParser: createCliJsonlStreamingParser({
      backend: params.context.preparedBackend.backend,
      providerId: params.context.backendResolved.id,
      onAssistantDelta: params.onAssistantDelta,
    }),
    resolve: params.resolve,
    reject: params.reject,
  };
  turn.noOutputTimer = setTimeout(() => {
    closeLiveSession(
      params.session,
      "abort",
      createTimeoutError(
        params.session,
        `CLI produced no output for ${Math.round(params.noOutputTimeoutMs / 1000)}s and was terminated.`,
      ),
    );
  }, params.noOutputTimeoutMs);
  turn.timeoutTimer = setTimeout(() => {
    closeLiveSession(
      params.session,
      "abort",
      createTimeoutError(
        params.session,
        `CLI exceeded timeout (${Math.round(params.context.params.timeoutMs / 1000)}s) and was terminated.`,
      ),
    );
  }, params.context.params.timeoutMs);
  return turn;
}

function closeOldestIdleSession(): boolean {
  for (const session of liveSessions.values()) {
    if (!session.currentTurn && !session.drainingAbortedTurn) {
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
    liveSessions.size + liveSessionCreates.size < CLAUDE_LIVE_MAX_SESSIONS
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

export async function runClaudeLiveSessionTurn(params: {
  context: PreparedCliRunContext;
  args: string[];
  env: Record<string, string>;
  prompt: string;
  useResume: boolean;
  noOutputTimeoutMs: number;
  getProcessSupervisor: () => ProcessSupervisor;
  onAssistantDelta: (delta: CliStreamingDelta) => void;
  cleanup: () => Promise<void>;
}): Promise<ClaudeLiveRunResult> {
  const key = buildClaudeLiveKey(params.context);
  const resumeCapable = Boolean(params.context.preparedBackend.backend.resumeArgs?.length);
  const argv = [
    params.context.preparedBackend.backend.command,
    ...buildClaudeLiveArgs({
      args: params.args,
      backend: params.context.preparedBackend.backend,
      systemPrompt: params.context.systemPrompt,
      useResume: params.useResume,
    }),
  ];
  const fingerprint = buildClaudeLiveFingerprint({
    context: params.context,
    argv,
    env: params.env,
  });
  let cleanupDone = false;
  const cleanup = async () => {
    if (cleanupDone) {
      return;
    }
    cleanupDone = true;
    await params.cleanup();
  };
  let session = liveSessions.get(key) ?? null;
  if (session && resumeCapable && !params.useResume) {
    closeLiveSession(session, "restart");
    session = null;
  }
  if (session && session.fingerprint !== fingerprint) {
    closeLiveSession(session, "restart");
    session = null;
  }
  let cleanupTurnArtifacts = Boolean(session);
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
        session = await pendingSession;
      } catch (error) {
        await cleanup();
        throw error;
      }
      if (session.fingerprint !== fingerprint) {
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
      const createSession = createClaudeLiveSession({
        context: params.context,
        argv,
        env: params.env,
        fingerprint,
        key,
        noOutputTimeoutMs: params.noOutputTimeoutMs,
        supervisor: params.getProcessSupervisor(),
        cleanup,
      }).finally(() => {
        if (liveSessionCreates.get(key) === createSession) {
          liveSessionCreates.delete(key);
        }
      });
      liveSessionCreates.set(key, createSession);
      try {
        session = await createSession;
      } catch (error) {
        await cleanup();
        throw error;
      }
    }
  }
  if (cleanupTurnArtifacts && session) {
    await cleanup();
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    cliBackendLog.info(
      `claude live session reuse: provider=${session.providerId} model=${session.modelId}`,
    );
  }
  if (session.closing) {
    await cleanup();
    throw new Error("Claude CLI live session closed before handling the turn");
  }
  if (session.currentTurn || session.drainingAbortedTurn) {
    throw new Error("Claude CLI live session is already handling a turn");
  }
  const liveSession = session;
  liveSession.noOutputTimeoutMs = params.noOutputTimeoutMs;
  liveSession.stderr = "";

  const outputPromise = new Promise<CliOutput>((resolve, reject) => {
    liveSession.currentTurn = createTurn({
      context: params.context,
      noOutputTimeoutMs: params.noOutputTimeoutMs,
      onAssistantDelta: params.onAssistantDelta,
      session: liveSession,
      resolve,
      reject,
    });
  });
  const abort = () => abortTurn(liveSession, createAbortError());
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
        await writeTurnInput(liveSession, params.prompt);
      } catch (error) {
        closeLiveSession(liveSession, "abort", error);
      }
    }
    return { output: await outputPromise };
  } finally {
    replyBackendCompleted = true;
    params.context.params.abortSignal?.removeEventListener("abort", abort);
    if (replyBackendHandle) {
      params.context.params.replyOperation?.detachBackend(replyBackendHandle);
    }
  }
}
