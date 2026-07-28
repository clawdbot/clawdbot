// Manual transcript trimming and model-backed session compaction.
import { randomUUID } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  validateSessionsCompactParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue/cleanup.js";
import {
  resolveSessionWorkStartError,
  SESSION_LIFECYCLE_CHANGED_ERROR_REASON,
} from "../../config/sessions.js";
import {
  applySessionPatchProjection,
  loadTranscriptEvents,
  preflightSessionTranscriptForManualCompact,
  trimSessionTranscriptForManualCompact,
} from "../../config/sessions/session-accessor.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  isCompetingSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { recordSessionCompacted } from "../../sessions/session-state-events.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-create-service.js";
import { migrateAndPruneGatewaySessionStoreKey } from "../session-utils.js";
import { asWorkerInferenceControl } from "../worker-environments/inference-control.js";
import { hasVisibleActiveSessionRun } from "./session-active-runs.js";
import { emitSessionsChanged } from "./session-change-event.js";
import {
  preflightGatewaySessionCompaction,
  runGatewaySessionCompaction,
} from "./sessions-compaction-runner.js";
import {
  emitSessionOperation,
  loadAccessorSessionEntryForGatewayTarget,
  requireSessionKey,
  resolveGatewaySessionTargetFromKey,
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
    const { target, storePath } = resolveGatewaySessionTargetFromKey(key, cfg, {
      agentId: requestedAgentId,
    });
    // Lock + read in a short critical section; transcript work happens outside.
    // The projection resolver re-runs gateway key migration on the writer
    // snapshot so alias promotion/pruning persists through the accessor.
    let compactPrimaryKey = target.canonicalKey;
    const compactRead = await applySessionPatchProjection({
      agentId: target.agentId,
      storePath,
      resolveTarget: ({ entries }) => {
        const snapshot = Object.fromEntries(
          entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
        );
        const { target: migratedTarget, primaryKey } = migrateAndPruneGatewaySessionStoreKey({
          cfg,
          key,
          store: snapshot,
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
      const transcriptEvents = await loadTranscriptEvents({
        agentId: target.agentId,
        sessionId,
        sessionKey: compactTarget.primaryKey,
        storePath,
      }).catch(() => []);
      if (transcriptEvents.length === 0) {
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
    const lifecycleIdentities = [
      key,
      target.canonicalKey,
      compactTarget.primaryKey,
      sessionId,
      lifecycleRevision,
    ];
    let sessionStillCurrent = true;
    let compactionNoopReason: string | undefined;
    let blockedByActiveRun = false;
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
            hasVisibleActiveSessionRun({
              context,
              requestedKey: key,
              canonicalKey: target.canonicalKey,
              sessionId,
              agentId: requestedAgentId,
              defaultAgentId: resolveDefaultAgentId(cfg),
            });
          if (blockedByActiveRun) {
            return;
          }
          // Drop work queued against the pre-compaction transcript before its
          // lifecycle fence commits and no longer exposes queue cleanup.
          clearSessionQueues([key, target.canonicalKey, compactTarget.primaryKey, sessionId]);
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
                  ? { archived: trimResult.archived, kept: trimResult.kept }
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
                ...(target.canonicalKey === "global" && target.agentId
                  ? { agentId: target.agentId }
                  : {}),
                reason: "compact",
                compacted: true,
              });
            }
            return;
          }

          const transcriptEvents = await loadTranscriptEvents({
            agentId: target.agentId,
            sessionId,
            sessionKey: compactTarget.primaryKey,
            storePath,
          }).catch(() => []);
          if (transcriptEvents.length === 0) {
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
            ...(target.canonicalKey === "global" && target.agentId
              ? { agentId: target.agentId }
              : {}),
          });
          const emitCompactionEnd = (completed: boolean, reason?: string) =>
            emitSessionOperation(context, {
              operationId,
              operation: "compact",
              phase: "end",
              sessionKey: target.canonicalKey,
              ...(target.canonicalKey === "global" && target.agentId
                ? { agentId: target.agentId }
                : {}),
              completed,
              reason,
            });
          let result: Awaited<ReturnType<typeof runGatewaySessionCompaction>>;
          try {
            result = await runGatewaySessionCompaction({
              cfg,
              entry: latestEntry,
              agentId: target.agentId,
              sessionId,
              sessionKey: target.canonicalKey,
              sessionStoreKey: compactTarget.primaryKey,
              storePath,
            });
          } catch (err) {
            emitCompactionEnd(false, formatErrorMessage(err));
            throw err;
          }
          if (result.ok && result.compacted) {
            let persisted: boolean;
            try {
              // Guarded terminal persist: skip when session ownership rotated
              // while compaction ran (sessionId/lifecycleRevision/work-start).
              const persistProjection = await applySessionPatchProjection({
                agentId: target.agentId,
                storePath,
                resolveTarget: () => ({ primaryKey: compactTarget.primaryKey }),
                project: ({ existingEntry }) => {
                  if (
                    !existingEntry ||
                    existingEntry.sessionId !== sessionId ||
                    existingEntry.lifecycleRevision !== lifecycleRevision ||
                    resolveSessionWorkStartError(target.canonicalKey, existingEntry)
                  ) {
                    return { ok: false };
                  }
                  const entryToUpdate = existingEntry;
                  entryToUpdate.updatedAt = Date.now();
                  entryToUpdate.compactionCount =
                    Math.max(0, entryToUpdate.compactionCount ?? 0) + 1;
                  if (
                    result.result?.sessionId &&
                    result.result.sessionId !== entryToUpdate.sessionId
                  ) {
                    entryToUpdate.sessionId = result.result.sessionId;
                  }
                  delete entryToUpdate.inputTokens;
                  delete entryToUpdate.outputTokens;
                  delete entryToUpdate.contextBudgetStatus;
                  if (
                    typeof result.result?.tokensAfter === "number" &&
                    Number.isFinite(result.result.tokensAfter)
                  ) {
                    entryToUpdate.totalTokens = result.result.tokensAfter;
                    entryToUpdate.totalTokensFresh = true;
                  } else {
                    delete entryToUpdate.totalTokens;
                    delete entryToUpdate.totalTokensFresh;
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
              sessionId: result.result?.sessionId ?? sessionId,
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
              ...(target.canonicalKey === "global" && target.agentId
                ? { agentId: target.agentId }
                : {}),
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
