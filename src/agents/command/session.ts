import crypto from "node:crypto";
import type { MsgContext } from "../../auto-reply/templating.js";
import {
  normalizeThinkLevel,
  normalizeVerboseLevel,
  type ThinkLevel,
  type VerboseLevel,
} from "../../auto-reply/thinking.js";
import { resolveSessionLifecycleTimestamps } from "../../config/sessions/lifecycle.js";
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
import { resolveSessionKey } from "../../config/sessions/session-key.js";
import { loadSessionStore } from "../../config/sessions/store-load.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  normalizeMainKey,
} from "../../routing/session-key.js";
import { resolveSessionIdMatchSelection } from "../../sessions/session-id-resolution.js";
import { listAgentIds, resolveDefaultAgentId } from "../agent-scope.js";
import { clearBootstrapSnapshotOnSessionRollover } from "../bootstrap-cache.js";

export type SessionResolution = {
  sessionId: string;
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  storePath: string;
  isNewSession: boolean;
  persistedThinking?: ThinkLevel;
  persistedVerbose?: VerboseLevel;
};

type SessionKeyResolution = {
  sessionKey?: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
};

type SessionIdMatchSet = {
  matches: Array<[string, SessionEntry]>;
  primaryStoreMatches: Array<[string, SessionEntry]>;
  storeByKey: Map<string, SessionKeyResolution>;
};

export function buildExplicitSessionIdSessionKey(params: {
  sessionId: string;
  agentId?: string;
}): string {
  return `agent:${normalizeAgentId(params.agentId)}:explicit:${params.sessionId.trim()}`;
}

function resolveLegacyMainStoreSessionForDefaultAgent(opts: {
  cfg: OpenClawConfig;
  defaultAgentId: string;
  mainKey: string;
  sessionKey?: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
}): SessionKeyResolution | undefined {
  if (opts.defaultAgentId === DEFAULT_AGENT_ID || !opts.sessionKey) {
    return undefined;
  }
  const defaultMainSessionKey = buildAgentMainSessionKey({
    agentId: opts.defaultAgentId,
    mainKey: opts.mainKey,
  });
  if (opts.sessionKey !== defaultMainSessionKey || opts.sessionStore[opts.sessionKey]) {
    return undefined;
  }

  const legacyStorePath = resolveStorePath(opts.cfg.session?.store, {
    agentId: DEFAULT_AGENT_ID,
  });
  const legacyKeys = [
    buildAgentMainSessionKey({ agentId: DEFAULT_AGENT_ID, mainKey: opts.mainKey }),
    buildAgentMainSessionKey({ agentId: DEFAULT_AGENT_ID, mainKey: "main" }),
  ];
  if (legacyStorePath === opts.storePath) {
    for (const legacyKey of legacyKeys) {
      const legacyEntry = opts.sessionStore[legacyKey];
      if (legacyEntry) {
        opts.sessionStore[opts.sessionKey] = { ...legacyEntry };
        return {
          sessionKey: opts.sessionKey,
          sessionStore: opts.sessionStore,
          storePath: opts.storePath,
        };
      }
    }
    return undefined;
  }
  const legacyStore = loadSessionStore(legacyStorePath);
  for (const legacyKey of legacyKeys) {
    const legacyEntry = legacyStore[legacyKey];
    if (legacyEntry) {
      opts.sessionStore[opts.sessionKey] = { ...legacyEntry };
      return {
        sessionKey: opts.sessionKey,
        sessionStore: opts.sessionStore,
        storePath: opts.storePath,
      };
    }
  }
  return undefined;
}

function collectSessionIdMatchesForRequest(opts: {
  cfg: OpenClawConfig;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
  storeAgentId?: string;
  sessionId: string;
  searchOtherAgentStores: boolean;
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
    addMatches(loadSessionStore(candidateStorePath), candidateStorePath);
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
  const sessionStore = loadSessionStore(storePath);
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

export function resolveSessionKeyForRequest(opts: {
  cfg: OpenClawConfig;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): SessionKeyResolution {
  const sessionCfg = opts.cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);
  const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(opts.cfg));
  const requestedAgentId = opts.agentId?.trim() ? normalizeAgentId(opts.agentId) : undefined;
  const requestedSessionId = opts.sessionId?.trim() || undefined;
  const explicitSessionKey =
    opts.sessionKey?.trim() ||
    (!requestedSessionId
      ? resolveExplicitAgentSessionKey({
          cfg: opts.cfg,
          agentId: requestedAgentId,
        })
      : undefined);
  const storeAgentId = explicitSessionKey
    ? resolveAgentIdFromSessionKey(explicitSessionKey)
    : (requestedAgentId ?? defaultAgentId);
  const storePath = resolveStorePath(sessionCfg?.store, {
    agentId: storeAgentId,
  });
  const sessionStore = loadSessionStore(storePath);

  const ctx: MsgContext | undefined = opts.to?.trim() ? { From: opts.to } : undefined;
  let sessionKey: string | undefined =
    explicitSessionKey ?? (ctx ? resolveSessionKey(scope, ctx, mainKey, storeAgentId) : undefined);

  if (ctx && !requestedAgentId && !requestedSessionId && !explicitSessionKey) {
    const legacyMainSession = resolveLegacyMainStoreSessionForDefaultAgent({
      cfg: opts.cfg,
      defaultAgentId,
      mainKey,
      sessionKey,
      sessionStore,
      storePath,
    });
    if (legacyMainSession) {
      return legacyMainSession;
    }
  }

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

export function resolveSession(opts: {
  cfg: OpenClawConfig;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): SessionResolution {
  const sessionCfg = opts.cfg.session;
  const { sessionKey, sessionStore, storePath } = resolveSessionKeyForRequest({
    cfg: opts.cfg,
    to: opts.to,
    sessionId: opts.sessionId,
    sessionKey: opts.sessionKey,
    agentId: opts.agentId,
  });
  const now = Date.now();

  const sessionEntry = sessionKey ? sessionStore[sessionKey] : undefined;

  const resetType = resolveSessionResetType({ sessionKey });
  const channelReset = resolveChannelResetConfig({
    sessionCfg,
    channel: sessionEntry?.lastChannel ?? sessionEntry?.channel ?? sessionEntry?.origin?.provider,
  });
  const resetPolicy = resolveSessionResetPolicy({
    sessionCfg,
    resetType,
    resetOverride: channelReset,
  });
  const fresh = sessionEntry
    ? evaluateSessionFreshness({
        updatedAt: sessionEntry.updatedAt,
        ...resolveSessionLifecycleTimestamps({
          entry: sessionEntry,
          agentId: opts.agentId,
          storePath,
        }),
        now,
        policy: resetPolicy,
      }).fresh
    : false;
  const sessionId =
    opts.sessionId?.trim() || (fresh ? sessionEntry?.sessionId : undefined) || crypto.randomUUID();
  const isNewSession = !fresh && !opts.sessionId;

  clearBootstrapSnapshotOnSessionRollover({
    sessionKey,
    previousSessionId: isNewSession ? sessionEntry?.sessionId : undefined,
  });

  const persistedThinking =
    fresh && sessionEntry?.thinkingLevel
      ? normalizeThinkLevel(sessionEntry.thinkingLevel)
      : undefined;
  const persistedVerbose =
    fresh && sessionEntry?.verboseLevel
      ? normalizeVerboseLevel(sessionEntry.verboseLevel)
      : undefined;

  return {
    sessionId,
    sessionKey,
    sessionEntry,
    sessionStore,
    storePath,
    isNewSession,
    persistedThinking,
    persistedVerbose,
  };
}
