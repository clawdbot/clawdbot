import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { readClaim } from "./legacy-main-session-migration-operations.js";
import type { PhysicalStore, SessionClaim } from "./legacy-main-session-migration.contract.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";

/** Returns the stored `agent:<id>:` prefix when the key is owned by the legacy agent. */
function legacyAgentKeyPrefix(key: string, legacyAgentId: string): string | null {
  const parsed = parseAgentSessionKey(key);
  if (!parsed || normalizeAgentId(parsed.agentId) !== legacyAgentId) {
    return null;
  }
  const prefix = `agent:${parsed.agentId}:`;
  return key.startsWith(prefix) ? prefix : null;
}

function canonicalKeyFor(key: string, legacyAgentId: string, ownerAgentId: string): string | null {
  const prefix = legacyAgentKeyPrefix(key, legacyAgentId);
  return prefix ? `agent:${ownerAgentId}:${key.slice(prefix.length)}` : null;
}

export function storeHasLegacyAgentSessionKey(params: {
  legacyAgentId: string;
  store: PhysicalStore;
  env: NodeJS.ProcessEnv;
}): boolean {
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      executeSqliteQuerySync(
        database.db,
        getSessionKysely(database.db).selectFrom("session_nodes").select("session_key"),
      ).rows.some((row) => legacyAgentKeyPrefix(row.session_key, params.legacyAgentId) !== null),
    { agentId: params.store.databaseAgentId, env: params.env, path: params.store.path },
  );
  // A missing database, schema, or table proves absence exactly as the armed claim
  // reader does below; only genuine read failures throw and let the caller fail open.
  return result.found ? result.value : false;
}

export function readClaimsFromStore(params: {
  legacyAgentId: string;
  ownerAgentId: string;
  store: PhysicalStore;
  env: NodeJS.ProcessEnv;
}): { canonical: SessionClaim[]; legacy: SessionClaim[] } {
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      const keys = executeSqliteQuerySync(
        database.db,
        getSessionKysely(database.db).selectFrom("session_nodes").select("session_key"),
      ).rows.map((row) => row.session_key);
      const legacy: SessionClaim[] = [];
      const canonical: SessionClaim[] = [];
      for (const key of keys) {
        const canonicalKey = canonicalKeyFor(key, params.legacyAgentId, params.ownerAgentId);
        if (canonicalKey) {
          const claim = readClaim(database, params.store, key, canonicalKey);
          if (claim) {
            legacy.push(claim);
          }
          continue;
        }
        const parsed = parseAgentSessionKey(key);
        if (parsed && normalizeAgentId(parsed.agentId) === params.ownerAgentId) {
          const claim = readClaim(database, params.store, key, key);
          if (claim) {
            canonical.push(claim);
          }
        }
      }
      return { canonical, legacy };
    },
    { agentId: params.store.databaseAgentId, env: params.env, path: params.store.path },
  );
  return result.found ? result.value : { canonical: [], legacy: [] };
}
