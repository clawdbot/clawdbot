import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { hasGeneratedMediaCompletionEvent } from "../../agents/internal-event-contract.js";
import {
  evaluateSessionFreshness,
  hasTerminalMainSessionTranscriptNewerThanRegistrySync,
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  resolveChannelResetConfig,
  resolveSessionLifecycleTimestamps,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveSessionWorkStartError,
  resolveTerminalMainSessionTranscriptRegistryCheck,
  type SessionEntry,
  type SessionFreshness,
} from "../../config/sessions.js";
import { hasProviderOwnedSession } from "../../config/sessions/entry-freshness.js";
import { readTranscriptStatsSync } from "../../config/sessions/session-accessor.js";
import { resolveMaintenanceConfigFromInput } from "../../config/sessions/store-maintenance.js";
import { isRecoverableTerminalSessionStatus } from "../../config/sessions/terminal-status.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseCronRunScopeSuffix } from "../../sessions/session-key-utils.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.shared.js";
import { loadSessionEntry } from "../session-utils.js";
import {
  respondDeletedAgentSession,
  type RestoredCronContinuation,
} from "./agent-handler-helpers.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type PreparedAgentSession = {
  cfg: OpenClawConfig;
  storePath: string;
  entry?: SessionEntry;
  canonicalKey: string;
  storeKeys?: string[];
  maintenanceConfig: ReturnType<typeof resolveMaintenanceConfigFromInput>;
  canonicalSessionAgentId: string;
  resetPolicy: ReturnType<typeof resolveSessionResetPolicy>;
  now: number;
  freshness: SessionFreshness | undefined;
  visibleRequest: boolean;
  mainSessionKey: string;
  isSystemGatewayRun: boolean;
  usableRequestedSessionId?: string;
  sessionId: string;
  isNewSession: boolean;
  rotatedSessionId: boolean;
  touchInteraction: boolean;
  sessionPersistedBeforeGatewayAdmission: boolean;
  effectiveBootstrapContextRunKind?: "default" | "heartbeat" | "cron";
  restoredCronContinuationIdentity?: Pick<
    RestoredCronContinuation,
    "lifecycleRevision" | "sessionId"
  >;
  failedSessionTranscriptMissing: (entry: SessionEntry | undefined) => boolean;
};

