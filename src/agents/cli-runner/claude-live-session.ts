/** Coordinates admission and reuse for Claude CLI live processes. */
import crypto from "node:crypto";
import {
  splitSystemPromptCacheBoundary,
  stripSystemPromptCacheBoundary,
} from "@openclaw/ai/internal/shared";
import type { ReplyBackendHandle } from "../../auto-reply/reply/reply-run-registry.js";
import { createAbortError as createNamedAbortError } from "../../infra/abort-signal.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { CliBackendConfig } from "../../plugins/cli-backend.types.js";
import type {
  CliStreamingDelta,
  CliThinkingDelta,
  CliThinkingProgress,
  CliToolResultDelta,
  CliToolUseStartDelta,
  CliUsage,
} from "../cli-output-contracts.js";
import { isTimeoutError, FailoverError, resolveFailoverStatus } from "../failover-error.js";
import {
  abortClaudeTurn,
  beginClaudeTurn,
  createClaudeUserInputMessage,
  refreshClaudePrompt,
  resolveClaudeLiveExecPermission,
  spawnClaudeProcess,
  writeClaudeInput,
  type ClaudeLiveProcess,
} from "./claude-live-process.js";
import {
  buildClaudeLiveKey,
  beginClaudeSessionCreate,
  enqueueClaudeTurn,
  ensureClaudeSessionCapacity,
  finishClaudeSessionCreate,
  getClaudeSession,
  registerClaudeSession,
  removeClaudeSession,
} from "./claude-live-registry.js";
import type { ClaudeLiveToolTerminalOutcome } from "./claude-live-turn.js";
import { cliBackendLog } from "./log.js";
import type { PreparedCliRunContext } from "./types.js";

type ProcessSupervisor = ReturnType<
  typeof import("../../process/supervisor/index.js").getProcessSupervisor
>;

type ClaudeLiveRunResult = {
  output: import("../cli-output-contracts.js").CliOutput;
};

type RunClaudeTurnParams = {
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
};

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
  return params.permissionMode
    ? upsertArgValue(liveArgs, "--permission-mode", params.permissionMode)
    : liveArgs;
}

function buildClaudeLiveFingerprint(params: {
  context: PreparedCliRunContext;
  argv: string[];
  env: Record<string, string>;
}): string {
  const managedMcpGrant = params.context.preparedBackend.mcpClientGrantCapture;
  const normalizeMcpGrantToken =
    managedMcpGrant !== undefined &&
    params.env.OPENCLAW_MCP_TOKEN === managedMcpGrant.transportToken;
  const stableSystemPrompt =
    (params.context.preparedBackend.backend.systemPromptWhen === "always"
      ? splitSystemPromptCacheBoundary(params.context.systemPrompt)?.stablePrefix
      : undefined) ?? params.context.systemPrompt;
  const normalizeMcpConfigPath = Boolean(params.context.preparedBackend.mcpConfigHash);
  const skillSnapshot = params.context.params.skillsSnapshot;
  const skillsFingerprint = skillSnapshot
    ? sha256Hex(
        JSON.stringify({
          promptHash: sha256Hex(skillSnapshot.prompt),
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
      skillsFingerprint ? "--plugin-dir" : undefined,
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
    workspaceDirHash: sha256Hex(params.context.workspaceDir),
    cwdHash: params.context.cwdHash ?? sha256Hex(params.context.cwd ?? params.context.workspaceDir),
    provider: params.context.params.provider,
    model: params.context.normalizedModel,
    systemPromptHash: sha256Hex(stableSystemPrompt),
    authProfileIdHash: params.context.effectiveAuthProfileId
      ? sha256Hex(params.context.effectiveAuthProfileId)
      : undefined,
    authEpochHash: params.context.authEpoch ? sha256Hex(params.context.authEpoch) : undefined,
    extraSystemPromptHash: params.context.extraSystemPromptHash,
    promptToolNamesHash: params.context.promptToolNamesHash,
    // A warm child carries the canonical MCP topology across turns. Per-turn
    // authority rotates through the capture grant without restarting it.
    mcpResumeHash:
      params.context.preparedBackend.mcpResumeHash ?? params.context.preparedBackend.mcpConfigHash,
    credentialFingerprint: params.context.preparedBackend.secretInput?.fingerprint,
    skillsFingerprint,
    argv: stableArgv,
    // This is the canonical compatibility check for all spawn-time inputs.
    // Claude reads MAX_THINKING_TOKENS only when the child starts, so a changed
    // thinking environment invalidates a warm process without a second reuse gate.
    env: Object.keys(params.env)
      .toSorted()
      .map((key) => [
        key,
        key === "OPENCLAW_MCP_TOKEN" && normalizeMcpGrantToken
          ? "<managed-mcp-grant>"
          : params.env[key]
            ? sha256Hex(params.env[key])
            : "",
      ]),
  });
}

function adoptClaudeLiveProcessMcpGrant(params: {
  session: ClaudeLiveProcess;
  context: PreparedCliRunContext;
}): boolean {
  const turnGrant = params.context.preparedBackend.mcpClientGrantCapture;
  if (!turnGrant && !params.session.mcpGrantToken) {
    return true;
  }
  if (!turnGrant || !params.session.mcpGrantToken) {
    return false;
  }
  turnGrant.adoptProcessToken(params.session.mcpGrantToken);
  return true;
}

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

async function abortTurnBeforeStart(
  cleanup: () => Promise<void>,
  abortError: Error,
): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    throw new Error("Claude live turn aborted before start and cleanup failed", {
      cause: cleanupError,
    });
  }
  throw abortError;
}

