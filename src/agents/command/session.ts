/**
 * Resolves command session ids, keys, stores, and persisted thinking state.
 */
import crypto from "node:crypto";
import path from "node:path";
import type { MsgContext } from "../../auto-reply/templating.js";
import {
  normalizeThinkLevel,
  normalizeVerboseLevel,
  type ThinkLevel,
  type VerboseLevel,
} from "../../auto-reply/thinking.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../config/legacy.default-agent-owner.js";
import { hasProviderOwnedSession } from "../../config/sessions/entry-freshness.js";
import {
  hasTerminalMainSessionTranscriptNewerThanRegistrySync,
  resolveSessionLifecycleTimestamps,
} from "../../config/sessions/lifecycle.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentIdFromSessionKey,
  resolveExplicitAgentSessionKey,
} from "../../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  evaluateSessionFreshness,
  resolveSessionResetPolicy,
} from "../../config/sessions/reset-policy.js";
import { resolveChannelResetConfig, resolveSessionResetType } from "../../config/sessions/reset.js";
import { listSessionEntriesCore } from "../../config/sessions/session-accessor.js";
import { resolveSessionKey } from "../../config/sessions/session-key.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  classifySessionKeyShape,
  isUnscopedSessionKeySentinel,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { isModelSelectionLocked } from "../../sessions/model-overrides.js";
import { resolveSessionIdMatchSelection } from "../../sessions/session-id-resolution.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.shared.js";
import {
  AgentSelectionRequiredError,
  listAgentIds,
  resolveDefaultAgentId,
} from "../agent-scope.js";
import { clearBootstrapSnapshotOnSessionRollover } from "../bootstrap-cache.js";
import { clearAllCliSessions } from "../cli-session.js";
import { transitionMainSessionRecovery } from "../main-session-recovery/main-session-recovery-state.js";

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
  agentId?: string;
  sessionKey?: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
};

export function clearRotatedSessionMetadata(entry: SessionEntry): SessionEntry {
  const next = {
    ...entry,
    sessionFile: undefined,
    status: undefined,
    lifecycleRunId: undefined,
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
    sessionDiffBaseline: undefined,
    lastInteractionAt: undefined,
    pendingTranscriptRepair: undefined,
  };
  transitionMainSessionRecovery(next, { kind: "clear" });
  clearAllCliSessions(next);
  return next;
}

type SessionIdMatchSet = {
  candidates: SessionIdMatchCandidate[];
  ownerConflict: boolean;
};

type SessionIdMatchCandidate = {
  sessionKey: string;
  entry: SessionEntry;
  resolution: SessionKeyResolution;
  primary: boolean;
};

function selectSessionIdMatchCandidate(
  candidates: SessionIdMatchCandidate[],
  sessionId: string,
): SessionIdMatchCandidate | undefined {
  const selection = resolveSessionIdMatchSelection(
    candidates.map((candidate) => [candidate.sessionKey, candidate.entry]),
    sessionId,
  );
  if (selection.kind !== "selected") {
    return undefined;
  }
  return candidates
    .filter((candidate) => candidate.sessionKey === selection.sessionKey)
    .toSorted((left, right) => {
      const updatedAt = (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0);
      if (updatedAt !== 0) {
        return updatedAt;
      }
      if (left.primary !== right.primary) {
        return left.primary ? -1 : 1;
      }
      return (left.resolution.agentId ?? "").localeCompare(right.resolution.agentId ?? "");
    })[0];
}

