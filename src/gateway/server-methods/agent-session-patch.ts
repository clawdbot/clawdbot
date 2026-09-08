import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveTrustedGroupId } from "../../agents/agent-tools.policy.js";
import { clearAllCliSessions } from "../../agents/cli-session.js";
import { buildMainSessionRecoveryClearPatch } from "../../agents/main-session-recovery/main-session-recovery-clear.js";
import {
  evaluateSessionFreshness,
  hasTerminalMainSessionTranscriptNewerThanRegistrySync,
  resolveSessionLifecycleTimestamps,
  type SessionFreshness,
} from "../../config/sessions.js";
import { hasProviderOwnedSession } from "../../config/sessions/entry-freshness.js";
import { resolveSessionEntryAccessTarget } from "../../config/sessions/session-accessor.js";
import { isRecoverableTerminalSessionStatus } from "../../config/sessions/terminal-status.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  isAcpSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeSessionDeliveryState,
  sessionDeliveryOrigin,
  sessionDeliveryRoute,
  type DeliveryContext,
} from "../../utils/delivery-context.shared.js";
import { resolveSessionStoreKey } from "../session-store-key.js";
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

type AgentSessionReuseInput = {
  freshEntry: SessionEntry | undefined;
  cfg: OpenClawConfig;
  sessionAgentId: string;
  canonicalSessionKey: string;
  storePath: string;
  expectedExistingSessionId?: string;
  hasRestoredCronContinuation: boolean;
  resetPolicy: ReturnType<typeof import("../../config/sessions.js").resolveSessionResetPolicy>;
  now: number;
  requestedSessionId?: string;
  isSystemGatewayRun: boolean;
  visibleRequest: boolean;
  failedSessionTranscriptMissing: (entry: SessionEntry | undefined) => boolean;
};

/** Re-evaluate the entry from each read; callers retain admission and concurrent-rotation fencing. */
export function evaluateAgentSessionReuse(params: AgentSessionReuseInput) {
  const lifecycleTimestamps = params.freshEntry
    ? resolveSessionLifecycleTimestamps({
        entry: params.freshEntry,
        storePath: params.storePath,
        agentId: params.sessionAgentId,
        sessionKey: params.canonicalSessionKey,
      })
    : undefined;
  const skipImplicitExpiry =
    params.expectedExistingSessionId !== undefined ||
    params.hasRestoredCronContinuation ||
    params.freshEntry?.modelSelectionLocked === true ||
    (params.resetPolicy.configured !== true && hasProviderOwnedSession(params.freshEntry));
  const freshness = params.freshEntry
    ? skipImplicitExpiry
      ? ({ fresh: true } satisfies SessionFreshness)
      : evaluateSessionFreshness({
          updatedAt: params.freshEntry.updatedAt,
          ...lifecycleTimestamps,
          now: params.now,
          policy: params.resetPolicy,
        })
    : undefined;
  const requestedSessionMatchesEntry = Boolean(
    params.requestedSessionId && params.freshEntry?.sessionId?.trim() === params.requestedSessionId,
  );
  const terminalMainTranscriptNewerThanRegistry =
    params.isSystemGatewayRun || requestedSessionMatchesEntry
      ? false
      : hasTerminalMainSessionTranscriptNewerThanRegistrySync({
          entry: params.freshEntry,
          sessionScope: params.cfg.session?.scope,
          sessionKey: params.canonicalSessionKey,
          agentId: params.sessionAgentId,
          mainKey: params.cfg.session?.mainKey,
          storePath: params.storePath,
        });
  const recoverableTerminalSession =
    Boolean(params.freshEntry?.sessionId) &&
    params.visibleRequest &&
    isRecoverableTerminalSessionStatus(params.freshEntry?.status);
  const canReuseSession =
    Boolean(params.freshEntry?.sessionId) &&
    ((freshness?.fresh ?? false) || recoverableTerminalSession) &&
    !params.failedSessionTranscriptMissing(params.freshEntry) &&
    !terminalMainTranscriptNewerThanRegistry;
  const usableRequestedSessionId =
    params.requestedSessionId && (!params.freshEntry?.sessionId || canReuseSession)
      ? params.requestedSessionId
      : undefined;
  const sessionId =
    usableRequestedSessionId ?? (canReuseSession ? params.freshEntry?.sessionId : undefined);
  const isNewSession =
    !params.freshEntry ||
    (!canReuseSession && !usableRequestedSessionId) ||
    Boolean(usableRequestedSessionId && params.freshEntry?.sessionId !== usableRequestedSessionId);
  return {
    freshness,
    recoverableTerminalSession,
    canReuseSession,
    usableRequestedSessionId,
    sessionId,
    isNewSession,
  };
}

