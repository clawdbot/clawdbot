import path from "node:path";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";

/** SQLite database target resolved from a legacy session store path. */
type ResolvedSqliteStoreTarget = {
  agentId?: string;
  path: string;
};

function resolveCustomStoreSqlitePath(params: {
  agentId?: string;
  sqliteBaseName?: string;
  storePath: string;
}): string {
  const resolved = path.resolve(params.storePath);
  const sessionsDir = path.dirname(resolved);
  const sqliteBaseName =
    params.sqliteBaseName ?? (path.basename(resolved, path.extname(resolved)) || "openclaw-agent");
  const agentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
  const sqliteName =
    agentId && agentId !== DEFAULT_AGENT_ID && normalizeAgentId(sqliteBaseName) !== agentId
      ? `${sqliteBaseName}.${agentId}`
      : sqliteBaseName;
  return path.join(sessionsDir, `${sqliteName}.sqlite`);
}

/** Resolves the SQLite database target that owns a legacy session store path. */
export function resolveSqliteTargetFromSessionStorePath(
  storePath: string,
  options: { agentId?: string } = {},
): ResolvedSqliteStoreTarget {
  const resolved = path.resolve(storePath);
  if (path.basename(resolved) === "openclaw-agent.sqlite" || resolved.endsWith(".sqlite")) {
    const agentId = resolveAgentIdFromSqliteDatabasePath(resolved);
    return {
      path: resolved,
      ...(agentId ? { agentId } : {}),
    };
  }
  const sessionsDir = path.dirname(resolved);
  if (path.basename(resolved) !== "sessions.json") {
    return {
      path: resolveCustomStoreSqlitePath({
        ...(options.agentId ? { agentId: options.agentId } : {}),
        storePath: resolved,
      }),
    };
  }
  if (path.basename(sessionsDir) !== "sessions") {
    return {
      path: resolveCustomStoreSqlitePath({
        ...(options.agentId ? { agentId: options.agentId } : {}),
        sqliteBaseName: "openclaw-agent",
        storePath: resolved,
      }),
    };
  }
  const agentDir = path.dirname(sessionsDir);
  if (path.basename(path.dirname(agentDir)) !== "agents") {
    return {
      path: resolveCustomStoreSqlitePath({
        ...(options.agentId ? { agentId: options.agentId } : {}),
        sqliteBaseName: "openclaw-agent",
        storePath: resolved,
      }),
    };
  }
  return {
    agentId: normalizeAgentId(path.basename(agentDir)),
    path: path.join(agentDir, "agent", "openclaw-agent.sqlite"),
  };
}

/** Extracts the agent id from the canonical per-agent SQLite database path. */
function resolveAgentIdFromSqliteDatabasePath(databasePath: string): string | undefined {
  if (path.basename(databasePath) !== "openclaw-agent.sqlite") {
    return undefined;
  }
  const agentDbDir = path.dirname(databasePath);
  if (path.basename(agentDbDir) !== "agent") {
    return undefined;
  }
  const agentDir = path.dirname(agentDbDir);
  if (path.basename(path.dirname(agentDir)) !== "agents") {
    return undefined;
  }
  return normalizeAgentId(path.basename(agentDir));
}
