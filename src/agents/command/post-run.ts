import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import type { FollowupRun } from "../../auto-reply/reply/queue.js";
import type { CliDeps } from "../../cli/deps.types.js";
import { resolveSessionAuthProfileOverrideSource } from "../../config/sessions/auth-profile-override-provenance.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import { buildRestartRecoveryClaimCleanupPatch } from "../../config/sessions/restart-recovery-state.js";
import type { RestartRecoveryTerminalDeliveryEvidenceResult } from "../../config/sessions/restart-recovery-types.js";
import { resolveFreshSessionTotalTokens, type SessionEntry } from "../../config/sessions/types.js";
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
import { normalizeAgentRunTerminalDeliverySnapshot } from "../agent-run-terminal-delivery.js";
import { OPENCLAW_AGENT_RUNTIME_ID } from "../agent-runtime-id.js";
import { isHeartbeatLifecycleRunKind } from "../bootstrap-mode.js";
import { persistPendingFinalDeliveryMarker } from "../pending-final-delivery-marker.js";
import type { AgentRunSessionTarget } from "../run-session-target.js";
import { throwAgentRunRestartAbortReason } from "../run-termination.js";
import { persistAssistantTranscriptRepairRecord } from "./assistant-transcript-repair.js";
import { persistAgentSession } from "./attempt-execution.shared.js";
import type { PreparedAgentCommandExecution } from "./prepare.js";
import type { runEmbeddedAgentAttempt } from "./run-embedded-attempt.js";
import {
  loadAgentRunnerMemoryRuntime,
  loadCliCompactionRuntime,
  loadDeliveryRuntime,
  loadSessionStoreRuntime,
} from "./runtime-loaders.js";
import { clearPendingFinalDelivery } from "./session-helpers.js";
import type { EmbeddedSessionState } from "./session-preparation.js";
import type { AgentCommandOpts } from "./types.js";