export function buildAgentSessionPatch(
  params: AgentSessionReuseInput & {
    initialEntry: SessionEntry | undefined;
    normalizedSpawned: { groupId?: string; groupChannel?: string; groupSpace?: string };
    requestDeliveryHint: DeliveryContext | undefined;
    requestLabel?: string;
    explicitSessionKey?: string;
    pluginOwnerId?: string;
    fallbackSessionId: string;
    touchInteraction: boolean;
  },
): AgentSessionPatchBuild {
  const storedSpawnedBy = normalizeOptionalString(params.freshEntry?.spawnedBy);
  const freshSpawnedBy = storedSpawnedBy
    ? resolveSessionStoreKey({
        cfg: params.cfg,
        sessionKey: storedSpawnedBy,
        storeAgentId: params.sessionAgentId,
      })
    : undefined;
  const storedGroup = normalizeTrustedGroupMetadata(params.freshEntry);
  let inheritedGroup: TrustedGroupMetadata | undefined;
  if (
    freshSpawnedBy &&
    (!storedGroup.groupId || !storedGroup.groupChannel || !storedGroup.groupSpace)
  ) {
    try {
      const parentEntry = resolveSessionEntryAccessTarget({
        cfg: params.cfg,
        sessionKey: freshSpawnedBy,
      }).entry;
      inheritedGroup = normalizeTrustedGroupMetadata({
        groupId: parentEntry?.groupId,
        groupChannel: parentEntry?.groupChannel,
        groupSpace: parentEntry?.space,
      });
    } catch (error) {
      if ((error as { code?: unknown })?.code === "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED") {
        throw error;
      }
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

  const effectiveDelivery = mergeDeliveryContext(
    deliveryContextFromSession(params.freshEntry),
    params.requestDeliveryHint,
  );
  const delivery = normalizeSessionDeliveryState({
    route: sessionDeliveryRoute(params.freshEntry),
    context: effectiveDelivery,
    origin: sessionDeliveryOrigin(params.freshEntry),
  });
  const labelValue = normalizeOptionalString(params.requestLabel) || params.freshEntry?.label;
  const explicitSessionDisplayName =
    params.freshEntry === undefined &&
    params.visibleRequest &&
    normalizeOptionalString(params.explicitSessionKey) &&
    !labelValue &&
    !isCronSessionKey(params.canonicalSessionKey) &&
    !isSubagentSessionKey(params.canonicalSessionKey) &&
    !isAcpSessionKey(params.canonicalSessionKey)
      ? parseAgentSessionKey(params.canonicalSessionKey)?.rest.trim()
      : undefined;
  const freshSessionRotatedSinceLoad = Boolean(
    params.initialEntry?.sessionId &&
    params.freshEntry?.sessionId &&
    params.freshEntry.sessionId !== params.initialEntry.sessionId,
  );
  const reuse = evaluateAgentSessionReuse(params);
  const freshSessionId = reuse.sessionId ?? params.fallbackSessionId;
  const freshRotatedSessionId = Boolean(
    params.freshEntry?.sessionId && params.freshEntry.sessionId !== freshSessionId,
  );
  const patchSessionId = freshSessionRotatedSinceLoad
    ? params.freshEntry?.sessionId
    : freshSessionId;
  const shouldClearRotatedState = freshRotatedSessionId && !freshSessionRotatedSinceLoad;
  const shouldClearTerminalState =
    reuse.canReuseSession &&
    reuse.recoverableTerminalSession &&
    !freshSessionRotatedSinceLoad &&
    patchSessionId === params.freshEntry?.sessionId;
  const automaticRecoveryClearPatch = shouldClearRotatedState
    ? buildMainSessionRecoveryClearPatch(params.freshEntry)
    : {};
  const patch: Partial<SessionEntry> = {
    sessionId: patchSessionId,
    updatedAt: params.now,
    ...(reuse.isNewSession && !freshSessionRotatedSinceLoad
      ? { sessionStartedAt: params.now }
      : {}),
    ...(params.touchInteraction
      ? {
          lastInteractionAt: params.now,
          // Clear at human-turn admission, before the model may declare a new
          // status. Later lifecycle writes must not erase a same-turn declaration.
          agentStatus: undefined,
        }
      : {}),
    ...automaticRecoveryClearPatch,
    delivery,
    ...(labelValue ? { label: labelValue } : {}),
    // An operator-supplied key is an explicit name: keep it instead of generating
    // a dashboard title later, matching the semantics of a Control UI rename.
    ...(explicitSessionDisplayName ? { displayName: explicitSessionDisplayName } : {}),
    ...(freshSpawnedBy ? { spawnedBy: freshSpawnedBy } : {}),
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
          lifecycleRunId: undefined,
          lastRunId: undefined,
          startedAt: undefined,
          endedAt: undefined,
          runtimeMs: undefined,
          abortedLastRun: undefined,
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
    isNewSession: reuse.isNewSession,
    rotatedSessionId: freshRotatedSessionId,
    usableRequestedSessionId: reuse.usableRequestedSessionId,
    freshness: reuse.freshness,
  };
}
