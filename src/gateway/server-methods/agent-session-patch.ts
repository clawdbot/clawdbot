import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveTrustedGroupId } from "../../agents/agent-tools.policy.js";
import { clearAllCliSessions } from "../../agents/cli-session.js";
import {
  evaluateSessionFreshness,
  hasTerminalMainSessionTranscriptNewerThanRegistrySync,
  resolveSessionLifecycleTimestamps,
  type SessionEntry,
  type SessionFreshness,
} from "../../config/sessions.js";
import { hasProviderOwnedSession } from "../../config/sessions/entry-freshness.js";
import { isRecoverableTerminalSessionStatus } from "../../config/sessions/terminal-status.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  mergeDeliveryContext,
  normalizeSessionDeliveryFields,
  type DeliveryContext,
} from "../../utils/delivery-context.shared.js";
import { canonicalizeSpawnedByForAgent, loadSessionEntry } from "../session-utils.js";
import {
  normalizeTrustedGroupMetadata,
  requestGroupMatchesTrusted,
  resolveTrustedGroupMetadata,
  type TrustedGroupMetadata,
} from "./agent-task-tracking.js";

export type AgentSessionPatchBuild = {
  patch: Partial<SessionEntry>;
  spawnedBy: string | undefined;
  groupId: string | undefined;
  groupChannel: string | undefined;
  groupSpace: string | undefined;
  freshSessionRotatedSinceLoad: boolean;
  isNewSession: boolean;
  rotatedSessionId: boolean;
  usableRequestedSessionId: string | undefined;
  freshness: SessionFreshness | undefined;
};

