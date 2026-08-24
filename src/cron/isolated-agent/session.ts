/** Resolves session rollover and carried state for isolated cron runs. */
import crypto from "node:crypto";
import { clearBootstrapSnapshotOnSessionRollover } from "../../agents/bootstrap-cache.js";
import { clearAllCliSessions } from "../../agents/cli-session.js";
import { resolveSessionAuthProfileOverrideSource } from "../../config/sessions/auth-profile-override-provenance.js";
import { hasProviderOwnedSession } from "../../config/sessions/entry-freshness.js";
import {
  resolveSessionLifecycleTimestamps,
  resolveSessionWorkStartError,
} from "../../config/sessions/lifecycle.js";
import { hasSessionAutoModelFallbackProvenance } from "../../config/sessions/model-override-provenance.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  evaluateSessionFreshness,
  resolveSessionResetPolicy,
  type SessionFreshness,
} from "../../config/sessions/reset-policy.js";
import {
  listSessionEntriesCore,
  loadSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const FRESH_CRON_CARRIED_PREFERENCE_FIELDS = [
  "chatType",
  "thinkingLevel",
  "fastMode",
  "verboseLevel",
  "traceLevel",
  "reasoningLevel",
  "ttsAuto",
  "responseUsage",
  "pinnedAt",
  "label",
  "displayName",
] as const satisfies readonly (keyof SessionEntry)[];

const AMBIENT_SESSION_CONTEXT_FIELDS = [
  "elevatedLevel",
  "groupActivation",
  "groupActivationNeedsSystemIntro",
  "sendPolicy",
  "queueMode",
  "queueDebounceMs",
  "queueCap",
  "queueDrop",
  "groupId",
  "subject",
  "groupChannel",
  "space",
  "acp",
] as const satisfies readonly (keyof SessionEntry)[];

function cloneSessionField<T>(value: T): T {
  return globalThis.structuredClone(value);
}

function copySessionFields(
  target: SessionEntry,
  entry: SessionEntry,
  fields: readonly (keyof SessionEntry)[],
): void {
  for (const field of fields) {
    if (entry[field] !== undefined) {
      target[field] = cloneSessionField(entry[field]) as never;
    }
  }
}

function preserveNonAutoModelOverride(target: SessionEntry, entry: SessionEntry): void {
  const recoveredAutoFallbackOverride =
    entry.modelOverrideSource === undefined && hasSessionAutoModelFallbackProvenance(entry);
  if (entry.modelOverrideSource !== "auto" && !recoveredAutoFallbackOverride) {
    let preservedModelSelection = false;
    if (entry.modelOverride !== undefined) {
      target.modelOverride = entry.modelOverride;
      preservedModelSelection = true;
    }
    if (entry.providerOverride !== undefined) {
      target.providerOverride = entry.providerOverride;
    }
    if (entry.modelOverrideSource !== undefined) {
      target.modelOverrideSource = entry.modelOverrideSource;
    }
    if (entry.modelOverrideRouteResolution !== undefined) {
      target.modelOverrideRouteResolution = entry.modelOverrideRouteResolution;
    }
    // Runtime overrides qualify an explicit model selection; carrying one alone
    // would pin a fresh cron session to a stale engine after its model resets.
    if (preservedModelSelection && entry.agentRuntimeOverride !== undefined) {
      target.agentRuntimeOverride = entry.agentRuntimeOverride;
    }
  }
}

function preserveUserAuthOverride(target: SessionEntry, entry: SessionEntry): void {
  const source = resolveSessionAuthProfileOverrideSource(entry);
  if (source === "user") {
    if (entry.authProfileOverride !== undefined) {
      target.authProfileOverride = entry.authProfileOverride;
    }
    target.authProfileOverrideSource = source;
    if (entry.authProfileOverrideCompactionCount !== undefined) {
      target.authProfileOverrideCompactionCount = entry.authProfileOverrideCompactionCount;
    }
  }
}

function sanitizeFreshCronSessionEntry(
  entry: SessionEntry,
  options: { preserveAmbientContext: boolean },
): SessionEntry {
  const next = {} as SessionEntry;

  copySessionFields(next, entry, FRESH_CRON_CARRIED_PREFERENCE_FIELDS);
  if (options.preserveAmbientContext) {
    copySessionFields(next, entry, AMBIENT_SESSION_CONTEXT_FIELDS);
  }
  preserveNonAutoModelOverride(next, entry);
  preserveUserAuthOverride(next, entry);

  return next;
}

/**
 * Reads the current cron session row without an in-process cache snapshot.
 * Lifecycle admission guards compare this against the run's initial entry, so
 * the read must bypass cached store snapshots (accessor readConsistency
 * "latest"). Cron keys are canonicalized before use, so accessor key
 * resolution selects the same row the cron persist path writes.
 */
export function loadCronSessionEntryLatest(
  storePath: string,
  sessionKey: string,
): SessionEntry | undefined {
  return loadSessionEntry({ sessionKey, storePath, readConsistency: "latest" });
}

/** Resolves or rolls over the cron session entry for one isolated-agent run. */
export function resolveCronSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  sourceSessionKey?: string;
  nowMs: number;
  agentId: string;
  forceNew?: boolean;
  hookExternalContentSource?: SessionEntry["hookExternalContentSource"];
  store?: Record<string, SessionEntry>;
}) {
  const sessionCfg = params.cfg.session;
  const storePath = resolveSessionStorePathCore(sessionCfg?.store, {
    agentId: params.agentId,
  });
  const store =
    params.store ??
    Object.fromEntries(
      listSessionEntriesCore({ agentId: params.agentId, storePath }).map(
        ({ sessionKey, entry }) => [sessionKey, entry],
      ),
    );
  const sourceSessionKey = params.sourceSessionKey?.trim();
  const sourceSessionDiffers = Boolean(sourceSessionKey && sourceSessionKey !== params.sessionKey);
  const targetEntry = store[params.sessionKey];
  const entry = store[sourceSessionKey || params.sessionKey];
  // Guard the run's target row even when a differing source session seeds the
  // carried preferences. A forced isolated heartbeat may replace its archived
  // synthetic row, but trusted initialization must still finish first.
  const canRollArchivedHeartbeat =
    params.forceNew === true &&
    targetEntry?.archivedAt !== undefined &&
    targetEntry.initializationPending !== true &&
    Boolean(targetEntry.heartbeatIsolatedBaseSessionKey?.trim());
  const sessionWorkStartError = resolveSessionWorkStartError(params.sessionKey, targetEntry);
  if (sessionWorkStartError && !canRollArchivedHeartbeat) {
    throw new Error(sessionWorkStartError);
  }

  let sessionId: string;
  let isNewSession: boolean;
  let systemSent: boolean;
  let resetBoundaryPending: { reason: "cron-stale"; sessionFile: string } | undefined;

  if (!params.forceNew && entry?.sessionId) {
    // Cron/webhook sessions follow the direct reset policy so scheduled turns
    // roll over like 1:1 conversations rather than long-lived group contexts.
    const resetPolicy = resolveSessionResetPolicy({
      sessionCfg,
      resetType: "direct",
    });
    const skipImplicitExpiry = resetPolicy.configured !== true && hasProviderOwnedSession(entry);
    const freshness = skipImplicitExpiry
      ? ({ fresh: true } satisfies SessionFreshness)
      : evaluateSessionFreshness({
          updatedAt: entry.updatedAt,
          ...resolveSessionLifecycleTimestamps({
            entry,
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            storePath,
          }),
          now: params.nowMs,
          policy: resetPolicy,
        });

    if (freshness.fresh) {
      sessionId = entry.sessionId;
      isNewSession = false;
      systemSent = entry.systemSent ?? false;
    } else {
      sessionId = sourceSessionDiffers ? crypto.randomUUID() : entry.sessionId;
      isNewSession = true;
      systemSent = false;
      if (!sourceSessionDiffers) {
        resetBoundaryPending = { reason: "cron-stale", sessionFile: params.sessionKey };
      }
    }
  } else {
    sessionId = crypto.randomUUID();
    isNewSession = true;
    systemSent = false;
  }

  const previousSessionId =
    isNewSession && !sourceSessionDiffers && !resetBoundaryPending ? entry?.sessionId : undefined;
  clearBootstrapSnapshotOnSessionRollover({
    sessionKey: params.sessionKey,
    previousSessionId,
  });

  const baseEntry = entry
    ? isNewSession
      ? sanitizeFreshCronSessionEntry(entry, { preserveAmbientContext: !params.forceNew })
      : entry
    : undefined;

  const lifecycleRevision = crypto.randomUUID();
  const sessionEntry: SessionEntry = {
    // Fresh cron sessions keep user preference/auth overrides but drop resume
    // handles and auto-fallback model overrides that belong to the old run.
    ...baseEntry,
    sessionId,
    lifecycleRevision,
    updatedAt: params.nowMs,
    sessionStartedAt: isNewSession
      ? params.nowMs
      : (baseEntry?.sessionStartedAt ??
        resolveSessionLifecycleTimestamps({
          entry,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          storePath,
        }).sessionStartedAt),
    lastInteractionAt: isNewSession ? params.nowMs : baseEntry?.lastInteractionAt,
    ...(params.hookExternalContentSource
      ? { hookExternalContentSource: params.hookExternalContentSource }
      : {}),
    systemSent,
  };
  if (resetBoundaryPending) {
    clearAllCliSessions(sessionEntry);
    sessionEntry.agentHarnessId = undefined;
    sessionEntry.compactionCount = 0;
  }
  return {
    storePath,
    store,
    sessionEntry,
    lifecycleRevision,
    systemSent,
    isNewSession,
    previousSessionId,
    resetBoundaryPending,
    initialSessionEntry: targetEntry,
  };
}
