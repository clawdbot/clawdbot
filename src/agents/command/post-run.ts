import type { CliDeps } from "../../cli/deps.types.js";
import type { RestartRecoveryTerminalDeliveryEvidenceResult } from "../../config/sessions/restart-recovery-types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { DeliveryContext } from "../../utils/delivery-context.shared.js";
import {
  buildRestartRecoveryTerminalDeliveryEvidence,
  constrainRestartRecoveryDeliveryPayloads,
  shouldPersistCurrentRunSessionCleanup,
} from "../agent-command-restart-recovery.js";
import { isHeartbeatLifecycleRunKind } from "../bootstrap-mode.js";
import { persistPendingFinalDeliveryMarker } from "../pending-final-delivery-marker.js";
import type { AgentRunSessionTarget } from "../run-session-target.js";
import { throwAgentRunRestartAbortReason } from "../run-termination.js";
import type { PreparedAgentCommandExecution } from "./prepare.js";
import type { EmbeddedAgentAttempt } from "./run-embedded-attempt.js";
import {
  loadCliCompactionRuntime,
  loadDeliveryRuntime,
  loadSessionStoreRuntime,
} from "./runtime-loaders.js";
import { clearPendingFinalDeliveryFields, persistSessionEntry } from "./session-helpers.js";
import type { EmbeddedSessionState } from "./session-preparation.js";
import type { AgentCommandOpts } from "./types.js";

const log = createSubsystemLogger("agents/agent-command");

