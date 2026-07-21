/**
 * Runs post-stream context-engine, transcript, cache, and lifecycle work.
 */
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../../context-engine/host-compat.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import { captureAgentRunLifecycleGeneration } from "../../../infra/agent-events.js";
import { freezeDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import type { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import type { createAnthropicPayloadLogger } from "../../anthropic-payload-log.js";
import { FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE } from "../../bootstrap-files.js";
import { isHeartbeatLifecycleRunKind } from "../../bootstrap-mode.js";
import type { createCacheTrace } from "../../cache-trace.js";
import { runAgentEndSideEffects } from "../../harness/agent-end-side-effects.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { AgentSession, SessionManager } from "../../sessions/index.js";
import type { NormalizedUsage } from "../../usage.js";
import {
  rotateTranscriptAfterCompaction,
  shouldRotateCompactionTranscript,
} from "../compaction-successor-transcript.js";
import { runContextEngineMaintenance } from "../context-engine-maintenance.js";
import { log } from "../logger.js";
import { updateActiveEmbeddedRunSessionFile } from "../runs.js";
import { buildEmbeddedAgentEndContext } from "./agent-end-context.js";
import {
  finalizeAttemptContextEngineTurn,
  type buildContextEnginePromptCacheInfo,
} from "./attempt.context-engine-helpers.js";
import { buildAfterTurnRuntimeContextFromUsage } from "./attempt.prompt-helpers.js";
import type { createEmbeddedAttemptSessionLockController } from "./attempt.session-lock.js";
import { shouldPersistCompletedBootstrapTurn } from "./attempt.thread-helpers.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type CacheTrace = ReturnType<typeof createCacheTrace>;
type AnthropicPayloadLogger = ReturnType<typeof createAnthropicPayloadLogger>;
type HookRunner = ReturnType<typeof getGlobalHookRunner>;
type AttemptSessionLockController = Awaited<
  ReturnType<typeof createEmbeddedAttemptSessionLockController>
>;
type PromptCacheInfo = ReturnType<typeof buildContextEnginePromptCacheInfo>;
type WithOwnedSessionWriteLock = <T>(operation: () => Promise<T> | T) => Promise<T>;

type CompleteEmbeddedAttemptAfterTurnInput = {
  attempt: EmbeddedRunAttemptParams;
  activeContextEngine?: ContextEngine;
  activeSession: AgentSession;
  sessionManager: SessionManager;
  sessionLockController: AttemptSessionLockController;
  withOwnedSessionWriteLock: WithOwnedSessionWriteLock;
  state: {
    promptError: unknown;
    yieldAborted: boolean;
    sessionIdUsed: string;
    sessionFileUsed?: string;
    messagesSnapshot: AgentMessage[];
    prePromptMessageCount: number;
    contextEngineAfterTurnCheckpoint: number | null;
    lastCallUsage?: NormalizedUsage;
    promptCache?: PromptCacheInfo;
    beforeAgentFinalizeRevisionReason?: string;
    compactionOccurredThisAttempt: boolean;
  };
  readLifecycleState: () => {
    aborted: boolean;
    timedOut: boolean;
    idleTimedOut: boolean;
    timedOutDuringCompaction: boolean;
  };
  runtime: {
    effectiveWorkspace: string;
    agentDir: string;
    sessionAgentId: string;
    resolveActiveContextEnginePluginId: () => string | undefined;
    shouldRecordCompletedBootstrapTurn: boolean;
    cacheTrace: CacheTrace;
    anthropicPayloadLogger: AnthropicPayloadLogger;
    hookAgentId: string;
    diagnosticTrace: Parameters<typeof freezeDiagnosticTraceContext>[0];
    skillWorkshopAvailable: boolean;
    hookRunner: HookRunner;
    promptStartedAt: number;
  };
};

export async function completeEmbeddedAttemptAfterTurn(
  input: CompleteEmbeddedAttemptAfterTurnInput,
): Promise<{ sessionIdUsed: string; sessionFileUsed?: string }> {
  const { attempt, activeContextEngine, activeSession, sessionManager, state, runtime } = input;
  let { sessionIdUsed, sessionFileUsed } = state;

  // Context-engine hooks may call runtime LLM capabilities. Only the transcript
  // rewrite callback reacquires the synchronous session write boundary.
  if (activeContextEngine && !state.beforeAgentFinalizeRevisionReason) {
    const lifecycleState = input.readLifecycleState();
    const afterTurnRuntimeContext = buildAfterTurnRuntimeContextFromUsage({
      attempt,
      workspaceDir: runtime.effectiveWorkspace,
      agentDir: runtime.agentDir,
      tokenBudget: attempt.contextTokenBudget,
      lastCallUsage: state.lastCallUsage,
      promptCache: state.promptCache,
      activeAgentId: runtime.sessionAgentId,
      contextEnginePluginId: runtime.resolveActiveContextEnginePluginId(),
    });
    await finalizeAttemptContextEngineTurn({
      contextEngine: activeContextEngine,
      promptError: Boolean(state.promptError),
      aborted: lifecycleState.aborted,
      yieldAborted: state.yieldAborted,
      sessionIdUsed,
      sessionKey: attempt.sessionKey,
      sessionTarget: attempt.sessionTarget,
      sessionFile: attempt.sessionFile,
      messagesSnapshot: state.messagesSnapshot,
      prePromptMessageCount: state.contextEngineAfterTurnCheckpoint ?? state.prePromptMessageCount,
      tokenBudget: attempt.contextTokenBudget,
      runtimeContext: afterTurnRuntimeContext,
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
          withSessionManagerRewriteLock: async (operation) =>
            await input.withOwnedSessionWriteLock(operation),
          runtimeContext: contextParams.runtimeContext,
          runtimeSettings: contextParams.runtimeSettings,
          config: attempt.config,
          agentId: runtime.sessionAgentId,
        }),
      sessionManager,
      config: attempt.config,
      warn: (message) => log.warn(message),
      isHeartbeat: isHeartbeatLifecycleRunKind(attempt.bootstrapContextRunKind),
    });
  }

  if (!state.beforeAgentFinalizeRevisionReason) {
    await input.sessionLockController.waitForSessionEvents(activeSession);
    await input.withOwnedSessionWriteLock(async () => {
      const lifecycleState = input.readLifecycleState();
      if (
        shouldPersistCompletedBootstrapTurn({
          shouldRecordCompletedBootstrapTurn: runtime.shouldRecordCompletedBootstrapTurn,
          promptError: state.promptError,
          aborted: lifecycleState.aborted,
          timedOutDuringCompaction: lifecycleState.timedOutDuringCompaction,
          compactionOccurredThisAttempt: state.compactionOccurredThisAttempt,
        })
      ) {
        try {
          sessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, {
            timestamp: Date.now(),
            runId: attempt.runId,
            sessionId: attempt.sessionId,
          });
        } catch (entryErr) {
          log.warn(`failed to persist bootstrap completion entry: ${String(entryErr)}`);
        }
      }

      if (
        state.compactionOccurredThisAttempt &&
        !state.promptError &&
        !lifecycleState.aborted &&
        !lifecycleState.timedOut &&
        !lifecycleState.idleTimedOut &&
        !lifecycleState.timedOutDuringCompaction &&
        shouldRotateCompactionTranscript(attempt.config)
      ) {
        try {
          const rotation = await rotateTranscriptAfterCompaction({
            sessionManager,
            sessionFile: attempt.sessionFile,
          });
          if (rotation.rotated) {
            sessionIdUsed = rotation.sessionId ?? sessionIdUsed;
            sessionFileUsed = rotation.sessionFile ?? sessionFileUsed;
            updateActiveEmbeddedRunSessionFile(
              attempt.sessionId,
              sessionFileUsed,
              attempt.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(attempt.runId),
            );
            log.info(
              `[compaction] rotated active transcript after automatic compaction ` +
                `(sessionKey=${attempt.sessionKey ?? attempt.sessionId})`,
            );
          }
        } catch (err) {
          log.warn("[compaction] automatic transcript rotation failed", {
            errorMessage: formatErrorMessage(err),
          });
        }
      }
    });
  }

  const lifecycleAfterTurn = input.readLifecycleState();
  runtime.cacheTrace?.recordStage("session:after", {
    messages: state.messagesSnapshot,
    note: lifecycleAfterTurn.timedOutDuringCompaction
      ? "compaction timeout"
      : state.promptError
        ? "prompt error"
        : undefined,
  });
  runtime.anthropicPayloadLogger?.recordUsage(state.messagesSnapshot, state.promptError);

  if (!state.beforeAgentFinalizeRevisionReason) {
    const lifecycleForAgentEnd = input.readLifecycleState();
    runAgentEndSideEffects({
      event: {
        messages: state.messagesSnapshot,
        success: !lifecycleForAgentEnd.aborted && !state.promptError,
        error: state.promptError ? formatErrorMessage(state.promptError) : undefined,
        durationMs: Date.now() - runtime.promptStartedAt,
      },
      ctx: buildEmbeddedAgentEndContext({
        run: attempt,
        agentId: runtime.hookAgentId,
        trace: freezeDiagnosticTraceContext(runtime.diagnosticTrace),
        skillWorkshopAvailable: runtime.skillWorkshopAvailable,
        compacted: state.compactionOccurredThisAttempt,
      }),
      hookRunner: runtime.hookRunner,
    });
  }

  return { sessionIdUsed, sessionFileUsed };
}
