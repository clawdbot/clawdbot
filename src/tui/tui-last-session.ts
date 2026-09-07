// Stores and resolves the last TUI session per workspace.
import { createHash } from "node:crypto";
import { normalizeLowercaseStringOrEmpty as normalizeMarker } from "@openclaw/normalization-core/string-coerce";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import {
  writeConfigMachineState,
  updateConfigMachineState,
} from "../state/config-machine-state-write.js";
import { readConfigMachineStateWithMetadata } from "../state/config-machine-state.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type { TuiSessionList } from "./tui-backend.js";
import type { SessionScope } from "./tui-types.js";

type TuiLastSessionDatabase = Pick<OpenClawStateKyselyDatabase, "config_machine_state">;

const TUI_LAST_SESSION_STATE_KEY_PREFIX = "tui.lastSession.";

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
  const sessionKey = readConfigMachineStateWithMetadata<string>(
    `${TUI_LAST_SESSION_STATE_KEY_PREFIX}${params.scopeKey}`,
    stateDatabaseOptions(params.stateDir),
  );
  const rememberedKey = sessionKey?.value.trim() ?? "";
  return rememberedKey && !isHeartbeatSessionKey(rememberedKey) ? rememberedKey : null;
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
  writeConfigMachineState(
    `${TUI_LAST_SESSION_STATE_KEY_PREFIX}${params.scopeKey}`,
    sessionKey,
    stateDatabaseOptions(params.stateDir),
  );
}

/**
 * Wraps writeTuiLastSessionKey for fire-and-forget callers: a failing state DB
 * means the next launch silently loses session restore, so the first failure
 * is reported once instead of spamming every session switch.
 */
export function createRememberSessionKeyWriter(params: {
  buildScopeKey: (sessionKey: string) => string;
  reportFailure: (message: string) => void;
  write: typeof writeTuiLastSessionKey;
}): (sessionKey: string) => void {
  const write = params.write;
  let failureReported = false;
  return (sessionKey: string) => {
    const trimmed = sessionKey.trim();
    if (!trimmed || trimmed === "unknown") {
      return;
    }
    void write({ scopeKey: params.buildScopeKey(trimmed), sessionKey: trimmed }).catch(
      (err: unknown) => {
        if (failureReported) {
          return;
        }
        failureReported = true;
        params.reportFailure(err instanceof Error ? err.message : String(err));
      },
    );
  };
}

/** Removes restore pointers that target sessions retired by doctor repair. */
export function clearTuiLastSessionPointers(params: {
  sessionKeys: ReadonlySet<string>;
  stateDir?: string;
}): number {
  if (params.sessionKeys.size === 0) {
    return 0;
  }
  const options = stateDatabaseOptions(params.stateDir);
  const matchingKeys = withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
    const rows = executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<TuiLastSessionDatabase>(db)
        .selectFrom("config_machine_state")
        .select(["state_key", "value_json"])
        .where("state_key", "like", `${TUI_LAST_SESSION_STATE_KEY_PREFIX}%`),
    ).rows;
    return rows.flatMap((row) => {
      const sessionKey: unknown = JSON.parse(row.value_json);
      return typeof sessionKey === "string" && params.sessionKeys.has(sessionKey)
        ? [row.state_key]
        : [];
    });
  }, options);
  return (matchingKeys ?? []).reduce(
    (cleared, stateKey) =>
      cleared + Number(clearTuiPointerIfRetired(stateKey, params.sessionKeys, options)),
    0,
  );
}

// Compare-and-delete inside the write transaction: a live replacement pointer
// written after the read-only scan must survive doctor cleanup.
function clearTuiPointerIfRetired(
  stateKey: string,
  retiredSessionKeys: ReadonlySet<string>,
  options: OpenClawStateDatabaseOptions,
): boolean {
  let cleared = false;
  updateConfigMachineState<string>(
    stateKey,
    (current) => {
      if (typeof current === "string" && retiredSessionKeys.has(current)) {
        cleared = true;
        return undefined;
      }
      return current;
    },
    options,
  );
  return cleared;
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
