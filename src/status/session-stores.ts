import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  listSessionEntriesReadOnly,
  type SessionEntrySummary,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.js";
import { parseAgentSessionKey } from "../routing/session-key.js";

type StatusSessionStore = {
  sessions: SessionEntrySummary[];
  byAgent: Map<string, SessionEntrySummary[]>;
};

/** One collection owns the snapshot; borrowed read policies must finish before an await. */
export function createStatusSessionStoreReader(
  readEntries: typeof listSessionEntriesReadOnly = listSessionEntriesReadOnly,
) {
  const stores = new Map<string, StatusSessionStore>();
  return {
    stores,
    read(storePath: string, agentId?: string) {
      const path = resolveSqliteTargetFromSessionStorePath(storePath, { agentId }).path;
      let store = stores.get(path);
      if (!store) {
        store = { sessions: [], byAgent: new Map() };
        for (const row of readEntries({
          ...(agentId ? { agentId } : {}),
          storePath,
        })) {
          // The accessor validates canonical keys; only global/unknown buckets lack an agent.
          const owner = parseAgentSessionKey(row.sessionKey)?.agentId;
          if (!owner) {
            continue;
          }
          store.sessions.push(row);
          const agentSessions = store.byAgent.get(owner);
          if (agentSessions) {
            agentSessions.push(row);
          } else {
            store.byAgent.set(owner, [row]);
          }
        }
        stores.set(path, store);
      }
      return { path, sessions: agentId ? (store.byAgent.get(agentId) ?? []) : store.sessions };
    },
  };
}

/** Reads each physical store once, retaining retired agent namespaces in the aggregate. */
export function readStatusSessionStores(
  cfg: OpenClawConfig,
  agents: ReadonlyArray<{ id: string; name?: string }>,
) {
  const reader = createStatusSessionStoreReader();
  const byAgent = agents.map((agent) => ({
    agent,
    ...reader.read(
      resolveSessionStorePathCore(cfg.session?.store, { agentId: agent.id }),
      agent.id,
    ),
  }));
  return {
    paths: [...reader.stores.keys()],
    sessions: [...reader.stores.values()].flatMap((store) => store.sessions),
    byAgent,
  };
}
