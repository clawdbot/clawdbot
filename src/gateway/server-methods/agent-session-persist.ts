import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  isMainSessionRecoveryExhausted,
  transitionMainSessionRecovery,
} from "../../agents/main-session-recovery-state.js";
import type { MainSessionRecoveryOwnerLease } from "../../agents/main-session-recovery-store.js";
import {
  mergeSessionEntry,
  resolveSessionLifecycleTimestamps,
  resolveSessionWorkStartError,
  type SessionEntry,
  type InternalSessionEntry,
  type SessionFreshness,
} from "../../config/sessions.js";
import {
  patchSessionEntryTarget,
  type SessionEntryPatchOptions,
} from "../../config/sessions/session-accessor.js";
import { buildSessionCreationStamp } from "../../config/sessions/session-entry-provenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeCronScheduledToolPolicy } from "../../cron/scheduled-tool-policy.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { recordSessionCreated } from "../../sessions/session-state-events.js";
import { getGeneratedMediaTaskIdsForSessionKey } from "../../tasks/task-status-access.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.shared.js";
import { formatForLog } from "../ws-log.js";
import {
  assertExpectedExistingSession,
  ExpectedExistingSessionChangedError,
} from "./agent-expected-session.js";
import {
  cronContinuationHasReusableRuntime,
  emitAgentSendSessionLifecycleTransition,
  withSqliteSessionFileMarker,
  type RestoredCronContinuation,
} from "./agent-handler-helpers.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import type { AgentSessionPatchBuild } from "./agent-session-patch.js";
import type { TrustedSessionCreation } from "./session-creation-provenance.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export type CronContinuationClaim = {
  storePath: string;
  sessionKey: string;
  lifecycleRevision: string;
  initialEntry: SessionEntry;
  mediaTaskIdsBefore: ReadonlySet<string>;
};

type AgentSessionPersistResult = {
  sessionEntry?: SessionEntry;
  resolvedSessionId?: string;
  sessionPersistedBeforeGatewayAdmission: boolean;
  supersededSessionId?: string;
  admittedSessionId: string;
  skipAgentInitialSessionTouch: boolean;
  patchBuild: AgentSessionPatchBuild;
  isNewSession: boolean;
  rotatedSessionId: boolean;
  usableRequestedSessionId?: string;
  freshness: SessionFreshness | undefined;
  spawnedBy?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  pendingChatRun?: { sessionKey: string; agentId?: string };
  bestEffortDeliver: boolean;
  restoredCronContinuation?: RestoredCronContinuation;
};

