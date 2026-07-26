/**
 * Orchestrates one agent attempt across embedded, CLI, and ACP runtimes.
 */
import type { AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import {
  normalizeOptionalLowercaseString,
  type FastMode,
} from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import { ACP_TURN_TIMEOUT_DETAIL_CODE } from "../../acp/control-plane/manager.turn-timeout.js";
import { formatAcpErrorChain } from "../../acp/runtime/errors.js";
import { resolveAcpToolTerminalOutcome } from "../../acp/tool-status.js";
import { normalizeReplyPayload } from "../../auto-reply/reply/normalize-reply.js";
import {
  readChannelSourceTurnId,
  readChannelSourceTurnSameThreadRequired,
  setChannelSourceTurnId,
  setChannelSourceTurnSameThreadRequired,
} from "../../auto-reply/reply/source-turn-id.js";
import type { ThinkLevel, VerboseLevel } from "../../auto-reply/thinking.js";
import { persistSessionTranscriptTurn } from "../../config/sessions/session-accessor.js";
import { readTailAssistantTextFromSessionTranscript } from "../../config/sessions/transcript.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  injectTimestamp,
  timestampOptsFromConfig,
} from "../../gateway/server-methods/agent-timestamp.js";
import { emitAgentAuditEvent, emitAgentEvent } from "../../infra/agent-events.js";
import { emitTrustedDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { readErrorName } from "../../infra/errors.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import {
  buildPersistedUserTurnMessage,
  preparePersistedUserTurnMessageForTranscriptWrite,
  type PersistedUserTurnMessage,
  type UserTurnInput,
  type UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { buildWorkspaceSkillSnapshot } from "../../skills/loading/workspace.js";
import {
  getGeneratedMediaTaskIdsForSessionKey,
  hasNewGeneratedMediaTaskForSessionKey,
} from "../../tasks/task-status-access.js";
import { resolveUserPath } from "../../utils.js";
import { resolveMessageChannel } from "../../utils/message-channel.js";
import { resolveAuthProfileOrder } from "../auth-profiles/order.js";
import { ensureAuthProfileStore } from "../auth-profiles/store.js";
import { resolveBootstrapWarningSignaturesSeen } from "../bootstrap-budget.js";
import { resolveCliBackendConfig } from "../cli-backends.js";
import {
  cliBackendAcceptsAuthProfileForwarding,
  resolveCliExecutionAuthProfileId,
} from "../cli-execution-auth.js";
import { runCliAgent } from "../cli-runner.js";
import { hasClaudeLiveSessionForOwner } from "../cli-runner/claude-live-session.js";
import { resolveCliRuntimeToolsAllow } from "../cli-runner/tool-policy.js";
import { getCliSessionBinding } from "../cli-session.js";
import { runEmbeddedAgent, type EmbeddedAgentRunResult } from "../embedded-agent.js";
import { FailoverError } from "../failover-error.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../harness/hook-helpers.js";
import { resolveAvailableAgentHarnessPolicy } from "../harness/selection.js";
import { resolveCliRuntimeExecutionProvider } from "../model-runtime-aliases.js";
import { isCliProvider } from "../model-selection.js";
import { resolveOpenAIRuntimeProvider } from "../openai-routing.js";
import type { AgentRunSessionTarget } from "../run-session-target.js";
import { resolveAgentRunAbortLifecycleFields } from "../run-termination.js";
import { buildAgentRuntimeAuthPlan } from "../runtime-plan/auth.js";
import type { AgentMessage } from "../runtime/index.js";
import { withLocalSessionPlacementTurnAdmission } from "../session-placement-admission.js";
import { buildUsageWithNoCost } from "../stream-message-shared.js";
import { isSubagentAnnounceCompletionHandoff } from "../subagent-announce-handoff.js";
import {
  buildClaudeCliFallbackContextPrelude,
  claudeCliSessionTranscriptHasContent,
  resolveFallbackRetryPrompt,
} from "./attempt-execution.helpers.js";
import { resolveAgentRunContext } from "./run-context.js";
import {
  clearCliSessionInStore,
  consumeCliSessionForkInStore,
  persistCliSessionForkSuccessorInStore,
  restoreCliSessionForkInStore,
} from "./session-store.js";
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
function shouldSuppressEmbeddedLiveStreamOutput(params: { opts: AgentCommandOpts }): boolean {
  return params.opts.sessionEffects === "internal" && params.opts.deliver !== true;
}

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
  sessionFile?: string;
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

type PersistTextTurnTranscriptResult =
  | { kind: "persisted"; sessionEntry: SessionEntry | undefined }
  | { kind: "session-rebound"; sessionEntry: undefined };

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

  if (!params.allowHarnessAuthProfileForwarding) {
    return { authProfileProvider: params.authProfileProvider };
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
): Promise<PersistTextTurnTranscriptResult> {
  const promptText = params.transcriptBody ?? params.body;
  const replyText = params.finalText;
  const userMessage =
    params.userMessage ??
    (promptText
      ? ({
          role: "user",
          content: promptText,
          timestamp: Date.now(),
        } as PersistedUserTurnMessage)
      : undefined);
  if (!userMessage && !replyText) {
    return { kind: "persisted", sessionEntry: params.sessionEntry };
  }

  const messages = [];
  if (userMessage) {
    messages.push({
      message: userMessage,
      idempotencyLookup: "scan" as const,
      prepareMessageAfterIdempotencyCheck: (message: unknown) =>
        preparePersistedUserTurnMessageForTranscriptWrite(message as PersistedUserTurnMessage, {
          agentId: params.sessionAgentId,
          sessionKey: params.sessionKey,
          beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
        }),
    });
  }

  if (replyText) {
    messages.push({
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
      shouldAppend: async ({ sessionFile }: { sessionFile: string }) => {
        if (!params.embeddedAssistantGapFill) {
          return true;
        }
        const latest = await readTailAssistantTextFromSessionTranscript(sessionFile, {
          excludeTranscriptOnlyOpenClawAssistant: true,
        });
        const normalizedReply = normalizeTranscriptMirrorText(replyText);
        const normalizedLatest = latest?.text ? normalizeTranscriptMirrorText(latest.text) : "";
        return !normalizedLatest || normalizedLatest !== normalizedReply;
      },
    });
  }

  const turn = await persistSessionTranscriptTurn(
    {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionFile,
      sessionEntry: params.sessionEntry,
      sessionStore: params.sessionStore,
      storePath: params.storePath,
      agentId: params.sessionAgentId,
      threadId: params.threadId,
    },
    {
      config: params.config,
      cwd: params.sessionCwd,
      messages,
      publishWhen: "always",
      touchSessionEntry: true,
      updateMode: "file-only",
      ...(params.sessionStore && params.storePath ? { expectedSessionId: params.sessionId } : {}),
    },
  );
  if (turn.rejectedReason === "session-rebound") {
    return { kind: "session-rebound", sessionEntry: undefined };
  }
  return { kind: "persisted", sessionEntry: turn.sessionEntry };
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
  userInput?: UserTurnInput;
  finalText: string;
  sessionId: string;
  sessionKey: string;
  sessionFile?: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  sessionAgentId: string;
  threadId?: string | number;
  sessionCwd: string;
  config: OpenClawConfig;
}): Promise<PersistTextTurnTranscriptResult> {
  return await persistTextTurnTranscript({
    ...params,
    ...(params.userInput ? { userMessage: buildPersistedUserTurnMessage(params.userInput) } : {}),
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
  sessionFile?: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  sessionAgentId: string;
  threadId?: string | number;
  sessionCwd: string;
  config: OpenClawConfig;
  embeddedAssistantGapFill?: boolean;
  skipUserTurn?: boolean;
}): Promise<PersistTextTurnTranscriptResult> {
  const replyText = resolveCliTranscriptReplyText(params.result);
  const provider = params.result.meta.agentMeta?.provider?.trim() ?? "cli";
  const model = params.result.meta.agentMeta?.model?.trim() ?? "default";
  const gapFill = params.embeddedAssistantGapFill ?? false;
  const skipUserTurn = gapFill || params.skipUserTurn === true;

  return await persistTextTurnTranscript({
    body: skipUserTurn ? "" : params.body,
    transcriptBody: skipUserTurn ? undefined : params.transcriptBody,
    ...(!skipUserTurn && params.userMessage ? { userMessage: params.userMessage } : {}),
    finalText: replyText,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
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
  configuredAuthProfileId?: string;
  originalProvider: string;
  cfg: OpenClawConfig;
  sessionEntry: SessionEntry | undefined;
  agentHarnessRuntimeOverride?: string;
  sessionId: string;
  sessionKey: string | undefined;
  sessionTarget?: AgentRunSessionTarget;
  sessionAgentId: string;
  sessionFile: string;
  workspaceDir: string;
  cwd?: string;
  body: string;
  transcriptBody?: string;
  isFallbackRetry: boolean;
  resolvedThinkLevel: ThinkLevel;
  fastMode?: FastMode;
  fastModeStartedAtMs?: number;
  fastModeAutoOnSeconds?: number;
  isFinalFallbackAttempt?: boolean;
  timeoutMs: number;
  runTimeoutOverrideMs?: number;
  runId: string;
  lifecycleGeneration: string;
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
  deferTerminalLifecycle?: boolean;
  authProfileProvider: string;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  pluginsEnabled?: boolean;
  metadataSnapshot?: PluginMetadataSnapshot;
  allowTransientCooldownProbe?: boolean;
  modelFallbacksOverride?: string[];
  sessionHasHistory?: boolean;
  fallbackRuntimeState?: { originRuntime?: "cli" | "embedded" };
  suppressPromptPersistenceOnRetry?: boolean;
  userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
  onUserMessagePersisted?: (message: Extract<AgentMessage, { role: "user" }>) => void;
  onLifecycleGenerationChanged?: (lifecycleGeneration: string) => void;
}) {
  const sessionAuthProfileId = params.sessionEntry?.authProfileOverride?.trim();
  const sessionAuthProfileSource = params.sessionEntry?.authProfileOverrideSource;
  // An explicit session choice owns the conversation. Otherwise the profile
  // bound to the configured model replaces a stale automatic session choice.
  const selectedAuthProfile =
    sessionAuthProfileId && sessionAuthProfileSource !== "auto"
      ? { id: sessionAuthProfileId, source: sessionAuthProfileSource }
      : params.configuredAuthProfileId?.trim()
        ? { id: params.configuredAuthProfileId.trim(), source: "user" as const }
        : sessionAuthProfileId
          ? { id: sessionAuthProfileId, source: sessionAuthProfileSource }
          : undefined;
  const isRawModelRun = params.opts.modelRun === true || params.opts.promptMode === "none";
  // A completion handoff relays frozen child output; letting it act with the
  // requester's tools would turn child text into a new privileged instruction.
  const isSubagentAnnounceHandoff = isSubagentAnnounceCompletionHandoff({
    inputProvenance: params.opts.inputProvenance,
    internalEvents: params.opts.internalEvents,
  });
  const disableTools = params.opts.modelRun === true || isSubagentAnnounceHandoff;
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
  const sessionRuntimeOverride = isRawModelRun ? undefined : params.agentHarnessRuntimeOverride;
  const locksSessionRuntimeOverride =
    sessionRuntimeOverride !== undefined && params.sessionEntry?.modelSelectionLocked === true;
  const sessionCliRuntime =
    sessionRuntimeOverride &&
    !locksSessionRuntimeOverride &&
    isCliProvider(sessionRuntimeOverride, params.cfg)
      ? sessionRuntimeOverride
      : undefined;
  const configuredCliRuntime =
    !isRawModelRun && !sessionRuntimeOverride
      ? resolveCliRuntimeExecutionProvider({
          provider: params.providerOverride,
          cfg: params.cfg,
          agentId: params.sessionAgentId,
          modelId: params.modelOverride,
          authProfileId: selectedAuthProfile?.id,
        })
      : undefined;
  const cliExecutionProvider = isRawModelRun
    ? params.providerOverride
    : (sessionCliRuntime ?? configuredCliRuntime ?? params.providerOverride);
  const isCliExecutionProvider = sessionRuntimeOverride
    ? sessionCliRuntime !== undefined
    : isCliProvider(cliExecutionProvider, params.cfg);
  if (params.fallbackRuntimeState && params.fallbackRuntimeState.originRuntime === undefined) {
    params.fallbackRuntimeState.originRuntime =
      !isRawModelRun && isCliExecutionProvider ? "cli" : "embedded";
  }
  const shouldForwardImagesToEmbedded =
    !params.isFallbackRetry || params.fallbackRuntimeState?.originRuntime === "cli";
  const allowCliAuthProfileForwarding =
    isCliExecutionProvider &&
    cliBackendAcceptsAuthProfileForwarding({
      provider: cliExecutionProvider,
      config: params.cfg,
      agentId: params.sessionAgentId,
    });
  const agentHarnessPolicy = isRawModelRun
    ? ({ runtime: "openclaw", runtimeSource: "model" } as const)
    : sessionRuntimeOverride
      ? ({ runtime: sessionRuntimeOverride, runtimeSource: "model" } as const)
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
    sessionAuthProfileId: selectedAuthProfile?.id,
    sessionAuthProfileSource: selectedAuthProfile?.source,
    harnessId: requestedAgentHarnessId,
    harnessRuntime: agentHarnessPolicy.runtime,
    ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
    providerAuthAliasesEnabled: params.pluginsEnabled,
    allowHarnessAuthProfileForwarding: !isCliExecutionProvider,
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
    allowHarnessAuthProfileForwarding: !isCliExecutionProvider,
  });
  const cliAuthProfileId = allowCliAuthProfileForwarding
    ? resolveCliExecutionAuthProfileId({
        cliExecutionProvider,
        authProfileProvider: params.authProfileProvider,
        config: params.cfg,
        agentDir: params.agentDir,
        selected: harnessAuthSelection,
      })
    : undefined;
  const authProfileId = allowCliAuthProfileForwarding
    ? cliAuthProfileId
    : runtimeAuthPlan.forwardedAuthProfileId;
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
    sessionRuntimeOverride ??
    (agentHarnessPolicy.runtime === "openclaw" && agentHarnessPolicy.runtimeSource !== "implicit"
      ? "openclaw"
      : undefined);
  if (!isRawModelRun && isCliExecutionProvider) {
    const cliSessionBinding = getCliSessionBinding(params.sessionEntry, cliExecutionProvider);
    const cliProcessCwd = params.cwd ? resolveUserPath(params.cwd) : params.workspaceDir;
    const cliPrompt =
      params.opts.inputProvenance?.kind === "inter_session"
        ? effectivePrompt
        : injectTimestamp(effectivePrompt, timestampOptsFromConfig(params.cfg));
    const mutableCliSessionStore =
      params.sessionKey && params.sessionStore && params.storePath
        ? {
            sessionKey: params.sessionKey,
            sessionStore: params.sessionStore,
            storePath: params.storePath,
          }
        : undefined;
    const resolveReusableCliSessionBinding = async () => {
      const hasManagedClaudeLiveSession = Boolean(
        isClaudeCliProvider(cliExecutionProvider) &&
        cliSessionBinding?.sessionId &&
        hasClaudeLiveSessionForOwner({
          backendId: cliExecutionProvider,
          agentAccountId: params.runContext.accountId,
          agentId: params.sessionAgentId,
          authProfileId: cliSessionBinding.authProfileId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
        }),
      );
      if (
        !isClaudeCliProvider(cliExecutionProvider) ||
        !cliSessionBinding?.sessionId ||
        hasManagedClaudeLiveSession ||
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

      // The store is already cleared above, so no stale --resume can leak to a
      // later turn. Still return the bound id as the reuse candidate: prepare
      // re-detects the missing transcript, keeps useResume=false, and arms
      // raw-transcript reseed from prior OpenClaw history. Returning undefined
      // strips the candidate and starves reseed, losing warm-stdin continuity.
      return cliSessionBinding;
    };
    const mediaTaskIdsBefore = getGeneratedMediaTaskIdsForSessionKey(params.sessionKey);
    const runCliWithSession = async (
      nextCliSessionId: string | undefined,
      activeCliSessionBinding = cliSessionBinding,
    ) => {
      const forkCliSessionOnResume = activeCliSessionBinding?.forkNextResume === true;
      if (
        forkCliSessionOnResume &&
        !resolveCliBackendConfig(cliExecutionProvider, params.cfg, {
          agentId: params.sessionAgentId,
        })?.config.forkArg
      ) {
        throw new Error(`CLI backend "${cliExecutionProvider}" does not support session forks`);
      }
      const forkStoreParams =
        forkCliSessionOnResume && nextCliSessionId && mutableCliSessionStore
          ? {
              provider: cliExecutionProvider,
              expectedCliSessionId: nextCliSessionId,
              ...mutableCliSessionStore,
            }
          : undefined;
      return withLocalSessionPlacementTurnAdmission(
        {
          sessionId: params.sessionId,
          sessionKey: params.sessionKey ?? params.sessionId,
          agentId: params.sessionAgentId,
          runId: params.runId,
        },
        () =>
          runCliAgent({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            sessionEntry: params.sessionEntry,
            agentId: params.sessionAgentId,
            trigger: "user",
            sessionFile: params.sessionFile,
            storePath: params.storePath,
            workspaceDir: params.workspaceDir,
            cwd: params.cwd,
            config: params.cfg,
            prompt: cliPrompt,
            transcriptPrompt: params.transcriptBody,
            modelProvider: params.providerOverride,
            provider: cliExecutionProvider,
            model: params.modelOverride,
            thinkLevel: params.resolvedThinkLevel,
            timeoutMs: params.timeoutMs,
            runTimeoutOverrideMs: params.runTimeoutOverrideMs,
            runId: params.runId,
            lifecycleGeneration: params.lifecycleGeneration,
            lane: params.opts.lane,
            extraSystemPrompt: params.opts.extraSystemPrompt,
            inputProvenance: params.opts.inputProvenance,
            sourceReplyDeliveryMode: params.opts.sourceReplyDeliveryMode,
            requireExplicitMessageTarget:
              params.opts.requireExplicitMessageTarget ?? isSubagentSessionKey(params.sessionKey),
            cliSessionBindingFacts: params.opts.cliSessionBindingFacts,
            cliSessionId: nextCliSessionId,
            cliSessionBinding:
              nextCliSessionId === activeCliSessionBinding?.sessionId
                ? activeCliSessionBinding
                : undefined,
            forkCliSessionOnResume,
            ...(forkStoreParams
              ? {
                  claimCliSessionFork: async () => {
                    const claimed = await consumeCliSessionForkInStore(forkStoreParams);
                    if (claimed) {
                      params.sessionEntry = claimed;
                    }
                    return Boolean(claimed);
                  },
                  restoreCliSessionFork: async () => {
                    const restored = await restoreCliSessionForkInStore(forkStoreParams);
                    if (restored) {
                      params.sessionEntry = restored;
                    }
                  },
                  persistCliSessionForkSuccessor: async (successorCliSessionId: string) => {
                    const persisted = await persistCliSessionForkSuccessorInStore({
                      ...forkStoreParams,
                      successorCliSessionId,
                    });
                    if (!persisted) {
                      throw new Error("CLI session fork successor could not be persisted");
                    }
                    params.sessionEntry = persisted;
                  },
                }
              : {}),
            authProfileId,
            bootstrapPromptWarningSignaturesSeen,
            bootstrapPromptWarningSignature,
            // Image discovery must use the original turn, before retry/history decoration.
            imagePrompt: params.body,
            // Fallback prompts repeat the current task, so prompt-local images must
            // accompany every CLI process. Native dedupe requires a runtime receipt.
            images: params.opts.images,
            imageOrder: params.opts.imageOrder,
            media: params.opts.media,
            skillsSnapshot: params.skillsSnapshot,
            messageChannel: params.messageChannel,
            streamParams: params.opts.streamParams,
            messageProvider: params.opts.messageProvider ?? params.messageChannel,
            currentChannelId: params.runContext.currentChannelId,
            chatId: params.runContext.chatId,
            channelContext: params.runContext.channelContext,
            currentThreadTs: params.runContext.currentThreadTs,
            currentInboundAudio: params.runContext.currentInboundAudio,
            approvalReviewerDeviceId: params.opts.approvalReviewerDeviceId,
            agentAccountId: params.runContext.accountId,
            senderId: params.runContext.senderId,
            senderIsOwner: params.opts.senderIsOwner,
            bashElevated: params.opts.bashElevated,
            groupId: params.runContext.groupId,
            groupChannel: params.runContext.groupChannel,
            groupSpace: params.runContext.groupSpace,
            spawnedBy: params.spawnedBy,
            toolsAllow: resolveCliRuntimeToolsAllow(
              params.opts.toolsAllow,
              params.opts.toolsAllowIsDefault,
            ),
            scheduledToolPolicy: params.opts.scheduledToolPolicy,
            cleanupBundleMcpOnRunEnd: params.opts.cleanupBundleMcpOnRunEnd,
            cleanupCliLiveSessionOnRunEnd: params.opts.cleanupCliLiveSessionOnRunEnd,
            oneShotCliRun: params.opts.oneShotCliRun,
            userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
            suppressNextUserMessagePersistence: params.suppressPromptPersistenceOnRetry === true,
            disableTools,
            allowEmptyAssistantReplyAsSilent: isSubagentAnnounceHandoff,
            ...(mutableCliSessionStore && !forkCliSessionOnResume
              ? {
                  onBeforeFreshCliSessionRetry: async (retry) => {
                    if (
                      hasNewGeneratedMediaTaskForSessionKey(
                        params.sessionKey,
                        mediaTaskIdsBefore,
                      ) ||
                      retry.sessionId !== activeCliSessionBinding?.sessionId
                    ) {
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
          }),
      );
    };
    return resolveReusableCliSessionBinding().then(async (activeCliSessionBinding) => {
      try {
        return await runCliWithSession(activeCliSessionBinding?.sessionId, activeCliSessionBinding);
      } catch (err) {
        if (
          isClaudeCliProvider(cliExecutionProvider) &&
          !activeCliSessionBinding?.forkNextResume &&
          shouldClearReusedCliSessionAfterError(err) &&
          !hasNewGeneratedMediaTaskForSessionKey(params.sessionKey, mediaTaskIdsBefore) &&
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

  const embeddedRunParams: Parameters<typeof runEmbeddedAgent>[0] = {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionTarget: params.sessionTarget,
    sandboxSessionKey: params.sessionKey,
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
    chatId: params.runContext.chatId,
    channelContext: params.runContext.channelContext,
    currentThreadTs: params.runContext.currentThreadTs,
    currentInboundAudio: params.runContext.currentInboundAudio,
    replyToMode: params.runContext.replyToMode,
    hasRepliedRef: params.runContext.hasRepliedRef,
    senderId: params.runContext.senderId,
    senderIsOwner: params.opts.senderIsOwner,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    cwd: params.cwd,
    config: params.cfg,
    agentHarnessId: embeddedAgentHarnessOverride,
    modelSelectionLocked: !isRawModelRun && params.sessionEntry?.modelSelectionLocked === true,
    agentHarnessRuntimeOverride: embeddedAgentHarnessOverride,
    skillsSnapshot: params.skillsSnapshot,
    prompt: effectivePrompt,
    transcriptPrompt: params.transcriptBody,
    // CLI-origin retries cannot rely on transcript replay: orphan-user repair
    // removes the persisted CLI turn before the embedded prompt is submitted.
    images: shouldForwardImagesToEmbedded ? params.opts.images : undefined,
    imageOrder: shouldForwardImagesToEmbedded ? params.opts.imageOrder : undefined,
    media: params.opts.media,
    clientTools: params.opts.clientTools,
    provider: embeddedAgentProvider,
    model: params.modelOverride,
    modelFallbacksOverride: params.modelFallbacksOverride,
    authProfileId,
    authProfileIdSource: authProfileId ? harnessAuthSelection.authProfileIdSource : undefined,
    thinkLevel: params.resolvedThinkLevel,
    fastMode: params.fastMode,
    fastModeStartedAtMs: params.fastModeStartedAtMs,
    fastModeAutoOnSeconds: params.fastModeAutoOnSeconds,
    isFinalFallbackAttempt: params.isFinalFallbackAttempt,
    verboseLevel: params.resolvedVerboseLevel,
    bashElevated: params.opts.bashElevated,
    approvalReviewerDeviceId: params.opts.approvalReviewerDeviceId,
    timeoutMs: params.timeoutMs,
    runId: params.runId,
    lifecycleGeneration: params.lifecycleGeneration,
    lane: params.opts.lane,
    // Hidden internal runs lack an event consumer; visible lanes still feed UI and parent relays.
    suppressLiveStreamOutput: shouldSuppressEmbeddedLiveStreamOutput(params),
    abortSignal: params.opts.abortSignal,
    extraSystemPrompt: params.opts.extraSystemPrompt,
    bootstrapContextMode: params.opts.bootstrapContextMode,
    bootstrapContextRunKind: params.opts.bootstrapContextRunKind,
    toolsAllow: params.opts.toolsAllow,
    runtimePluginToolGrant: params.opts.runtimePluginToolGrant,
    trustedInternalHandoff: params.opts.trustedInternalHandoff,
    scheduledToolPolicy: params.opts.scheduledToolPolicy,
    internalEvents: params.opts.internalEvents,
    inputProvenance: params.opts.inputProvenance,
    sourceReplyDeliveryMode: params.opts.sourceReplyDeliveryMode,
    disableMessageTool: params.opts.disableMessageTool,
    swarmCollector: params.opts.swarmCollector,
    swarmOutputSchema: params.opts.swarmOutputSchema,
    forceRestartSafeTools: params.opts.forceRestartSafeTools,
    streamParams: params.opts.streamParams,
    agentDir: params.agentDir,
    allowGatewaySubagentBinding: params.opts.allowGatewaySubagentBinding,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
    cleanupBundleMcpOnRunEnd: params.opts.cleanupBundleMcpOnRunEnd,
    oneShotCliRun: params.opts.oneShotCliRun,
    modelRun: params.opts.modelRun,
    promptMode: params.opts.promptMode,
    disableTools,
    allowEmptyAssistantReplyAsSilent: isSubagentAnnounceHandoff,
    onAgentEvent: params.onAgentEvent,
    deferTerminalLifecycle: params.deferTerminalLifecycle,
    suppressNextUserMessagePersistence: params.suppressPromptPersistenceOnRetry === true,
    userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
    onUserMessagePersisted: params.onUserMessagePersisted,
    onExecutionStarted: (info) => {
      if (info?.lifecycleGeneration) {
        params.onLifecycleGenerationChanged?.(info.lifecycleGeneration);
      }
    },
    onSessionIdChanged: params.opts.onSessionIdChanged,
    bootstrapPromptWarningSignaturesSeen,
    bootstrapPromptWarningSignature,
  };
  setChannelSourceTurnId(embeddedRunParams, readChannelSourceTurnId(params.runContext));
  setChannelSourceTurnSameThreadRequired(
    embeddedRunParams,
    readChannelSourceTurnSameThreadRequired(params.runContext),
  );
  return runEmbeddedAgent(embeddedRunParams);
}

export function buildAcpResult(params: {
  payloadText: string;
  startedAt: number;
  stopReason?: string;
  resultStatus?: Extract<AcpRuntimeEvent, { type: "done" }>["status"];
  abortSignal?: AbortSignal;
}) {
  const normalizedFinalPayload = normalizeReplyPayload({
    text: params.payloadText,
  });
  const payloads = normalizedFinalPayload ? [normalizedFinalPayload] : [];
  const abortFields = resolveAgentRunAbortLifecycleFields(params.abortSignal);
  const resultCancelled = params.resultStatus === "cancelled";
  return {
    payloads,
    meta: {
      durationMs: Date.now() - params.startedAt,
      aborted: abortFields.aborted ?? resultCancelled,
      stopReason: abortFields.stopReason ?? (resultCancelled ? "stop" : params.stopReason),
    },
  };
}

export function emitAcpLifecycleStart(params: {
  runId: string;
  startedAt: number;
  sessionKey?: string;
  agentId?: string;
  lifecycleGeneration?: string;
  auditOnly?: boolean;
}) {
  const emit = params.auditOnly ? emitAgentAuditEvent : emitAgentEvent;
  emit({
    runId: params.runId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.lifecycleGeneration ? { lifecycleGeneration: params.lifecycleGeneration } : {}),
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
type ActiveAcpTool = {
  runId: string;
  sessionKey?: string;
  agentId?: string;
  toolCallId: string;
  toolName: string;
  startedAt: number;
};

export type AcpToolLifecycleTracker = {
  active: Map<string, ActiveAcpTool>;
  terminalToolCallIds: Set<string>;
  saturated: boolean;
};

const MAX_TRACKED_ACP_TOOLS = 4_096;

export function createAcpToolLifecycleTracker(): AcpToolLifecycleTracker {
  return {
    active: new Map(),
    terminalToolCallIds: new Set(),
    saturated: false,
  };
}

function acpAuditToolName(kind: unknown): string {
  switch (kind) {
    case "read":
    case "edit":
    case "delete":
    case "move":
    case "search":
    case "execute":
    case "fetch":
    case "switch_mode":
    case "think":
    case "other":
      return `acp_${kind}`;
    default:
      return "acp_tool";
  }
}

function resolveAcpToolTerminalReason(
  signal: AbortSignal | undefined,
  stopReason?: string,
  error?: unknown,
  resultStatus?: Extract<AcpRuntimeEvent, { type: "done" }>["status"],
): "failed" | "cancelled" | "timed_out" {
  const abortFields = resolveAgentRunAbortLifecycleFields(signal);
  if (abortFields.aborted) {
    return abortFields.stopReason === "timeout" ? "timed_out" : "cancelled";
  }
  const normalizedStopReason = normalizeOptionalLowercaseString(stopReason);
  if (normalizedStopReason === "timeout") {
    return "timed_out";
  }
  if (resultStatus === "cancelled") {
    return "cancelled";
  }
  if (
    error instanceof Error &&
    (error as Error & { detailCode?: unknown }).detailCode === ACP_TURN_TIMEOUT_DETAIL_CODE
  ) {
    return "timed_out";
  }
  if (
    normalizedStopReason === "cancel" ||
    normalizedStopReason === "cancelled" ||
    normalizedStopReason === "manual-cancel"
  ) {
    return "cancelled";
  }
  return "failed";
}

function resolveAcpLifecycleEndFields(
  signal: AbortSignal | undefined,
  stopReason?: string,
  resultStatus?: Extract<AcpRuntimeEvent, { type: "done" }>["status"],
) {
  const abortFields = resolveAgentRunAbortLifecycleFields(signal);
  if (abortFields.aborted) {
    return abortFields;
  }
  const terminalReason = resolveAcpToolTerminalReason(
    undefined,
    stopReason,
    undefined,
    resultStatus,
  );
  if (terminalReason === "timed_out") {
    return { aborted: true, stopReason: "timeout", status: "timed_out" } as const;
  }
  if (terminalReason === "cancelled") {
    return { aborted: true, stopReason: "stop", status: "cancelled" } as const;
  }
  return {};
}

function emitAcpToolExecutionEvent(params: {
  runId: string;
  toolTracker: AcpToolLifecycleTracker;
  sessionKey?: string;
  agentId?: string;
  abortSignal?: AbortSignal;
  event: Extract<AcpRuntimeEvent, { type: "tool_call" }>;
}): void {
  const { event } = params;
  const now = Date.now();
  const toolCallId = event.toolCallId?.trim() ? event.toolCallId : undefined;
  const activeTool = toolCallId ? params.toolTracker.active.get(toolCallId) : undefined;
  const terminalOutcome = resolveAcpToolTerminalOutcome(event.status);
  const toolName = acpAuditToolName(event.kind);
  // ACP runtimes may replay terminal updates. Keep the closed identity until the run ends so a
  // late progress/terminal pair cannot reopen one invocation as a second durable audit action.
  if (toolCallId && !activeTool) {
    if (params.toolTracker.terminalToolCallIds.has(toolCallId)) {
      return;
    }
    // Never evict an open identity: once this run reaches its bound, ignore new identities until
    // lifecycle cleanup releases the complete set. Other runs own independent trackers.
    const trackedIdentities =
      params.toolTracker.active.size + params.toolTracker.terminalToolCallIds.size;
    if (params.toolTracker.saturated || trackedIdentities >= MAX_TRACKED_ACP_TOOLS) {
      params.toolTracker.saturated = true;
      return;
    }
  }
  // Without an identity, wait for a terminal event so every observed action closes immediately.
  // Opening on progress would leave an unmatched audit action if the runtime omits its result.
  const startsUnidentifiedTool = toolCallId === undefined && terminalOutcome !== undefined;
  if (!activeTool && (toolCallId !== undefined || startsUnidentifiedTool)) {
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: params.runId,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      toolName,
      toolSource: "core",
      toolOwner: "acp",
    });
    if (toolCallId) {
      params.toolTracker.active.set(toolCallId, {
        runId: params.runId,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        ...(params.agentId ? { agentId: params.agentId } : {}),
        toolCallId,
        toolName,
        startedAt: now,
      });
    }
  }
  if (!terminalOutcome) {
    return;
  }
  const terminalReason = resolveAcpToolTerminalReason(
    params.abortSignal,
    undefined,
    undefined,
    terminalOutcome === "cancelled" ? "cancelled" : undefined,
  );
  const durationMs = Math.max(0, now - (activeTool?.startedAt ?? now));
  emitTrustedDiagnosticEvent(
    terminalOutcome === "completed"
      ? {
          type: "tool.execution.completed",
          runId: params.runId,
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          ...(params.agentId ? { agentId: params.agentId } : {}),
          ...(toolCallId ? { toolCallId } : {}),
          toolName: activeTool?.toolName ?? toolName,
          toolSource: "core",
          toolOwner: "acp",
          durationMs,
        }
      : {
          type: "tool.execution.error",
          runId: params.runId,
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          ...(params.agentId ? { agentId: params.agentId } : {}),
          ...(toolCallId ? { toolCallId } : {}),
          toolName: activeTool?.toolName ?? toolName,
          toolSource: "core",
          toolOwner: "acp",
          durationMs,
          errorCategory: terminalReason === "cancelled" ? "aborted" : "acp_tool",
          terminalReason,
        },
  );
  if (toolCallId) {
    params.toolTracker.active.delete(toolCallId);
    params.toolTracker.terminalToolCallIds.add(toolCallId);
  }
}

function finalizeAcpToolsForRun(
  toolTracker: AcpToolLifecycleTracker,
  runId: string,
  terminalReason: "failed" | "cancelled" | "timed_out",
): void {
  const now = Date.now();
  for (const activeTool of toolTracker.active.values()) {
    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      runId,
      ...(activeTool.sessionKey ? { sessionKey: activeTool.sessionKey } : {}),
      ...(activeTool.agentId ? { agentId: activeTool.agentId } : {}),
      toolName: activeTool.toolName,
      toolSource: "core",
      toolOwner: "acp",
      toolCallId: activeTool.toolCallId,
      durationMs: Math.max(0, now - activeTool.startedAt),
      errorCategory: terminalReason === "cancelled" ? "aborted" : "acp_tool_incomplete",
      terminalReason,
    });
  }
  toolTracker.active.clear();
  toolTracker.terminalToolCallIds.clear();
  toolTracker.saturated = false;
}

function resolvePresentProxyEnvKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return ACP_PROXY_ENV_KEYS.filter((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function sanitizeAcpDiagnosticText(value: string): string {
  return truncateUtf16Safe(redactSensitiveText(value).replace(/\s+/g, " ").trim(), 240);
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
      ...(event.status ? { status: event.status } : {}),
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
  toolTracker: AcpToolLifecycleTracker;
  event: AcpRuntimeEvent;
  sessionKey?: string;
  agentId?: string;
  abortSignal?: AbortSignal;
  auditOnly?: boolean;
}) {
  if (params.event.type === "tool_call") {
    emitAcpToolExecutionEvent({
      runId: params.runId,
      toolTracker: params.toolTracker,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
      event: params.event,
    });
  }
  if (!params.auditOnly) {
    emitAgentEvent({
      runId: params.runId,
      stream: "acp",
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      data: {
        phase: "runtime_event",
        ...acpRuntimeEventDiagnostics(params.event),
      },
    });
  }
}

export function emitAcpLifecycleEnd(params: {
  runId: string;
  toolTracker: AcpToolLifecycleTracker;
  sessionKey?: string;
  agentId?: string;
  lifecycleGeneration?: string;
  abortSignal?: AbortSignal;
  stopReason?: string;
  resultStatus?: Extract<AcpRuntimeEvent, { type: "done" }>["status"];
  auditOnly?: boolean;
}) {
  finalizeAcpToolsForRun(
    params.toolTracker,
    params.runId,
    resolveAcpToolTerminalReason(
      params.abortSignal,
      params.stopReason,
      undefined,
      params.resultStatus,
    ),
  );
  const emit = params.auditOnly ? emitAgentAuditEvent : emitAgentEvent;
  emit({
    runId: params.runId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.lifecycleGeneration ? { lifecycleGeneration: params.lifecycleGeneration } : {}),
    stream: "lifecycle",
    data: {
      phase: "end",
      endedAt: Date.now(),
      ...resolveAcpLifecycleEndFields(params.abortSignal, params.stopReason, params.resultStatus),
    },
  });
}

export function emitAcpLifecycleError(params: {
  runId: string;
  toolTracker: AcpToolLifecycleTracker;
  error: unknown;
  sessionKey?: string;
  agentId?: string;
  lifecycleGeneration?: string;
  abortSignal?: AbortSignal;
  terminalOutcome?: "blocked";
  auditOnly?: boolean;
}) {
  const terminalReason = resolveAcpToolTerminalReason(params.abortSignal, undefined, params.error);
  finalizeAcpToolsForRun(params.toolTracker, params.runId, terminalReason);
  const lifecycleFields =
    params.terminalOutcome === "blocked"
      ? ({ livenessState: "blocked" } as const)
      : terminalReason === "timed_out"
        ? ({ aborted: true, stopReason: "timeout", status: "timed_out" } as const)
        : resolveAgentRunAbortLifecycleFields(params.abortSignal);
  const emit = params.auditOnly ? emitAgentAuditEvent : emitAgentEvent;
  emit({
    runId: params.runId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.lifecycleGeneration ? { lifecycleGeneration: params.lifecycleGeneration } : {}),
    stream: "lifecycle",
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    data: {
      phase: "error",
      ...(!params.auditOnly ? { error: formatAcpErrorChain(params.error) } : {}),
      endedAt: Date.now(),
      ...lifecycleFields,
    },
  });
}

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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