export function buildAgentSessionPatch(params: {
  freshEntry: SessionEntry | undefined;
  initialEntry: SessionEntry | undefined;
  cfg: OpenClawConfig;
  sessionAgentId: string;
  canonicalSessionKey: string;
  storePath: string;
  normalizedSpawned: { groupId?: string; groupChannel?: string; groupSpace?: string };
  requestDeliveryHint: DeliveryContext | undefined;
  requestLabel?: string;
  recipientChannel?: string;
  pluginOwnerId?: string;
  expectedExistingSessionId?: string;
  hasRestoredCronContinuation: boolean;
  resetPolicy: ReturnType<typeof import("../../config/sessions.js").resolveSessionResetPolicy>;
  now: number;
  requestedSessionId?: string;
  isSystemGatewayRun: boolean;
  visibleRequest: boolean;
  fallbackSessionId: string;
  touchInteraction: boolean;
  failedSessionTranscriptMissing: (entry: SessionEntry | undefined) => boolean;
}): AgentSessionPatchBuild {
  const freshSpawnedBy = canonicalizeSpawnedByForAgent(
    params.cfg,
    params.sessionAgentId,
    params.freshEntry?.spawnedBy,
  );
  const storedGroup = normalizeTrustedGroupMetadata(params.freshEntry);
  let inheritedGroup: TrustedGroupMetadata | undefined;
  if (
    freshSpawnedBy &&
    (!storedGroup.groupId || !storedGroup.groupChannel || !storedGroup.groupSpace)
  ) {
    try {
      const parentEntry = loadSessionEntry(freshSpawnedBy)?.entry;
      inheritedGroup = normalizeTrustedGroupMetadata({
        groupId: parentEntry?.groupId,
        groupChannel: parentEntry?.groupChannel,
        groupSpace: parentEntry?.space,
      });
    } catch {
      inheritedGroup = undefined;
    }
  }
  const trustedGroup = resolveTrustedGroupMetadata({
    sessionKey: params.canonicalSessionKey,
    spawnedBy: freshSpawnedBy,
    stored: storedGroup,
    inherited: inheritedGroup,
  });
  const validatedGroup = trustedGroup.groupId
    ? resolveTrustedGroupId({
        groupId: trustedGroup.groupId,
        sessionKey: params.canonicalSessionKey,
        spawnedBy: freshSpawnedBy,
      })
    : undefined;
  const trustRequestSelectors =
    Boolean(trustedGroup.groupId) &&
    requestGroupMatchesTrusted({
      requestGroupId: params.normalizedSpawned.groupId,
      trustedGroupId: trustedGroup.groupId,
    });
  const nextGroup = validatedGroup?.dropped
    ? { groupId: undefined, groupChannel: undefined, groupSpace: undefined }
    : {
        groupId: trustedGroup.groupId,
        groupChannel:
          trustedGroup.groupChannel ??
          (trustRequestSelectors ? params.normalizedSpawned.groupChannel : undefined),
        groupSpace:
          trustedGroup.groupSpace ??
          (trustRequestSelectors ? params.normalizedSpawned.groupSpace : undefined),
      };

  const deliveryFields = normalizeSessionDeliveryFields(params.freshEntry);
  const effectiveDelivery = mergeDeliveryContext(
    deliveryFields.deliveryContext,
    params.requestDeliveryHint,
  );
  const effectiveDeliveryFields = normalizeSessionDeliveryFields({
    route: deliveryFields.route,
    deliveryContext: effectiveDelivery,
  });
  const labelValue = normalizeOptionalString(params.requestLabel) || params.freshEntry?.label;
  const channelValue = params.freshEntry?.channel ?? params.recipientChannel?.trim();
  const freshSessionRotatedSinceLoad = Boolean(
    params.initialEntry?.sessionId &&
    params.freshEntry?.sessionId &&
    params.freshEntry.sessionId !== params.initialEntry.sessionId,
  );
  const freshLifecycleTimestamps = params.freshEntry
    ? resolveSessionLifecycleTimestamps({
        entry: params.freshEntry,
        storePath: params.storePath,
        agentId: params.sessionAgentId,
      })
    : undefined;
  const freshSkipImplicitExpiry =
    params.expectedExistingSessionId !== undefined ||
    params.hasRestoredCronContinuation ||
    params.freshEntry?.modelSelectionLocked === true ||
    (params.resetPolicy.configured !== true && hasProviderOwnedSession(params.freshEntry));
  const freshFreshness = params.freshEntry
    ? freshSkipImplicitExpiry
      ? ({ fresh: true } satisfies SessionFreshness)
      : evaluateSessionFreshness({
          updatedAt: params.freshEntry.updatedAt,
          ...freshLifecycleTimestamps,
          now: params.now,
          policy: params.resetPolicy,
        })
    : undefined;
  const freshRequestedSessionMatchesEntry = Boolean(
    params.requestedSessionId && params.freshEntry?.sessionId?.trim() === params.requestedSessionId,
  );
  const freshTerminalMainTranscriptNewerThanRegistry =
    params.isSystemGatewayRun || freshRequestedSessionMatchesEntry
      ? false
      : hasTerminalMainSessionTranscriptNewerThanRegistrySync({
          entry: params.freshEntry,
          sessionScope: params.cfg.session?.scope,
          sessionKey: params.canonicalSessionKey,
          agentId: params.sessionAgentId,
          mainKey: params.cfg.session?.mainKey,
          storePath: params.storePath,
        });
  const freshRecoverableTerminalSession =
    Boolean(params.freshEntry?.sessionId) &&
    params.visibleRequest &&
    isRecoverableTerminalSessionStatus(params.freshEntry?.status);
  const freshCanReuseSession =
    Boolean(params.freshEntry?.sessionId) &&
    ((freshFreshness?.fresh ?? false) || freshRecoverableTerminalSession) &&
    !params.failedSessionTranscriptMissing(params.freshEntry) &&
    !freshTerminalMainTranscriptNewerThanRegistry;
  const freshUsableRequestedSessionId =
    params.requestedSessionId && (!params.freshEntry?.sessionId || freshCanReuseSession)
      ? params.requestedSessionId
      : undefined;
  const freshSessionId =
    freshUsableRequestedSessionId ??
    (freshCanReuseSession ? params.freshEntry?.sessionId : undefined) ??
    params.fallbackSessionId;
  const freshIsNewSession =
    !params.freshEntry ||
    (!freshCanReuseSession && !freshUsableRequestedSessionId) ||
    Boolean(
      freshUsableRequestedSessionId &&
      params.freshEntry?.sessionId !== freshUsableRequestedSessionId,
    );
  const freshRotatedSessionId = Boolean(
    params.freshEntry?.sessionId && params.freshEntry.sessionId !== freshSessionId,
  );
  const patchSessionId = freshSessionRotatedSinceLoad
    ? params.freshEntry?.sessionId
    : freshSessionId;
  const shouldClearRotatedState = freshRotatedSessionId && !freshSessionRotatedSinceLoad;
  const shouldClearTerminalState =
    freshCanReuseSession &&
    freshRecoverableTerminalSession &&
    !freshSessionRotatedSinceLoad &&
    patchSessionId === params.freshEntry?.sessionId;
  const patch: Partial<SessionEntry> = {
    sessionId: patchSessionId,
    updatedAt: params.now,
    ...(freshIsNewSession && !freshSessionRotatedSinceLoad ? { sessionStartedAt: params.now } : {}),
    ...(params.touchInteraction ? { lastInteractionAt: params.now } : {}),
    ...(effectiveDeliveryFields.route ? { route: effectiveDeliveryFields.route } : {}),
    ...(effectiveDeliveryFields.deliveryContext
      ? { deliveryContext: effectiveDeliveryFields.deliveryContext }
      : {}),
    ...(effectiveDeliveryFields.lastChannel
      ? { lastChannel: effectiveDeliveryFields.lastChannel }
      : {}),
    ...(effectiveDeliveryFields.lastTo ? { lastTo: effectiveDeliveryFields.lastTo } : {}),
    ...(effectiveDeliveryFields.lastAccountId
      ? { lastAccountId: effectiveDeliveryFields.lastAccountId }
      : {}),
    ...(effectiveDeliveryFields.lastThreadId != null
      ? { lastThreadId: effectiveDeliveryFields.lastThreadId }
      : {}),
    ...(labelValue ? { label: labelValue } : {}),
    ...(freshSpawnedBy ? { spawnedBy: freshSpawnedBy } : {}),
    ...(channelValue ? { channel: channelValue } : {}),
    groupId: nextGroup.groupId,
    groupChannel: nextGroup.groupChannel,
    space: nextGroup.groupSpace,
    // Plugin ownership is creation-only; existing sessions keep their original owner.
    ...(params.freshEntry === undefined && params.pluginOwnerId
      ? { pluginOwnerId: params.pluginOwnerId }
      : {}),
    ...(shouldClearRotatedState || shouldClearTerminalState
      ? {
          status: undefined,
          startedAt: undefined,
          endedAt: undefined,
          runtimeMs: undefined,
          abortedLastRun: undefined,
          ...(shouldClearRotatedState ? { sessionFile: undefined } : {}),
        }
      : {}),
  };
  if (shouldClearRotatedState) {
    clearAllCliSessions(patch);
  }
  return {
    patch,
    spawnedBy: freshSpawnedBy,
    groupId: nextGroup.groupId,
    groupChannel: nextGroup.groupChannel,
    groupSpace: nextGroup.groupSpace,
    freshSessionRotatedSinceLoad,
    isNewSession: freshIsNewSession,
    rotatedSessionId: freshRotatedSessionId,
    usableRequestedSessionId: freshUsableRequestedSessionId,
    freshness: freshFreshness,
  };
}
