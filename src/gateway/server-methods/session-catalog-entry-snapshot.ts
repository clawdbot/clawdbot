import type {
  SessionCatalogHost,
  SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  listSessionEntriesReadOnly,
  type SessionEntrySummary,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionCatalogEntrySnapshot } from "../../plugins/session-catalog.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
import { projectSessionActor } from "../session-utils-row.js";

type SessionCatalogRequestEntrySnapshot = {
  sessionEntries: SessionCatalogEntrySnapshot;
  projectHostCreatedActors: (host: SessionCatalogHost) => SessionCatalogHost;
};

export function createSessionCatalogRequestEntrySnapshot(params: {
  cfg: OpenClawConfig;
  fallbackAgentId: string;
}): SessionCatalogRequestEntrySnapshot {
  const entriesByAgentId = new Map<string, readonly SessionEntrySummary[]>();
  const entryIndexByAgentId = new Map<string, ReadonlyMap<string, SessionEntry>>();
  const actorBySessionKey = new Map<string, SessionCatalogSession["createdActor"]>();

  const entriesForAgent = (rawAgentId: string): readonly SessionEntrySummary[] => {
    const agentId = normalizeAgentId(rawAgentId);
    if (!entriesByAgentId.has(agentId)) {
      entriesByAgentId.set(agentId, listSessionEntriesReadOnly({ agentId }));
    }
    return entriesByAgentId.get(agentId) ?? [];
  };

  const entryIndexForAgent = (agentId: string): ReadonlyMap<string, SessionEntry> => {
    const normalizedAgentId = normalizeAgentId(agentId);
    const cached = entryIndexByAgentId.get(normalizedAgentId);
    if (cached) {
      return cached;
    }
    const index = new Map(
      entriesForAgent(normalizedAgentId).map(({ sessionKey, entry }) => [sessionKey, entry]),
    );
    entryIndexByAgentId.set(normalizedAgentId, index);
    return index;
  };

  const createdActorForSession = (sessionKey: string): SessionCatalogSession["createdActor"] => {
    if (actorBySessionKey.has(sessionKey)) {
      return actorBySessionKey.get(sessionKey);
    }
    const agentId = resolveAgentIdFromSessionKey(sessionKey, params.fallbackAgentId);
    const index = entryIndexForAgent(agentId);
    const canonicalKey = resolveStoredSessionKeyForAgentStore({
      cfg: params.cfg,
      agentId,
      sessionKey,
    });
    const candidates = new Set([sessionKey, canonicalKey]);
    let freshest: SessionEntry | undefined;
    for (const key of candidates) {
      const entry = index.get(key);
      if (entry && (!freshest || (entry.updatedAt ?? 0) > (freshest.updatedAt ?? 0))) {
        freshest = entry;
      }
    }
    const actor = projectSessionActor(freshest?.createdActor);
    actorBySessionKey.set(sessionKey, actor);
    return actor;
  };

  return {
    sessionEntries: { entriesForAgent },
    projectHostCreatedActors: (host) => ({
      ...host,
      sessions: host.sessions.map(({ createdActor: _providerCreatedActor, ...session }) => {
        const createdActor = session.sessionKey
          ? createdActorForSession(session.sessionKey)
          : undefined;
        return createdActor ? { ...session, createdActor } : session;
      }),
    }),
  };
}
