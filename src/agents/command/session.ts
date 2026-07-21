/**
 * Resolves command session ids, keys, stores, and persisted thinking state.
 */
import crypto from "node:crypto";
import type { MsgContext } from "../../auto-reply/templating.js";
import {
  normalizeThinkLevel,
  normalizeVerboseLevel,
  type ThinkLevel,
  type VerboseLevel,
} from "../../auto-reply/thinking.js";
import { hasProviderOwnedSession } from "../../config/sessions/entry-freshness.js";
import {
  hasTerminalMainSessionTranscriptNewerThanRegistrySync,
  resolveSessionLifecycleTimestamps,
} from "../../config/sessions/lifecycle.js";
import {
  resolveAgentIdFromSessionKey,
  resolveExplicitAgentSessionKey,
} from "../../config/sessions/main-session.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  evaluateSessionFreshness,
  resolveSessionResetPolicy,
} from "../../config/sessions/reset-policy.js";
import { resolveChannelResetConfig, resolveSessionResetType } from "../../config/sessions/reset.js";
import { listSessionEntries } from "../../config/sessions/session-accessor.js";
import { resolveSessionKey } from "../../config/sessions/session-key.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  classifySessionKeyShape,
  isUnscopedSessionKeySentinel,
  normalizeAgentId,
  normalizeMainKey,
} from "../../routing/session-key.js";
import { isModelSelectionLocked } from "../../sessions/model-overrides.js";
import { resolveSessionIdMatchSelection } from "../../sessions/session-id-resolution.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.shared.js";
import { listAgentIds, resolveDefaultAgentId } from "../agent-scope.js";
import { clearBootstrapSnapshotOnSessionRollover } from "../bootstrap-cache.js";
import { clearAllCliSessions } from "../cli-session.js";
import { transitionMainSessionRecovery } from "../main-session-recovery-state.js";

/** Resolved command session identity plus backing store metadata. */
type SessionResolution = {
  sessionId: string;
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  storePath: string;
  isNewSession: boolean;
  previousSessionId?: string;
  persistedThinking?: ThinkLevel;
  persistedVerbose?: VerboseLevel;
};

type SessionKeyResolution = {
  sessionKey?: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
};

export function clearRotatedSessionMetadata(entry: SessionEntry): SessionEntry {
  const next = {
    ...entry,
    sessionFile: undefined,
    status: undefined,
    startedAt: undefined,
    endedAt: undefined,
    runtimeMs: undefined,
    abortedLastRun: undefined,
    restartRecoveryForceSafeTools: undefined,
    restartRecoveryDeliveryContext: undefined,
    restartRecoveryDeliveryMediaUrls: undefined,
    restartRecoveryDisableMessageTool: undefined,
    restartRecoverySuppressTextDelivery: undefined,
    restartRecoveryDeliveryRequestFingerprint: undefined,
    restartRecoveryDeliveryRunId: undefined,
    restartRecoveryDeliverySourceRunId: undefined,
    restartRecoveryBeforeAgentReplyState: undefined,
    restartRecoveryDeliveryReceiptState: undefined,
    restartRecoveryDeliveryToolCallId: undefined,
    restartRecoveryRequesterAccountId: undefined,
    restartRecoveryRequesterSenderId: undefined,
    restartRecoverySameChannelThreadRequired: undefined,
    restartRecoverySourceIngress: undefined,
    restartRecoverySourceReplyDeliveryMode: undefined,
    restartRecoveryTerminalDeliveryEvidence: undefined,
    restartRecoveryTerminalRunIds: undefined,
    sessionStartedAt: undefined,
    lastInteractionAt: undefined,
  };
  transitionMainSessionRecovery(next, { kind: "clear" });
  clearAllCliSessions(next);
  return next;
}

type SessionIdMatchSet = {
  matches: Array<[string, SessionEntry]>;
  primaryStoreMatches: Array<[string, SessionEntry]>;
  storeByKey: Map<string, SessionKeyResolution>;
};

function loadCommandSessionStore(params: {
  agentId?: string;
  clone?: boolean;
  storePath: string;
}): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntries({
      storePath: params.storePath,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.clone === false ? { clone: false } : {}),
    }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
}

/** Builds the synthetic session key used for explicit session-id runs. */
export function buildExplicitSessionIdSessionKey(params: {
  sessionId: string;
  agentId?: string;
}): string {
  return `agent:${normalizeAgentId(params.agentId)}:explicit:${params.sessionId.trim()}`;
}

