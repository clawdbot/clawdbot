/**
 * Prepares the durable session manager before embedded-agent session creation.
 */
import { parseSqliteSessionFileMarker } from "../../../config/sessions/sqlite-marker.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../../context-engine/host-compat.js";
import type { AgentMessage } from "../../runtime/index.js";
import {
  invalidateSessionFileRepairCache,
  repairSessionFileIfNeeded,
} from "../../session-file-repair.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { SessionManager } from "../../sessions/index.js";
import { runContextEngineMaintenance } from "../context-engine-maintenance.js";
import { log } from "../logger.js";
import { prewarmSessionFile, trackSessionManagerAccess } from "../session-manager-cache.js";
import { prepareSessionManagerForRun } from "../session-manager-init.js";
import { resolveExistingAttemptTranscriptState } from "./attempt-transcript-helpers.js";
import {
  runAttemptContextEngineBootstrap,
  type AttemptContextEngine,
} from "./attempt.context-engine-helpers.js";
import { buildAfterTurnRuntimeContext } from "./attempt.prompt-helpers.js";
import type { EmbeddedAttemptSessionLockController } from "./attempt.session-lock.js";
import { resolveAttemptTranscriptPolicy } from "./attempt.transcript-policy.js";
import { createUserTranscriptContextRegistry } from "./attempt.user-transcript-context-registry.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type AttemptSessionManager = ReturnType<typeof guardSessionManager>;
type WithOwnedSessionWriteLock = <T>(operation: () => Promise<T> | T) => Promise<T>;
type CompactionPersistenceGuard = Pick<
  NonNullable<Parameters<typeof guardSessionManager>[1]>,
  "withCompactionPersistence"
>;

function buildCompactionPersistenceGuard(params: {
  sessionFile: string;
  sessionLockController: Pick<EmbeddedAttemptSessionLockController, "withOwnedSessionFileWrite">;
}): CompactionPersistenceGuard {
  if (parseSqliteSessionFileMarker(params.sessionFile)) {
    return {};
  }
  return {
    withCompactionPersistence: (append, validateAppend) =>
      params.sessionLockController.withOwnedSessionFileWrite(append, validateAppend),
  };
}

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
  sessionLockController: EmbeddedAttemptSessionLockController;
  withOwnedSessionWriteLock: WithOwnedSessionWriteLock;
}) {
  const { attempt } = input;
  const trustedSessionFileSnapshot =
    await input.sessionLockController.readTrustedCurrentSessionFileSnapshot();
  const repairReport = await repairSessionFileIfNeeded({
    sessionFile: attempt.sessionFile,
    trustedSnapshot: trustedSessionFileSnapshot,
    debug: (message) => log.debug(message),
    warn: (message) => log.warn(message),
  });
  if (
    repairReport.validatedSnapshot &&
    !input.sessionLockController.publishValidatedSessionFileSnapshot(repairReport.validatedSnapshot)
  ) {
    invalidateSessionFileRepairCache(attempt.sessionFile);
  }
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

  await prewarmSessionFile(attempt.sessionFile);
  const preparedUserTurnMessage = attempt.skipPreparedUserTurnMessage
    ? undefined
    : await attempt.userTurnTranscriptRecorder?.resolveMessage();
  let latestPersistedUserMessage: AgentMessage | undefined;
  let latestRuntimeUserMessage: AgentMessage | undefined;
  let latestUserTurnTranscriptRecorder = attempt.userTurnTranscriptRecorder;
  const userTranscriptContextRegistry = createUserTranscriptContextRegistry();
  const sessionManager = guardSessionManager(SessionManager.open(attempt.sessionFile), {
    agentId: input.sessionAgentId,
    sessionKey: attempt.sessionKey,
    config: attempt.config,
    contextWindowTokens: attempt.contextTokenBudget,
    inputProvenance: attempt.inputProvenance,
    preparedUserTurnMessage,
    allowSyntheticToolResults: transcriptPolicy.allowSyntheticToolResults,
    missingToolResultText: isOpenAIResponsesApi ? "aborted" : undefined,
    allowedToolNames: input.replayAllowedToolNames,
    suppressNextUserMessagePersistence: attempt.suppressNextUserMessagePersistence,
    suppressTranscriptOnlyAssistantPersistence: attempt.suppressTranscriptOnlyAssistantPersistence,
    suppressAssistantErrorPersistence: attempt.suppressAssistantErrorPersistence,
    onMessagePersisted: () => {
      input.sessionLockController.refreshAfterOwnedSessionWrite();
    },
    // SQLite owns compaction persistence and validation inside its transaction.
    // This append validator is a JSONL file-ownership fence, not a storage shim.
    ...buildCompactionPersistenceGuard({
      sessionFile: attempt.sessionFile,
      sessionLockController: input.sessionLockController,
    }),
    onUserMessagePreparingForPersistence: (_message, recorder, preparedMessage) => {
      latestPersistedUserMessage = undefined;
      latestUserTurnTranscriptRecorder =
        recorder ??
        (preparedMessage === preparedUserTurnMessage
          ? attempt.userTurnTranscriptRecorder
          : undefined);
    },
    onUserMessagePersisted: (message, runtimeMessage) => {
      latestPersistedUserMessage = message;
      latestRuntimeUserMessage = runtimeMessage;
      if (runtimeMessage) {
        userTranscriptContextRegistry.record(runtimeMessage, message);
      }
      attempt.onUserMessagePersisted?.(message);
    },
    onUserMessagePersistenceSuppressed: (_message, runtimeMessage) => {
      latestRuntimeUserMessage = runtimeMessage;
    },
    onUserMessageBlocked: () => {
      attempt.userTurnTranscriptRecorder?.markBlocked();
    },
    onAssistantErrorMessagePersisted: (message) => {
      attempt.onAssistantErrorMessagePersisted?.(message);
    },
  });
  // Publish ownership before async bootstrap. Outer cleanup must close this manager
  // even when a context-engine or transcript preparation step fails.
  input.onSessionManagerCreated(sessionManager);
  trackSessionManagerAccess(attempt.sessionFile);

  await input.withOwnedSessionWriteLock(async () => {
    await runAttemptContextEngineBootstrap({
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
        }),
      warn: (message) => log.warn(message),
    });

    await prepareSessionManagerForRun({
      sessionManager,
      sessionFile: attempt.sessionFile,
      hadSessionFile: transcriptState.hasFileTranscriptState,
      sessionId: attempt.sessionId,
      cwd: input.effectiveCwd,
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