export function prepareAgentSession(params: {
  requestedSessionKey: string;
  requestedSessionId?: string;
  expectedExistingSessionId?: string;
  agentId?: string;
  recipientChannel?: string;
  request: AgentRunRequest;
  canUseCronRunContinuation: boolean;
  lifecycleGeneration: string;
  effectiveBootstrapContextRunKind?: "default" | "heartbeat" | "cron";
  preAttachmentSession?: { canonicalKey: string; sessionId?: string };
  respond: GatewayRequestHandlerOptions["respond"];
}): PreparedAgentSession | undefined {
  const { cfg, storePath, entry, canonicalKey, legacyKey, storeKeys } = loadSessionEntry(
    params.requestedSessionKey,
    { ...(params.agentId ? { agentId: params.agentId } : {}), clone: false },
  );
  if (params.expectedExistingSessionId && entry?.sessionId !== params.expectedExistingSessionId) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        `Session "${canonicalKey}" changed before expected work could start.`,
      ),
    );
    return undefined;
  }

  let effectiveBootstrapContextRunKind = params.effectiveBootstrapContextRunKind;
  let restoredCronContinuationIdentity: PreparedAgentSession["restoredCronContinuationIdentity"];
  const isGeneratedMediaCronContinuation =
    hasGeneratedMediaCompletionEvent(params.request.internalEvents) &&
    parseCronRunScopeSuffix(canonicalKey).runId !== undefined;
  if (isGeneratedMediaCronContinuation) {
    if (!params.canUseCronRunContinuation) {
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "cron run completion handoffs are reserved for server-owned callers",
        ),
      );
      return undefined;
    }
    const marker = entry?.cronRunContinuation;
    const continuationSessionId = normalizeOptionalString(entry?.sessionId);
    const staleClaim =
      marker?.phase === "continuing" &&
      marker.ownerLifecycleGeneration !== params.lifecycleGeneration;
    if (staleClaim || (marker?.phase === "ready" && marker.basePersisted !== true)) {
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          staleClaim
            ? "cron run continuation owner was lost during gateway restart"
            : "cron run continuation base session was not persisted",
        ),
      );
      return undefined;
    }
    if (!marker || marker.phase !== "ready" || !continuationSessionId) {
      params.respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "cron run continuation is not ready"),
      );
      return undefined;
    }
    if (params.requestedSessionId && params.requestedSessionId !== continuationSessionId) {
      params.respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "cron run continuation session changed"),
      );
      return undefined;
    }
    restoredCronContinuationIdentity = {
      lifecycleRevision: marker.lifecycleRevision,
      sessionId: continuationSessionId,
    };
    effectiveBootstrapContextRunKind = "cron";
  }

  const sessionExistedBeforeAttachmentSetup =
    params.preAttachmentSession?.canonicalKey === canonicalKey
      ? params.preAttachmentSession
      : undefined;
  if (sessionExistedBeforeAttachmentSetup && !entry) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Session "${canonicalKey}" was deleted while starting work. Retry.`,
      ),
    );
    return undefined;
  }
  if (
    sessionExistedBeforeAttachmentSetup &&
    entry?.sessionId !== sessionExistedBeforeAttachmentSetup.sessionId
  ) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Session "${canonicalKey}" changed while starting work. Retry.`,
      ),
    );
    return undefined;
  }
  if (
    respondDeletedAgentSession({
      cfg,
      canonicalKey,
      entry,
      acpMetadataSessionKey: legacyKey,
      respond: params.respond,
    })
  ) {
    return undefined;
  }
  const archivedSessionError = resolveSessionWorkStartError(canonicalKey, entry);
  if (archivedSessionError) {
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, archivedSessionError));
    return undefined;
  }

  const canonicalSessionAgentId =
    canonicalKey === "global"
      ? (params.agentId ?? resolveDefaultAgentId(cfg))
      : resolveAgentIdFromSessionKey(canonicalKey);
  const now = Date.now();
  const resetPolicy = resolveSessionResetPolicy({
    sessionCfg: cfg.session,
    resetType: resolveSessionResetType({ sessionKey: canonicalKey }),
    resetOverride: resolveChannelResetConfig({
      sessionCfg: cfg.session,
      channel: sessionDeliveryChannel(entry) ?? params.recipientChannel,
    }),
  });
  const lifecycleTimestamps = entry
    ? resolveSessionLifecycleTimestamps({
        entry,
        storePath,
        agentId: canonicalSessionAgentId,
      })
    : undefined;
  const skipImplicitExpiry =
    params.expectedExistingSessionId !== undefined ||
    restoredCronContinuationIdentity !== undefined ||
    entry?.modelSelectionLocked === true ||
    (resetPolicy.configured !== true && hasProviderOwnedSession(entry));
  const freshness = entry
    ? skipImplicitExpiry
      ? ({ fresh: true } satisfies SessionFreshness)
      : evaluateSessionFreshness({
          updatedAt: entry.updatedAt,
          ...lifecycleTimestamps,
          now,
          policy: resetPolicy,
        })
    : undefined;
  const visibleRequest =
    effectiveBootstrapContextRunKind !== "cron" &&
    effectiveBootstrapContextRunKind !== "heartbeat" &&
    !params.request.internalEvents?.length;
  const failedSessionTranscriptMissing = (candidateEntry: SessionEntry | undefined): boolean => {
    if (candidateEntry?.status !== "failed" || !candidateEntry.sessionId?.trim()) {
      return false;
    }
    try {
      return (
        readTranscriptStatsSync({
          agentId: canonicalSessionAgentId,
          sessionId: candidateEntry.sessionId,
          sessionKey: canonicalKey,
          storePath,
          sessionEntry: candidateEntry,
        }).eventCount === 0
      );
    } catch {
      return true;
    }
  };
  const mainSessionKey = resolveAgentMainSessionKey({ cfg, agentId: canonicalSessionAgentId });
  const isSystemGatewayRun =
    effectiveBootstrapContextRunKind === "cron" || effectiveBootstrapContextRunKind === "heartbeat";
  const requestedSessionMatchesEntry = Boolean(
    params.requestedSessionId && entry?.sessionId?.trim() === params.requestedSessionId,
  );
  const terminalMainTranscriptCheck =
    isSystemGatewayRun || requestedSessionMatchesEntry
      ? undefined
      : resolveTerminalMainSessionTranscriptRegistryCheck({
          entry,
          sessionScope: cfg.session?.scope,
          sessionKey: canonicalKey,
          agentId: canonicalSessionAgentId,
          mainKey: cfg.session?.mainKey,
          storePath,
        });
  const terminalMainTranscriptNewerThanRegistry = terminalMainTranscriptCheck
    ? hasTerminalMainSessionTranscriptNewerThanRegistrySync({
        entry,
        sessionScope: cfg.session?.scope,
        sessionKey: canonicalKey,
        agentId: canonicalSessionAgentId,
        mainKey: cfg.session?.mainKey,
        storePath,
      })
    : false;
  const recoverableTerminalSession =
    Boolean(entry?.sessionId) &&
    visibleRequest &&
    isRecoverableTerminalSessionStatus(entry?.status);
  const canReuseSession =
    Boolean(entry?.sessionId) &&
    ((freshness?.fresh ?? false) || recoverableTerminalSession) &&
    !failedSessionTranscriptMissing(entry) &&
    !terminalMainTranscriptNewerThanRegistry;
  const usableRequestedSessionId =
    params.requestedSessionId && (!entry?.sessionId || canReuseSession)
      ? params.requestedSessionId
      : undefined;
  const sessionId =
    usableRequestedSessionId ?? (canReuseSession ? entry?.sessionId : undefined) ?? randomUUID();
  const isNewSession =
    !entry ||
    (!canReuseSession && !usableRequestedSessionId) ||
    Boolean(usableRequestedSessionId && entry?.sessionId !== usableRequestedSessionId);
  return {
    cfg,
    storePath,
    entry,
    canonicalKey,
    storeKeys,
    maintenanceConfig: resolveMaintenanceConfigFromInput(cfg.session?.maintenance),
    canonicalSessionAgentId,
    resetPolicy,
    now,
    freshness,
    visibleRequest,
    mainSessionKey,
    isSystemGatewayRun,
    usableRequestedSessionId,
    sessionId,
    isNewSession,
    rotatedSessionId: Boolean(entry?.sessionId && entry.sessionId !== sessionId),
    touchInteraction: visibleRequest,
    sessionPersistedBeforeGatewayAdmission: entry !== undefined,
    effectiveBootstrapContextRunKind,
    restoredCronContinuationIdentity,
    failedSessionTranscriptMissing,
  };
}
