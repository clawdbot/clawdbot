/**
 * Orchestrates one agent attempt across embedded, CLI, and ACP runtimes.
 */
import type { AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import { formatAcpErrorChain } from "../../acp/runtime/errors.js";
import { normalizeReplyPayload } from "../../auto-reply/reply/normalize-reply.js";
import type { ThinkLevel, VerboseLevel } from "../../auto-reply/thinking.js";
import { appendSessionTranscriptMessage } from "../../config/sessions/transcript-append.js";
import {
  readTailAssistantTextFromSessionTranscript,
  resolveSessionTranscriptFile,
} from "../../config/sessions/transcript.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { readErrorName } from "../../infra/errors.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import {
  appendUserTurnTranscriptMessage,
  type PersistedUserTurnMessage,
} from "../../sessions/user-turn-transcript.js";
import { buildWorkspaceSkillSnapshot } from "../../skills/loading/workspace.js";
import { resolveUserPath } from "../../utils.js";
import { resolveMessageChannel } from "../../utils/message-channel.js";
import { resolveAuthProfileOrder } from "../auth-profiles/order.js";
import { ensureAuthProfileStore } from "../auth-profiles/store.js";
import { resolveBootstrapWarningSignaturesSeen } from "../bootstrap-budget.js";
import { runCliAgent } from "../cli-runner.js";
import { getCliSessionBinding } from "../cli-session.js";
import { runEmbeddedAgent, type EmbeddedAgentRunResult } from "../embedded-agent.js";
import { FailoverError } from "../failover-error.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../harness/hook-helpers.js";
import { resolveAvailableAgentHarnessPolicy } from "../harness/selection.js";
import { resolveCliRuntimeExecutionProvider } from "../model-runtime-aliases.js";
import { isCliProvider } from "../model-selection.js";
import { resolveOpenAIRuntimeProvider } from "../openai-routing.js";
import { buildAgentRuntimeAuthPlan } from "../runtime-plan/auth.js";
import type { AgentMessage } from "../runtime/index.js";
import { acquireSessionWriteLock, resolveSessionWriteLockOptions } from "../session-write-lock.js";
import { buildUsageWithNoCost } from "../stream-message-shared.js";
import {
  buildClaudeCliFallbackContextPrelude,
  claudeCliSessionTranscriptHasContent,
  resolveFallbackRetryPrompt,
} from "./attempt-execution.helpers.js";
import { persistSessionEntry } from "./attempt-execution.shared.js";
import { resolveAgentRunContext } from "./run-context.js";
import { clearCliSessionInStore } from "./session-store.js";
import type { AgentCommandOpts } from "./types.js";

export {
  createAcpVisibleTextAccumulator,
  sessionFileHasContent,
} from "./attempt-execution.helpers.js";

const log = createSubsystemLogger("agents/agent-command");

function shouldClearReusedCliSessionAfterError(err: unknown): boolean {
  if (readErrorName(err) === "AbortError") {
    return true;
  }
  return err instanceof FailoverError;
}

function resolveClearedCliSessionReason(err: unknown): string {
  if (err instanceof FailoverError) {
    return err.reason;
  }
  return readErrorName(err) || "error";
}

function normalizeTranscriptMirrorText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
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

type TranscriptUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

type PersistTextTurnTranscriptParams = {
  body: string;
  transcriptBody?: string;
  userMessage?: PersistedUserTurnMessage;
  finalText: string;
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  sessionAgentId: string;
  threadId?: string | number;
  sessionCwd: string;
  config: OpenClawConfig;
  embeddedAssistantGapFill?: boolean;
  assistant: {
    api: string;
    provider: string;
    model: string;
    usage?: TranscriptUsage;
  };
};

type HarnessAuthProfileSelection = {
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  authProfileProvider: string;
  authProfileMode?: string;
};

function resolveProfileAuthFromStore(params: { agentDir: string; profileId: string | undefined }): {
  provider?: string;
  mode?: string;
} {
  const profileId = params.profileId?.trim();
  if (!profileId) {
    return {};
  }
  const credential = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
    externalCliProfileIds: [profileId],
  }).profiles[profileId];
  return { provider: credential?.provider, mode: credential?.type };
}