type EmbeddedAgentAttempt = Awaited<ReturnType<typeof runEmbeddedAgentAttempt>>;

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
    timeoutMs,
    outboundSession,
    runId,
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
  const { resolvedVerboseLevel, skillsSnapshot, runContext } = params.embeddedSessionState;
  const effectiveCwd = cwd ?? workspaceDir;
  const isHeartbeatLifecycleRun = isHeartbeatLifecycleRunKind(params.opts.bootstrapContextRunKind);
  let sessionEntry = params.sessionEntry;
  let result = params.attempt.result;
  let { runOwnedSessionId, sessionReboundDuringRun } = params.sessionOwnership;
  const publishSessionOwnership = () => {
    // Outer restart-recovery cleanup runs even after later delivery failures.
    params.onSessionOwnershipChanged({ runOwnedSessionId, sessionReboundDuringRun });
  };

  try {
    await fallbackTrajectoryRecorder?.flush();
    const finalVisiblePayload = result.payloads
      ?.toReversed()
      .find((payload) => !payload.isError && !payload.isReasoning && payload.text?.trim());
    const assistantTranscriptOwned =
      finalVisiblePayload !== undefined &&
      getReplyPayloadMetadata(finalVisiblePayload)?.assistantTranscriptOwned === true;
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
    const resultErrorPayload = result.payloads?.find((payload) => payload.isError === true);
    if (resultErrorPayload) {
      const message =
        typeof resultErrorPayload.text === "string" && resultErrorPayload.text.trim()
          ? resultErrorPayload.text
          : undefined;
      params.opts.onResultErrorPayload?.(message);
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
      const { updateSessionStoreAfterAgentRun } = await loadSessionStoreRuntime();
      await updateSessionStoreAfterAgentRun({
        cfg,
        agentDir,
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
          fallbackProvider !== provider ||
          fallbackModel !== model ||
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
    let persistedCliTurnTranscript = false;
    if (!sessionReboundDuringRun && transcriptPersistenceRunner === "cli") {
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
          skipAssistantTurn: assistantTranscriptOwned,
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
        if (
          sessionStore &&
          sessionKey &&
          !params.suppressVisibleSessionEffects &&
          !sessionReboundDuringRun &&
          !assistantTranscriptOwned
        ) {
          await persistAssistantTranscriptRepairRecord({
            context: {
              sessionKey: internalSessionTarget?.sessionKey ?? sessionKey ?? effectiveSessionId,
              sessionEntry: internalSessionTarget?.sessionEntry ?? sessionEntry,
              sessionStore,
              storePath: internalSessionTarget?.storePath ?? storePath,
              sessionAgentId: internalSessionTarget?.agentId ?? sessionAgentId,
              config: cfg,
            },
            replyText: attemptExecutionRuntime.resolveCliTranscriptReplyText(result),
            provider: result.meta.agentMeta?.provider,
            model: result.meta.agentMeta?.model,
            runOwnedSessionId,
          });
        }
      }
    }

    // Embedded runs own transcript persistence; CLI runs must prove their explicit append succeeded.
    const turnTranscriptPersisted =
      transcriptPersistenceRunner === "embedded" || persistedCliTurnTranscript;
    let followupRun: FollowupRun | undefined;
    if (
      turnTranscriptPersisted &&
      sessionEntry &&
      sessionStore &&
      sessionKey &&
      !params.suppressVisibleSessionEffects
    ) {
      const flushProvider = result.meta.agentMeta?.provider ?? fallbackProvider;
      const flushModel = result.meta.agentMeta?.model ?? fallbackModel;
      const maintenanceAuthProfile = params.attempt.maintenanceAuthProfile ?? {
        authProfileId: sessionEntry.authProfileOverride?.trim() || undefined,
        authProfileIdSource: resolveSessionAuthProfileOverrideSource(sessionEntry),
      };
      followupRun = {
        prompt: "",
        enqueuedAt: Date.now(),
        run: {
          agentId: sessionAgentId,
          agentDir,
          sessionId: sessionEntry.sessionId,
          sessionKey,
          sessionFile: sessionKey,
          workspaceDir,
          cwd: effectiveCwd,
          runtimePolicySessionKey: sessionKey,
          config: cfg,
          provider: flushProvider,
          model: flushModel,
          ...maintenanceAuthProfile,
          blockReplyBreak: "message_end",
          skillsSnapshot,
          thinkLevel: effectiveTurnThinkLevel,
          verboseLevel: resolvedVerboseLevel ?? "off",
          timeoutMs,
          // Maintenance is system-owned and must not inherit completed-turn authority.
          senderIsOwner: false,
        },
      };
      throwAgentRunRestartAbortReason(params.opts.abortSignal?.reason);
      assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
      const { runMemoryFlushIfNeeded } = await loadAgentRunnerMemoryRuntime();
      throwAgentRunRestartAbortReason(params.opts.abortSignal?.reason);
      assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
      const memoryFlushResult = await runMemoryFlushIfNeeded({
        cfg,
        followupRun,
        promptForEstimate: "",
        sessionCtx: {},
        defaultModel: flushModel,
        resolvedVerboseLevel: resolvedVerboseLevel ?? "off",
        sessionEntry,
        sessionStore,
        sessionKey,
        runtimePolicySessionKey: sessionKey,
        storePath,
        isHeartbeat: isHeartbeatLifecycleRun,
        abortSignal: params.opts.abortSignal,
        onSessionIdChanged: params.opts.onSessionIdChanged,
      });
      sessionEntry = memoryFlushResult.sessionEntry ?? sessionEntry;
      followupRun.run.sessionId = sessionEntry.sessionId;
      if (sessionEntry.sessionId !== runOwnedSessionId) {
        runOwnedSessionId = sessionEntry.sessionId;
        publishSessionOwnership();
      }
      throwAgentRunRestartAbortReason(params.opts.abortSignal?.reason);
      assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
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

    const resolveFreshSessionEntryForDelivery =
      sessionStore && sessionKey && !params.suppressVisibleSessionEffects
        ? async (): Promise<SessionEntry | undefined> => {
            const { loadSessionEntryReadOnly } = await loadSessionStoreRuntime();
            const freshEntry = loadSessionEntryReadOnly({
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
    const canSafelyRunPostTurnCompaction =
      params.opts.deliver !== true ||
      !pendingFinalDeliveryMarker.hasSendableFinalPayload ||
      pendingFinalDeliveryMarker.pendingFinalDeliveryMarkerPersisted;
    const agentMeta = result.meta.agentMeta;
    // In-run compaction already owns this turn's reduction; its lastCallUsage can
    // still describe the old prompt and must not trigger another housekeeping pass.
    let embeddedCompactionRun =
      followupRun &&
      transcriptPersistenceRunner === "embedded" &&
      agentMeta?.agentHarnessId === OPENCLAW_AGENT_RUNTIME_ID &&
      sessionEntry?.sessionId === runOwnedSessionId &&
      !fallbackExhausted &&
      terminal.outcome.status === "ok" &&
      !resultErrorPayload &&
      !result.meta.yielded &&
      !result.meta.aborted &&
      (agentMeta.compactionCount ?? 0) === 0 &&
      !isHeartbeatLifecycleRun &&
      cfg.agents?.defaults?.compaction?.enabled !== false &&
      !params.preserveUserFacingSessionModelState &&
      !sessionReboundDuringRun &&
      params.opts.modelRun !== true &&
      params.opts.promptMode !== "none"
        ? followupRun
        : undefined;
    if (embeddedCompactionRun && params.attempt.maintenanceAuthProfile === undefined) {
      log.warn(
        "Post-turn compaction skipped: completed embedded run did not report its auth selection.",
      );
      embeddedCompactionRun = undefined;
    }
    if (
      (persistedCliTurnTranscript || embeddedCompactionRun) &&
      !params.suppressVisibleSessionEffects &&
      canSafelyRunPostTurnCompaction
    ) {
      const lifecycleRevisionBefore = sessionEntry?.lifecycleRevision;
      try {
        const compactionCountBefore = sessionEntry?.compactionCount ?? 0;
        const authorize = () => {
          throwAgentRunRestartAbortReason(params.opts.abortSignal?.reason);
          assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
          return params.opts.abortSignal?.aborted !== true && !sessionReboundDuringRun;
        };
        const compactedSessionEntry = embeddedCompactionRun
          ? await (
              await loadAgentRunnerMemoryRuntime()
            ).runSessionCompactionIfNeeded({
              cfg,
              followupRun: embeddedCompactionRun,
              promptForEstimate: "",
              sessionEntry,
              sessionStore,
              sessionKey,
              runtimePolicySessionKey: sessionKey,
              storePath,
              defaultModel: embeddedCompactionRun.run.model,
              isHeartbeat: false,
              agentHarnessId: agentMeta?.agentHarnessId,
              abortSignal: params.opts.abortSignal,
              onSessionIdChanged: params.opts.onSessionIdChanged,
              authorize,
            })
          : await (
              await loadCliCompactionRuntime()
            ).runCliTurnCompactionLifecycle({
              cfg,
              sessionId: sessionEntry?.sessionId ?? effectiveSessionId,
              sessionKey: sessionKey ?? effectiveSessionId,
              sessionEntry,
              sessionStore,
              storePath,
              sessionAgentId,
              workspaceDir,
              cwd: effectiveCwd,
              agentDir,
              provider: agentMeta?.provider ?? provider,
              model: agentMeta?.model ?? model,
              skillsSnapshot,
              messageChannel,
              agentAccountId: runContext.accountId,
              senderIsOwner: params.opts.senderIsOwner,
              thinkLevel: effectiveTurnThinkLevel,
              extraSystemPrompt: params.opts.extraSystemPrompt,
              pluginGeneration: params.prepared.commandRuntimeContext?.pluginGeneration,
            });
        throwAgentRunRestartAbortReason(params.opts.abortSignal?.reason);
        assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
        sessionEntry = compactedSessionEntry;
        runOwnedSessionId = compactedSessionEntry?.sessionId ?? runOwnedSessionId;
        publishSessionOwnership();
        const completedCompactions =
          (compactedSessionEntry?.compactionCount ?? 0) - compactionCountBefore;
        if (
          embeddedCompactionRun &&
          compactedSessionEntry &&
          agentMeta &&
          completedCompactions > 0
        ) {
          // These facts describe maintenance after the reply; preserve its original provider usage.
          result = {
            ...result,
            meta: {
              ...result.meta,
              agentMeta: {
                ...agentMeta,
                sessionId: runOwnedSessionId,
                sessionFile: formatSqliteSessionFileMarker({
                  agentId: sessionAgentId,
                  sessionId: runOwnedSessionId,
                  storePath,
                }),
                compactionCount: (agentMeta.compactionCount ?? 0) + completedCompactions,
                compactionTokensAfter: resolveFreshSessionTotalTokens(compactedSessionEntry),
                contextBudgetStatus: undefined,
              },
            },
          };
        }
      } catch (error) {
        throwAgentRunRestartAbortReason(params.opts.abortSignal?.reason);
        throwAgentRunRestartAbortReason(error);
        assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
        if (embeddedCompactionRun) {
          // Housekeeping must not erase a completed local reply, but stale ownership
          // is not an ordinary compactor failure and must still stop final delivery.
          params.opts.abortSignal?.throwIfAborted();
          const currentEntry = await resolveFreshSessionEntryForDelivery?.();
          params.opts.abortSignal?.throwIfAborted();
          assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
          if (!currentEntry || currentEntry.lifecycleRevision !== lifecycleRevisionBefore) {
            throw error;
          }
        } else if (
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
        const deliveryStatus = deliveryResult.deliveryStatus;
        const terminalDelivery = normalizeAgentRunTerminalDeliverySnapshot(
          deliveryStatus && {
            status: deliveryStatus.status,
            resultCount: deliveryStatus.resultCount ?? 0,
          },
        );
        if (terminalDelivery) {
          terminal.metadata.terminalDelivery = terminalDelivery;
        }
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
      const entry =
        (await resolveFreshSessionEntryForDelivery?.()) ?? sessionStore[sessionKey] ?? sessionEntry;
      if (!entry) {
        throw new Error("Cannot clear pending delivery without a session entry");
      }
      // This command only creates replayable markers, so transport-only is stale from an earlier run.
      const clearStaleTransportOnly =
        params.opts.deliver === true &&
        !pendingFinalDeliveryMarker.hasSendableFinalPayload &&
        entry.pendingFinalDelivery?.kind === "transport-only";
      const clearOwnedPendingFinal =
        deliveryResult?.deliverySucceeded === true &&
        pendingFinalDeliveryMarker.pendingFinalDeliveryIntentId !== undefined;
      // Preserve the exact local claim through sibling session writes so a delivered
      // source is tombstoned before admission release can erase its ownership fields.
      const recoveryClaimEntry =
        entry.restartRecoveryDeliveryRunId === runId
          ? entry
          : sessionEntry?.restartRecoveryDeliveryRunId === runId
            ? sessionEntry
            : params.sessionEntry?.restartRecoveryDeliveryRunId === runId
              ? params.sessionEntry
              : undefined;
      if (clearOwnedPendingFinal || clearStaleTransportOnly || recoveryClaimEntry) {
        const now = Date.now();
        sessionEntry = await persistAgentSession({
          sessionStore,
          sessionKey,
          storePath,
          initialEntry: entry,
          entry: {
            ...(clearOwnedPendingFinal || clearStaleTransportOnly
              ? clearPendingFinalDelivery(entry, now)
              : { ...entry, updatedAt: now }),
            ...(recoveryClaimEntry
              ? buildRestartRecoveryClaimCleanupPatch({
                  entry: {
                    ...recoveryClaimEntry,
                    restartRecoveryTerminalDeliveryEvidence:
                      entry.restartRecoveryTerminalDeliveryEvidence,
                    restartRecoveryTerminalRunIds: entry.restartRecoveryTerminalRunIds,
                  },
                  recordTerminalSource: true,
                  terminalDeliveryEvidence: buildRestartRecoveryTerminalDeliveryEvidence(
                    deliveryResult ?? result,
                  ),
                  terminalRunId: runId,
                })
              : {}),
          },
          shouldPersist: (current) =>
            shouldPersistCurrentRunSessionCleanup(current, runOwnedSessionId) &&
            (!recoveryClaimEntry ||
              current?.restartRecoveryDeliveryRunId === undefined ||
              current.restartRecoveryDeliveryRunId === runId) &&
            (!clearOwnedPendingFinal ||
              current?.pendingFinalDelivery?.intentId ===
                pendingFinalDeliveryMarker.pendingFinalDeliveryIntentId) &&
            (!clearStaleTransportOnly || current?.pendingFinalDelivery?.kind === "transport-only"),
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
    lifecycle.emitPostTurnError(error, terminal);
    throw error;
  }
}
