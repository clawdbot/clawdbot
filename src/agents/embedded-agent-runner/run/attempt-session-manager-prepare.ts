/**
 * Prepares the durable session manager before embedded-agent session creation.
 */
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../../context-engine/host-compat.js";
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
import type { EmbeddedRunAttemptParams } from "./types.js";

type AttemptSessionManager = ReturnType<typeof guardSessionManager>;
type WithOwnedSessionWriteLock = <T>(operation: () => Promise<T> | T) => Promise<T>;

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
    withCompactionPersistence: (append, validateAppend) =>
      input.sessionLockController.withOwnedSessionFileWrite(append, validateAppend),
    onUserMessagePersisted: (message) => {
      attempt.onUserMessagePersisted?.(message);
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

  return {
    isOpenAIResponsesApi,
    preparedUserTurnMessage,
    sessionManager,
    transcriptPolicy,
  };
}