function collectSessionIdMatchesForRequest(opts: {
  cfg: OpenClawConfig;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
  storeAgentId?: string;
  sessionId: string;
  searchOtherAgentStores: boolean;
  clone?: boolean;
}): SessionIdMatchSet {
  const matches: Array<[string, SessionEntry]> = [];
  const primaryStoreMatches: Array<[string, SessionEntry]> = [];
  const storeByKey = new Map<string, SessionKeyResolution>();

  const addMatches = (
    candidateStore: Record<string, SessionEntry>,
    candidateStorePath: string,
    options?: { primary?: boolean },
  ): void => {
    for (const [candidateKey, candidateEntry] of Object.entries(candidateStore)) {
      if (candidateEntry?.sessionId !== opts.sessionId) {
        continue;
      }
      matches.push([candidateKey, candidateEntry]);
      if (options?.primary) {
        primaryStoreMatches.push([candidateKey, candidateEntry]);
      }
      storeByKey.set(candidateKey, {
        sessionKey: candidateKey,
        sessionStore: candidateStore,
        storePath: candidateStorePath,
      });
    }
  };

  addMatches(opts.sessionStore, opts.storePath, { primary: true });
  if (!opts.searchOtherAgentStores) {
    return { matches, primaryStoreMatches, storeByKey };
  }

  for (const agentId of listAgentIds(opts.cfg)) {
    if (agentId === opts.storeAgentId) {
      continue;
    }
    const candidateStorePath = resolveStorePath(opts.cfg.session?.store, { agentId });
    addMatches(
      loadCommandSessionStore({
        agentId,
        storePath: candidateStorePath,
        ...(opts.clone === false ? { clone: false } : {}),
      }),
      candidateStorePath,
    );
  }

  return { matches, primaryStoreMatches, storeByKey };
}

/**
 * Resolve an existing stored session key for a session id from a specific agent store.
 * This scopes the lookup to the target store without implicitly converting `agentId`
 * into that agent's main session key.
 */
export function resolveStoredSessionKeyForSessionId(opts: {
  cfg: OpenClawConfig;
  sessionId: string;
  agentId?: string;
}): SessionKeyResolution {
  const sessionId = opts.sessionId.trim();
  const storeAgentId = opts.agentId?.trim() ? normalizeAgentId(opts.agentId) : undefined;
  const storePath = resolveStorePath(opts.cfg.session?.store, {
    agentId: storeAgentId,
  });
  const sessionStore = loadCommandSessionStore({
    storePath,
    ...(storeAgentId ? { agentId: storeAgentId } : {}),
  });
  if (!sessionId) {
    return { sessionKey: undefined, sessionStore, storePath };
  }

  const selection = resolveSessionIdMatchSelection(
    Object.entries(sessionStore).filter(([, entry]) => entry?.sessionId === sessionId),
    sessionId,
  );
  return {
    sessionKey: selection.kind === "selected" ? selection.sessionKey : undefined,
    sessionStore,
    storePath,
  };
}

/** Resolves the session key/store targeted by one command request. */
export function resolveSessionKeyForRequest(opts: {
  cfg: OpenClawConfig;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  clone?: boolean;
}): SessionKeyResolution {
  const sessionCfg = opts.cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);
  const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(opts.cfg));
  const requestedAgentId = opts.agentId?.trim() ? normalizeAgentId(opts.agentId) : undefined;
  const requestedSessionId = opts.sessionId?.trim() || undefined;
  const requestedSessionKey = opts.sessionKey?.trim() || undefined;
  const toSessionKey =
    !requestedSessionKey && !requestedSessionId && classifySessionKeyShape(opts.to) === "agent"
      ? opts.to?.trim()
      : undefined;
  const explicitSessionKey =
    requestedSessionKey ||
    toSessionKey ||
    (!requestedSessionId
      ? resolveExplicitAgentSessionKey({
          cfg: opts.cfg,
          agentId: requestedAgentId,
        })
      : undefined);
  const storeAgentId = explicitSessionKey
    ? isUnscopedSessionKeySentinel(explicitSessionKey)
      ? (requestedAgentId ?? defaultAgentId)
      : resolveAgentIdFromSessionKey(explicitSessionKey)
    : (requestedAgentId ?? defaultAgentId);
  const storePath = resolveStorePath(sessionCfg?.store, {
    agentId: storeAgentId,
  });
  const loadOptions = opts.clone === false ? { clone: false as const } : undefined;
  const sessionStore = loadCommandSessionStore({
    storePath,
    agentId: storeAgentId,
    ...(loadOptions ? { clone: false } : {}),
  });

  const ctx: MsgContext | undefined = opts.to?.trim() ? { From: opts.to } : undefined;
  let sessionKey: string | undefined =
    explicitSessionKey ?? (ctx ? resolveSessionKey(scope, ctx, mainKey, storeAgentId) : undefined);

  // If a session id was provided, prefer to re-use its existing entry (by id) even when no key was
  // derived. When duplicates exist across agent stores, pick the same deterministic best match used
  // by the shared gateway/session resolver helpers instead of whichever store happens to be scanned
  // first.
  if (
    requestedSessionId &&
    !explicitSessionKey &&
    (!sessionKey || sessionStore[sessionKey]?.sessionId !== requestedSessionId)
  ) {
    const { matches, primaryStoreMatches, storeByKey } = collectSessionIdMatchesForRequest({
      cfg: opts.cfg,
      sessionStore,
      storePath,
      storeAgentId,
      sessionId: requestedSessionId,
      searchOtherAgentStores: requestedAgentId === undefined,
      ...(opts.clone === false ? { clone: false } : {}),
    });
    const preferredSelection = resolveSessionIdMatchSelection(matches, requestedSessionId);
    const currentStoreSelection =
      preferredSelection.kind === "selected"
        ? preferredSelection
        : resolveSessionIdMatchSelection(primaryStoreMatches, requestedSessionId);
    if (currentStoreSelection.kind === "selected") {
      const preferred = storeByKey.get(currentStoreSelection.sessionKey);
      if (preferred) {
        return preferred;
      }
      sessionKey = currentStoreSelection.sessionKey;
    }
  }

  if (requestedSessionId && !sessionKey) {
    sessionKey = buildExplicitSessionIdSessionKey({
      sessionId: requestedSessionId,
      agentId: opts.agentId,
    });
  }

  return { sessionKey, sessionStore, storePath };
}