function resolveHarnessAuthProfileSelection(params: {
  config: OpenClawConfig;
  agentDir: string;
  workspaceDir: string;
  provider: string;
  authProfileProvider: string;
  sessionAuthProfileId?: string;
  sessionAuthProfileSource?: "auto" | "user";
  harnessId?: string;
  harnessRuntime?: string;
  metadataSnapshot?: PluginMetadataSnapshot;
  providerAuthAliasesEnabled?: boolean;
  allowHarnessAuthProfileForwarding: boolean;
}): HarnessAuthProfileSelection {
  const sessionAuthProfileId = params.sessionAuthProfileId?.trim();
  if (sessionAuthProfileId) {
    const profileAuth = resolveProfileAuthFromStore({
      agentDir: params.agentDir,
      profileId: sessionAuthProfileId,
    });
    return {
      authProfileId: sessionAuthProfileId,
      authProfileIdSource: params.sessionAuthProfileSource,
      authProfileProvider: profileAuth.provider ?? params.authProfileProvider,
      authProfileMode: profileAuth.mode,
    };
  }

  const runtimeAuthPlan = buildAgentRuntimeAuthPlan({
    provider: params.provider,
    authProfileProvider: params.authProfileProvider,
    config: params.config,
    workspaceDir: params.workspaceDir,
    ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
    providerAuthAliasesEnabled: params.providerAuthAliasesEnabled,
    harnessId: params.harnessId,
    harnessRuntime: params.harnessRuntime,
    allowHarnessAuthProfileForwarding: params.allowHarnessAuthProfileForwarding,
  });
  const harnessAuthProvider = runtimeAuthPlan.harnessAuthProvider;
  if (!harnessAuthProvider) {
    return { authProfileProvider: params.authProfileProvider };
  }

  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
    externalCliProviderIds: [harnessAuthProvider],
  });
  const authProfileId = resolveAuthProfileOrder({
    cfg: params.config,
    store,
    provider: harnessAuthProvider,
  })[0];

  return authProfileId
    ? {
        authProfileId,
        authProfileIdSource: "auto",
        authProfileProvider: harnessAuthProvider,
      }
    : { authProfileProvider: params.authProfileProvider };
}

function resolveTranscriptUsage(usage: PersistTextTurnTranscriptParams["assistant"]["usage"]) {
  if (!usage) {
    return ACP_TRANSCRIPT_USAGE;
  }
  return buildUsageWithNoCost({
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.total,
  });
}

async function persistTextTurnTranscript(
  params: PersistTextTurnTranscriptParams,
): Promise<SessionEntry | undefined> {
  const promptText = params.transcriptBody ?? params.body;
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
  const lock = await acquireSessionWriteLock({
    sessionFile,
    ...resolveSessionWriteLockOptions(params.config),
    allowReentrant: true,
  });
  let transcriptMarkerUpdatedAt: number | undefined;
  try {
    let wroteTranscript = false;
    const userMessage = params.userMessage;
    if (userMessage || promptText) {
      await appendUserTurnTranscriptMessage({
        transcriptPath: sessionFile,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        cwd: params.sessionCwd,
        config: params.config,
        beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
        ...(userMessage
          ? { message: userMessage }
          : {
              input: {
                text: promptText,
                timestamp: Date.now(),
              },
            }),
        updateMode: "none",
      });
      wroteTranscript = true;
    }

    if (replyText) {
      let appendAssistant = true;
      if (params.embeddedAssistantGapFill) {
        const latest = await readTailAssistantTextFromSessionTranscript(sessionFile);
        const normalizedReply = normalizeTranscriptMirrorText(replyText);
        const normalizedLatest = latest?.text ? normalizeTranscriptMirrorText(latest.text) : "";
        if (normalizedLatest && normalizedLatest === normalizedReply) {
          appendAssistant = false;
        }
      }
      if (appendAssistant) {
        await appendSessionTranscriptMessage({
          transcriptPath: sessionFile,
          sessionId: params.sessionId,
          cwd: params.sessionCwd,
          config: params.config,
          message: {
            role: "assistant",
            content: [{ type: "text", text: replyText }],
            api: params.assistant.api,
            provider: params.assistant.provider,
            model: params.assistant.model,
            usage: resolveTranscriptUsage(params.assistant.usage),
            stopReason: "stop",
            timestamp: Date.now(),
          },
        });
        wroteTranscript = true;
      }
    }
    if (wroteTranscript) {
      transcriptMarkerUpdatedAt = Date.now();
    }
  } finally {
    await lock.release();
  }

  let updatedSessionEntry = sessionEntry;
  if (params.sessionStore && params.storePath && transcriptMarkerUpdatedAt !== undefined) {
    const currentEntry = params.sessionStore[params.sessionKey] ?? sessionEntry;
    if (currentEntry?.sessionId === params.sessionId) {
      // Keep updatedAt as the registry marker for transcript writes we own.
      // Session reuse checks compare transcript mtime against this marker, not endedAt.
      updatedSessionEntry =
        (await persistSessionEntry({
          sessionStore: params.sessionStore,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          entry: {
            sessionId: params.sessionId,
            sessionFile,
            updatedAt: transcriptMarkerUpdatedAt,
          },
          preserveTranscriptMarkerUpdatedAt: true,
          shouldPersist: (current) => current?.sessionId === params.sessionId,
        })) ?? updatedSessionEntry;
    }
  }

  emitSessionTranscriptUpdate({
    sessionFile,
    sessionKey: params.sessionKey,
    agentId: params.sessionAgentId,
  });
  return updatedSessionEntry;
}

