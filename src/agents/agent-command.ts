import fs from "node:fs/promises";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { resolveAcpAgentPolicyError, resolveAcpDispatchPolicyError } from "../acp/policy.js";
import { toAcpRuntimeError } from "../acp/runtime/errors.js";
import { resolveAcpSessionCwd } from "../acp/runtime/session-identifiers.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { llmRouterHealth, llmRouterSelect, shouldUseLlmRouter } from "../integrations/llm-router-client.js";

const log = createSubsystemLogger("agents/agent-command");
import { normalizeReplyPayload } from "../auto-reply/reply/normalize-reply.js";
import {
  formatThinkingLevels,
  formatXHighModelHint,
  normalizeThinkLevel,
  normalizeVerboseLevel,
  supportsXHighThinking,
  type ThinkLevel,
  type VerboseLevel,
} from "../auto-reply/thinking.js";
import {
  isSilentReplyPrefixText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
} from "../auto-reply/tokens.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveCommandSecretRefsViaGateway } from "../cli/command-secret-gateway.js";
import { getAgentRuntimeCommandSecretTargetIds } from "../cli/command-secret-targets.js";
import { type CliDeps, createDefaultDeps } from "../cli/deps.js";
import {
  loadConfig,
  readConfigFileSnapshotForWrite,
  setRuntimeConfigSnapshot,
} from "../config/config.js";
import {
  mergeSessionEntry,
  resolveAgentIdFromSessionKey,
  type SessionEntry,
  updateSessionStore,
} from "../config/sessions.js";
import { resolveSessionTranscriptFile } from "../config/sessions/transcript.js";
import {
  clearAgentRunContext,
  emitAgentEvent,
  registerAgentRunContext,
} from "../infra/agent-events.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { getRemoteSkillEligibility } from "../infra/skills-remote.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { applyVerboseOverride } from "../sessions/level-overrides.js";
import { applyModelOverrideToSessionEntry } from "../sessions/model-overrides.js";
import { resolveSendPolicy } from "../sessions/send-policy.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { resolveMessageChannel } from "../utils/message-channel.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveEffectiveModelFallbacks,
  resolveSessionAgentId,
  resolveAgentSkillsFilter,
  resolveAgentWorkspaceDir,
} from "./agent-scope.js";
import { ensureAuthProfileStore } from "./auth-profiles.js";
import { clearSessionAuthProfileOverride } from "./auth-profiles/session-override.js";
import { resolveBootstrapWarningSignaturesSeen } from "./bootstrap-budget.js";
import { runCliAgent } from "./cli-runner.js";
import { getCliSessionId, setCliSessionId } from "./cli-session.js";
import { deliverAgentCommandResult } from "./command/delivery.js";
import { resolveAgentRunContext } from "./command/run-context.js";
import { updateSessionStoreAfterAgentRun } from "./command/session-store.js";
import { resolveSession } from "./command/session.js";
import type { AgentCommandIngressOpts, AgentCommandOpts } from "./command/types.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { FailoverError } from "./failover-error.js";
import { formatAgentInternalEventsForPrompt } from "./internal-events.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import { loadModelCatalog } from "./model-catalog.js";
import { runWithModelFallback } from "./model-fallback.js";
import {
  buildAllowedModelSet,
  buildConfiguredAllowlistKeys,
  isCliProvider,
  modelKey,
  normalizeModelRef,
  normalizeProviderId,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
  resolveThinkingDefault,
} from "./model-selection.js";
import { prepareSessionManagerForRun } from "./pi-embedded-runner/session-manager-init.js";
import { runEmbeddedPiAgent } from "./pi-embedded.js";
import { buildWorkspaceSkillSnapshot } from "./skills.js";
import { getSkillsSnapshotVersion } from "./skills/refresh.js";
import { normalizeSpawnedRunMetadata } from "./spawned-context.js";
import { resolveAgentTimeoutMs } from "./timeout.js";
import { ensureAgentWorkspace } from "./workspace.js";

type PersistSessionEntryParams = {
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath: string;
  entry: SessionEntry;
};

type OverrideFieldClearedByDelete =
  | "providerOverride"
  | "modelOverride"
  | "authProfileOverride"
  | "authProfileOverrideSource"
  | "authProfileOverrideCompactionCount"
  | "fallbackNoticeSelectedModel"
  | "fallbackNoticeActiveModel"
  | "fallbackNoticeReason"
  | "claudeCliSessionId";

const OVERRIDE_FIELDS_CLEARED_BY_DELETE: OverrideFieldClearedByDelete[] = [
  "providerOverride",
  "modelOverride",
  "authProfileOverride",
  "authProfileOverrideSource",
  "authProfileOverrideCompactionCount",
  "fallbackNoticeSelectedModel",
  "fallbackNoticeActiveModel",
  "fallbackNoticeReason",
  "claudeCliSessionId",
];

const OVERRIDE_VALUE_MAX_LENGTH = 256;

function containsControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      continue;
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function normalizeExplicitOverrideInput(raw: string, kind: "provider" | "model"): string {
  const trimmed = raw.trim();
  const label = kind === "provider" ? "Provider" : "Model";
  if (!trimmed) {
    throw new Error(`${label} override must be non-empty.`);
  }
  if (trimmed.length > OVERRIDE_VALUE_MAX_LENGTH) {
    throw new Error(`${label} override exceeds ${String(OVERRIDE_VALUE_MAX_LENGTH)} characters.`);
  }
  if (containsControlCharacters(trimmed)) {
    throw new Error(`${label} override contains invalid control characters.`);
  }
  return trimmed;
}

async function persistSessionEntry(params: PersistSessionEntryParams): Promise<void> {
  const persisted = await updateSessionStore(params.storePath, (store) => {
    const merged = mergeSessionEntry(store[params.sessionKey], params.entry);
    // Preserve explicit `delete` clears done by session override helpers.
    for (const field of OVERRIDE_FIELDS_CLEARED_BY_DELETE) {
      if (!Object.hasOwn(params.entry, field)) {
        Reflect.deleteProperty(merged, field);
      }
    }
    store[params.sessionKey] = merged;
    return merged;
  });
  params.sessionStore[params.sessionKey] = persisted;
}

function resolveFallbackRetryPrompt(params: { body: string; isFallbackRetry: boolean }): string {
  if (!params.isFallbackRetry) {
    return params.body;
  }
  return "Continue where you left off. The previous model attempt failed or timed out.";
}

function prependInternalEventContext(
  body: string,
  events: AgentCommandOpts["internalEvents"],
): string {
  if (body.includes("OpenClaw runtime context (internal):")) {
    return body;
  }
  const renderedEvents = formatAgentInternalEventsForPrompt(events);
  if (!renderedEvents) {
    return body;
  }
  return [renderedEvents, body].filter(Boolean).join("\n\n");
}

function createAcpVisibleTextAccumulator() {
  let pendingSilentPrefix = "";
  let visibleText = "";
  const startsWithWordChar = (chunk: string): boolean => /^[\p{L}\p{N}]/u.test(chunk);

  const resolveNextCandidate = (base: string, chunk: string): string => {
    if (!base) {
      return chunk;
    }
    if (
      isSilentReplyText(base, SILENT_REPLY_TOKEN) &&
      !chunk.startsWith(base) &&
      startsWithWordChar(chunk)
    ) {
      return chunk;
    }
    // Some ACP backends emit cumulative snapshots even on text_delta-style hooks.
    // Accept those only when they strictly extend the buffered text.
    if (chunk.startsWith(base) && chunk.length > base.length) {
      return chunk;
    }
    return `${base}${chunk}`;
  };

  const mergeVisibleChunk = (base: string, chunk: string): { text: string; delta: string } => {
    if (!base) {
      return { text: chunk, delta: chunk };
    }
    if (chunk.startsWith(base) && chunk.length > base.length) {
      const delta = chunk.slice(base.length);
      return { text: chunk, delta };
    }
    return {
      text: `${base}${chunk}`,
      delta: chunk,
    };
  };

  return {
    consume(chunk: string): { text: string; delta: string } | null {
      if (!chunk) {
        return null;
      }

      if (!visibleText) {
        const leadCandidate = resolveNextCandidate(pendingSilentPrefix, chunk);
        const trimmedLeadCandidate = leadCandidate.trim();
        if (
          isSilentReplyText(trimmedLeadCandidate, SILENT_REPLY_TOKEN) ||
          isSilentReplyPrefixText(trimmedLeadCandidate, SILENT_REPLY_TOKEN)
        ) {
          pendingSilentPrefix = leadCandidate;
          return null;
        }
        if (pendingSilentPrefix) {
          pendingSilentPrefix = "";
          visibleText = leadCandidate;
          return {
            text: visibleText,
            delta: leadCandidate,
          };
        }
      }

      const nextVisible = mergeVisibleChunk(visibleText, chunk);
      visibleText = nextVisible.text;
      return nextVisible.delta ? nextVisible : null;
    },
    finalize(): string {
      return visibleText.trim();
    },
    finalizeRaw(): string {
      return visibleText;
    },
  };
}

const ACP_TRANSCRIPT_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
} as const;

async function persistAcpTurnTranscript(params: {
  body: string;
  finalText: string;
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  sessionAgentId: string;
  threadId?: string | number;
  sessionCwd: string;
}): Promise<SessionEntry | undefined> {
  const promptText = params.body;
  const replyText = params.finalText;
  if (!promptText && !replyText) {
    return params.sessionEntry;
  }

  const { sessionFile, sessionEntry } = await resolveSessionTranscriptFile({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    storePath: params.storePath,
    agentId: params.sessionAgentId,
    threadId: params.threadId,
  });
  const hadSessionFile = await fs
    .access(sessionFile)
    .then(() => true)
    .catch(() => false);
  const sessionManager = SessionManager.open(sessionFile);
  await prepareSessionManagerForRun({
    sessionManager,
    sessionFile,
    hadSessionFile,
    sessionId: params.sessionId,
    cwd: params.sessionCwd,
  });

  if (promptText) {
    sessionManager.appendMessage({
      role: "user",
      content: promptText,
      timestamp: Date.now(),
    });
  }

  if (replyText) {
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: replyText }],
      api: "openai-responses",
      provider: "openclaw",
      model: "acp-runtime",
      usage: ACP_TRANSCRIPT_USAGE,
      stopReason: "stop",
      timestamp: Date.now(),
    });
  }

  emitSessionTranscriptUpdate(sessionFile);
  return sessionEntry;
}