/** Resolves or creates the session used by one agent command request. */
export function resolveSession(opts: {
  cfg: OpenClawConfig;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  clone?: boolean;
}): SessionResolution {
  const sessionCfg = opts.cfg.session;
  const { sessionKey, sessionStore, storePath } = resolveSessionKeyForRequest({
    cfg: opts.cfg,
    to: opts.to,
    sessionId: opts.sessionId,
    sessionKey: opts.sessionKey,
    agentId: opts.agentId,
    ...(opts.clone === false ? { clone: false } : {}),
  });
  const now = Date.now();

  const sessionEntry = sessionKey ? sessionStore[sessionKey] : undefined;
  const sessionAgentId = opts.agentId?.trim()
    ? normalizeAgentId(opts.agentId)
    : resolveAgentIdFromSessionKey(sessionKey);

  const resetType = resolveSessionResetType({ sessionKey });
  const channelReset = resolveChannelResetConfig({
    sessionCfg,
    channel: sessionDeliveryChannel(sessionEntry),
  });
  const resetPolicy = resolveSessionResetPolicy({
    sessionCfg,
    resetType,
    resetOverride: channelReset,
  });
  const requestedSessionId = opts.sessionId?.trim() || undefined;
  const terminalMainTranscriptNewerThanRegistry =
    sessionEntry && !requestedSessionId
      ? hasTerminalMainSessionTranscriptNewerThanRegistrySync({
          entry: sessionEntry,
          sessionScope: sessionCfg?.scope,
          sessionKey,
          agentId: sessionAgentId,
          mainKey: sessionCfg?.mainKey,
          storePath,
        })
      : false;
  const lockedModelSelection = isModelSelectionLocked(sessionEntry);
  const skipImplicitExpiry =
    resetPolicy.configured !== true && hasProviderOwnedSession(sessionEntry);
  const fresh = sessionEntry
    ? lockedModelSelection ||
      (!terminalMainTranscriptNewerThanRegistry &&
        (skipImplicitExpiry ||
          evaluateSessionFreshness({
            updatedAt: sessionEntry.updatedAt,
            ...resolveSessionLifecycleTimestamps({
              entry: sessionEntry,
              agentId: sessionAgentId,
              storePath,
            }),
            now,
            policy: resetPolicy,
          }).fresh))
    : false;
  const sessionId =
    requestedSessionId || (fresh ? sessionEntry?.sessionId : undefined) || crypto.randomUUID();
  const isNewSession = !fresh && !requestedSessionId;
  const resolvedSessionEntry =
    isNewSession && sessionEntry ? clearRotatedSessionMetadata(sessionEntry) : sessionEntry;

  clearBootstrapSnapshotOnSessionRollover({
    sessionKey,
    previousSessionId: isNewSession ? sessionEntry?.sessionId : undefined,
  });

  // Behavior overrides belong to the logical session, not one transcript id.
  // Carry them across every rollover; explicit `default` directives clear them.
  const persistedThinking = sessionEntry?.thinkingLevel
    ? normalizeThinkLevel(sessionEntry.thinkingLevel)
    : undefined;
  const persistedVerbose = sessionEntry?.verboseLevel
    ? normalizeVerboseLevel(sessionEntry.verboseLevel)
    : undefined;

  return {
    sessionId,
    sessionKey,
    sessionEntry: resolvedSessionEntry,
    sessionStore,
    storePath,
    isNewSession,
    previousSessionId: isNewSession ? sessionEntry?.sessionId : undefined,
    persistedThinking,
    persistedVerbose,
  };
}