export async function persistAgentSessionPhase(params: {
  request: AgentRunRequest;
  cfg: OpenClawConfig;
  storePath: string;
  storeKeys?: string[];
  entry?: SessionEntry;
  canonicalSessionKey: string;
  sessionAgentId: string;
  mainSessionKey: string;
  creation: TrustedSessionCreation;
  lifecycleGeneration: string;
  isRestartRecoveryResumeRun: boolean;
  runId: string;
  agentId?: string;
  suppressVisibleSessionEffects: boolean;
  restoredCronContinuationIdentity?: Pick<
    RestoredCronContinuation,
    "lifecycleRevision" | "sessionId"
  >;
  initialPatchBuild: AgentSessionPatchBuild;
  buildSessionPatch: (entry: SessionEntry | undefined) => AgentSessionPatchBuild;
  initialSessionEntry?: SessionEntry;
  initialResolvedSessionId?: string;
  initialSessionPersistedBeforeGatewayAdmission: boolean;
  initialSupersededSessionId?: string;
  touchInteraction: boolean;
  requestedBestEffortDeliver?: boolean;
  bestEffortDeliver: boolean;
  expectedSession: Parameters<typeof assertExpectedExistingSession>[0]["constraint"];
  maintenanceConfig: SessionEntryPatchOptions["maintenanceConfig"];
  abortForLifecycleRotation: (target?: { sessionKey?: string; agentId?: string }) => boolean;
  assertGatewayWorkAdmissionAllowed: () => void;
  respondToGatewayAdmissionOutcome: () => boolean;
  updateAdmissionState: (state: {
    resolvedSessionId?: string;
    admittedSessionId: string;
    supersededSessionId?: string;
    sessionPersistedBeforeGatewayAdmission: boolean;
  }) => void;
  getAdmittedSessionId: () => string;
  setCronContinuationClaim: (claim: CronContinuationClaim) => void;
  setMainRestartRecoveryOwnerLease: (lease: MainSessionRecoveryOwnerLease) => void;
  respond: GatewayRequestHandlerOptions["respond"];
}): Promise<AgentSessionPersistResult | undefined> {
  let patchBuild = params.initialPatchBuild;
  let sessionEntry = params.initialSessionEntry;
  let resolvedSessionId = params.initialResolvedSessionId;
  let sessionPersistedBeforeGatewayAdmission = params.initialSessionPersistedBeforeGatewayAdmission;
  let supersededSessionId = params.initialSupersededSessionId;
  let restoredCronContinuation: RestoredCronContinuation | undefined;
  let mainRestartRecoveryOwnerLease: MainSessionRecoveryOwnerLease | undefined;
  let skipAgentInitialSessionTouch = false;
  let createdNewEntry = false;
  const recoveredSessionStartedAt =
    !patchBuild.isNewSession &&
    params.entry !== undefined &&
    params.entry.sessionStartedAt === undefined
      ? resolveSessionLifecycleTimestamps({
          entry: params.entry,
          storePath: params.storePath,
          agentId: params.sessionAgentId,
        }).sessionStartedAt
      : undefined;

  if (params.storePath && !params.suppressVisibleSessionEffects) {
    if (
      params.abortForLifecycleRotation({
        sessionKey: params.canonicalSessionKey,
        agentId: params.agentId,
      })
    ) {
      return undefined;
    }
    let deniedBySendPolicy = false;
    let deniedSessionEntry: SessionEntry | undefined;
    let persisted: SessionEntry | undefined;
    let archivedDuringStoreUpdateError: string | undefined;
    let deletedDuringStoreUpdateError: string | undefined;
    let restoredCronContinuationError: string | undefined;
    let restartRecoveryReservationConflict: string | undefined;
    try {
      persisted =
        (await patchSessionEntryTarget(
          {
            agentId: params.sessionAgentId,
            storePath: params.storePath,
            target: {
              canonicalKey: params.canonicalSessionKey,
              storeKeys: params.storeKeys ?? [params.canonicalSessionKey],
            },
          },
          (_currentEntry, patchContext) => {
            assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
            const freshEntry = patchContext.existingEntry;
            assertExpectedExistingSession({
              constraint: params.expectedSession,
              entry: freshEntry,
              message: `Session "${params.canonicalSessionKey}" changed before expected work could start.`,
            });
            if (params.entry && !freshEntry) {
              deletedDuringStoreUpdateError = `Session "${params.canonicalSessionKey}" was deleted while starting work. Retry.`;
              throw new Error(deletedDuringStoreUpdateError);
            }
            const archivedError = resolveSessionWorkStartError(
              params.canonicalSessionKey,
              freshEntry,
            );
            if (archivedError) {
              archivedDuringStoreUpdateError = archivedError;
              throw new Error(archivedError);
            }
            const internalFreshEntry = freshEntry as InternalSessionEntry | undefined;
            if (
              !params.isRestartRecoveryResumeRun &&
              internalFreshEntry &&
              (internalFreshEntry.mainRestartRecovery?.tombstone ||
                isMainSessionRecoveryExhausted(internalFreshEntry))
            ) {
              restartRecoveryReservationConflict =
                `Session "${params.canonicalSessionKey}" is quarantined after restart recovery ` +
                "exhaustion; use /new or /reset before starting new work.";
              throw new Error(restartRecoveryReservationConflict);
            }
            let entryForPatch = freshEntry;
            if (params.restoredCronContinuationIdentity) {
              const marker = freshEntry?.cronRunContinuation;
              const provider = normalizeOptionalString(freshEntry?.modelProvider);
              const model = normalizeOptionalString(freshEntry?.model);
              const identityMatches =
                marker?.phase === "ready" &&
                marker.basePersisted === true &&
                marker.lifecycleRevision ===
                  params.restoredCronContinuationIdentity.lifecycleRevision &&
                freshEntry?.sessionId === params.restoredCronContinuationIdentity.sessionId;
              if (!identityMatches || !freshEntry || !provider || !model) {
                restoredCronContinuationError = "cron run continuation changed before admission";
                throw new Error(restoredCronContinuationError);
              }
              if (
                !cronContinuationHasReusableRuntime({
                  cfg: params.cfg,
                  entry: freshEntry,
                  agentId: params.sessionAgentId,
                  provider,
                  model,
                })
              ) {
                restoredCronContinuationError =
                  "cron run continuation has no reusable native CLI session";
                throw new Error(restoredCronContinuationError);
              }
              restoredCronContinuation = {
                ...params.restoredCronContinuationIdentity,
                provider,
                model,
                ...(freshEntry.thinkingLevel ? { thinking: freshEntry.thinkingLevel } : {}),
                ...(marker.toolsAllow !== undefined ? { toolsAllow: [...marker.toolsAllow] } : {}),
                ...(marker.toolsAllowIsDefault === true ? { toolsAllowIsDefault: true } : {}),
                ...(normalizeCronScheduledToolPolicy(marker.scheduledToolPolicy)
                  ? {
                      scheduledToolPolicy: normalizeCronScheduledToolPolicy(
                        marker.scheduledToolPolicy,
                      ),
                    }
                  : {}),
                ...(marker.cliSessionBindingFacts
                  ? { cliSessionBindingFacts: { ...marker.cliSessionBindingFacts } }
                  : {}),
              };
              entryForPatch = {
                ...freshEntry,
                cronRunContinuation: {
                  ...marker,
                  phase: "continuing",
                  ownerRunId: params.runId,
                  ownerLifecycleGeneration: params.lifecycleGeneration,
                },
              };
              params.setCronContinuationClaim({
                storePath: params.storePath,
                sessionKey: params.canonicalSessionKey,
                lifecycleRevision: marker.lifecycleRevision,
                initialEntry: structuredClone(entryForPatch!),
                mediaTaskIdsBefore: getGeneratedMediaTaskIdsForSessionKey(
                  params.canonicalSessionKey,
                ),
              });
            }
            patchBuild = params.buildSessionPatch(entryForPatch);
            const lifecyclePatch =
              recoveredSessionStartedAt !== undefined &&
              entryForPatch?.sessionStartedAt === undefined &&
              entryForPatch?.sessionId === params.entry?.sessionId
                ? { ...patchBuild.patch, sessionStartedAt: recoveredSessionStartedAt }
                : patchBuild.patch;
            const previousSessionId = normalizeOptionalString(freshEntry?.sessionId);
            const nextSessionId = normalizeOptionalString(lifecyclePatch.sessionId);
            const rotationLineage =
              previousSessionId && nextSessionId && previousSessionId !== nextSessionId
                ? { previousSessionId }
                : {};
            const effectivePatch = freshEntry
              ? { ...lifecyclePatch, ...rotationLineage }
              : {
                  ...lifecyclePatch,
                  ...buildSessionCreationStamp(params.creation),
                };
            createdNewEntry = freshEntry === undefined;
            const merged = withSqliteSessionFileMarker({
              agentId: params.sessionAgentId,
              entry: mergeSessionEntry(entryForPatch, effectivePatch),
              sessionKey: params.canonicalSessionKey,
              storePath: params.storePath,
            });
            const recoveryTransition = params.isRestartRecoveryResumeRun
              ? transitionMainSessionRecovery(merged as InternalSessionEntry, {
                  kind: "validate_recovery",
                  lifecycleGeneration: params.lifecycleGeneration,
                  runId: params.runId,
                  sessionId: params.request.expectedExistingSessionId ?? merged.sessionId,
                })
              : transitionMainSessionRecovery(merged as InternalSessionEntry, {
                  kind: "claim_foreground",
                  cycleId: randomUUID(),
                  lifecycleGeneration: params.lifecycleGeneration,
                  sessionId: merged.sessionId,
                  sessionKey: params.canonicalSessionKey,
                  claimId: mainRestartRecoveryOwnerLease?.claimId ?? randomUUID(),
                  runId: params.runId,
                });
            if (
              params.isRestartRecoveryResumeRun &&
              recoveryTransition.kind !== "recovery_validated"
            ) {
              restartRecoveryReservationConflict =
                `Session "${params.canonicalSessionKey}" restart recovery reservation is stale; ` +
                "recovery was skipped.";
              throw new Error(restartRecoveryReservationConflict);
            }
            if (recoveryTransition.kind === "foreground_claimed") {
              mainRestartRecoveryOwnerLease = {
                ...recoveryTransition.claim,
                storePath: params.storePath,
              };
              params.setMainRestartRecoveryOwnerLease(mainRestartRecoveryOwnerLease);
            }
            if (
              params.request.deliver === true &&
              resolveSendPolicy({
                cfg: params.cfg,
                entry: merged,
                sessionKey: params.canonicalSessionKey,
                channel: sessionDeliveryChannel(merged),
                chatType: merged.chatType,
              }) === "deny"
            ) {
              deniedBySendPolicy = true;
              deniedSessionEntry = merged;
              return null;
            }
            return merged;
          },
          {
            fallbackEntry: params.entry ?? mergeSessionEntry(undefined, patchBuild.patch),
            replaceEntry: true,
            takeCacheOwnership: true,
            maintenanceConfig: params.maintenanceConfig,
          },
        )) ?? undefined;
    } catch (err) {
      if (
        params.abortForLifecycleRotation({
          sessionKey: params.canonicalSessionKey,
          agentId: params.agentId,
        })
      ) {
        return undefined;
      }
      if (archivedDuringStoreUpdateError) {
        params.respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, archivedDuringStoreUpdateError),
        );
        return undefined;
      }
      if (deletedDuringStoreUpdateError) {
        params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
        return undefined;
      }
      if (err instanceof ExpectedExistingSessionChangedError) {
        params.respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, err.message));
        return undefined;
      }
      if (restoredCronContinuationError) {
        params.respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, restoredCronContinuationError),
        );
        return undefined;
      }
      if (restartRecoveryReservationConflict) {
        params.respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, restartRecoveryReservationConflict),
        );
        return undefined;
      }
      throw err;
    }
    if (
      params.abortForLifecycleRotation({
        sessionKey: params.canonicalSessionKey,
        agentId: params.agentId,
      })
    ) {
      return undefined;
    }
    if (deniedBySendPolicy && deniedSessionEntry) {
      sessionEntry = deniedSessionEntry;
      resolvedSessionId = sessionEntry.sessionId;
    } else if (persisted) {
      sessionEntry = persisted;
      resolvedSessionId = sessionEntry.sessionId;
      sessionPersistedBeforeGatewayAdmission = true;
    }
    if (
      patchBuild.isNewSession &&
      params.entry?.sessionId &&
      resolvedSessionId !== params.entry.sessionId
    ) {
      supersededSessionId = params.entry.sessionId;
    }
    const admittedSessionId = resolvedSessionId ?? params.runId;
    params.updateAdmissionState({
      resolvedSessionId,
      admittedSessionId,
      supersededSessionId,
      sessionPersistedBeforeGatewayAdmission,
    });
    try {
      params.assertGatewayWorkAdmissionAllowed();
    } catch (err) {
      params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
      return undefined;
    }
    if (
      params.respondToGatewayAdmissionOutcome() ||
      params.abortForLifecycleRotation({
        sessionKey: params.canonicalSessionKey,
        agentId: params.agentId,
      })
    ) {
      return undefined;
    }
    skipAgentInitialSessionTouch = params.touchInteraction;
    if (deniedBySendPolicy) {
      params.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
      );
      return undefined;
    }
  }

  const isNewSession = patchBuild.isNewSession;
  const rotatedSessionId = patchBuild.rotatedSessionId;
  const usableRequestedSessionId = patchBuild.usableRequestedSessionId;
  const freshness = patchBuild.freshness;
  if (createdNewEntry && sessionEntry) {
    recordSessionCreated({
      sessionKey: params.canonicalSessionKey,
      agentId: params.sessionAgentId,
      entry: sessionEntry,
    });
  }
  if (isNewSession && params.entry?.sessionId && resolvedSessionId !== params.entry.sessionId) {
    supersededSessionId = params.entry.sessionId;
  }
  if (
    !params.suppressVisibleSessionEffects &&
    isNewSession &&
    resolvedSessionId &&
    params.storePath &&
    !patchBuild.freshSessionRotatedSinceLoad
  ) {
    const previousSessionId = rotatedSessionId ? params.entry?.sessionId : undefined;
    emitAgentSendSessionLifecycleTransition({
      cfg: params.cfg,
      sessionKey: params.canonicalSessionKey,
      sessionId: resolvedSessionId,
      storePath: params.storePath,
      agentId: params.sessionAgentId,
      previousSessionId,
      previousEndReason: previousSessionId
        ? (freshness?.staleReason ??
          (usableRequestedSessionId && params.entry?.sessionId !== usableRequestedSessionId
            ? "new"
            : "unknown"))
        : undefined,
    });
  }
  if (
    params.request.deliver === true &&
    resolveSendPolicy({
      cfg: params.cfg,
      entry: sessionEntry,
      sessionKey: params.canonicalSessionKey,
      channel: sessionDeliveryChannel(sessionEntry),
      chatType: sessionEntry?.chatType,
    }) === "deny"
  ) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
    );
    return undefined;
  }
  const isMainSession =
    !params.suppressVisibleSessionEffects &&
    (params.canonicalSessionKey === params.mainSessionKey ||
      params.canonicalSessionKey === "global");
  return {
    sessionEntry,
    resolvedSessionId,
    sessionPersistedBeforeGatewayAdmission,
    supersededSessionId,
    // Admission revalidation can observe a newer session id after persistence.
    admittedSessionId: params.getAdmittedSessionId(),
    skipAgentInitialSessionTouch,
    patchBuild,
    isNewSession,
    rotatedSessionId,
    usableRequestedSessionId,
    freshness,
    spawnedBy: patchBuild.spawnedBy,
    groupId: patchBuild.groupId,
    groupChannel: patchBuild.groupChannel,
    groupSpace: patchBuild.groupSpace,
    pendingChatRun: isMainSession
      ? {
          sessionKey: params.canonicalSessionKey,
          ...(params.canonicalSessionKey === "global" ? { agentId: params.sessionAgentId } : {}),
        }
      : undefined,
    bestEffortDeliver:
      isMainSession && params.requestedBestEffortDeliver === undefined
        ? true
        : params.bestEffortDeliver,
    restoredCronContinuation,
  };
}