function runAgentAttempt(params: {
  providerOverride: string;
  modelOverride: string;
  cfg: ReturnType<typeof loadConfig>;
  sessionEntry: SessionEntry | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  sessionAgentId: string;
  sessionFile: string;
  workspaceDir: string;
  body: string;
  isFallbackRetry: boolean;
  resolvedThinkLevel: ThinkLevel;
  timeoutMs: number;
  runId: string;
  opts: AgentCommandOpts & { senderIsOwner: boolean };
  runContext: ReturnType<typeof resolveAgentRunContext>;
  spawnedBy: string | undefined;
  messageChannel: ReturnType<typeof resolveMessageChannel>;
  skillsSnapshot: ReturnType<typeof buildWorkspaceSkillSnapshot> | undefined;
  resolvedVerboseLevel: VerboseLevel | undefined;
  agentDir: string;
  onAgentEvent: (evt: { stream: string; data?: Record<string, unknown> }) => void;
  authProfileProvider: string;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  allowTransientCooldownProbe?: boolean;
}) {
  const effectivePrompt = resolveFallbackRetryPrompt({
    body: params.body,
    isFallbackRetry: params.isFallbackRetry,
  });
  const bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
    params.sessionEntry?.systemPromptReport,
  );
  const bootstrapPromptWarningSignature =
    bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1];
  if (isCliProvider(params.providerOverride, params.cfg)) {
    const cliSessionId = getCliSessionId(params.sessionEntry, params.providerOverride);
    const runCliWithSession = (nextCliSessionId: string | undefined) =>
      runCliAgent({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        agentId: params.sessionAgentId,
        sessionFile: params.sessionFile,
        workspaceDir: params.workspaceDir,
        config: params.cfg,
        prompt: effectivePrompt,
        provider: params.providerOverride,
        model: params.modelOverride,
        thinkLevel: params.resolvedThinkLevel,
        timeoutMs: params.timeoutMs,
        runId: params.runId,
        extraSystemPrompt: params.opts.extraSystemPrompt,
        cliSessionId: nextCliSessionId,
        bootstrapPromptWarningSignaturesSeen,
        bootstrapPromptWarningSignature,
        images: params.isFallbackRetry ? undefined : params.opts.images,
        streamParams: params.opts.streamParams,
      });
    return runCliWithSession(cliSessionId).catch(async (err) => {
      // Handle CLI session expired error
      if (
        err instanceof FailoverError &&
        err.reason === "session_expired" &&
        cliSessionId &&
        params.sessionKey &&
        params.sessionStore &&
        params.storePath
      ) {
        log.warn(
          `CLI session expired, clearing from session store: provider=${sanitizeForLog(params.providerOverride)} sessionKey=${params.sessionKey}`,
        );

        // Clear the expired session ID from the session store
        const entry = params.sessionStore[params.sessionKey];
        if (entry) {
          const updatedEntry = { ...entry };
          if (params.providerOverride === "claude-cli") {
            delete updatedEntry.claudeCliSessionId;
          }
          if (updatedEntry.cliSessionIds) {
            const normalizedProvider = normalizeProviderId(params.providerOverride);
            const newCliSessionIds = { ...updatedEntry.cliSessionIds };
            delete newCliSessionIds[normalizedProvider];
            updatedEntry.cliSessionIds = newCliSessionIds;
          }
          updatedEntry.updatedAt = Date.now();

          await persistSessionEntry({
            sessionStore: params.sessionStore,
            sessionKey: params.sessionKey,
            storePath: params.storePath,
            entry: updatedEntry,
          });

          // Update the session entry reference
          params.sessionEntry = updatedEntry;
        }

        // Retry with no session ID (will create a new session)
        return runCliWithSession(undefined).then(async (result) => {
          // Update session store with new CLI session ID if available
          if (
            result.meta.agentMeta?.sessionId &&
            params.sessionKey &&
            params.sessionStore &&
            params.storePath
          ) {
            const entry = params.sessionStore[params.sessionKey];
            if (entry) {
              const updatedEntry = { ...entry };
              setCliSessionId(
                updatedEntry,
                params.providerOverride,
                result.meta.agentMeta.sessionId,
              );
              updatedEntry.updatedAt = Date.now();

              await persistSessionEntry({
                sessionStore: params.sessionStore,
                sessionKey: params.sessionKey,
                storePath: params.storePath,
                entry: updatedEntry,
              });
            }
          }
          return result;
        });
      }
      throw err;
    });
  }

  const authProfileId =
    params.providerOverride === params.authProfileProvider
      ? params.sessionEntry?.authProfileOverride
      : undefined;
  return runEmbeddedPiAgent({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.sessionAgentId,
    trigger: "user",
    messageChannel: params.messageChannel,
    agentAccountId: params.runContext.accountId,
    messageTo: params.opts.replyTo ?? params.opts.to,
    messageThreadId: params.opts.threadId,
    groupId: params.runContext.groupId,
    groupChannel: params.runContext.groupChannel,
    groupSpace: params.runContext.groupSpace,
    spawnedBy: params.spawnedBy,
    currentChannelId: params.runContext.currentChannelId,
    currentThreadTs: params.runContext.currentThreadTs,
    replyToMode: params.runContext.replyToMode,
    hasRepliedRef: params.runContext.hasRepliedRef,
    senderIsOwner: params.opts.senderIsOwner,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    config: params.cfg,
    skillsSnapshot: params.skillsSnapshot,
    prompt: effectivePrompt,
    images: params.isFallbackRetry ? undefined : params.opts.images,
    clientTools: params.opts.clientTools,
    provider: params.providerOverride,
    model: params.modelOverride,
    authProfileId,
    authProfileIdSource: authProfileId ? params.sessionEntry?.authProfileOverrideSource : undefined,
    thinkLevel: params.resolvedThinkLevel,
    verboseLevel: params.resolvedVerboseLevel,
    timeoutMs: params.timeoutMs,
    runId: params.runId,
    lane: params.opts.lane,
    abortSignal: params.opts.abortSignal,
    extraSystemPrompt: params.opts.extraSystemPrompt,
    inputProvenance: params.opts.inputProvenance,
    streamParams: params.opts.streamParams,
    agentDir: params.agentDir,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
    onAgentEvent: params.onAgentEvent,
    bootstrapPromptWarningSignaturesSeen,
    bootstrapPromptWarningSignature,
  });
}

