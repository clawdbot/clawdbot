import type { AgentMessage } from "@earendil-works/pi-agent-core";
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
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { sanitizeForLog } from "../../terminal/ansi.js";
import { resolveMessageChannel } from "../../utils/message-channel.js";
import { resolveAuthProfileOrder } from "../auth-profiles/order.js";
import { ensureAuthProfileStore } from "../auth-profiles/store.js";
import { resolveBootstrapWarningSignaturesSeen } from "../bootstrap-budget.js";
import { runCliAgent } from "../cli-runner.js";
import { getCliSessionBinding, setCliSessionBinding } from "../cli-session.js";
import { FailoverError } from "../failover-error.js";
import { resolveAvailableAgentHarnessPolicy } from "../harness/selection.js";
import { resolveCliRuntimeExecutionProvider } from "../model-runtime-aliases.js";
import { isCliProvider } from "../model-selection.js";
import { resolveOpenAIRuntimeProviderForPi } from "../openai-codex-routing.js";
import { runEmbeddedPiAgent, type EmbeddedPiRunResult } from "../pi-embedded.js";
import { buildAgentRuntimeAuthPlan } from "../runtime-plan/auth.js";
import {
  acquireSessionWriteLock,
  resolveSessionWriteLockAcquireTimeoutMs,
} from "../session-write-lock.js";
import { buildWorkspaceSkillSnapshot } from "../skills.js";
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
    timeoutMs: resolveSessionWriteLockAcquireTimeoutMs(params.config),
    allowReentrant: true,
  });
  try {
    if (promptText) {
      await appendSessionTranscriptMessage({
        transcriptPath: sessionFile,
        sessionId: params.sessionId,
        cwd: params.sessionCwd,
        config: params.config,
        message: {
          role: "user",
          content: promptText,
          timestamp: Date.now(),
        },
      });
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
      }
    }
  } finally {
    await lock.release();
  }

  emitSessionTranscriptUpdate({ sessionFile, sessionKey: params.sessionKey });
  return sessionEntry;
}

