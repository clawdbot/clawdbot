import { isDeepStrictEqual } from "node:util";
import type {
  SessionCatalogHost,
  SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds } from "../../agents/agent-scope.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  listSessionEntriesReadOnly,
  type SessionEntrySummary,
} from "../../config/sessions/session-accessor.js";
import { sessionCreatorProfileId } from "../../config/sessions/session-entry-provenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionCatalogEntrySnapshot } from "../../plugins/session-catalog.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { projectSessionActor } from "../session-identity-projection.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
import type { SessionActorProfileIdentity } from "../session-utils-contracts.js";

export type SessionCatalogInstances = Map<
  string,
  Pick<SessionEntry, "sessionId" | "pluginOwnerId" | "createdActor">
>;

type SessionCatalogRequestEntrySnapshot = {
  sessionEntries: SessionCatalogEntrySnapshot;
  freeze: () => void;
  captureHostInstances: (host: SessionCatalogHost, instances: SessionCatalogInstances) => void;
  entryForSession: (sessionKey: string) => SessionEntry | undefined;
  projectHostCreatedActors: (
    host: SessionCatalogHost,
    instances: SessionCatalogInstances,
  ) => SessionCatalogHost;
};

export function createSessionCatalogRequestEntrySnapshot(params: {
  cfg: OpenClawConfig;
  fallbackAgentId: string;
}): SessionCatalogRequestEntrySnapshot {
  const entriesByAgentId = new Map<string, readonly SessionEntrySummary[]>();
  const entryIndexByAgentId = new Map<string, ReadonlyMap<string, SessionEntry>>();
  const actorBySessionKey = new Map<string, SessionCatalogSession["createdActor"]>();
  let frozen = false;
  // Hosts share human identities within this request; a new snapshot must see profile edits.
  const userProfileIdentityById = new Map<string, SessionActorProfileIdentity | undefined>();
  let catalogEntries:
    | ReturnType<NonNullable<SessionCatalogEntrySnapshot["entriesForCatalog"]>>
    | undefined;

  const entriesForAgent = (rawAgentId: string): readonly SessionEntrySummary[] => {
    const agentId = normalizeAgentId(rawAgentId);
    if (!entriesByAgentId.has(agentId)) {
      if (frozen) {
        return [];
      }
      entriesByAgentId.set(
        agentId,
        listSessionEntriesReadOnly({ agentId, clone: false, projection: "list" }),
      );
    }
    return entriesByAgentId.get(agentId) ?? [];
  };

  const entriesForCatalog: NonNullable<SessionCatalogEntrySnapshot["entriesForCatalog"]> = () => {
    if (catalogEntries) {
      return catalogEntries;
    }
    const agentIds = [
      params.fallbackAgentId,
      ...listAgentIds(params.cfg).filter((agentId) => agentId !== params.fallbackAgentId),
    ];
    catalogEntries = agentIds.flatMap((agentId) =>
      entriesForAgent(agentId).map((entry) => Object.assign({}, entry, { agentId })),
    );
    return catalogEntries;
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

  const entryForSession = (sessionKey: string): SessionEntry | undefined => {
    const agentId = resolveAgentIdFromSessionKey(
      sessionKey,
      tryResolveSessionCompatibilityOwnerAgentId(params.cfg, sessionKey) ?? params.fallbackAgentId,
    );
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
    return freshest;
  };

  const createdActorForSession = (sessionKey: string): SessionCatalogSession["createdActor"] => {
    if (actorBySessionKey.has(sessionKey)) {
      return actorBySessionKey.get(sessionKey);
    }
    const entry = entryForSession(sessionKey);
    const actor = projectSessionActor(
      entry?.createdActor,
      userProfileIdentityById,
      params.cfg,
      Boolean(sessionCreatorProfileId(entry?.createdActor)),
    );
    actorBySessionKey.set(sessionKey, actor);
    return actor;
  };

  return {
    sessionEntries: { entriesForAgent, entriesForCatalog },
    freeze: () => {
      // Capture before provider admission/IO, even when a provider first reads after awaiting.
      // A key first resolved after deletion/recreation cannot prove the original adoption.
      entriesForCatalog();
      frozen = true;
    },
    captureHostInstances: (host, instances) => {
      for (const session of host.sessions) {
        if (!session.sessionKey) {
          continue;
        }
        const entry = entryForSession(session.sessionKey);
        if (entry) {
          const { sessionId, pluginOwnerId, createdActor } = entry;
          instances.set(session.sessionKey, { sessionId, pluginOwnerId, createdActor });
        }
      }
    },
    entryForSession,
    projectHostCreatedActors: (host, instances) => ({
      ...host,
      sessions: host.sessions.map(
        ({ createdActor: _providerCreatedActor, sessionKey, ...session }) => {
          const original = sessionKey ? instances.get(sessionKey) : undefined;
          const current = sessionKey ? entryForSession(sessionKey) : undefined;
          // Native rows remain native if their adoption was replaced or detached. Never project
          // a reusable key's new creator onto the previous instance's provider metadata.
          if (
            !original ||
            !current ||
            original.sessionId !== current.sessionId ||
            original.pluginOwnerId !== current.pluginOwnerId ||
            current.initializationPending === true ||
            !isDeepStrictEqual(original.createdActor, current.createdActor)
          ) {
            return session;
          }
          const createdActor = sessionKey ? createdActorForSession(sessionKey) : undefined;
          return { ...session, sessionKey, ...(createdActor ? { createdActor } : {}) };
        },
      ),
    }),
  };
}