/** Runs one prompt through a reusable Claude CLI live session. */
export function runClaudeTurn(params: RunClaudeTurnParams): Promise<ClaudeLiveRunResult> {
  const key = buildClaudeLiveKey(params.context);
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => (cleanupPromise ??= Promise.resolve().then(params.cleanup));
  const abortSignal = params.context.params.abortSignal;
  if (!abortSignal) {
    return enqueueClaudeTurn(key, () => runSerializedClaudeTurn(params, key, cleanup));
  }
  if (abortSignal.aborted) {
    return abortTurnBeforeStart(cleanup, createAbortError(abortSignal.reason));
  }
  return new Promise<ClaudeLiveRunResult>((resolve, reject) => {
    let started = false;
    let settled = false;
    const settle = (
      outcome: { kind: "resolve"; value: ClaudeLiveRunResult } | { kind: "reject"; error: unknown },
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      abortSignal.removeEventListener("abort", onAbort);
      if (outcome.kind === "resolve") {
        resolve(outcome.value);
      } else {
        reject(
          outcome.error instanceof Error
            ? outcome.error
            : new Error(formatErrorMessage(outcome.error)),
        );
      }
    };
    const onAbort = () => {
      if (!started) {
        void abortTurnBeforeStart(cleanup, createAbortError(abortSignal.reason)).catch(
          (error: unknown) => settle({ kind: "reject", error }),
        );
      }
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
    const queued = enqueueClaudeTurn(key, async () => {
      started = true;
      abortSignal.removeEventListener("abort", onAbort);
      if (abortSignal.aborted) {
        return await abortTurnBeforeStart(cleanup, createAbortError(abortSignal.reason));
      }
      return await runSerializedClaudeTurn(params, key, cleanup);
    });
    void queued.then(
      (value) => settle({ kind: "resolve", value }),
      (error: unknown) => settle({ kind: "reject", error }),
    );
  });
}

async function runSerializedClaudeTurn(
  params: RunClaudeTurnParams,
  key: string,
  cleanup: () => Promise<void>,
): Promise<ClaudeLiveRunResult> {
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
  const systemPromptHash = sha256Hex(stripSystemPromptCacheBoundary(params.context.systemPrompt));
  let session = getClaudeSession(key) as ClaudeLiveProcess | undefined;
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
    session.close("restart");
    session = undefined;
  }
  if (session && resumeCapable && !params.useResume) {
    session.close("restart");
    session = undefined;
  }
  if (session && session.fingerprint !== fingerprint) {
    if (params.requiredSessionGeneration) {
      await cleanup();
      throw createRequiredLiveSessionError({
        context: params.context,
        code: "cli_live_session_changed",
      });
    }
    session.close("restart");
    session = undefined;
  }
  if (
    session &&
    !(await refreshClaudePrompt({ session, context: params.context, systemPromptHash }))
  ) {
    if (params.requiredSessionGeneration) {
      await cleanup();
      throw createRequiredLiveSessionError({
        context: params.context,
        code: "cli_live_session_changed",
      });
    }
    session = undefined;
  }
  if (!session && params.requiredSessionGeneration) {
    await cleanup();
    throw createRequiredLiveSessionError({
      context: params.context,
      code: "cli_live_session_missing",
    });
  }
  if (session) {
    const reusableSession = session;
    try {
      if (!adoptClaudeLiveProcessMcpGrant({ session: reusableSession, context: params.context })) {
        reusableSession.close("restart");
        session = undefined;
      }
    } catch (error) {
      reusableSession.close("restart", error);
      session = undefined;
      if (params.requiredSessionGeneration) {
        await cleanup();
        throw createRequiredLiveSessionError({
          context: params.context,
          code: "cli_live_session_changed",
          cause: error,
        });
      }
    }
  }
  if (!session && params.requiredSessionGeneration) {
    await cleanup();
    throw createRequiredLiveSessionError({
      context: params.context,
      code: "cli_live_session_changed",
    });
  }
  const cleanupTurnArtifacts = Boolean(session);
  let notifiedMcpCaptureKey: string | undefined;
  const notifyMcpCaptureReady = (captureKey: string | undefined) => {
    if (!captureKey || notifiedMcpCaptureKey === captureKey) {
      return;
    }
    params.onMcpCaptureReady?.(captureKey);
    notifiedMcpCaptureKey = captureKey;
  };
  try {
    ensureClaudeSessionCapacity(key, params.context);
  } catch (error) {
    await cleanup();
    throw error;
  }
  if (!session) {
    // The owner queue stays held until creation completes, so a same-key turn
    // cannot observe the pending promise. Pending records serve generation queries and capacity.
    if (params.requiredSessionGeneration) {
      await cleanup();
      throw createRequiredLiveSessionError({
        context: params.context,
        code: "cli_live_session_missing",
      });
    }
    const generation = crypto.randomUUID();
    // Capture keys are child env/MCP-header state and cannot rotate without a
    // new process. Bind one key to this process; grant activate/deactivate is
    // the per-turn admission fence. Drain timeout still kills the child.
    const mcpCaptureKey = params.context.mcpDeliveryCapture ? crypto.randomUUID() : undefined;
    if (mcpCaptureKey) {
      try {
        notifyMcpCaptureReady(mcpCaptureKey);
      } catch (error) {
        await cleanup();
        throw error;
      }
    }
    const pendingCreate = beginClaudeSessionCreate(key, generation);
    const createSession: Promise<ClaudeLiveProcess> = spawnClaudeProcess({
      context: params.context,
      argv,
      env: params.env,
      generation,
      fingerprint,
      systemPromptHash,
      key,
      mcpCaptureKey,
      noOutputTimeoutMs: params.noOutputTimeoutMs,
      supervisor: params.getProcessSupervisor(),
      cleanup,
      onSpawned: (spawned) => registerClaudeSession(spawned, pendingCreate),
      onClosed: removeClaudeSession,
    }).finally(() => finishClaudeSessionCreate(key, pendingCreate));
    try {
      session = await createSession;
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
  if (cleanupTurnArtifacts) {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    await cleanup();
    cliBackendLog.info(
      `claude live session reuse: provider=${session.providerId} model=${session.modelId}`,
    );
  }
  if (session.closing || getClaudeSession(key) !== session) {
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
  if (session.sessionId) {
    params.onSessionId?.(session.sessionId);
  }
  notifyMcpCaptureReady(session.mcpCaptureKey);
  session.noOutputTimeoutMs = params.noOutputTimeoutMs;
  session.stderr = "";
  const inputUuid = crypto.randomUUID();
  const outputPromise = beginClaudeTurn(session, {
    context: params.context,
    inputUuid,
    useResume: params.useResume,
    execPermission,
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
  });
  void outputPromise.catch(() => undefined);
  const abort = () =>
    abortClaudeTurn(session, createAbortError(params.context.params.abortSignal?.reason));
  const replyBackendHandle: ReplyBackendHandle | undefined = params.context.params.replyOperation
    ? {
        kind: "cli",
        runId: params.context.params.runId,
        toolAuthorityFingerprint: params.context.params.toolAuthorityFingerprint,
        cancel: abort,
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
        const requestPayload = createClaudeUserInputMessage(params.prompt, inputUuid);
        params.onRequestPayload?.(requestPayload);
        await Promise.race([writeClaudeInput(session, requestPayload), outputPromise]);
      } catch (error) {
        session.close("abort", error);
      }
    }
    return { output: await outputPromise };
  } finally {
    params.context.params.abortSignal?.removeEventListener("abort", abort);
    if (replyBackendHandle) {
      params.context.params.replyOperation?.detachBackend(replyBackendHandle);
    }
  }
}