function resolveCliTranscriptReplyText(result: EmbeddedPiRunResult): string {
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
  result: EmbeddedPiRunResult;
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
  body: string;
  isFallbackRetry: boolean;
  resolvedThinkLevel: ThinkLevel;
  fastMode?: boolean;
  timeoutMs: number;
  runId: string;
  opts: AgentCommandOpts & { senderIsOwner: boolean };
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
  authProfileProvider: string;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
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
  const requestedAgentHarnessId = isRawModelRun ? "pi" : undefined;
  const cliExecutionProvider = isRawModelRun
    ? params.providerOverride
    : (resolveCliRuntimeExecutionProvider({
        provider: params.providerOverride,
        cfg: params.cfg,
        agentId: params.sessionAgentId,
        modelId: params.modelOverride,
      }) ?? params.providerOverride);
  const agentHarnessPolicy = isRawModelRun
    ? ({ runtime: "pi" } as const)
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
    allowHarnessAuthProfileForwarding: !isCliProvider(cliExecutionProvider, params.cfg),
  });
  const runtimeAuthPlan = buildAgentRuntimeAuthPlan({
    provider: params.providerOverride,
    authProfileProvider: harnessAuthSelection.authProfileProvider,
    authProfileMode: harnessAuthSelection.authProfileMode,
    sessionAuthProfileId: harnessAuthSelection.authProfileId,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    harnessId: requestedAgentHarnessId,
    harnessRuntime: agentHarnessPolicy.runtime,
    allowHarnessAuthProfileForwarding: !isCliProvider(cliExecutionProvider, params.cfg),
  });
  const authProfileId = runtimeAuthPlan.forwardedAuthProfileId;
  const embeddedPiProvider = resolveOpenAIRuntimeProviderForPi({
    provider: params.providerOverride,
    harnessRuntime: agentHarnessPolicy.runtime,
    agentHarnessId: requestedAgentHarnessId,
    authProfileProvider: runtimeAuthPlan.authProfileProviderForAuth,
    authProfileId,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
  });
  const embeddedPiHarnessOverride =
    requestedAgentHarnessId ??
    (agentHarnessPolicy.runtime === "pi" && embeddedPiProvider !== params.providerOverride
      ? "pi"
      : undefined);
  if (!isRawModelRun && isCliProvider(cliExecutionProvider, params.cfg)) {
    const cliSessionBinding = getCliSessionBinding(params.sessionEntry, cliExecutionProvider);
    const resolveReusableCliSessionBinding = async () => {
      if (
        !isClaudeCliProvider(cliExecutionProvider) ||
        !cliSessionBinding?.sessionId ||
        (await claudeCliSessionTranscriptHasContent({ sessionId: cliSessionBinding.sessionId }))
      ) {
        return cliSessionBinding;
      }

      log.warn(
        `cli session reset: provider=${sanitizeForLog(cliExecutionProvider)} reason=transcript-missing sessionKey=${params.sessionKey ?? params.sessionId}`,
      );

      if (params.sessionKey && params.sessionStore && params.storePath) {
        params.sessionEntry =
          (await clearCliSessionInStore({
            provider: cliExecutionProvider,
            sessionKey: params.sessionKey,
            sessionStore: params.sessionStore,
            storePath: params.storePath,
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
        agentId: params.sessionAgentId,
        trigger: "user",
        sessionFile: params.sessionFile,
        workspaceDir: params.workspaceDir,
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
        agentAccountId: params.runContext.accountId,
        senderIsOwner: params.opts.senderIsOwner,
        toolsAllow: params.opts.toolsAllow,
        cleanupBundleMcpOnRunEnd: params.opts.cleanupBundleMcpOnRunEnd,
        cleanupCliLiveSessionOnRunEnd: params.opts.cleanupCliLiveSessionOnRunEnd,
      });
    return resolveReusableCliSessionBinding().then(async (activeCliSessionBinding) => {
      try {
        return await runCliWithSession(activeCliSessionBinding?.sessionId, activeCliSessionBinding);
      } catch (err) {
        if (
          err instanceof FailoverError &&
          err.reason === "session_expired" &&
          activeCliSessionBinding?.sessionId &&
          params.sessionKey &&
          params.sessionStore &&
          params.storePath
        ) {
          log.warn(
            `CLI session expired, clearing from session store: provider=${sanitizeForLog(cliExecutionProvider)} sessionKey=${params.sessionKey}`,
          );

          params.sessionEntry =
            (await clearCliSessionInStore({
              provider: cliExecutionProvider,
              sessionKey: params.sessionKey,
              sessionStore: params.sessionStore,
              storePath: params.storePath,
            })) ?? params.sessionEntry;

          return await runCliWithSession(undefined).then(async (result) => {
            if (
              result.meta.agentMeta?.cliSessionBinding?.sessionId &&
              params.sessionKey &&
              params.sessionStore &&
              params.storePath
            ) {
              const entry = params.sessionStore[params.sessionKey];
              if (entry) {
                const updatedEntry = { ...entry };
                setCliSessionBinding(
                  updatedEntry,
                  cliExecutionProvider,
                  result.meta.agentMeta.cliSessionBinding,
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
      }
    });
  }

  return runEmbeddedPiAgent({
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
    replyToMode: params.runContext.replyToMode,
    hasRepliedRef: params.runContext.hasRepliedRef,
    senderIsOwner: params.opts.senderIsOwner,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    config: params.cfg,
    agentHarnessId: embeddedPiHarnessOverride,
    agentHarnessRuntimeOverride: embeddedPiHarnessOverride,
    skillsSnapshot: params.skillsSnapshot,
    prompt: effectivePrompt,
    images: params.isFallbackRetry ? undefined : params.opts.images,
    imageOrder: params.isFallbackRetry ? undefined : params.opts.imageOrder,
    clientTools: params.opts.clientTools,
    provider: embeddedPiProvider,
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
    streamParams: params.opts.streamParams,
    agentDir: params.agentDir,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
    cleanupBundleMcpOnRunEnd: params.opts.cleanupBundleMcpOnRunEnd,
    modelRun: params.opts.modelRun,
    promptMode: params.opts.promptMode,
    disableTools: params.opts.modelRun === true,
    onAgentEvent: params.onAgentEvent,
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
