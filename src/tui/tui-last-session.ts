// Stores and resolves the last TUI session per workspace.
import { createHash } from "node:crypto";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import type { TuiSessionList } from "./tui-backend.js";
import type { SessionScope } from "./tui-types.js";

type TuiLastSessionDatabase = Pick<OpenClawStateKyselyDatabase, "tui_last_sessions">;

function stateDatabaseOptions(stateDir?: string) {
  return stateDir
    ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } }
    : { env: process.env };
}

/** Builds a stable private-store key for the current TUI connection, agent, and session scope. */
export function buildTuiLastSessionScopeKey(params: {
  connectionUrl: string;
  agentId: string;
  sessionScope: SessionScope;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const connectionUrl = params.connectionUrl.trim() || "local";
  return createHash("sha256")
    .update(`${params.sessionScope}\n${agentId}\n${connectionUrl}`)
    .digest("hex")
    .slice(0, 32);
}

function normalizeMarker(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isHeartbeatSessionKey(sessionKey: string): boolean {
  return normalizeMarker(sessionKey).endsWith(":heartbeat");
}

/** Detects heartbeat/system sessions that should not become the remembered human session. */
function isHeartbeatLikeTuiSession(session: TuiSessionList["sessions"][number]): boolean {
  if (isHeartbeatSessionKey(session.key)) {
    return true;
  }
  const markers = [
    session.provider,
    session.lastProvider,
    session.lastChannel,
    session.lastTo,
    session.origin?.provider,
    session.origin?.surface,
    session.origin?.label,
  ];
  return markers.some((marker) => normalizeMarker(marker) === "heartbeat");
}

/** Reads the remembered session key for a scope from canonical shared state. */
export async function readTuiLastSessionKey(params: {
  scopeKey: string;
  stateDir?: string;
}): Promise<string | null> {
  const database = openOpenClawStateDatabase(stateDatabaseOptions(params.stateDir));
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getNodeSqliteKysely<TuiLastSessionDatabase>(database.db)
      .selectFrom("tui_last_sessions")
      .select("session_key")
      .where("scope_key", "=", params.scopeKey),
  );
  const sessionKey = row?.session_key.trim() ?? "";
  return sessionKey && !isHeartbeatSessionKey(sessionKey) ? sessionKey : null;
}

/** Writes the remembered session key unless it is empty, unknown, or heartbeat-owned. */
export async function writeTuiLastSessionKey(params: {
  scopeKey: string;
  sessionKey: string;
  stateDir?: string;
}): Promise<void> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey || sessionKey === "unknown" || isHeartbeatSessionKey(sessionKey)) {
    return;
  }
  const updatedAt = Date.now();
  runOpenClawStateWriteTransaction(({ db }) => {
    const tuiDb = getNodeSqliteKysely<TuiLastSessionDatabase>(db);
    executeSqliteQuerySync(
      db,
      tuiDb
        .insertInto("tui_last_sessions")
        .values({
          scope_key: params.scopeKey,
          session_key: sessionKey,
          updated_at: updatedAt,
        })
        .onConflict((conflict) =>
          conflict.column("scope_key").doUpdateSet({
            session_key: sessionKey,
            updated_at: updatedAt,
          }),
        ),
    );
  }, stateDatabaseOptions(params.stateDir));
}

/** Removes restore pointers that target sessions retired by doctor repair. */
export function clearTuiLastSessionPointers(params: {
  sessionKeys: ReadonlySet<string>;
  stateDir?: string;
}): number {
  if (params.sessionKeys.size === 0) {
    return 0;
  }
  return runOpenClawStateWriteTransaction(({ db }) => {
    const result = executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<TuiLastSessionDatabase>(db)
        .deleteFrom("tui_last_sessions")
        .where("session_key", "in", [...params.sessionKeys]),
    );
    return Number(result.numAffectedRows ?? 0n);
  }, stateDatabaseOptions(params.stateDir));
}

/** Resolves a remembered key to a currently listed session for the active agent. */
export function resolveRememberedTuiSessionKey(params: {
  rememberedKey: string | null | undefined;
  currentAgentId: string;
  sessions: TuiSessionList["sessions"];
}): string | null {
  const rememberedKey = params.rememberedKey?.trim();
  if (!rememberedKey) {
    return null;
  }
  if (isHeartbeatSessionKey(rememberedKey)) {
    return null;
  }
  const currentAgentId = normalizeAgentId(params.currentAgentId);
  const parsed = parseAgentSessionKey(rememberedKey);
  if (parsed && normalizeAgentId(parsed.agentId) !== currentAgentId) {
    return null;
  }
  const rememberedRest = parsed?.rest ?? rememberedKey;
  // Agent-prefixed and bare keys can refer to the same session; compare the session rest too.
  const match = params.sessions.find((session) => {
    if (isHeartbeatLikeTuiSession(session)) {
      return false;
    }
    if (session.key === rememberedKey) {
      return true;
    }
    return parseAgentSessionKey(session.key)?.rest === rememberedRest;
  });
  return match?.key ?? null;
}
