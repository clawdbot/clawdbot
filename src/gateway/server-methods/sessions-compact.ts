// Manual transcript trimming and model-backed session compaction.
import { randomUUID } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  validateSessionsCompactParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { clearAllCliSessions } from "../../agents/cli-session.js";
import { resolveEmbeddedSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import { hasPendingFollowupQueueWork } from "../../auto-reply/reply/queue/state.js";
import {
  resolveSessionWorkStartError,
  SESSION_TOTAL_TOKENS_VERSION,
  SESSION_LIFECYCLE_CHANGED_ERROR_REASON,
  type SessionEntry,
} from "../../config/sessions.js";
import {
  applySessionPatchProjection,
  preflightSessionTranscriptForManualCompact,
  readTranscriptStatsSync,
  trimSessionTranscriptForManualCompact,
} from "../../config/sessions/session-accessor.js";
import { COMPACTION_RUN_USAGE_CLEAR_PATCH } from "../../config/sessions/session-entry-projection.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getCommandLaneSnapshot } from "../../process/command-queue.js";
import {
  isCompetingSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { recordSessionCompacted } from "../../sessions/session-state-events.js";
import {
  resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "../session-request-agent.js";
import {
  resolveCanonicalGatewaySessionStoreKey,
  resolveGatewaySessionStoreTargetWithStore,
} from "../session-utils.js";
import { asWorkerInferenceControl } from "../worker-environments/inference-control.js";
import { resolveVisibleActiveSessionRunState } from "./session-active-runs.js";
import { emitSessionsChanged } from "./session-change-event.js";
import {
  preflightGatewaySessionCompaction,
  runGatewaySessionCompaction,
} from "./sessions-compaction-runner.js";
import {
  emitSessionOperation,
  loadAccessorSessionEntryForGatewayTarget,
  requireSessionKey,
} from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionCompactHandlers: GatewayRequestHandlers = {
  "sessions.compact": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsCompactParams, "sessions.compact", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    const maxLines =
      typeof p.maxLines === "number" && Number.isFinite(p.maxLines)
        ? Math.max(1, Math.floor(p.maxLines))
        : undefined;

    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, p.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const requestedAgentId = requestedAgent.agentId;
    const compatibilityDefaultAgentId = tryResolveSessionCompatibilityOwnerAgentId(cfg, key);
    const target = resolveGatewaySessionStoreTargetWithStore({
      cfg,
      key,
      exactRead: true,
      ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
    });
    const storePath = target.storePath;
    // Lock + read in a short critical section; transcript work happens outside.
    // The projection resolver re-runs gateway key migration on the writer
    // snapshot so alias promotion/pruning persists through the accessor.
    let compactPrimaryKey = target.canonicalKey;
    const compactRead = await applySessionPatchProjection({
      agentId: target.agentId,
      sessionKeys: target.storeKeys,
      storePath,
      resolveTarget: ({ store }) => {
        const { target: migratedTarget, primaryKey } = resolveCanonicalGatewaySessionStoreKey({
          cfg,
          key,
          store: store as Record<string, SessionEntry>,
          agentId: requestedAgentId,
        });
        compactPrimaryKey = primaryKey;
        return { primaryKey, candidateKeys: migratedTarget.storeKeys };
      },
      // Read-only projection: persist the resolved row unchanged so the alias
      // migration above is saved even when compaction bails out below.
      project: ({ existingEntry }) =>
        existingEntry ? { ok: true, entry: existingEntry } : { ok: false },
    });
    const compactTarget = {
      entry: compactRead.ok ? compactRead.entry : undefined,
      primaryKey: compactPrimaryKey,
    };
    const entry = compactTarget.entry;
    const sessionId = entry?.sessionId;
    if (!sessionId) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          reason: "no sessionId",
        },
        undefined,
      );
      return;
    }

    if (maxLines !== undefined) {
      const trimPreflight = await preflightSessionTranscriptForManualCompact(
        {
          sessionId,
          storePath,
          sessionKey: compactTarget.primaryKey,
          agentId: target.agentId,
        },
        { maxLines },
      );
      if (!trimPreflight.compacted) {
        respond(
          true,
          {
            ok: true,
            key: target.canonicalKey,
            compacted: false,
            ...("kept" in trimPreflight
              ? { kept: trimPreflight.kept }
              : { reason: "no transcript" }),
          },
          undefined,
        );
        return;
      }
    } else {
      const transcriptStats = readTranscriptStatsSync({
        agentId: target.agentId,
        sessionId,
        sessionKey: compactTarget.primaryKey,
        storePath,
      });
      if (transcriptStats.eventCount === 0) {
        respond(
          true,
          {
            ok: true,
            key: target.canonicalKey,
            compacted: false,
            reason: "no transcript",
          },
          undefined,
        );
        return;
      }
    }

    const lifecycleRevision = entry.lifecycleRevision;
    const queueIdentities = [key, target.canonicalKey, compactTarget.primaryKey, sessionId];
    const lifecycleIdentities = [...queueIdentities, lifecycleRevision];
    let sessionStillCurrent = true;
    let compactionNoopReason: string | undefined;
    let blockedByActiveRun = false;
    let blockedByQueuedWork = false;
    try {
      await runExclusiveSessionLifecycleMutation({
        scope: storePath,
        identities: lifecycleIdentities,
        kind: "compaction",
        prepare: async () => {
          const latestEntry = loadAccessorSessionEntryForGatewayTarget({
            key,
            cfg,
            agentId: requestedAgentId,
          }).entry;
          if (
            !latestEntry ||
            latestEntry.sessionId !== sessionId ||
            latestEntry.lifecycleRevision !== lifecycleRevision ||
            resolveSessionWorkStartError(target.canonicalKey, latestEntry)
          ) {
            sessionStillCurrent = false;
            return;
          }
          if (maxLines === undefined) {
            compactionNoopReason = (
              await preflightGatewaySessionCompaction({
                cfg,
                entry: latestEntry,
                agentId: target.agentId,
                sessionId,
                sessionKey: target.canonicalKey,
                sessionStoreKey: compactTarget.primaryKey,
                storePath,
              })
            )?.reason;
            if (compactionNoopReason) {
              return;
            }
          }
          blockedByActiveRun =
            isCompetingSessionWorkAdmissionActive(storePath, lifecycleIdentities) ||
            (asWorkerInferenceControl(context.workerEnvironmentService)?.hasInferenceForSession(
              sessionId,
            ) ??
              false) ||
            resolveVisibleActiveSessionRunState({
              context,
              requestedKey: key,
              canonicalKey: target.canonicalKey,
              sessionId,
              agentId: requestedAgentId,
              defaultAgentId: compatibilityDefaultAgentId,
            }).active;
          // Accepted work can live only in its command lane; waiting behind it
          // while holding the lifecycle fence would deadlock or drop that turn.
          blockedByQueuedWork =
            hasPendingFollowupQueueWork(queueIdentities) ||
            queueIdentities.some(
              (identity) =>
                getCommandLaneSnapshot(resolveEmbeddedSessionLane(identity)).queuedCount > 0,
            );
        },
        run: async () => {
          if (!sessionStillCurrent) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                `Session ${key} changed before compaction. Retry.`,
                { details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON } },
              ),
            );
            return;
          }
          if (compactionNoopReason) {
            respond(
              true,
              {
                ok: false,
                key: target.canonicalKey,
                compacted: false,
                reason: compactionNoopReason,
              },
              undefined,
            );
            return;
          }
          if (blockedByQueuedWork) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                `Session ${key} has queued work; retry after it finishes.`,
              ),
            );
            return;
          }
          if (blockedByActiveRun) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                `Session ${key} has an active run; retry after it finishes.`,
              ),
            );
            return;
          }

          const latestEntry = loadAccessorSessionEntryForGatewayTarget({
            key,
            cfg,
            agentId: requestedAgentId,
          }).entry;
          if (
            !latestEntry ||
            latestEntry.sessionId !== sessionId ||
            latestEntry.lifecycleRevision !== lifecycleRevision ||
            resolveSessionWorkStartError(target.canonicalKey, latestEntry)
          ) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                `Session ${key} changed before compaction. Retry.`,
                { details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON } },
              ),
            );
            return;
          }

          const operationId = randomUUID();
          if (maxLines !== undefined) {
            const trimResult = await trimSessionTranscriptForManualCompact(
              {
                sessionId,
                storePath,
                sessionKey: compactTarget.primaryKey,
                agentId: target.agentId,
              },
              { maxLines },
            );
            respond(
              true,
              {
                ok: true,
                key: target.canonicalKey,
                compacted: trimResult.compacted,
                ...(trimResult.compacted
                  ? { kept: trimResult.kept }
                  : "kept" in trimResult
                    ? { kept: trimResult.kept }
                    : { reason: "no transcript" }),
              },
              undefined,
            );
            if (trimResult.compacted) {
              recordSessionCompacted({
                sessionKey: target.canonicalKey,
                operationId,
                sessionId,
                agentId: target.agentId ?? requestedAgentId,
              });
              emitSessionsChanged(context, {
                sessionKey: target.canonicalKey,
                agentId: target.agentId,
                reason: "compact",
                compacted: true,
              });
            }
            return;
          }

          const transcriptStats = readTranscriptStatsSync({
            agentId: target.agentId,
            sessionId,
            sessionKey: compactTarget.primaryKey,
            storePath,
          });
          if (transcriptStats.eventCount === 0) {
            respond(
              true,
              {
                ok: true,
                key: target.canonicalKey,
                compacted: false,
                reason: "no transcript",
              },
              undefined,
            );
            return;
          }
          emitSessionOperation(context, {
            operationId,
            operation: "compact",
            phase: "start",
            sessionKey: target.canonicalKey,
            agentId: target.agentId,
          });
          const emitCompactionEnd = (completed: boolean, reason?: string) =>
            emitSessionOperation(context, {
              operationId,
              operation: "compact",
              phase: "end",
              sessionKey: target.canonicalKey,
              agentId: target.agentId,
              completed,
              reason,
            });
          let result: Awaited<ReturnType<typeof runGatewaySessionCompaction>>;
          let expectedEntry: InternalSessionEntry = latestEntry;
          try {
            result = await runGatewaySessionCompaction(
              {
                cfg,
                entry: latestEntry,
                runId: operationId,
                agentId: target.agentId,
                sessionId,
                sessionKey: target.canonicalKey,
                sessionStoreKey: compactTarget.primaryKey,
                storePath,
              },
              {
                onCommitted: (accepted) => {
                  expectedEntry = accepted.entry;
                },
              },
            );
          } catch (err) {
            emitCompactionEnd(false, formatErrorMessage(err));
            throw err;
          }
          if (result.ok && result.compacted) {
            let persisted: boolean;
            try {
              // Skip terminal persistence when session ownership rotated during compaction.
              const persistProjection = await applySessionPatchProjection({
                agentId: target.agentId,
                sessionKeys: [compactTarget.primaryKey],
                storePath,
                resolveTarget: () => ({ primaryKey: compactTarget.primaryKey }),
                project: ({ existingEntry }) => {
                  if (
                    !existingEntry ||
                    existingEntry.sessionId !== expectedEntry.sessionId ||
                    existingEntry.lifecycleRevision !== expectedEntry.lifecycleRevision ||
                    existingEntry.activeWriterRunId !== expectedEntry.activeWriterRunId ||
                    resolveSessionWorkStartError(target.canonicalKey, existingEntry)
                  ) {
                    return { ok: false };
                  }
                  const entryToUpdate = existingEntry;
                  entryToUpdate.updatedAt = Date.now();
                  entryToUpdate.compactionCount =
                    Math.max(0, entryToUpdate.compactionCount ?? 0) + 1;
                  if (result.compactionKind === "context-engine") {
                    clearAllCliSessions(entryToUpdate);
                  }
                  Object.assign(entryToUpdate, COMPACTION_RUN_USAGE_CLEAR_PATCH);
                  delete entryToUpdate.contextBudgetStatus;
                  if (
                    typeof result.result?.tokensAfter === "number" &&
                    Number.isFinite(result.result.tokensAfter)
                  ) {
                    entryToUpdate.totalTokens = result.result.tokensAfter;
                    entryToUpdate.totalTokensFresh = true;
                    entryToUpdate.totalTokensVersion = SESSION_TOTAL_TOKENS_VERSION;
                  } else {
                    delete entryToUpdate.totalTokens;
                    delete entryToUpdate.totalTokensFresh;
                    delete entryToUpdate.totalTokensVersion;
                  }
                  return { ok: true, entry: entryToUpdate };
                },
              });
              persisted = persistProjection.ok;
            } catch (err) {
              emitCompactionEnd(false, formatErrorMessage(err));
              throw err;
            }
            if (!persisted) {
              const reason = `Session ${key} changed before compaction completed. Retry.`;
              emitCompactionEnd(false, reason);
              respond(
                false,
                undefined,
                errorShape(ErrorCodes.INVALID_REQUEST, reason, {
                  details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON },
                }),
              );
              return;
            }
            recordSessionCompacted({
              sessionKey: target.canonicalKey,
              operationId,
              sessionId: expectedEntry.sessionId,
              agentId: target.agentId ?? requestedAgentId,
            });
          }

          emitCompactionEnd(result.ok && result.compacted, result.reason);
          respond(
            true,
            {
              ok: result.ok,
              key: target.canonicalKey,
              compacted: result.compacted,
              reason: result.reason,
              result: result.result,
            },
            undefined,
          );
          if (result.ok) {
            emitSessionsChanged(context, {
              sessionKey: target.canonicalKey,
              agentId: target.agentId,
              reason: "compact",
              compacted: result.compacted,
            });
          }
        },
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(err)));
    }
  },
};