function resolveCliTranscriptReplyText(result: EmbeddedAgentRunResult): string {
  const visibleText = result.meta.finalAssistantVisibleText?.trim();
  if (visibleText) {
    return visibleText;
  }

  return (result.payloads ?? [])
    .filter((payload) => !payload.isError && !payload.isReasoning)
    .map((payload) => payload.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
}

function isClaudeCliProvider(provider: string): boolean {
  return provider.trim().toLowerCase() === "claude-cli";
}

export async function persistAcpTurnTranscript(params: {
  body: string;
  transcriptBody?: string;
  finalText: string;
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  sessionAgentId: string;
  threadId?: string | number;
  sessionCwd: string;
  config: OpenClawConfig;
}): Promise<SessionEntry | undefined> {
  return await persistTextTurnTranscript({
    ...params,
    assistant: {
      api: "openai-responses",
      provider: "openclaw",
      model: "acp-runtime",
    },
  });
}

export async function persistCliTurnTranscript(params: {
  body: string;
  transcriptBody?: string;
  userMessage?: PersistedUserTurnMessage;
  result: EmbeddedAgentRunResult;
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  sessionAgentId: string;
  threadId?: string | number;
  sessionCwd: string;
  config: OpenClawConfig;
  embeddedAssistantGapFill?: boolean;
}): Promise<SessionEntry | undefined> {
  const replyText = resolveCliTranscriptReplyText(params.result);
  const provider = params.result.meta.agentMeta?.provider?.trim() ?? "cli";
  const model = params.result.meta.agentMeta?.model?.trim() ?? "default";
  const gapFill = params.embeddedAssistantGapFill ?? false;

  return await persistTextTurnTranscript({
    body: gapFill ? "" : params.body,
    transcriptBody: gapFill ? undefined : params.transcriptBody,
    ...(!gapFill && params.userMessage ? { userMessage: params.userMessage } : {}),
    finalText: replyText,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    storePath: params.storePath,
    sessionAgentId: params.sessionAgentId,
    threadId: params.threadId,
    sessionCwd: params.sessionCwd,
    config: params.config,
    embeddedAssistantGapFill: gapFill,
    assistant: {
      api: "cli",
      provider,
      model,
      usage: params.result.meta.agentMeta?.usage,
    },
  });
}

export function runAgentAttempt(params: {
  providerOverride: string;
  modelOverride: string;
  originalProvider: string;
  cfg: OpenClawConfig;
  sessionEntry: SessionEntry | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  sessionAgentId: string;
  sessionFile: string;
  workspaceDir: string;
  cwd?: string;
  body: string;
  isFallbackRetry: boolean;
  resolvedThinkLevel: ThinkLevel;
  fastMode?: boolean;
  timeoutMs: number;
  runId: string;
  opts: AgentCommandOpts;
  runContext: ReturnType<typeof resolveAgentRunContext>;
  spawnedBy: string | undefined;
  messageChannel: ReturnType<typeof resolveMessageChannel>;
  skillsSnapshot: ReturnType<typeof buildWorkspaceSkillSnapshot> | undefined;
  resolvedVerboseLevel: VerboseLevel | undefined;
  agentDir: string;
  onAgentEvent: (evt: {
    stream: string;
    data?: Record<string, unknown>;
    sessionKey?: string;
  }) => void;
  deferTerminalLifecycleEnd?: boolean;
  authProfileProvider: string;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  pluginsEnabled?: boolean;
  metadataSnapshot?: PluginMetadataSnapshot;
  allowTransientCooldownProbe?: boolean;
  modelFallbacksOverride?: string[];
  sessionHasHistory?: boolean;
  suppressPromptPersistenceOnRetry?: boolean;
  onUserMessagePersisted?: (message: Extract<AgentMessage, { role: "user" }>) => void;
}) {
  const isRawModelRun = params.opts.modelRun === true || params.opts.promptMode === "none";
  const claudeCliFallbackPrelude =
    !isRawModelRun &&
    params.isFallbackRetry &&
    isClaudeCliProvider(params.originalProvider) &&
    !isClaudeCliProvider(params.providerOverride)
      ? buildClaudeCliFallbackContextPrelude({
          cliSessionId: getCliSessionBinding(params.sessionEntry, "claude-cli")?.sessionId,
        })
      : "";
  const resolvedPrompt = resolveFallbackRetryPrompt({
    body: params.body,
    isFallbackRetry: params.isFallbackRetry,
    sessionHasHistory: params.sessionHasHistory,
    priorContextPrelude: claudeCliFallbackPrelude,
  });
  const effectivePrompt = isRawModelRun
    ? resolvedPrompt
    : annotateInterSessionPromptText(resolvedPrompt, params.opts.inputProvenance);
  const bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
    params.sessionEntry?.systemPromptReport,
  );
  const bootstrapPromptWarningSignature =
    bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1];
  const requestedAgentHarnessId = isRawModelRun ? "openclaw" : undefined;
  const cliExecutionProvider = isRawModelRun
    ? params.providerOverride
    : (resolveCliRuntimeExecutionProvider({
        provider: params.providerOverride,
        cfg: params.cfg,
        agentId: params.sessionAgentId,
        modelId: params.modelOverride,
        authProfileId: params.sessionEntry?.authProfileOverride,
      }) ?? params.providerOverride);
  const agentHarnessPolicy = isRawModelRun
    ? ({ runtime: "openclaw", runtimeSource: "model" } as const)
    : resolveAvailableAgentHarnessPolicy({
        provider: params.providerOverride,
        modelId: params.modelOverride,
        config: params.cfg,
        agentId: params.sessionAgentId,
        sessionKey: params.sessionKey ?? params.sessionId,
      });
  const harnessAuthSelection = resolveHarnessAuthProfileSelection({
    config: params.cfg,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    provider: params.providerOverride,
    authProfileProvider: params.authProfileProvider,
    sessionAuthProfileId: params.sessionEntry?.authProfileOverride,
    sessionAuthProfileSource: params.sessionEntry?.authProfileOverrideSource,
    harnessId: requestedAgentHarnessId,
    harnessRuntime: agentHarnessPolicy.runtime,
    ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
    providerAuthAliasesEnabled: params.pluginsEnabled,
    allowHarnessAuthProfileForwarding: !isCliProvider(cliExecutionProvider, params.cfg),
  });
  const runtimeAuthPlan = buildAgentRuntimeAuthPlan({
    provider: params.providerOverride,
    authProfileProvider: harnessAuthSelection.authProfileProvider,
    authProfileMode: harnessAuthSelection.authProfileMode,
    sessionAuthProfileId: harnessAuthSelection.authProfileId,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
    providerAuthAliasesEnabled: params.pluginsEnabled,
    harnessId: requestedAgentHarnessId,
    harnessRuntime: agentHarnessPolicy.runtime,
    allowHarnessAuthProfileForwarding: !isCliProvider(cliExecutionProvider, params.cfg),
  });
  const authProfileId = runtimeAuthPlan.forwardedAuthProfileId;
  const embeddedAgentProvider = resolveOpenAIRuntimeProvider({
    provider: params.providerOverride,
    harnessRuntime: agentHarnessPolicy.runtime,
    agentHarnessId: requestedAgentHarnessId,
    authProfileProvider: runtimeAuthPlan.authProfileProviderForAuth,
    authProfileId,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
  });
  const embeddedAgentHarnessOverride =
    requestedAgentHarnessId ??
    (agentHarnessPolicy.runtime === "openclaw" && agentHarnessPolicy.runtimeSource !== "implicit"
      ? "openclaw"
      : undefined);
  if (!isRawModelRun && isCliProvider(cliExecutionProvider, params.cfg)) {
    const cliSessionBinding = getCliSessionBinding(params.sessionEntry, cliExecutionProvider);
    const cliProcessCwd = params.cwd ? resolveUserPath(params.cwd) : params.workspaceDir;
    const mutableCliSessionStore =
      params.sessionKey && params.sessionStore && params.storePath
        ? {
            sessionKey: params.sessionKey,
            sessionStore: params.sessionStore,
            storePath: params.storePath,
          }
        : undefined;
    const resolveReusableCliSessionBinding = async () => {
      if (
        !isClaudeCliProvider(cliExecutionProvider) ||
        !cliSessionBinding?.sessionId ||
        (await claudeCliSessionTranscriptHasContent({
          sessionId: cliSessionBinding.sessionId,
          workspaceDir: cliProcessCwd,
        }))
      ) {
        return cliSessionBinding;
      }

      log.warn(
        `cli session reset: provider=${sanitizeForLog(cliExecutionProvider)} reason=transcript-missing sessionKey=${params.sessionKey ?? params.sessionId}`,
      );

      if (mutableCliSessionStore) {
        params.sessionEntry =
          (await clearCliSessionInStore({
            provider: cliExecutionProvider,
            ...mutableCliSessionStore,
          })) ?? params.sessionEntry;
      }

      return undefined;
    };
    const runCliWithSession = (
      nextCliSessionId: string | undefined,
      activeCliSessionBinding = cliSessionBinding,
    ) =>
      runCliAgent({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionEntry: params.sessionEntry,
        agentId: params.sessionAgentId,
        trigger: "user",
        sessionFile: params.sessionFile,
        workspaceDir: params.workspaceDir,
        cwd: params.cwd,
        config: params.cfg,
        prompt: effectivePrompt,
        provider: cliExecutionProvider,
        model: params.modelOverride,
        thinkLevel: params.resolvedThinkLevel,
        timeoutMs: params.timeoutMs,
        runId: params.runId,
        extraSystemPrompt: params.opts.extraSystemPrompt,
        inputProvenance: params.opts.inputProvenance,
        cliSessionId: nextCliSessionId,
        cliSessionBinding:
          nextCliSessionId === activeCliSessionBinding?.sessionId
            ? activeCliSessionBinding
            : undefined,
        authProfileId,
        bootstrapPromptWarningSignaturesSeen,
        bootstrapPromptWarningSignature,
        images: params.isFallbackRetry ? undefined : params.opts.images,
        imageOrder: params.isFallbackRetry ? undefined : params.opts.imageOrder,
        skillsSnapshot: params.skillsSnapshot,
        messageChannel: params.messageChannel,
        streamParams: params.opts.streamParams,
        messageProvider: params.opts.messageProvider ?? params.messageChannel,
        currentChannelId: params.runContext.currentChannelId,
        currentThreadTs: params.runContext.currentThreadTs,
        currentInboundAudio: params.runContext.currentInboundAudio,
        agentAccountId: params.runContext.accountId,
        senderIsOwner: params.opts.senderIsOwner,
        toolsAllow: params.opts.toolsAllow,
        cleanupBundleMcpOnRunEnd: params.opts.cleanupBundleMcpOnRunEnd,
        cleanupCliLiveSessionOnRunEnd: params.opts.cleanupCliLiveSessionOnRunEnd,
        ...(mutableCliSessionStore
          ? {
              onBeforeFreshCliSessionRetry: async (retry) => {
                if (retry.sessionId !== activeCliSessionBinding?.sessionId) {
                  return false;
                }

                log.warn(
                  `CLI session failed, clearing before fresh retry: provider=${sanitizeForLog(cliExecutionProvider)} sessionKey=${mutableCliSessionStore.sessionKey} reason=${sanitizeForLog(retry.reason)}`,
                );

                params.sessionEntry =
                  (await clearCliSessionInStore({
                    provider: cliExecutionProvider,
                    ...mutableCliSessionStore,
                  })) ?? params.sessionEntry;
                return true;
              },
            }
          : {}),
      });
    return resolveReusableCliSessionBinding().then(async (activeCliSessionBinding) => {
      try {
        return await runCliWithSession(activeCliSessionBinding?.sessionId, activeCliSessionBinding);
      } catch (err) {
        if (
          isClaudeCliProvider(cliExecutionProvider) &&
          shouldClearReusedCliSessionAfterError(err) &&
          activeCliSessionBinding?.sessionId &&
          mutableCliSessionStore
        ) {
          log.warn(
            `CLI session cleared after failed reused turn: provider=${sanitizeForLog(cliExecutionProvider)} sessionKey=${mutableCliSessionStore.sessionKey} reason=${sanitizeForLog(resolveClearedCliSessionReason(err))}`,
          );

          params.sessionEntry =
            (await clearCliSessionInStore({
              provider: cliExecutionProvider,
              ...mutableCliSessionStore,
            })) ?? params.sessionEntry;
        }
        throw err;
      }
    });
  }

  return runEmbeddedAgent({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.sessionAgentId,
    trigger: "user",
    messageChannel: params.messageChannel,
    messageProvider: params.opts.messageProvider ?? params.messageChannel,
    agentAccountId: params.runContext.accountId,
    messageTo: params.opts.replyTo ?? params.opts.to,
    messageThreadId: params.opts.threadId,
    groupId: params.runContext.groupId,
    groupChannel: params.runContext.groupChannel,
    groupSpace: params.runContext.groupSpace,
    spawnedBy: params.spawnedBy,
    currentChannelId: params.runContext.currentChannelId,
    currentThreadTs: params.runContext.currentThreadTs,
    currentInboundAudio: params.runContext.currentInboundAudio,
    replyToMode: params.runContext.replyToMode,
    hasRepliedRef: params.runContext.hasRepliedRef,
    senderIsOwner: params.opts.senderIsOwner,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    cwd: params.cwd,
    config: params.cfg,
    agentHarnessId: embeddedAgentHarnessOverride,
    agentHarnessRuntimeOverride: embeddedAgentHarnessOverride,
    skillsSnapshot: params.skillsSnapshot,
    prompt: effectivePrompt,
    images: params.isFallbackRetry ? undefined : params.opts.images,
    imageOrder: params.isFallbackRetry ? undefined : params.opts.imageOrder,
    clientTools: params.opts.clientTools,
    provider: embeddedAgentProvider,
    model: params.modelOverride,
    modelFallbacksOverride: params.modelFallbacksOverride,
    authProfileId,
    authProfileIdSource: authProfileId ? harnessAuthSelection.authProfileIdSource : undefined,
    thinkLevel: params.resolvedThinkLevel,
    fastMode: params.fastMode,
    verboseLevel: params.resolvedVerboseLevel,
    bashElevated: params.opts.bashElevated,
    timeoutMs: params.timeoutMs,
    runId: params.runId,
    lane: params.opts.lane,
    abortSignal: params.opts.abortSignal,
    extraSystemPrompt: params.opts.extraSystemPrompt,
    bootstrapContextMode: params.opts.bootstrapContextMode,
    bootstrapContextRunKind: params.opts.bootstrapContextRunKind,
    toolsAllow: params.opts.toolsAllow,
    internalEvents: params.opts.internalEvents,
    inputProvenance: params.opts.inputProvenance,
    sourceReplyDeliveryMode: params.opts.sourceReplyDeliveryMode,
    disableMessageTool: params.opts.disableMessageTool,
    streamParams: params.opts.streamParams,
    agentDir: params.agentDir,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
    cleanupBundleMcpOnRunEnd: params.opts.cleanupBundleMcpOnRunEnd,
    modelRun: params.opts.modelRun,
    promptMode: params.opts.promptMode,
    disableTools: params.opts.modelRun === true,
    onAgentEvent: params.onAgentEvent,
    deferTerminalLifecycleEnd: params.deferTerminalLifecycleEnd,
    suppressNextUserMessagePersistence: params.suppressPromptPersistenceOnRetry === true,
    onUserMessagePersisted: params.onUserMessagePersisted,
    bootstrapPromptWarningSignaturesSeen,
    bootstrapPromptWarningSignature,
  });
}