async function prepareAgentCommandExecution(
  opts: AgentCommandOpts & { senderIsOwner: boolean },
  runtime: RuntimeEnv,
) {
  const message = opts.message ?? "";
  if (!message.trim()) {
    throw new Error("Message (--message) is required");
  }
  const body = prependInternalEventContext(message, opts.internalEvents);
  if (!opts.to && !opts.sessionId && !opts.sessionKey && !opts.agentId) {
    throw new Error("Pass --to <E.164>, --session-id, or --agent to choose a session");
  }

  const loadedRaw = loadConfig();
  const sourceConfig = await (async () => {
    try {
      const { snapshot } = await readConfigFileSnapshotForWrite();
      if (snapshot.valid) {
        return snapshot.resolved;
      }
    } catch {
      // Fall back to runtime-loaded config when source snapshot is unavailable.
    }
    return loadedRaw;
  })();
  const { resolvedConfig: cfg, diagnostics } = await resolveCommandSecretRefsViaGateway({
    config: loadedRaw,
    commandName: "agent",
    targetIds: getAgentRuntimeCommandSecretTargetIds(),
  });
  setRuntimeConfigSnapshot(cfg, sourceConfig);
  const normalizedSpawned = normalizeSpawnedRunMetadata({
    spawnedBy: opts.spawnedBy,
    groupId: opts.groupId,
    groupChannel: opts.groupChannel,
    groupSpace: opts.groupSpace,
    workspaceDir: opts.workspaceDir,
  });
  for (const entry of diagnostics) {
    runtime.log(`[secrets] ${entry}`);
  }
  const agentIdOverrideRaw = opts.agentId?.trim();
  const agentIdOverride = agentIdOverrideRaw ? normalizeAgentId(agentIdOverrideRaw) : undefined;
  if (agentIdOverride) {
    const knownAgents = listAgentIds(cfg);
    if (!knownAgents.includes(agentIdOverride)) {
      throw new Error(
        `Unknown agent id "${agentIdOverrideRaw}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`,
      );
    }
  }
  if (agentIdOverride && opts.sessionKey) {
    const sessionAgentId = resolveAgentIdFromSessionKey(opts.sessionKey);
    if (sessionAgentId !== agentIdOverride) {
      throw new Error(
        `Agent id "${agentIdOverrideRaw}" does not match session key agent "${sessionAgentId}".`,
      );
    }
  }
  const agentCfg = cfg.agents?.defaults;
  const configuredModel = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const thinkingLevelsHint = formatThinkingLevels(configuredModel.provider, configuredModel.model);

  const thinkOverride = normalizeThinkLevel(opts.thinking);
  const thinkOnce = normalizeThinkLevel(opts.thinkingOnce);
  if (opts.thinking && !thinkOverride) {
    throw new Error(`Invalid thinking level. Use one of: ${thinkingLevelsHint}.`);
  }
  if (opts.thinkingOnce && !thinkOnce) {
    throw new Error(`Invalid one-shot thinking level. Use one of: ${thinkingLevelsHint}.`);
  }

  const verboseOverride = normalizeVerboseLevel(opts.verbose);
  if (opts.verbose && !verboseOverride) {
    throw new Error('Invalid verbose level. Use "on", "full", or "off".');
  }

  const laneRaw = typeof opts.lane === "string" ? opts.lane.trim() : "";
  const isSubagentLane = laneRaw === String(AGENT_LANE_SUBAGENT);
  const timeoutSecondsRaw =
    opts.timeout !== undefined
      ? Number.parseInt(String(opts.timeout), 10)
      : isSubagentLane
        ? 0
        : undefined;
  if (
    timeoutSecondsRaw !== undefined &&
    (Number.isNaN(timeoutSecondsRaw) || timeoutSecondsRaw < 0)
  ) {
    throw new Error("--timeout must be a non-negative integer (seconds; 0 means no timeout)");
  }
  const timeoutMs = resolveAgentTimeoutMs({
    cfg,
    overrideSeconds: timeoutSecondsRaw,
  });

  const sessionResolution = resolveSession({
    cfg,
    to: opts.to,
    sessionId: opts.sessionId,
    sessionKey: opts.sessionKey,
    agentId: agentIdOverride,
  });

  const {
    sessionId,
    sessionKey,
    sessionEntry: sessionEntryRaw,
    sessionStore,
    storePath,
    isNewSession,
    persistedThinking,
    persistedVerbose,
  } = sessionResolution;
  const sessionAgentId =
    agentIdOverride ??
    resolveSessionAgentId({
      sessionKey: sessionKey ?? opts.sessionKey?.trim(),
      config: cfg,
    });
  const outboundSession = buildOutboundSessionContext({
    cfg,
    agentId: sessionAgentId,
    sessionKey,
  });
  // Internal callers (for example subagent spawns) may pin workspace inheritance.
  const workspaceDirRaw =
    normalizedSpawned.workspaceDir ?? resolveAgentWorkspaceDir(cfg, sessionAgentId);
  const agentDir = resolveAgentDir(cfg, sessionAgentId);
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap,
  });
  const workspaceDir = workspace.dir;
  const runId = opts.runId?.trim() || sessionId;
  const acpManager = getAcpSessionManager();
  const acpResolution = sessionKey
    ? acpManager.resolveSession({
        cfg,
        sessionKey,
      })
    : null;

  return {
    body,
    cfg,
    normalizedSpawned,
    agentCfg,
    thinkOverride,
    thinkOnce,
    verboseOverride,
    timeoutMs,
    sessionId,
    sessionKey,
    sessionEntry: sessionEntryRaw,
    sessionStore,
    storePath,
    isNewSession,
    persistedThinking,
    persistedVerbose,
    sessionAgentId,
    outboundSession,
    workspaceDir,
    agentDir,
    runId,
    acpManager,
    acpResolution,
  };
}

