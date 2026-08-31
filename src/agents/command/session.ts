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
import { isInternalSessionEffectsKey } from "../../config/sessions/internal-session-key.js";
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
import {
  listSessionEntriesCore,
  loadExactSessionEntryReadOnly,
  type SessionEntrySummary,
} from "../../config/sessions/session-accessor.js";
import { resolveSessionKey } from "../../config/sessions/session-key.js";
import {
  resolvePersistedSessionStoreOwner,
  resolvePersistedSessionStoreOwnerForKey,
} from "../../config/sessions/session-store-owner.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
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
  sessionEntry?: InternalSessionEntry;
  storePath: string;
  isNewSession: boolean;
  previousSessionId?: string;
  persistedThinking?: ThinkLevel;
  persistedVerbose?: VerboseLevel;
};

type SessionKeyResolution = {
  agentId?: string;
  sessionKey?: string;
  sessionEntry?: InternalSessionEntry;
  storePath: string;
};

export function clearRotatedSessionMetadata(entry: InternalSessionEntry): InternalSessionEntry {
  const next = {
    ...entry,
    sessionFile: undefined,
    status: undefined,
    lifecycleRunId: undefined,
    lastRunId: undefined,
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
    sessionDiffBaselineCapture: undefined,
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
  entry: InternalSessionEntry;
  resolution: Omit<SessionKeyResolution, "sessionEntry">;
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

function loadCommandSessionEntries(params: {
  agentId?: string;
  storePath: string;
}): SessionEntrySummary[] {
  return listSessionEntriesCore({
    storePath: params.storePath,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    clone: false,
  });
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
  sessionEntries: SessionEntrySummary[];
  storePath: string;
  storeAgentId?: string;
  sessionId: string;
  searchOtherAgentStores: boolean;
}): SessionIdMatchSet {
  const candidates: SessionIdMatchCandidate[] = [];
  let ownerConflict = false;
  const configuredAgentIds = listAgentIds(opts.cfg).map(normalizeAgentId);
  const compatibilityAgentId = tryResolveLegacyCompatibilityAgentId(opts.cfg);
  const persistedStoreOwner = resolvePersistedSessionStoreOwner(opts.cfg);
  const configuredStoreOwners = new Map<string, Set<string>>();
  for (const agentId of configuredAgentIds) {
    const configuredStorePath = path.resolve(
      resolveSessionStorePathCore(opts.cfg.session?.store, { agentId }),
    );
    const owners = configuredStoreOwners.get(configuredStorePath) ?? new Set<string>();
    owners.add(agentId);
    configuredStoreOwners.set(configuredStorePath, owners);
  }

  const addMatches = (
    candidateEntries: SessionEntrySummary[],
    candidateStorePath: string,
    candidateAgentId: string | undefined,
    options?: { primary?: boolean },
  ): void => {
    for (const { sessionKey: candidateKey, entry: candidateEntry } of candidateEntries) {
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
      const parsedAgentId = parseAgentSessionKey(candidateKey)?.agentId;
      const normalizedParsedAgentId = parsedAgentId ? normalizeAgentId(parsedAgentId) : undefined;
      if (normalizedParsedAgentId && !configuredAgentIds.includes(normalizedParsedAgentId)) {
        continue;
      }
      const isLegacyUnscopedKey = classifySessionKeyShape(candidateKey) === "legacy_or_alias";
      // A persisted fixed-store owner is authoritative even after retirement: retired rows stay
      // unavailable instead of being reassigned by path cardinality or scan order.
      const legacyUnscopedOwner = isLegacyUnscopedKey
        ? persistedStoreOwner.kind === "configured"
          ? persistedStoreOwner.agentId
          : persistedStoreOwner.kind === "retired"
            ? undefined
            : (pathOwnedAgentId ??
              (opts.searchOtherAgentStores ? undefined : scopedCandidateAgentId) ??
              compatibilityAgentId)
        : undefined;
      const matchedAgentId =
        normalizedParsedAgentId ??
        (isLegacyUnscopedKey
          ? legacyUnscopedOwner
          : (scopedCandidateAgentId ?? compatibilityAgentId));
      if (isLegacyUnscopedKey && persistedStoreOwner.kind === "retired") {
        ownerConflict = true;
        continue;
      }
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
          storePath: candidateStorePath,
        },
      });
    }
  };

  addMatches(opts.sessionEntries, opts.storePath, opts.storeAgentId, { primary: true });
  if (!opts.searchOtherAgentStores) {
    return { candidates, ownerConflict };
  }

  for (const agentId of configuredAgentIds) {
    if (agentId === opts.storeAgentId) {
      continue;
    }
    const candidateStorePath = resolveSessionStorePathCore(opts.cfg.session?.store, { agentId });
    addMatches(
      loadCommandSessionEntries({
        agentId,
        storePath: candidateStorePath,
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
  const requestedAgentId = opts.agentId?.trim() ? normalizeAgentId(opts.agentId) : undefined;
  const persistedStoreOwner = resolvePersistedSessionStoreOwner(opts.cfg);
  const storeAgentId =
    requestedAgentId ??
    (persistedStoreOwner.kind === "configured" ? persistedStoreOwner.agentId : undefined) ??
    tryResolveLegacyCompatibilityAgentId(opts.cfg) ??
    resolveDefaultAgentId(opts.cfg, {
      surface: "stored session lookup",
      hint: "Pass an explicit agent id when looking up a session by id.",
    });
  const storePath = resolveSessionStorePathCore(opts.cfg.session?.store, {
    agentId: storeAgentId,
  });
  const sessionEntries = loadCommandSessionEntries({
    storePath,
    agentId: storeAgentId,
  });
  if (!sessionId) {
    return { sessionKey: undefined, storePath };
  }

  const resolveMatchedAgentId = (sessionKey: string): string | undefined => {
    const scopedAgentId = parseAgentSessionKey(sessionKey)?.agentId;
    if (scopedAgentId) {
      return normalizeAgentId(scopedAgentId);
    }
    const persistedRowOwner = resolvePersistedSessionStoreOwnerForKey(opts.cfg, sessionKey);
    return persistedRowOwner.kind === "configured"
      ? persistedRowOwner.agentId
      : persistedRowOwner.kind === "retired"
        ? undefined
        : (requestedAgentId ?? tryResolveLegacyCompatibilityAgentId(opts.cfg));
  };
  const sessionIdMatches = sessionEntries.filter(({ entry }) => entry.sessionId === sessionId);
  const selectionMatches = requestedAgentId
    ? sessionIdMatches.filter(
        ({ sessionKey }) => resolveMatchedAgentId(sessionKey) === requestedAgentId,
      )
    : sessionIdMatches;
  if (requestedAgentId && selectionMatches.length === 0 && sessionIdMatches.length > 0) {
    throw new AgentSelectionRequiredError(listAgentIds(opts.cfg), {
      surface: `stored session id "${sessionId}"`,
      hint: `The matching rows belong to a different agent than agent "${requestedAgentId}".`,
    });
  }
  const selection = resolveSessionIdMatchSelection(
    selectionMatches.map(({ sessionKey, entry }) => [sessionKey, entry]),
    sessionId,
  );
  if (selection.kind !== "selected") {
    return { agentId: requestedAgentId, sessionKey: undefined, storePath };
  }

  const sessionKey = selection.sessionKey;
  const persistedRowOwner = resolvePersistedSessionStoreOwnerForKey(opts.cfg, sessionKey);
  const resolvedAgentId = resolveMatchedAgentId(sessionKey);
  if (!resolvedAgentId) {
    throw new AgentSelectionRequiredError(listAgentIds(opts.cfg), {
      surface: `stored session key "${sessionKey}"`,
      hint:
        persistedRowOwner.kind === "retired"
          ? `The shared fixed-store row belongs to retired agent "${persistedRowOwner.agentId}".`
          : "Pass an explicit agent id when looking up an unscoped session by id.",
    });
  }
  if (requestedAgentId && requestedAgentId !== resolvedAgentId) {
    throw new AgentSelectionRequiredError(listAgentIds(opts.cfg), {
      surface: `stored session key "${sessionKey}"`,
      hint: `The matching row belongs to agent "${resolvedAgentId}", not agent "${requestedAgentId}".`,
    });
  }
  return {
    agentId: resolvedAgentId,
    sessionKey,
    sessionEntry: structuredClone(
      selectionMatches.find((match) => match.sessionKey === sessionKey)?.entry,
    ),
    storePath,
  };
}

function resolveSessionKeyForRequestInternal(opts: {
  cfg: OpenClawConfig;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  createMissingSessionId: boolean;
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
  const explicitKeyStoreOwner = resolvePersistedSessionStoreOwnerForKey(
    opts.cfg,
    explicitSessionKey,
  );
  if (
    explicitKeyStoreOwner.kind === "configured" &&
    requestedAgentId &&
    requestedAgentId !== explicitKeyStoreOwner.agentId
  ) {
    throw new AgentSelectionRequiredError(listAgentIds(opts.cfg), {
      surface: `session key "${explicitSessionKey}"`,
      hint: `The shared fixed-store row belongs to agent "${explicitKeyStoreOwner.agentId}", not --agent "${requestedAgentId}".`,
    });
  }
  if (explicitKeyStoreOwner.kind === "retired") {
    throw new AgentSelectionRequiredError(listAgentIds(opts.cfg), {
      surface: `session key "${explicitSessionKey}"`,
      hint: `The shared fixed-store row belongs to retired agent "${explicitKeyStoreOwner.agentId}".`,
    });
  }
  const knownAgentId =
    requestedAgentId ??
    scopedSessionAgentId ??
    (explicitKeyStoreOwner.kind === "configured" ? explicitKeyStoreOwner.agentId : undefined) ??
    tryResolveLegacyCompatibilityAgentId(opts.cfg);
  const unownedBareSessionKey = Boolean(
    requestedSessionId &&
    explicitSessionKey &&
    classifySessionKeyShape(explicitSessionKey) === "legacy_or_alias" &&
    !knownAgentId,
  );
  // A session id is already an explicit target: seed only its store scan from a live roster owner.
  // The anchor is not resolved ownership and must never escape through the returned resolution.
  const sessionIdScanAnchor = requestedSessionId
    ? (knownAgentId ?? listAgentIds(opts.cfg)[0])
    : undefined;
  const defaultAgentId = knownAgentId
    ? normalizeAgentId(knownAgentId)
    : requestedSessionId
      ? undefined
      : normalizeAgentId(
          resolveDefaultAgentId(opts.cfg, {
            surface: "agent command session routing",
            hint: "Pass --agent <id> or an agent-prefixed --session-key.",
          }),
        );
  const storeAgentId = explicitSessionKey
    ? unownedBareSessionKey
      ? sessionIdScanAnchor
      : isUnscopedSessionKeySentinel(explicitSessionKey)
        ? (requestedAgentId ?? defaultAgentId)
        : resolveAgentIdFromSessionKey(explicitSessionKey, defaultAgentId)
    : (requestedAgentId ?? defaultAgentId ?? sessionIdScanAnchor);
  if (!storeAgentId) {
    throw new AgentSelectionRequiredError(listAgentIds(opts.cfg), {
      surface: "agent command session routing",
      hint: "Pass --agent <id> or an agent-prefixed --session-key.",
    });
  }
  const storePath = resolveSessionStorePathCore(sessionCfg?.store, {
    agentId: storeAgentId,
  });
  const ctx: MsgContext | undefined = opts.to?.trim() ? { From: opts.to } : undefined;
  let sessionKey: string | undefined =
    (!unownedBareSessionKey && explicitSessionKey
      ? canonicalizeMainSessionAlias({
          cfg: opts.cfg,
          agentId: storeAgentId,
          sessionKey: explicitSessionKey,
        })
      : undefined) ??
    (!unownedBareSessionKey && ctx
      ? resolveSessionKey(scope, ctx, mainKey, storeAgentId)
      : undefined);

  // Command preparation needs one owned entry. Exact reads preserve the SQLite target and
  // Doctor guards without enumerating the agent store or exposing hidden run-owned rows.
  const sessionEntry =
    sessionKey && !isInternalSessionEffectsKey(sessionKey)
      ? loadExactSessionEntryReadOnly({ agentId: storeAgentId, storePath, sessionKey })?.entry
      : undefined;

  // If a session id was provided, prefer to re-use its existing entry (by id) even when no key was
  // derived. When duplicates exist across agent stores, pick the same deterministic best match used
  // by the shared gateway/session resolver helpers instead of whichever store happens to be scanned
  // first.
  if (
    requestedSessionId &&
    (!explicitSessionKey || unownedBareSessionKey) &&
    (!sessionKey || sessionEntry?.sessionId !== requestedSessionId)
  ) {
    const { candidates, ownerConflict } = collectSessionIdMatchesForRequest({
      cfg: opts.cfg,
      sessionEntries: loadCommandSessionEntries({ storePath, agentId: storeAgentId }),
      storePath,
      storeAgentId,
      sessionId: requestedSessionId,
      searchOtherAgentStores: requestedAgentId === undefined,
    });
    const selectedMatch = selectSessionIdMatchCandidate(
      candidates.filter((candidate) => candidate.resolution.agentId !== undefined),
      requestedSessionId,
    );
    if (selectedMatch) {
      return {
        ...selectedMatch.resolution,
        sessionEntry: structuredClone(selectedMatch.entry),
      };
    }
    if (ownerConflict) {
      throw new AgentSelectionRequiredError(listAgentIds(opts.cfg), {
        surface: `session id "${requestedSessionId}"`,
        hint: requestedAgentId
          ? `The matching session belongs to a different agent than --agent "${requestedAgentId}".`
          : "The matching unscoped session belongs to a retired fixed-store owner.",
      });
    }
  }

  if (requestedSessionId && !sessionKey && opts.createMissingSessionId) {
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
      storePath,
    };
  }

  return { agentId: storeAgentId, sessionKey, sessionEntry, storePath };
}

/** Resolves an existing session-id row across agent stores without creating a fallback key. */
export function resolveExistingSessionKeyForRequest(opts: {
  cfg: OpenClawConfig;
  sessionId: string;
  agentId?: string;
}): SessionKeyResolution {
  return resolveSessionKeyForRequestInternal({ ...opts, createMissingSessionId: false });
}

/** Resolves the session key/store targeted by one command request. */
function resolveSessionKeyForRequest(opts: {
  cfg: OpenClawConfig;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): SessionKeyResolution {
  return resolveSessionKeyForRequestInternal({ ...opts, createMissingSessionId: true });
}

/** Core alias retained for runtime owners that bypass the public library facade. */
export function resolveSessionKeyForRequestCore(
  opts: Parameters<typeof resolveSessionKeyForRequest>[0],
): SessionKeyResolution {
  return resolveSessionKeyForRequest(opts);
}

/** Resolves or creates the session used by one agent command request. */
export function resolveSession(opts: {
  cfg: OpenClawConfig;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): SessionResolution {
  const sessionCfg = opts.cfg.session;
  const {
    agentId: resolvedAgentId,
    sessionKey,
    sessionEntry,
    storePath,
  } = resolveSessionKeyForRequestCore({
    cfg: opts.cfg,
    to: opts.to,
    sessionId: opts.sessionId,
    sessionKey: opts.sessionKey,
    agentId: opts.agentId,
  });
  const now = Date.now();

  const sessionAgentId =
    (opts.agentId?.trim() ? normalizeAgentId(opts.agentId) : undefined) ??
    resolvedAgentId ??
    parseAgentSessionKey(sessionKey)?.agentId ??
    tryResolveLegacyCompatibilityAgentId(opts.cfg) ??
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
    storePath,
    isNewSession,
    previousSessionId: isNewSession ? sessionEntry?.sessionId : undefined,
    persistedThinking,
    persistedVerbose,
  };
}