export function buildAcpResult(params: {
  payloadText: string;
  startedAt: number;
  stopReason?: string;
  abortSignal?: AbortSignal;
}) {
  const normalizedFinalPayload = normalizeReplyPayload({
    text: params.payloadText,
  });
  const payloads = normalizedFinalPayload ? [normalizedFinalPayload] : [];
  return {
    payloads,
    meta: {
      durationMs: Date.now() - params.startedAt,
      aborted: params.abortSignal?.aborted === true,
      stopReason: params.stopReason,
    },
  };
}

export function emitAcpLifecycleStart(params: { runId: string; startedAt: number }) {
  emitAgentEvent({
    runId: params.runId,
    stream: "lifecycle",
    data: {
      phase: "start",
      startedAt: params.startedAt,
    },
  });
}

const ACP_PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

function resolvePresentProxyEnvKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return ACP_PROXY_ENV_KEYS.filter((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function sanitizeAcpDiagnosticText(value: string): string {
  return redactSensitiveText(value).replace(/\s+/g, " ").trim().slice(0, 240);
}

function acpRuntimeEventDiagnostics(event: AcpRuntimeEvent): Record<string, unknown> {
  if (event.type === "status") {
    return {
      eventType: event.type,
      text: sanitizeAcpDiagnosticText(event.text),
      ...(event.tag ? { tag: event.tag } : {}),
    };
  }
  if (event.type === "tool_call") {
    return {
      eventType: event.type,
      text: sanitizeAcpDiagnosticText(event.text),
      ...(event.tag ? { tag: event.tag } : {}),
      ...(event.status ? { status: sanitizeAcpDiagnosticText(event.status) } : {}),
      ...(event.title ? { title: sanitizeAcpDiagnosticText(event.title) } : {}),
      ...(event.toolCallId ? { toolCallId: sanitizeAcpDiagnosticText(event.toolCallId) } : {}),
    };
  }
  if (event.type === "error") {
    return {
      eventType: event.type,
      message: sanitizeAcpDiagnosticText(event.message),
      ...(event.code ? { code: sanitizeAcpDiagnosticText(event.code) } : {}),
      ...(typeof event.retryable === "boolean" ? { retryable: event.retryable } : {}),
    };
  }
  if (event.type === "done") {
    return {
      eventType: event.type,
      ...(event.stopReason ? { stopReason: sanitizeAcpDiagnosticText(event.stopReason) } : {}),
    };
  }
  return {
    eventType: event.type,
    stream: event.stream ?? "output",
  };
}

export function emitAcpPromptSubmitted(params: { runId: string; sessionKey?: string; at: number }) {
  emitAgentEvent({
    runId: params.runId,
    stream: "acp",
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    data: {
      phase: "prompt_submitted",
      at: params.at,
      proxyEnvKeys: resolvePresentProxyEnvKeys(),
    },
  });
}

export function emitAcpRuntimeEvent(params: {
  runId: string;
  event: AcpRuntimeEvent;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "acp",
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    data: {
      phase: "runtime_event",
      ...acpRuntimeEventDiagnostics(params.event),
    },
  });
}

export function emitAcpLifecycleEnd(params: { runId: string }) {
  emitAgentEvent({
    runId: params.runId,
    stream: "lifecycle",
    data: {
      phase: "end",
      endedAt: Date.now(),
    },
  });
}

export function emitAcpLifecycleError(params: {
  runId: string;
  error: unknown;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "lifecycle",
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    data: {
      phase: "error",
      error: formatAcpErrorChain(params.error),
      endedAt: Date.now(),
    },
  });
}

/** @deprecated use formatAcpErrorChain from src/acp/runtime/errors.ts */
export const formatAcpLifecycleError = formatAcpErrorChain;

export function emitAcpAssistantDelta(params: { runId: string; text: string; delta: string }) {
  emitAgentEvent({
    runId: params.runId,
    stream: "assistant",
    data: {
      text: params.text,
      delta: params.delta,
    },
  });
}