async function agentCommandInternal(
  opts: AgentCommandOpts & { senderIsOwner: boolean },
  runtime: RuntimeEnv = defaultRuntime,
  deps: CliDeps = createDefaultDeps(),
) {
  const prepared = await prepareAgentCommandExecution(opts, runtime);
  const {
    body,
    cfg,
    normalizedSpawned,
    agentCfg,
    thinkOverride,
    thinkOnce,
    verboseOverride,
    timeoutMs,
    sessionId,
    sessionKey,
    sessionStore,
    storePath,
    isNewSession,
    persistedThinking,
    persistedVerbose,
    sessionAgentId,
    outboundSession,
    workspaceDir,
    agentDir,
    runId,
    acpManager,
    acpResolution,
  } = prepared;
  let sessionEntry = prepared.sessionEntry;

  try {
    if (opts.deliver === true) {
      const sendPolicy = resolveSendPolicy({
        cfg,
        entry: sessionEntry,
        sessionKey,
        channel: sessionEntry?.channel,
        chatType: sessionEntry?.chatType,
      });
      if (sendPolicy === "deny") {
        throw new Error("send blocked by session policy");
      }
    }

    if (acpResolution?.kind === "stale") {
      throw acpResolution.error;
    }

    if (acpResolution?.kind === "ready" && sessionKey) {
      const startedAt = Date.now();
      registerAgentRunContext(runId, {
        sessionKey,
      });
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: {
          phase: "start",
          startedAt,
        },
      });

      const visibleTextAccumulator = createAcpVisibleTextAccumulator();
      let stopReason: string | undefined;
      try {
        const dispatchPolicyError = resolveAcpDispatchPolicyError(cfg);
        if (dispatchPolicyError) {
          throw dispatchPolicyError;
        }
        const acpAgent = normalizeAgentId(
          acpResolution.meta.agent || resolveAgentIdFromSessionKey(sessionKey),
        );
        const agentPolicyError = resolveAcpAgentPolicyError(cfg, acpAgent);
        if (agentPolicyError) {
          throw agentPolicyError;
        }

        await acpManager.runTurn({
          cfg,
          sessionKey,
          text: body,
          mode: "prompt",
          requestId: runId,
          signal: opts.abortSignal,
          onEvent: (event) => {
            if (event.type === "done") {
              stopReason = event.stopReason;
              return;
            }
            if (event.type !== "text_delta") {
              return;
            }
            if (event.stream && event.stream !== "output") {
              return;
            }
            if (!event.text) {
              return;
            }
            const visibleUpdate = visibleTextAccumulator.consume(event.text);
            if (!visibleUpdate) {
              return;
            }
            emitAgentEvent({
              runId,
              stream: "assistant",
              data: {
                text: visibleUpdate.text,
                delta: visibleUpdate.delta,
              },
            });
          },
        });
      } catch (error) {
        const acpError = toAcpRuntimeError({
          error,
          fallbackCode: "ACP_TURN_FAILED",
          fallbackMessage: "ACP turn failed before completion.",
        });
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: {
            phase: "error",
            error: acpError.message,
            endedAt: Date.now(),
          },
        });
        throw acpError;
      }

      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: Date.now(),
        },
      });

      const finalTextRaw = visibleTextAccumulator.finalizeRaw();
      const finalText = visibleTextAccumulator.finalize();
      try {
        sessionEntry = await persistAcpTurnTranscript({
          body,
          finalText: finalTextRaw,
          sessionId,
          sessionKey,
          sessionEntry,
          sessionStore,
          storePath,
          sessionAgentId,
          threadId: opts.threadId,
          sessionCwd: resolveAcpSessionCwd(acpResolution.meta) ?? workspaceDir,
        });
      } catch (error) {
        log.warn(
          `ACP transcript persistence failed for ${sessionKey}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const normalizedFinalPayload = normalizeReplyPayload({
        text: finalText,
      });
      const payloads = normalizedFinalPayload ? [normalizedFinalPayload] : [];
      const result = {
        payloads,
        meta: {
          durationMs: Date.now() - startedAt,
          aborted: opts.abortSignal?.aborted === true,
          stopReason,
        },
      };

      return await deliverAgentCommandResult({
        cfg,
        deps,
        runtime,
        opts,
        outboundSession,
        sessionEntry,
        result,
        payloads,
      });
    }

    let resolvedThinkLevel = thinkOnce ?? thinkOverride ?? persistedThinking;
    const resolvedVerboseLevel =
      verboseOverride ?? persistedVerbose ?? (agentCfg?.verboseDefault as VerboseLevel | undefined);

    if (sessionKey) {
      registerAgentRunContext(runId, {
        sessionKey,
        verboseLevel: resolvedVerboseLevel,
      });
    }

    const needsSkillsSnapshot = isNewSession || !sessionEntry?.skillsSnapshot;
    const skillsSnapshotVersion = getSkillsSnapshotVersion(workspaceDir);
    const skillFilter = resolveAgentSkillsFilter(cfg, sessionAgentId);
    const skillsSnapshot = needsSkillsSnapshot
      ? buildWorkspaceSkillSnapshot(workspaceDir, {
          config: cfg,
          eligibility: { remote: getRemoteSkillEligibility() },
          snapshotVersion: skillsSnapshotVersion,
          skillFilter,
        })
      : sessionEntry?.skillsSnapshot;

    if (skillsSnapshot && sessionStore && sessionKey && needsSkillsSnapshot) {
      const current = sessionEntry ?? {
        sessionId,
        updatedAt: Date.now(),
      };
      const next: SessionEntry = {
        ...current,
        sessionId,
        updatedAt: Date.now(),
        skillsSnapshot,
      };
      await persistSessionEntry({
        sessionStore,
        sessionKey,
        storePath,
        entry: next,
      });
      sessionEntry = next;
    }

    // Persist explicit /command overrides to the session store when we have a key.
    if (sessionStore && sessionKey) {
      const entry = sessionStore[sessionKey] ??
        sessionEntry ?? { sessionId, updatedAt: Date.now() };
      const next: SessionEntry = { ...entry, sessionId, updatedAt: Date.now() };
      if (thinkOverride) {
        next.thinkingLevel = thinkOverride;
      }
      applyVerboseOverride(next, verboseOverride);
      await persistSessionEntry({
        sessionStore,
        sessionKey,
        storePath,
        entry: next,
      });
      sessionEntry = next;
    }

    const configuredDefaultRef = resolveDefaultModelForAgent({
      cfg,
      agentId: sessionAgentId,
    });
    const { provider: defaultProvider, model: defaultModel } = normalizeModelRef(
      configuredDefaultRef.provider,
      configuredDefaultRef.model,
    );
    let provider = defaultProvider;
    let model = defaultModel;
    const hasAllowlist = agentCfg?.models && Object.keys(agentCfg.models).length > 0;
    const hasStoredOverride = Boolean(
      sessionEntry?.modelOverride || sessionEntry?.providerOverride,
    );
    const explicitProviderOverride =
      typeof opts.provider === "string"
        ? normalizeExplicitOverrideInput(opts.provider, "provider")
        : undefined;
    const explicitModelOverride =
      typeof opts.model === "string"
        ? normalizeExplicitOverrideInput(opts.model, "model")
        : undefined;
    const hasExplicitRunOverride = Boolean(explicitProviderOverride || explicitModelOverride);
    if (hasExplicitRunOverride && opts.allowModelOverride !== true) {
      throw new Error("Model override is not authorized for this caller.");
    }
    const needsModelCatalog = hasAllowlist || hasStoredOverride || hasExplicitRunOverride;
    let allowedModelKeys = new Set<string>();
    let allowedModelCatalog: Awaited<ReturnType<typeof loadModelCatalog>> = [];
    let modelCatalog: Awaited<ReturnType<typeof loadModelCatalog>> | null = null;
    let allowAnyModel = false;

    if (needsModelCatalog) {
      modelCatalog = await loadModelCatalog({ config: cfg });
      const allowed = buildAllowedModelSet({
        cfg,
        catalog: modelCatalog,
        defaultProvider,
        defaultModel,
        agentId: sessionAgentId,
      });
      allowedModelKeys = allowed.allowedKeys;
      allowedModelCatalog = allowed.allowedCatalog;
      allowAnyModel = allowed.allowAny ?? false;
    }

    if (sessionEntry && sessionStore && sessionKey && hasStoredOverride) {
      const entry = sessionEntry;
      const overrideProvider = sessionEntry.providerOverride?.trim() || defaultProvider;
      const overrideModel = sessionEntry.modelOverride?.trim();
      if (overrideModel) {
        const normalizedOverride = normalizeModelRef(overrideProvider, overrideModel);
        const key = modelKey(normalizedOverride.provider, normalizedOverride.model);
        if (
          !isCliProvider(normalizedOverride.provider, cfg) &&
          !allowAnyModel &&
          !allowedModelKeys.has(key)
        ) {
          const { updated } = applyModelOverrideToSessionEntry({
            entry,
            selection: { provider: defaultProvider, model: defaultModel, isDefault: true },
          });
          if (updated) {
            await persistSessionEntry({
              sessionStore,
              sessionKey,
              storePath,
              entry,
            });
          }
        }
      }
    }

    const storedProviderOverride = sessionEntry?.providerOverride?.trim();
    const storedModelOverride = sessionEntry?.modelOverride?.trim();
    if (storedModelOverride) {
      const candidateProvider = storedProviderOverride || defaultProvider;
      const normalizedStored = normalizeModelRef(candidateProvider, storedModelOverride);
      const key = modelKey(normalizedStored.provider, normalizedStored.model);
      if (
        isCliProvider(normalizedStored.provider, cfg) ||
        allowAnyModel ||
        allowedModelKeys.has(key)
      ) {
        provider = normalizedStored.provider;
        model = normalizedStored.model;
      }
    }
    const providerForAuthProfileValidation = provider;
    if (hasExplicitRunOverride) {
      const explicitRef = explicitModelOverride
        ? explicitProviderOverride
          ? normalizeModelRef(explicitProviderOverride, explicitModelOverride)
          : parseModelRef(explicitModelOverride, provider)
        : explicitProviderOverride
          ? normalizeModelRef(explicitProviderOverride, model)
          : null;
      if (!explicitRef) {
        throw new Error("Invalid model override.");
      }
      const explicitKey = modelKey(explicitRef.provider, explicitRef.model);
      if (
        !isCliProvider(explicitRef.provider, cfg) &&
        !allowAnyModel &&
        !allowedModelKeys.has(explicitKey)
      ) {
        throw new Error(
          `Model override "${sanitizeForLog(explicitRef.provider)}/${sanitizeForLog(explicitRef.model)}" is not allowed for agent "${sessionAgentId}".`,
        );
      }
      provider = explicitRef.provider;
      model = explicitRef.model;
    }
    if (sessionEntry) {
      const authProfileId = sessionEntry.authProfileOverride;
      if (authProfileId) {
        const entry = sessionEntry;
        const store = ensureAuthProfileStore();
        const profile = store.profiles[authProfileId];
        if (!profile || profile.provider !== providerForAuthProfileValidation) {
          if (sessionStore && sessionKey) {
            await clearSessionAuthProfileOverride({
              sessionEntry: entry,
              sessionStore,
              sessionKey,
              storePath,
            });
          }
        }
      }
    }

    if (!resolvedThinkLevel) {
      let catalogForThinking = modelCatalog ?? allowedModelCatalog;
      if (!catalogForThinking || catalogForThinking.length === 0) {
        modelCatalog = await loadModelCatalog({ config: cfg });
        catalogForThinking = modelCatalog;
      }
      resolvedThinkLevel = resolveThinkingDefault({
        cfg,
        provider,
        model,
        catalog: catalogForThinking,
      });
    }
    if (resolvedThinkLevel === "xhigh" && !supportsXHighThinking(provider, model)) {
      const explicitThink = Boolean(thinkOnce || thinkOverride);
      if (explicitThink) {
        throw new Error(`Thinking level "xhigh" is only supported for ${formatXHighModelHint()}.`);
      }
      resolvedThinkLevel = "high";
      if (sessionEntry && sessionStore && sessionKey && sessionEntry.thinkingLevel === "xhigh") {
        const entry = sessionEntry;
        entry.thinkingLevel = "high";
        entry.updatedAt = Date.now();
        await persistSessionEntry({
          sessionStore,
          sessionKey,
          storePath,
          entry,
        });
      }
    }
    let sessionFile: string | undefined;
    if (sessionStore && sessionKey) {
      const resolvedSessionFile = await resolveSessionTranscriptFile({
        sessionId,
        sessionKey,
        sessionStore,
        storePath,
        sessionEntry,
        agentId: sessionAgentId,
        threadId: opts.threadId,
      });
      sessionFile = resolvedSessionFile.sessionFile;
      sessionEntry = resolvedSessionFile.sessionEntry;
    }
    if (!sessionFile) {
      const resolvedSessionFile = await resolveSessionTranscriptFile({
        sessionId,
        sessionKey: sessionKey ?? sessionId,
        storePath,
        sessionEntry,
        agentId: sessionAgentId,
        threadId: opts.threadId,
      });
      sessionFile = resolvedSessionFile.sessionFile;
      sessionEntry = resolvedSessionFile.sessionEntry;
    }

    const startedAt = Date.now();
    let lifecycleEnded = false;

    let result: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
    let fallbackProvider = provider;
    let fallbackModel = model;
    try {
      const runContext = resolveAgentRunContext(opts);
      const messageChannel = resolveMessageChannel(
        runContext.messageChannel,
        opts.replyChannel ?? opts.channel,
      );
      const spawnedBy = normalizedSpawned.spawnedBy ?? sessionEntry?.spawnedBy;
      // Keep fallback candidate resolution centralized so session model overrides,
      // per-agent overrides, and default fallbacks stay consistent across callers.
      const effectiveFallbacksOverride = resolveEffectiveModelFallbacks({
        cfg,
        agentId: sessionAgentId,
        hasSessionModelOverride: Boolean(storedModelOverride),
      });

      // Track model fallback attempts so retries on an existing session don't
      // re-inject the original prompt as a duplicate user message.
      if (shouldUseLlmRouter() && !isCliProvider(provider, cfg)) {
        try {
          const health = await llmRouterHealth();
          if (health.status === "ok") {
            const selected = await llmRouterSelect({ prompt: body });
            const allowedSet = buildConfiguredAllowlistKeys({ cfg, defaultProvider: DEFAULT_PROVIDER });
            const candidateKey = modelKey(selected.selected_provider, selected.selected_model);
            if (!allowedSet || allowedSet.has(candidateKey)) {
              provider = selected.selected_provider;
              model = selected.selected_model;
            }
          }
        } catch (error) {
          log.warn(`llm-router unavailable, falling back to internal selection: ${sanitizeForLog(String(error))}`);
        }
      }

      let fallbackAttemptIndex = 0;
      const fallbackResult = await runWithModelFallback({
        cfg,
        provider,
        model,
        runId,
        agentDir,
        fallbacksOverride: effectiveFallbacksOverride,
        run: (providerOverride, modelOverride, runOptions) => {
          const isFallbackRetry = fallbackAttemptIndex > 0;
          fallbackAttemptIndex += 1;
          return runAgentAttempt({
            providerOverride,
            modelOverride,
            cfg,
            sessionEntry,
            sessionId,
            sessionKey,
            sessionAgentId,
            sessionFile,
            workspaceDir,
            body,
            isFallbackRetry,
            resolvedThinkLevel,
            timeoutMs,
            runId,
            opts,
            runContext,
            spawnedBy,
            messageChannel,
            skillsSnapshot,
            resolvedVerboseLevel,
            agentDir,
            authProfileProvider: providerForAuthProfileValidation,
            sessionStore,
            storePath,
            allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
            onAgentEvent: (evt) => {
              // Track lifecycle end for fallback emission below.
              if (
                evt.stream === "lifecycle" &&
                typeof evt.data?.phase === "string" &&
                (evt.data.phase === "end" || evt.data.phase === "error")
              ) {
                lifecycleEnded = true;
              }
            },
          });
        },
      });
      result = fallbackResult.result;
      fallbackProvider = fallbackResult.provider;
      fallbackModel = fallbackResult.model;
      if (!lifecycleEnded) {
        const stopReason = result.meta.stopReason;
        if (stopReason && stopReason !== "end_turn") {
          console.error(`[agent] run ${runId} ended with stopReason=${stopReason}`);
        }
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: {
            phase: "end",
            startedAt,
            endedAt: Date.now(),
            aborted: result.meta.aborted ?? false,
            stopReason,
          },
        });
      }
    } catch (err) {
      if (!lifecycleEnded) {
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: {
            phase: "error",
            startedAt,
            endedAt: Date.now(),
            error: String(err),
          },
        });
      }
      throw err;
    }

    // Update token+model fields in the session store.
    if (sessionStore && sessionKey) {
      await updateSessionStoreAfterAgentRun({
        cfg,
        contextTokensOverride: agentCfg?.contextTokens,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: provider,
        defaultModel: model,
        fallbackProvider,
        fallbackModel,
        result,
      });
    }

    const payloads = result.payloads ?? [];
    return await deliverAgentCommandResult({
      cfg,
      deps,
      runtime,
      opts,
      outboundSession,
      sessionEntry,
      result,
      payloads,
    });
  } finally {
    clearAgentRunContext(runId);
  }
}

export async function agentCommand(
  opts: AgentCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps: CliDeps = createDefaultDeps(),
) {
  return await agentCommandInternal(
    {
      ...opts,
      // agentCommand is the trusted-operator entrypoint used by CLI/local flows.
      // Ingress callers must opt into owner semantics explicitly via
      // agentCommandFromIngress so network-facing paths cannot inherit this default by accident.
      senderIsOwner: opts.senderIsOwner ?? true,
      // Local/CLI callers are trusted by default for per-run model overrides.
      allowModelOverride: opts.allowModelOverride ?? true,
    },
    runtime,
    deps,
  );
}

export async function agentCommandFromIngress(
  opts: AgentCommandIngressOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps: CliDeps = createDefaultDeps(),
) {
  if (typeof opts.senderIsOwner !== "boolean") {
    // HTTP/WS ingress must declare the trust level explicitly at the boundary.
    // This keeps network-facing callers from silently picking up the local trusted default.
    throw new Error("senderIsOwner must be explicitly set for ingress agent runs.");
  }
  if (typeof opts.allowModelOverride !== "boolean") {
    throw new Error("allowModelOverride must be explicitly set for ingress agent runs.");
  }
  return await agentCommandInternal(
    {
      ...opts,
      senderIsOwner: opts.senderIsOwner,
      allowModelOverride: opts.allowModelOverride,
    },
    runtime,
    deps,
  );
}
