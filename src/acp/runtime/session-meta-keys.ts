import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import { tryResolveLegacyCompatibilityAgentId } from "../../config/legacy.default-agent-owner.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";

export type AcpSessionsTable = OpenClawStateKyselyDatabase["acp_sessions"];
type AcpSessionMetaDatabase = Pick<OpenClawStateKyselyDatabase, "acp_sessions">;
export type AcpSessionRow = Selectable<AcpSessionsTable>;
export type AcpSessionEntryBinding = Pick<SessionEntry, "lifecycleRevision"> &
  Partial<Pick<SessionEntry, "sessionId" | "sessionStartedAt">>;

export function getAcpSessionKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<AcpSessionMetaDatabase>(db);
}

export function selectAcpSessionRow(
  db: DatabaseSync,
  sessionKey: string,
): AcpSessionRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    getAcpSessionKysely(db)
      .selectFrom("acp_sessions")
      .selectAll()
      .where("session_key", "=", sessionKey),
  );
}

const ACP_DATABASE_KEY_PREFIX = "@acp:v1:";
const ACP_LEGACY_AGENT_SCOPED_DB_KEY_PREFIX = "@agent:";

export function buildAcpDatabaseSessionKey(storeSessionKey: string, agentId?: string): string {
  const normalizedKey = storeSessionKey.trim();
  const identity = [agentId ? normalizeAgentId(agentId) : null, normalizedKey];
  return `${ACP_DATABASE_KEY_PREFIX}${Buffer.from(JSON.stringify(identity), "utf8").toString("base64url")}`;
}

function parseAcpDatabaseSessionKey(sessionKey: string): {
  agentId?: string;
  storeSessionKey: string;
} {
  if (sessionKey.startsWith(ACP_DATABASE_KEY_PREFIX)) {
    try {
      const decoded = JSON.parse(
        Buffer.from(sessionKey.slice(ACP_DATABASE_KEY_PREFIX.length), "base64url").toString("utf8"),
      ) as unknown;
      if (
        Array.isArray(decoded) &&
        decoded.length === 2 &&
        (decoded[0] === null || typeof decoded[0] === "string") &&
        typeof decoded[1] === "string"
      ) {
        return {
          ...(decoded[0] ? { agentId: normalizeAgentId(decoded[0]) } : {}),
          storeSessionKey: decoded[1],
        };
      }
    } catch {
      // A legacy raw key may happen to use the reserved prefix. Treat it as raw.
    }
    return { storeSessionKey: sessionKey };
  }
  if (!sessionKey.startsWith(ACP_LEGACY_AGENT_SCOPED_DB_KEY_PREFIX)) {
    return { storeSessionKey: sessionKey };
  }
  const remainder = sessionKey.slice(ACP_LEGACY_AGENT_SCOPED_DB_KEY_PREFIX.length);
  const separator = remainder.indexOf(":");
  return separator > 0
    ? {
        agentId: normalizeAgentId(remainder.slice(0, separator)),
        storeSessionKey: remainder.slice(separator + 1),
      }
    : { storeSessionKey: sessionKey };
}

export function parseAcpDatabaseSessionKeyCandidates(sessionKey: string): Array<{
  agentId?: string;
  storeSessionKey: string;
}> {
  const parsed = parseAcpDatabaseSessionKey(sessionKey);
  if (parsed.storeSessionKey === sessionKey && parsed.agentId === undefined) {
    return [parsed];
  }
  return [parsed, { storeSessionKey: sessionKey }];
}

function resolveAcpLegacyUnscopedOwner(
  cfg: OpenClawConfig | undefined,
  storeSessionKey: string,
): string | undefined {
  if (!cfg) {
    return undefined;
  }
  const persistedOwner = resolvePersistedSessionStoreOwnerForKey(cfg, storeSessionKey);
  return persistedOwner.kind === "configured"
    ? persistedOwner.agentId
    : persistedOwner.kind === "none"
      ? tryResolveLegacyCompatibilityAgentId(cfg)
      : undefined;
}

export function legacyAcpDatabaseSessionKeys(
  storeSessionKey: string,
  agentId?: string,
  cfg?: OpenClawConfig,
): string[] {
  const normalizedKey = storeSessionKey.trim();
  const keys: string[] = [];
  if (agentId && !parseAgentSessionKey(normalizedKey)) {
    keys.push(
      `${ACP_LEGACY_AGENT_SCOPED_DB_KEY_PREFIX}${normalizeAgentId(agentId)}:${normalizedKey}`,
    );
  }
  const compatibilityOwner = resolveAcpLegacyUnscopedOwner(cfg, normalizedKey);
  if (
    parseAgentSessionKey(normalizedKey) ||
    !agentId ||
    compatibilityOwner === normalizeAgentId(agentId)
  ) {
    keys.push(normalizedKey);
  }
  return [...new Set(keys)];
}

export function acpSessionRowMatchesEntry(
  row: AcpSessionRow,
  entry: AcpSessionEntryBinding | undefined,
): boolean {
  return (
    row.session_id == null ||
    row.session_id === entry?.lifecycleRevision ||
    (row.session_id === entry?.sessionId &&
      (entry?.sessionStartedAt === undefined || row.updated_at >= entry.sessionStartedAt))
  );
}

export function selectAcpSessionRowForStoreEntry(
  db: DatabaseSync,
  storeSessionKey: string,
  agentId?: string,
  cfg?: OpenClawConfig,
  entry?: AcpSessionEntryBinding,
): AcpSessionRow | undefined {
  const databaseKey = buildAcpDatabaseSessionKey(storeSessionKey, agentId);
  for (const key of [databaseKey, ...legacyAcpDatabaseSessionKeys(storeSessionKey, agentId, cfg)]) {
    const row = selectAcpSessionRow(db, key);
    if (row && (!entry || acpSessionRowMatchesEntry(row, entry))) {
      return row;
    }
  }
  return undefined;
}

export function resolveReadableAcpSessionRow(params: {
  row: AcpSessionRow | undefined;
  entry: AcpSessionEntryBinding | undefined;
}): AcpSessionRow | undefined {
  const { row, entry } = params;
  return row && acpSessionRowMatchesEntry(row, entry) ? row : undefined;
}
