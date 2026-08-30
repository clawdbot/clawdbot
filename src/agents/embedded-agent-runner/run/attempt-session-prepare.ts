/**
 * Prepares transcript boundaries, session management, and active resources.
 * It may assume attempt configuration and tool inputs are ready.
 */
import type { SessionTranscriptRuntimeTarget } from "../../../config/sessions/session-accessor.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../../context-engine/host-compat.js";
import {
  attachRuntimePromptMediaFacts,
  readPersistedMediaFacts,
} from "../../../media/media-facts.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import type { NestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import { createPreparedEmbeddedAgentSettingsManager } from "../../agent-project-settings.js";
import {
  applyAgentAutoCompactionGuard,
  applyAgentCompactionSettingsFromConfig,
  isSilentOverflowProneModel,
  resolveEffectiveCompactionMode,
} from "../../agent-settings.js";
import { toToolDefinitions } from "../../agent-tool-definition-adapter.js";
import { sanitizeCompactionReplayMessages } from "../../compaction-replay.js";
import { resolveUserTimezone } from "../../date-time.js";
import { bootstrapHarnessContextEngine } from "../../harness/context-engine-lifecycle.js";
import { relocateCurrentRuntimeContextCarrierToTail } from "../../internal-runtime-context.js";
import type { AgentMessage } from "../../runtime/index.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  type AgentSession,
  type CreateAgentSessionOptions,
  SessionManager,
} from "../../sessions/index.js";
import { createAgentSessionForEmbeddedRunner } from "../../sessions/sdk.js";
import { wrapToolDefinition } from "../../sessions/tools/tool-definition-wrapper.js";
import { resolveToolSearchCatalogTool } from "../../tool-search.js";
import { runContextEngineMaintenance } from "../context-engine-maintenance.js";
import { buildEmbeddedExtensionFactories } from "../extensions.js";
import { log } from "../logger.js";
import { createEmbeddedAgentResourceLoader } from "../resource-loader.js";
import { applySystemPromptToSession } from "../system-prompt.js";
import { prepareEmbeddedAttemptClientTools } from "./attempt-client-tools.js";
import type { AttemptContextEngine } from "./attempt-context-engine-helpers.js";
import { resolveAttemptTranscriptPolicy } from "./attempt-history.js";
import { normalizeMessagesForLlmBoundary } from "./attempt-llm-boundary.js";
import {
  replayTrailingEntriesForOrphanRepair,
  resolveOrphanRepairPlan,
} from "./attempt-orphan-repair.js";
import { buildAfterTurnRuntimeContext } from "./attempt-prompt-helpers.js";
import { installStepAuditApi, STEP_AUDIT_FEEDBACK_MARKER } from "./attempt-step-audit.js";
import { resolveExistingAttemptTranscriptState } from "./attempt-transcript-helpers.js";
import type { EmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle.js";
import { createUserTranscriptContextRegistry } from "./attempt-user-transcript-context-registry.js";
import { installCodeModeOutcomeHook } from "./code-mode-outcome.js";
import { buildCodeModeRecoveryCandidate } from "./code-mode-reconciliation.js";
import { installMessageToolOnlyTerminalHook } from "./message-tool-terminal.js";
import { reconcilePrePersistedCurrentUserTurn } from "./pre-persisted-user-turn.js";
import { resolveSessionBoundaryPromptCacheKey } from "./session-boundary-prompt-cache-key.js";
import { notifyToolActivity } from "./tool-activity-heartbeat.js";
import {
  createToolLoopBatchAdmission,
  installToolLoopRecoveryCleanup,
} from "./tool-loop-recovery.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/**
 * Prepares embedded-agent resources, tools, and active sessions.
 */

type ClientToolPreparation = Omit<
  Parameters<typeof prepareEmbeddedAttemptClientTools>[0],
  "attempt"
>;

type AttemptSessionManager = ReturnType<typeof guardSessionManager>;

/** Prepares resource loading, client tools, and the active agent session. */
export async function prepareEmbeddedAttemptAgentSession(input: {
  attempt: EmbeddedRunAttemptParams;
  activeContextEngineInfo?: AttemptContextEngine["info"];
  agentCoreThinkingLevel: CreateAgentSessionOptions["thinkingLevel"];
  agentDir: string;
  clientToolPreparation: ClientToolPreparation;
  effectiveCwd: string;
  getCurrentAttemptPluginMetadataSnapshot: () => PluginMetadataSnapshot | undefined;
  initialSystemPrompt: string;
  markStage: (stage: string) => void;
  onSessionCreated: (session: AgentSession) => void;
  onSystemPromptChanged: (systemPrompt: string) => void;
  runAbortSignal: AbortSignal;
  sessionAgentId: string;
  transcriptLifecycle: EmbeddedAttemptTranscriptLifecycle;
  sessionManager: AttemptSessionManager;
  nestedToolActivities: readonly NestedToolActivity[];
}) {
  const { attempt } = input;
  const settingsManager = createPreparedEmbeddedAgentSettingsManager({
    cwd: input.effectiveCwd,
    agentDir: input.agentDir,
    cfg: attempt.config,
    pluginMetadataSnapshot: input.getCurrentAttemptPluginMetadataSnapshot(),
    contextTokenBudget: attempt.contextTokenBudget,
  });
  const autoCompactionGuardArgs = {
    settingsManager,
    contextEngineInfo: input.activeContextEngineInfo,
    compactionMode: resolveEffectiveCompactionMode(attempt.config),
    silentOverflowProneProvider: isSilentOverflowProneModel({
      provider: attempt.provider,
      modelId: attempt.modelId,
      baseUrl: attempt.model.baseUrl ?? undefined,
    }),
  };
  applyAgentAutoCompactionGuard(autoCompactionGuardArgs);

  // These factories carry compaction/pruning runtime state into the resource loader.
  const extensionFactories = buildEmbeddedExtensionFactories({
    cfg: attempt.config,
    sessionManager: input.sessionManager,
    provider: attempt.provider,
    modelId: attempt.modelId,
    model: attempt.model,
    contextTokenBudget: attempt.contextTokenBudget,
    agentId: input.sessionAgentId,
    sessionId: attempt.sessionId,
    sessionKey: attempt.sessionKey ?? attempt.sandboxSessionKey,
    runId: attempt.runId,
  });
  const resourceLoader = createEmbeddedAgentResourceLoader({
    cwd: input.effectiveCwd,
    agentDir: input.agentDir,
    settingsManager,
    extensionFactories,
  });
  await resourceLoader.reload();
  // reload() rehydrates disk settings. Reapply OpenClaw's context budget and
  // auto-compaction guards before the session can submit a prompt (#75799).
  applyAgentCompactionSettingsFromConfig({
    settingsManager,
    cfg: attempt.config,
    contextTokenBudget: attempt.contextTokenBudget,
  });
  applyAgentAutoCompactionGuard(autoCompactionGuardArgs);
  input.markStage("session-resource-loader");

  // Tool creation needs the same runner later used by lifecycle hooks.
  const hookRunner = getGlobalHookRunner();
  const preparedClientTools = prepareEmbeddedAttemptClientTools({
    attempt,
    ...input.clientToolPreparation,
  });
  const { allCustomTools, sessionToolAllowlist, ...clientToolRuntime } = preparedClientTools;

  const sessionOptions: CreateAgentSessionOptions = {
    cwd: input.effectiveCwd,
    agentDir: input.agentDir,
    authStorage: attempt.authStorage,
    modelRegistry: attempt.modelRegistry,
    model: attempt.model,
    thinkingLevel: input.agentCoreThinkingLevel,
    tools: sessionToolAllowlist,
    customTools: allCustomTools,
    sessionManager: input.sessionManager,
    settingsManager,
    resourceLoader,
    resolveDeferredTool: input.clientToolPreparation.deferredDirectoryToolsCallable
      ? ({ toolCall }) => {
          const tool = resolveToolSearchCatalogTool(
            {
              config: attempt.config,
              runtimeConfig: attempt.config,
              agentId: input.sessionAgentId,
              sessionKey: input.clientToolPreparation.sandboxSessionKey,
              sessionId: attempt.sessionId,
              runId: attempt.runId,
              catalogRef: input.clientToolPreparation.toolSearchCatalogRef,
              abortSignal: input.runAbortSignal,
            },
            toolCall.name,
          );
          // Catalog entries already own before_tool_call wrapping.
          const definition = tool
            ? toToolDefinitions([tool], input.clientToolPreparation.catalogToolHookContext)[0]
            : undefined;
          const hydratedTool = definition ? wrapToolDefinition(definition) : undefined;
          if (hydratedTool) {
            log.info(`tool-search: hydrated deferred directory tool ${toolCall.name}`);
            const originalExecute = hydratedTool.execute;
            hydratedTool.execute = (async (...args: Parameters<typeof originalExecute>) => {
              const interval = setInterval(() => notifyToolActivity(attempt.runId), 60_000);
              interval.unref?.();
              try {
                notifyToolActivity(attempt.runId);
                return await originalExecute(...args);
              } finally {
                clearInterval(interval);
                notifyToolActivity(attempt.runId);
              }
            }) as typeof originalExecute;
          }
          return hydratedTool;
        }
      : undefined,
    withSessionWriteSettlement: (operation) =>
      input.transcriptLifecycle.withTranscriptWrite(operation),
  };
  const createdSession = await createAgentSessionForEmbeddedRunner(sessionOptions, {
    // Without a resolved model budget, the outer loop cannot own bounded recovery.
    contextOverflowRecoveryOwner: attempt.contextTokenBudget === undefined ? "session" : "caller",
    beforeToolBatch: input.clientToolPreparation.catalogToolHookContext
      ? createToolLoopBatchAdmission(
          input.clientToolPreparation.catalogToolHookContext,
          attempt.codeModeRecovery,
        )
      : undefined,
  });
  const activeSession = createdSession.session;
  if (!activeSession) {
    throw new Error("Embedded agent session missing");
  }
  // Publish ownership before post-construction hooks. Outer cleanup must dispose
  // the session if tool activation or terminal-hook installation fails.
  input.onSessionCreated(activeSession);
  installToolLoopRecoveryCleanup({ agent: activeSession.agent, runId: attempt.runId });
  activeSession.setActiveToolsByName(sessionToolAllowlist);
  // Step-audit checkpoints: review plugins capture the transcript tail before
  // each tool/text step and roll a rejected step back via the returned API
  // (published on `globalThis.__openclawStepAuditRegistry` keyed by runId).
  installStepAuditApi({
    runId: attempt.runId,
    activeSession,
    sessionManager: input.sessionManager,
    feedbackMarker: STEP_AUDIT_FEEDBACK_MARKER,
  });
  const setActiveSessionSystemPrompt = (nextSystemPrompt: string) => {
    input.onSystemPromptChanged(nextSystemPrompt);
    applySystemPromptToSession(activeSession, nextSystemPrompt);
  };
  setActiveSessionSystemPrompt(input.initialSystemPrompt);
  let didDeliverSourceReplyViaMessageTool = false;
  let codeModeRecoveryCandidate: ReturnType<typeof buildCodeModeRecoveryCandidate> | undefined;
  let codeModeReconciliationReadAuthorized = false;
  const markSourceReplyDelivered = () => {
    didDeliverSourceReplyViaMessageTool = true;
  };
  installMessageToolOnlyTerminalHook({
    agent: activeSession.agent,
    sourceReplyDeliveryMode: attempt.sourceReplyDeliveryMode,
    onDeliveredSourceReply: markSourceReplyDelivered,
    config: attempt.config,
    currentProvider: attempt.messageChannel ?? attempt.messageProvider,
    currentAccountId: attempt.agentAccountId,
    currentChannelId: attempt.currentChannelId,
    currentMessagingTarget: attempt.currentMessagingTarget,
    currentThreadId: attempt.currentThreadTs,
    currentMessageId: attempt.currentMessageId,
    replyToMode: attempt.replyToMode,
    hasRepliedRef: attempt.hasRepliedRef,
    sessionKey: attempt.sessionKey,
  });
  if (input.clientToolPreparation.codeModeControlsEnabledForRun) {
    installCodeModeOutcomeHook({
      agent: activeSession.agent,
      onReconciliationCandidate: (parentToolCallId) => {
        if (codeModeReconciliationReadAuthorized) {
          codeModeRecoveryCandidate = buildCodeModeRecoveryCandidate({
            parentToolCallId,
            nestedToolActivities: input.nestedToolActivities,
          });
        }
      },
    });
  }
  input.markStage("agent-session");

  return {
    activeSession,
    allCustomTools,
    ...clientToolRuntime,
    getCodeModeRecoveryCandidate: () => codeModeRecoveryCandidate,
    hasDeliveredSourceReply: () => didDeliverSourceReplyViaMessageTool,
    hookRunner,
    markSourceReplyDelivered,
    setCodeModeReconciliationReadAuthorized: (value: boolean) => {
      codeModeReconciliationReadAuthorized = clientToolRuntime.coreReadAuthorized && value;
    },
    setActiveSessionSystemPrompt,
    settingsManager,
  };
}

/** Prepares the restored transcript at the LLM boundary for one attempt. */

type SessionBoundaryAttempt = Pick<
  EmbeddedRunAttemptParams,
  | "config"
  | "onUserMessagePersistenceInvalidated"
  | "operation"
  | "prompt"
  | "suppressNextUserMessagePersistence"
  | "trigger"
  | "userTurnTranscriptRecorder"
>;

type LlmBoundaryOptions = NonNullable<Parameters<typeof normalizeMessagesForLlmBoundary>[1]>;

type CurrentUserTimestampOverride = NonNullable<LlmBoundaryOptions["currentUserTimestampOverride"]>;

export function prepareEmbeddedAttemptSessionBoundary(input: {
  activeSession: Pick<AgentSession, "agent">;
  attempt: SessionBoundaryAttempt;
  getUserTranscriptContexts: () => LlmBoundaryOptions["userTranscriptContexts"];
  isRawModelRun: boolean;
  preparedUserTurnMessage: AgentMessage | undefined;
  sessionManager: ReturnType<typeof guardSessionManager>;
  setActiveSessionSystemPrompt: (systemPrompt: string) => void;
}): {
  boundaryTimezone: string | undefined;
  includeBoundaryTimestamp: boolean;
  orphanRepair: ReturnType<typeof resolveOrphanRepairPlan>;
  setCurrentUserTimestampOverride: (override: CurrentUserTimestampOverride | undefined) => void;
} {
  const { activeSession, attempt, isRawModelRun, sessionManager } = input;
  const preserveExactPrompt = isRawModelRun || attempt.operation === "settled-tool-finalization";
  if (isRawModelRun) {
    // Raw probes measure only the requested provider prompt. Restored history,
    // queued work, and the normal system prompt would contaminate it.
    activeSession.agent.reset();
    input.setActiveSessionSystemPrompt("");
  }

  const orphanRepairCandidate = preserveExactPrompt
    ? undefined
    : resolveOrphanRepairPlan({
        sessionManager,
        prompt: attempt.prompt,
        trigger: attempt.trigger,
      });
  // Admission can persist the turn before prompt preparation intentionally omits it.
  // Prefer the recorder-owned row so orphan repair cannot detach the canonical leaf.
  const currentUserTurnMessage =
    attempt.userTurnTranscriptRecorder?.getPersistedMessage?.() ?? input.preparedUserTurnMessage;
  const reconciledCurrentUser =
    !preserveExactPrompt &&
    reconcilePrePersistedCurrentUserTurn({
      activeSession,
      currentUserTurnMessage,
      durableUserTurnMessage: orphanRepairCandidate?.messageEntry.message,
      userTurnAlreadyPersisted: attempt.userTurnTranscriptRecorder?.hasPersisted() === true,
    });
  const orphanRepair = reconciledCurrentUser ? undefined : orphanRepairCandidate;
  if (orphanRepair?.removeLeaf) {
    if (orphanRepair.messageEntry.parentId) {
      sessionManager.branch(orphanRepair.messageEntry.parentId);
    } else {
      sessionManager.resetLeaf();
    }
    replayTrailingEntriesForOrphanRepair(sessionManager, orphanRepair.trailingEntries);
    // The old canonical user turn is gone. Its persistence suppression must not
    // discard the merged replacement prompt.
    sessionManager.clearNextUserMessagePersistenceSuppression?.();
    attempt.onUserMessagePersistenceInvalidated?.();
    activeSession.agent.state.messages = sanitizeCompactionReplayMessages(
      sessionManager.buildSessionContext().messages,
    );
  }

  // This is the single timestamping source for user messages sent to the LLM.
  // Raw probes retain exact prompt bytes.
  const boundaryTimezone = preserveExactPrompt
    ? undefined
    : resolveUserTimezone(attempt.config?.agents?.defaults?.userTimezone);
  const includeBoundaryTimestamp = !preserveExactPrompt;
  let currentUserTimestampOverride: CurrentUserTimestampOverride | undefined;
  const buildBoundaryOptions = (): LlmBoundaryOptions => {
    if (preserveExactPrompt) {
      return { projectPersistedSenderContext: false };
    }
    const userTranscriptContexts = input.getUserTranscriptContexts();
    return {
      ...(boundaryTimezone ? { timezone: boundaryTimezone } : {}),
      ...(includeBoundaryTimestamp ? {} : { includeTimestamp: false }),
      ...(userTranscriptContexts?.length ? { userTranscriptContexts } : {}),
      ...(currentUserTimestampOverride ? { currentUserTimestampOverride } : {}),
    };
  };

  if (typeof activeSession.agent.convertToLlm === "function") {
    const baseConvertToLlm = activeSession.agent.convertToLlm.bind(activeSession.agent);
    activeSession.agent.convertToLlm = async (messages) =>
      await baseConvertToLlm(
        // Wire-only relocation keeps the request append-only through the active
        // user turn without changing position-sensitive precheck normalization.
        relocateCurrentRuntimeContextCarrierToTail(
          normalizeMessagesForLlmBoundary(messages, buildBoundaryOptions()),
        ),
      );
  }

  return {
    boundaryTimezone,
    includeBoundaryTimestamp,
    orphanRepair,
    setCurrentUserTimestampOverride: (override) => {
      currentUserTimestampOverride = override;
    },
  };
}

/**
 * Prepares the durable session manager before embedded-agent session creation.
 */

type WithOwnedTranscriptWrite = <T>(operation: () => Promise<T> | T) => Promise<T>;
export async function prepareEmbeddedAttemptSessionManager(input: {
  attempt: EmbeddedRunAttemptParams;
  activeContextEngine?: AttemptContextEngine;
  agentDir: string;
  effectiveCwd: string;
  effectiveWorkspace: string;
  onSessionManagerCreated: (sessionManager: AttemptSessionManager) => void;
  replayAllowedToolNames: ReadonlySet<string>;
  resolveActiveContextEnginePluginId: () => string | undefined;
  sessionAgentId: string;
  transcriptLifecycle: EmbeddedAttemptTranscriptLifecycle;
  withOwnedTranscriptWrite: WithOwnedTranscriptWrite;
}) {
  const { attempt } = input;
  const transcriptState = await resolveExistingAttemptTranscriptState({
    agentId: input.sessionAgentId,
    config: attempt.config,
    sessionFile: attempt.sessionFile,
    sessionId: attempt.sessionId,
    sessionKey: attempt.sessionKey,
    sessionTarget: attempt.sessionTarget,
  });
  const transcriptPolicy = resolveAttemptTranscriptPolicy({
    runtimePlan: attempt.runtimePlan,
    runtimePlanModelContext: {
      workspaceDir: input.effectiveWorkspace,
      modelApi: attempt.model.api,
      model: attempt.model,
    },
    provider: attempt.provider,
    modelId: attempt.modelId,
    config: attempt.config,
    env: process.env,
  });
  const isOpenAIResponsesApi =
    attempt.model.api === "openai-responses" ||
    attempt.model.api === "azure-openai-responses" ||
    attempt.model.api === "openai-chatgpt-responses";

  const preparedUserTurnMessage = attempt.skipPreparedUserTurnMessage
    ? undefined
    : await attempt.userTurnTranscriptRecorder?.resolveMessage();
  let latestPersistedUserMessage: AgentMessage | undefined;
  let latestRuntimeUserMessage: AgentMessage | undefined;
  let latestUserTurnTranscriptRecorder = attempt.userTurnTranscriptRecorder;
  const userTranscriptContextRegistry = createUserTranscriptContextRegistry();
  const sessionManager = guardSessionManager(
    attempt.sessionManager ??
      (attempt.sessionTarget
        ? SessionManager.open(
            attempt.sessionTarget as SessionTranscriptRuntimeTarget,
            input.effectiveCwd,
            {
              maxBytes: Math.min(
                64 * 1024 * 1024,
                Math.max(1024, (attempt.contextTokenBudget ?? 128_000) * 8),
              ),
              maxEvents: 10_000,
            },
          )
        : SessionManager.inMemory(input.effectiveCwd)),
    {
      agentId: input.sessionAgentId,
      runId: attempt.runId,
      sessionKey: attempt.sessionKey,
      config: attempt.config,
      contextWindowTokens: attempt.contextTokenBudget,
      inputProvenance: attempt.inputProvenance,
      preparedUserTurnMessage,
      preparedUserTurnTranscriptRecorder: preparedUserTurnMessage
        ? attempt.userTurnTranscriptRecorder
        : undefined,
      allowSyntheticToolResults: transcriptPolicy.allowSyntheticToolResults,
      missingToolResultText: isOpenAIResponsesApi ? "aborted" : undefined,
      allowedToolNames: input.replayAllowedToolNames,
      trigger: attempt.trigger,
      suppressNextUserMessagePersistence: attempt.suppressNextUserMessagePersistence,
      suppressTranscriptOnlyAssistantPersistence:
        attempt.suppressTranscriptOnlyAssistantPersistence,
      suppressAssistantErrorPersistence: attempt.suppressAssistantErrorPersistence,
      skipBeforeMessageWriteHooks: attempt.operation === "settled-tool-finalization",
      prepareAssistantTranscriptMessage: attempt.prepareAssistantTranscriptMessage,
      onUserMessagePreparingForPersistence: (_message, recorder) => {
        latestPersistedUserMessage = undefined;
        latestUserTurnTranscriptRecorder = recorder;
      },
      onUserMessagePersisted: (message, runtimeMessage) => {
        latestPersistedUserMessage = message;
        latestRuntimeUserMessage = runtimeMessage;
        if (runtimeMessage) {
          const media = readPersistedMediaFacts(message);
          if (media?.length) {
            attachRuntimePromptMediaFacts(runtimeMessage, media);
          }
          userTranscriptContextRegistry.record(runtimeMessage, message);
        }
        attempt.onUserMessagePersisted?.(message);
      },
      onUserMessagePersistenceSuppressed: (message, runtimeMessage) => {
        latestRuntimeUserMessage = runtimeMessage;
        const media = runtimeMessage ? readPersistedMediaFacts(message) : undefined;
        if (runtimeMessage && media?.length) {
          attachRuntimePromptMediaFacts(runtimeMessage, media);
        }
      },
      onUserMessageBlocked: () => {
        attempt.userTurnTranscriptRecorder?.markBlocked();
      },
      onAssistantErrorMessagePersisted: (message) => {
        attempt.onAssistantErrorMessagePersisted?.(message);
      },
    },
  );
  attempt.promptCacheKey = resolveSessionBoundaryPromptCacheKey({
    api: attempt.model.api,
    boundaryCount: sessionManager.getBoundaryCount(),
    promptCacheKey: attempt.promptCacheKey,
    sessionId: attempt.sessionId,
  });
  // Publish ownership before async bootstrap. Outer cleanup must close this manager
  // even when a context-engine or transcript preparation step fails.
  input.onSessionManagerCreated(sessionManager);

  await input.withOwnedTranscriptWrite(async () => {
    await bootstrapHarnessContextEngine({
      hadSessionFile: transcriptState.hasBootstrapTranscriptState,
      contextEngine: input.activeContextEngine,
      sessionId: attempt.sessionId,
      sessionKey: attempt.sessionKey,
      sessionTarget: attempt.sessionTarget,
      sessionFile: attempt.sessionFile,
      sessionManager,
      runtimeContext: buildAfterTurnRuntimeContext({
        attempt,
        workspaceDir: input.effectiveWorkspace,
        cwd: input.effectiveCwd,
        agentDir: input.agentDir,
        tokenBudget: attempt.contextTokenBudget,
        activeAgentId: input.sessionAgentId,
        contextEnginePluginId: input.resolveActiveContextEnginePluginId(),
      }),
      contextEngineHostSupport: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
      providerId: attempt.provider,
      requestedModelId: attempt.requestedModelId,
      modelId: attempt.modelId,
      fallbackReason: attempt.fallbackReason,
      degradedReason: attempt.degradedReason,
      runMaintenance: async (contextParams) =>
        await runContextEngineMaintenance({
          contextEngine: contextParams.contextEngine as never,
          sessionId: contextParams.sessionId,
          sessionKey: contextParams.sessionKey,
          sessionTarget: contextParams.sessionTarget,
          sessionFile: contextParams.sessionFile,
          reason: contextParams.reason,
          sessionManager: contextParams.sessionManager as never,
          runtimeContext: contextParams.runtimeContext,
          runtimeSettings: contextParams.runtimeSettings,
          config: attempt.config,
          agentId: input.sessionAgentId,
          contextEngineAgentId: attempt.contextEngineAgentId,
        }),
      warn: (message) => log.warn(message),
    });
  });
  // Bootstrap may repair or migrate transcript rows. Only user writes after
  // preparation can be the active prompt source at the provider boundary.
  latestPersistedUserMessage = undefined;
  latestRuntimeUserMessage = undefined;
  userTranscriptContextRegistry.clear();

  return {
    userMessageBoundary: {
      getUserTranscriptContexts: () => {
        const transcriptMessage =
          latestPersistedUserMessage ?? latestUserTurnTranscriptRecorder?.getPersistedMessage?.();
        // A suppressed retry reuses the canonical persisted row, while the SDK
        // may rebuild its runtime object. Match against that row as the stable
        // fallback after preferring the exact suppressed runtime correlation.
        const runtimeMessage =
          latestRuntimeUserMessage ??
          (attempt.suppressNextUserMessagePersistence ? transcriptMessage : undefined);
        return userTranscriptContextRegistry.list(runtimeMessage, transcriptMessage);
      },
      preparedUserTurnMessage,
    },
    isOpenAIResponsesApi,
    preparedUserTurnMessage,
    sessionManager,
    transcriptPolicy,
  };
}