export async function finalizeEmbeddedAgentCommand(params: {
  prepared: PreparedAgentCommandExecution;
  opts: AgentCommandOpts;
  deps: CliDeps;
  runtime: RuntimeEnv;
  sessionEntry?: SessionEntry;
  attempt: EmbeddedAgentAttempt;
  embeddedSessionState: EmbeddedSessionState;
  suppressVisibleSessionEffects: boolean;
  preserveUserFacingSessionModelState: boolean;
  currentRunDeliveryContext?: DeliveryContext;
  sessionOwnership: {
    runOwnedSessionId: string;
    sessionReboundDuringRun: boolean;
  };
  trackInternalModelRunTarget: (target: AgentRunSessionTarget | undefined) => void;
  onSessionOwnershipChanged: (ownership: {
    runOwnedSessionId: string;
    sessionReboundDuringRun: boolean;
  }) => void;
  onTerminalDeliveryEvidenceChanged: (
    evidence: RestartRecoveryTerminalDeliveryEvidenceResult,
  ) => void;
}) {
  const {
    cfg,
    body,
    transcriptBody,
    sessionId,
    sessionKey,
    sessionStore,
    storePath,
    sessionAgentId,
    workspaceDir,
    cwd,
    agentDir,
    outboundSession,
    agentCfg,
  } = params.prepared;
  const {
    fallbackProvider,
    fallbackModel,
    fallbackExhausted,
    provider,
    model,
    effectiveTurnThinkLevel,
    internalSessionTarget,
    attemptExecutionRuntime,
    messageChannel,
    suppressUserTurnPersistence,
    userTurnTranscriptRecorder,
    fallbackTrajectoryRecorder,
    lifecycle,
    terminal,
    lifecycleGeneration,
  } = params.attempt;
  const { skillsSnapshot, runContext } = params.embeddedSessionState;
  const effectiveCwd = cwd ?? workspaceDir;
  let sessionEntry = params.sessionEntry;
  let result = params.attempt.result;
  let { runOwnedSessionId, sessionReboundDuringRun } = params.sessionOwnership;
  const publishSessionOwnership = () => {
    // Outer restart-recovery cleanup runs even after later delivery failures.
    params.onSessionOwnershipChanged({ runOwnedSessionId, sessionReboundDuringRun });
  };

  try {
    await fallbackTrajectoryRecorder?.flush();
    if (params.opts.internalDeliveryMediaUrls !== undefined) {
      result = {
        ...result,
        payloads: constrainRestartRecoveryDeliveryPayloads(
          result.payloads,
          params.opts.internalDeliveryMediaUrls,
          params.opts.internalDeliverySuppressText === true,
        ),
      };
    }
    params.onTerminalDeliveryEvidenceChanged(buildRestartRecoveryTerminalDeliveryEvidence(result));

    const rotatedSessionFile = result.meta.agentMeta?.sessionFile;
    const effectiveSessionId = rotatedSessionFile
      ? (result.meta.agentMeta?.sessionId ?? internalSessionTarget?.sessionId ?? sessionId)
      : (internalSessionTarget?.sessionId ?? sessionId);
    if (internalSessionTarget && effectiveSessionId !== internalSessionTarget.sessionId) {
      params.trackInternalModelRunTarget({
        ...internalSessionTarget,
        sessionId: effectiveSessionId,
      });
    }
    if (sessionStore && sessionKey && !params.suppressVisibleSessionEffects) {
      const isHeartbeatLifecycleRun = isHeartbeatLifecycleRunKind(
        params.opts.bootstrapContextRunKind,
      );
      const { updateSessionStoreAfterAgentRun } = await loadSessionStoreRuntime();
      await updateSessionStoreAfterAgentRun({
        cfg,
        contextTokensOverride: agentCfg?.contextTokens,
        sessionId: effectiveSessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: provider,
        defaultModel: model,
        fallbackProvider,
        fallbackModel,
        result,
        touchInteraction:
          params.opts.bootstrapContextRunKind !== "cron" &&
          !isHeartbeatLifecycleRun &&
          !params.opts.internalEvents?.length,
        // Cron output counts as unread-worthy activity; heartbeat and
        // internal-event turns must not re-flag the session unread.
        touchActivity: !isHeartbeatLifecycleRun && !params.opts.internalEvents?.length,
        preserveRuntimeModel:
          fallbackExhausted ||
          isHeartbeatLifecycleRun ||
          params.preserveUserFacingSessionModelState,
        preserveUserFacingSessionModelState: params.preserveUserFacingSessionModelState,
        clearRestartRecoveryForceSafeTools:
          params.opts.forceRestartSafeTools === true && params.opts.deliver !== true,
      });
      sessionEntry = sessionStore[sessionKey] ?? sessionEntry;
    }
    runOwnedSessionId = effectiveSessionId;
    publishSessionOwnership();

    const transcriptPersistenceRunner = result.meta.executionTrace?.runner;
    const embeddedAssistantGapFill =
      transcriptPersistenceRunner === "embedded" ||
      (transcriptPersistenceRunner === undefined &&
        Boolean(result.meta.finalAssistantVisibleText?.trim()));
    let persistedCliTurnTranscript = false;
    if (
      !sessionReboundDuringRun &&
      (transcriptPersistenceRunner === "cli" || embeddedAssistantGapFill)
    ) {
      try {
        const transcriptResult = await attemptExecutionRuntime.persistCliTurnTranscript({
          body,
          transcriptBody,
          result,
          sessionId: effectiveSessionId,
          sessionKey: internalSessionTarget?.sessionKey ?? sessionKey ?? effectiveSessionId,
          sessionEntry: internalSessionTarget?.sessionEntry ?? sessionEntry,
          sessionStore: params.suppressVisibleSessionEffects ? undefined : sessionStore,
          storePath: internalSessionTarget?.storePath ?? storePath,
          sessionAgentId: internalSessionTarget?.agentId ?? sessionAgentId,
          threadId: params.opts.threadId,
          sessionCwd: effectiveCwd,
          config: cfg,
          embeddedAssistantGapFill,
          skipUserTurn:
            suppressUserTurnPersistence ||
            userTurnTranscriptRecorder.hasPersisted() ||
            userTurnTranscriptRecorder.isBlocked(),
        });
        sessionReboundDuringRun = transcriptResult.kind === "session-rebound";
        publishSessionOwnership();
        if (!internalSessionTarget) {
          sessionEntry = transcriptResult.sessionEntry;
        }
        persistedCliTurnTranscript = transcriptResult.kind === "persisted";
      } catch (error) {
        log.warn(
          `Turn transcript persistence failed for ${sessionKey ?? sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const payloads = result.payloads ?? [];
    const pendingFinalDeliveryMarker = await persistPendingFinalDeliveryMarker({
      deliver: params.opts.deliver === true,
      sessionStore,
      sessionKey,
      sessionEntry,
      storePath,
      suppressVisibleSessionEffects: params.suppressVisibleSessionEffects,
      sessionReboundDuringRun,
      payloads,
      deliveryContext: params.currentRunDeliveryContext,
      runOwnedSessionId,
    });
    sessionEntry = pendingFinalDeliveryMarker.sessionEntry;

    const canSafelyRunPostTurnCompaction =
      params.opts.deliver !== true ||
      !pendingFinalDeliveryMarker.hasSendableFinalPayload ||
      pendingFinalDeliveryMarker.pendingFinalDeliveryMarkerPersisted;
    if (
      persistedCliTurnTranscript &&
      !params.suppressVisibleSessionEffects &&
      canSafelyRunPostTurnCompaction
    ) {
      try {
        const compactedSessionEntry = await (
          await loadCliCompactionRuntime()
        ).runCliTurnCompactionLifecycle({
          cfg,
          sessionId: effectiveSessionId,
          sessionKey: sessionKey ?? effectiveSessionId,
          sessionEntry,
          sessionStore,
          storePath,
          sessionAgentId,
          workspaceDir,
          cwd: effectiveCwd,
          agentDir,
          provider: result.meta.agentMeta?.provider ?? provider,
          model: result.meta.agentMeta?.model ?? model,
          skillsSnapshot,
          messageChannel,
          agentAccountId: runContext.accountId,
          senderIsOwner: params.opts.senderIsOwner,
          thinkLevel: effectiveTurnThinkLevel,
          extraSystemPrompt: params.opts.extraSystemPrompt,
        });
        throwAgentRunRestartAbortReason(params.opts.abortSignal?.reason);
        assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
        sessionEntry = compactedSessionEntry;
        runOwnedSessionId = compactedSessionEntry?.sessionId ?? runOwnedSessionId;
        publishSessionOwnership();
      } catch (error) {
        throwAgentRunRestartAbortReason(params.opts.abortSignal?.reason);
        throwAgentRunRestartAbortReason(error);
        assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
        if (
          params.opts.deliver !== true ||
          !pendingFinalDeliveryMarker.pendingFinalDeliveryMarkerPersisted ||
          !pendingFinalDeliveryMarker.hasSendableFinalPayload
        ) {
          throw error;
        }
        log.warn(
          `Post-turn transcript compaction failed for ${sessionKey ?? sessionId}; continuing final delivery: ${formatErrorMessage(error)}`,
        );
      }
    }

    const { deliverAgentCommandResult } = await loadDeliveryRuntime();
    const resolveFreshSessionEntryForDelivery =
      sessionStore && sessionKey && !params.suppressVisibleSessionEffects
        ? async (): Promise<SessionEntry | undefined> => {
            const { loadSessionEntry } = await loadSessionStoreRuntime();
            const freshEntry = loadSessionEntry({
              storePath,
              sessionKey,
              readConsistency: "latest",
              clone: false,
            });
            if (!freshEntry || freshEntry.sessionId !== runOwnedSessionId) {
              return undefined;
            }
            sessionStore[sessionKey] = freshEntry;
            return freshEntry;
          }
        : undefined;
    const deliveryParams = {
      cfg,
      deps: params.deps,
      runtime: params.runtime,
      opts: params.opts,
      outboundSession,
      sessionEntry,
      result,
      payloads,
      assertDeliveryCurrent: () => assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration),
      onDeliveryResult: (
        deliveryResult: Parameters<
          NonNullable<Parameters<typeof deliverAgentCommandResult>[0]["onDeliveryResult"]>
        >[0],
      ) => {
        params.onTerminalDeliveryEvidenceChanged(
          buildRestartRecoveryTerminalDeliveryEvidence(deliveryResult),
        );
      },
    };
    const deliveryResult = await deliverAgentCommandResult(
      resolveFreshSessionEntryForDelivery
        ? {
            ...deliveryParams,
            expectedSessionIdForFreshDelivery: runOwnedSessionId,
            resolveFreshSessionEntryForDelivery,
          }
        : deliveryParams,
    );

    if (
      sessionStore &&
      sessionKey &&
      !isSubagentSessionKey(sessionKey) &&
      !params.suppressVisibleSessionEffects &&
      !sessionReboundDuringRun
    ) {
      const entry = sessionStore[sessionKey] ?? sessionEntry;
      if (!entry) {
        throw new Error("Cannot clear pending delivery without a session entry");
      }
      const noPendingTextForThisRun =
        params.opts.deliver === true &&
        pendingFinalDeliveryMarker.pendingFinalDeliveryTextForThisRun === undefined &&
        entry.pendingFinalDelivery === true &&
        !entry.pendingFinalDeliveryText;
      if (deliveryResult?.deliverySucceeded === true || noPendingTextForThisRun) {
        sessionEntry = await persistSessionEntry({
          sessionStore,
          sessionKey,
          storePath,
          initialEntry: entry,
          entry: clearPendingFinalDeliveryFields(entry, Date.now()),
          shouldPersist: (current) =>
            shouldPersistCurrentRunSessionCleanup(current, runOwnedSessionId),
        });
      }
    }

    if (fallbackExhausted || lifecycle.resolveResultError(result, false)) {
      lifecycle.emitResultError(result, fallbackExhausted, terminal);
    } else {
      lifecycle.emitEnd(terminal);
    }
    return {
      deliveryResult,
      sessionEntry,
      runOwnedSessionId,
      sessionReboundDuringRun,
    };
  } catch (error) {
    lifecycle.emitPostTurnError(error);
    throw error;
  }
}