function loadCommandSessionStore(params: {
  agentId?: string;
  clone?: boolean;
  storePath: string;
}): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntriesCore({
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
  const candidates: SessionIdMatchCandidate[] = [];
  let ownerConflict = false;
  const configuredAgentIds = listAgentIds(opts.cfg).map(normalizeAgentId);
  const compatibilityAgentId = tryResolveLegacyCompatibilityAgentId(opts.cfg);
  const persistedSessionStoreAgentId = opts.cfg.agents?.defaults?.sessionStore?.agentId?.trim();
  const normalizedPersistedSessionStoreAgentId = persistedSessionStoreAgentId
    ? normalizeAgentId(persistedSessionStoreAgentId)
    : undefined;
  const fixedStoreCompatibilityAgentId =
    normalizedPersistedSessionStoreAgentId &&
    configuredAgentIds.includes(normalizedPersistedSessionStoreAgentId)
      ? normalizedPersistedSessionStoreAgentId
      : compatibilityAgentId;
  const configuredStoreOwners = new Map<string, Set<string>>();
  for (const agentId of configuredAgentIds) {
    const configuredStorePath = path.resolve(
      resolveStorePath(opts.cfg.session?.store, { agentId }),
    );
    const owners = configuredStoreOwners.get(configuredStorePath) ?? new Set<string>();
    owners.add(agentId);
    configuredStoreOwners.set(configuredStorePath, owners);
  }

  const addMatches = (
    candidateStore: Record<string, SessionEntry>,
    candidateStorePath: string,
    candidateAgentId: string | undefined,
    options?: { primary?: boolean },
  ): void => {
    for (const [candidateKey, candidateEntry] of Object.entries(candidateStore)) {
      if (candidateEntry?.sessionId !== opts.sessionId) {
        continue;
      }
      const normalizedCandidateAgentId = candidateAgentId
        ? normalizeAgentId(candidateAgentId)
        : undefined;
      const scopedCandidateAgentId =
        normalizedCandidateAgentId && configuredAgentIds.includes(normalizedCandidateAgentId)
          ? normalizedCandidateAgentId
          : undefined;
      const pathOwners = configuredStoreOwners.get(path.resolve(candidateStorePath));
      const pathOwnedAgentId =
        pathOwners?.size === 1 ? pathOwners.values().next().value : undefined;
      const sharedPathCompatibilityAgentId =
        pathOwners && pathOwners.size > 1 ? fixedStoreCompatibilityAgentId : undefined;
      const parsedAgentId = parseAgentSessionKey(candidateKey)?.agentId;
      const normalizedParsedAgentId = parsedAgentId ? normalizeAgentId(parsedAgentId) : undefined;
      if (normalizedParsedAgentId && !configuredAgentIds.includes(normalizedParsedAgentId)) {
        continue;
      }
      const isLegacyUnscopedKey = classifySessionKeyShape(candidateKey) === "legacy_or_alias";
      // Unique physical paths prove ownership directly. During cross-agent scans, unscoped rows
      // in a shared fixed store need a persisted/retained owner; only an agent-constrained lookup
      // may assign the scan candidate.
      const legacyUnscopedOwner = isLegacyUnscopedKey
        ? (pathOwnedAgentId ??
          sharedPathCompatibilityAgentId ??
          (opts.searchOtherAgentStores ? undefined : scopedCandidateAgentId) ??
          compatibilityAgentId)
        : undefined;
      const matchedAgentId =
        normalizedParsedAgentId ??
        legacyUnscopedOwner ??
        (isLegacyUnscopedKey ? undefined : scopedCandidateAgentId) ??
        compatibilityAgentId;
      if (
        !opts.searchOtherAgentStores &&
        scopedCandidateAgentId &&
        matchedAgentId &&
        normalizeAgentId(matchedAgentId) !== scopedCandidateAgentId
      ) {
        ownerConflict = true;
        continue;
      }
      candidates.push({
        sessionKey: candidateKey,
        entry: candidateEntry,
        primary: options?.primary === true,
        resolution: {
          ...(matchedAgentId ? { agentId: normalizeAgentId(matchedAgentId) } : {}),
          sessionKey: candidateKey,
          sessionStore: candidateStore,
          storePath: candidateStorePath,
        },
      });
    }
  };

  addMatches(opts.sessionStore, opts.storePath, opts.storeAgentId, { primary: true });
  if (!opts.searchOtherAgentStores) {
    return { candidates, ownerConflict };
  }

  for (const agentId of configuredAgentIds) {
    if (agentId === opts.storeAgentId) {
      continue;
    }
    const candidateStorePath = resolveSessionStorePathCore(opts.cfg.session?.store, { agentId });
    addMatches(
      loadCommandSessionStore({
        agentId,
        storePath: candidateStorePath,
        ...(opts.clone === false ? { clone: false } : {}),
      }),
      candidateStorePath,
      agentId,
    );
  }

  return { candidates, ownerConflict };
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
  const storeAgentId = opts.agentId?.trim()
    ? normalizeAgentId(opts.agentId)
    : (tryResolveLegacyCompatibilityAgentId(opts.cfg) ??
      resolveDefaultAgentId(opts.cfg, {
        surface: "stored session lookup",
        hint: "Pass an explicit agent id when looking up a session by id.",
      }));
  const storePath = resolveSessionStorePathCore(opts.cfg.session?.store, {
    agentId: storeAgentId,
  });
  const sessionStore = loadCommandSessionStore({
    storePath,
    agentId: storeAgentId,
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
export function resolveSessionKeyForRequestCore(opts: {
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
  const scopedSessionAgentId = parseAgentSessionKey(explicitSessionKey)?.agentId;
  // A session id is already an explicit target: seed its store scan from a live roster owner
  // instead of inventing a `main` owner that may not exist in an explicit fleet.
  const sessionIdScanAnchor = requestedSessionId
    ? (tryResolveLegacyCompatibilityAgentId(opts.cfg) ?? listAgentIds(opts.cfg)[0])
    : undefined;
  const defaultAgentId = normalizeAgentId(
    requestedAgentId ??
      scopedSessionAgentId ??
      sessionIdScanAnchor ??
      resolveDefaultAgentId(opts.cfg, {
        surface: "agent command session routing",
        hint: "Pass --agent <id> or an agent-prefixed --session-key.",
      }),
  );
  const storeAgentId = explicitSessionKey
    ? isUnscopedSessionKeySentinel(explicitSessionKey)
      ? (requestedAgentId ?? defaultAgentId)
      : resolveAgentIdFromSessionKey(explicitSessionKey, defaultAgentId)
    : (requestedAgentId ?? defaultAgentId);
  const storePath = resolveSessionStorePathCore(sessionCfg?.store, {
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
    (explicitSessionKey
      ? canonicalizeMainSessionAlias({
          cfg: opts.cfg,
          agentId: storeAgentId,
          sessionKey: explicitSessionKey,
        })
      : undefined) ?? (ctx ? resolveSessionKey(scope, ctx, mainKey, storeAgentId) : undefined);

  // Entrypoint migration owners canonicalize legacy state before runtime reads. A missing target
  // row is not evidence that another agent's main session belongs to the configured default agent.

  // If a session id was provided, prefer to re-use its existing entry (by id) even when no key was
  // derived. When duplicates exist across agent stores, pick the same deterministic best match used
  // by the shared gateway/session resolver helpers instead of whichever store happens to be scanned
  // first.
  if (
    requestedSessionId &&
    !explicitSessionKey &&
    (!sessionKey || sessionStore[sessionKey]?.sessionId !== requestedSessionId)
  ) {
    const { candidates, ownerConflict } = collectSessionIdMatchesForRequest({
      cfg: opts.cfg,
      sessionStore,
      storePath,
      storeAgentId,
      sessionId: requestedSessionId,
      searchOtherAgentStores: requestedAgentId === undefined,
      ...(opts.clone === false ? { clone: false } : {}),
    });
    if (ownerConflict && requestedAgentId) {
      throw new AgentSelectionRequiredError(listAgentIds(opts.cfg), {
        surface: `session id "${requestedSessionId}"`,
        hint: `The matching session belongs to a different agent than --agent "${requestedAgentId}".`,
      });
    }
    const selectedMatch = selectSessionIdMatchCandidate(
      candidates.filter((candidate) => candidate.resolution.agentId !== undefined),
      requestedSessionId,
    );
    if (selectedMatch) {
      return selectedMatch.resolution;
    }
  }

  if (requestedSessionId && !sessionKey) {
    const explicitSessionAgentId =
      requestedAgentId ??
      tryResolveLegacyCompatibilityAgentId(opts.cfg) ??
      resolveDefaultAgentId(opts.cfg, {
        surface: "agent command session creation",
        hint: "Pass --agent <id> when creating a session from --session-id.",
      });
    sessionKey = buildExplicitSessionIdSessionKey({
      sessionId: requestedSessionId,
      agentId: explicitSessionAgentId,
    });
    return {
      agentId: explicitSessionAgentId,
      sessionKey,
      sessionStore,
      storePath,
    };
  }

  return { agentId: storeAgentId, sessionKey, sessionStore, storePath };
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
  const {
    agentId: resolvedAgentId,
    sessionKey,
    sessionStore,
    storePath,
  } = resolveSessionKeyForRequestCore({
    cfg: opts.cfg,
    to: opts.to,
    sessionId: opts.sessionId,
    sessionKey: opts.sessionKey,
    agentId: opts.agentId,
    ...(opts.clone === false ? { clone: false } : {}),
  });
  const now = Date.now();

  const sessionEntry = sessionKey ? sessionStore[sessionKey] : undefined;
  const sessionAgentId =
    (opts.agentId?.trim() ? normalizeAgentId(opts.agentId) : undefined) ??
    resolvedAgentId ??
    parseAgentSessionKey(sessionKey)?.agentId ??
    resolveDefaultAgentId(opts.cfg, {
      surface: "agent command session ownership",
      hint: "Pass --agent <id> or an agent-prefixed --session-key.",
    });

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
              sessionKey,
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
