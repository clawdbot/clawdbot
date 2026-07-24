import { existsSync } from "node:fs";
import path from "node:path";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveOpenClawRegisteredAgentDatabaseOwners } from "../../state/openclaw-agent-db-registry.js";
import { inspectOpenClawAgentDatabaseOwner } from "../../state/openclaw-agent-db.js";

/** SQLite database target resolved from a legacy session store path. */
type ResolvedSqliteStoreTarget = {
  agentId?: string;
  ownerSource?: "database-registry" | "database-path" | "configured-default" | "ambiguous-registry";
  path: string;
  unsuffixedOwnerAgentId?: string;
};

function resolveCustomStoreSqlitePath(params: {
  agentId?: string;
  defaultAgentId?: string;
  env?: NodeJS.ProcessEnv;
  registeredOwnerAgentIds?: readonly string[];
  sqliteBaseName?: string;
  storePath: string;
}): ResolvedSqliteStoreTarget {
  const resolved = path.resolve(params.storePath);
  const sessionsDir = path.dirname(resolved);
  const sqliteBaseName =
    params.sqliteBaseName ?? (path.basename(resolved, path.extname(resolved)) || "openclaw-agent");
  const agentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
  const unsuffixedPath = path.join(sessionsDir, `${sqliteBaseName}.sqlite`);
  const registeredOwners = [
    ...new Set(
      (
        params.registeredOwnerAgentIds ??
        resolveOpenClawRegisteredAgentDatabaseOwners(unsuffixedPath, {
          ...(params.env ? { env: params.env } : {}),
        })
      ).map(normalizeAgentId),
    ),
  ];
  const databaseOwner =
    registeredOwners.length === 1 || !existsSync(unsuffixedPath)
      ? undefined
      : inspectOpenClawAgentDatabaseOwner(unsuffixedPath);
  const databaseOwnerAgentId =
    databaseOwner?.status === "owned" ? normalizeAgentId(databaseOwner.agentId) : undefined;
  const unsuffixedOwnerAgentId =
    registeredOwners.length === 1
      ? registeredOwners[0]
      : databaseOwnerAgentId
        ? databaseOwnerAgentId
        : normalizeAgentId(params.defaultAgentId ?? "main");
  const ownerSource =
    registeredOwners.length === 1
      ? "database-registry"
      : databaseOwnerAgentId
        ? "database-path"
        : "configured-default";
  // One logical fixed store must never map two agent owners to one physical DB.
  // Registry/DB ownership wins; otherwise the configured default keeps the unsuffixed file.
  // Filenames never infer ownership, so every other claimant is always suffixed.
  const sqliteName =
    !agentId || agentId === unsuffixedOwnerAgentId
      ? sqliteBaseName
      : `${sqliteBaseName}.${agentId}`;
  const physicalOwnerAgentId = agentId ?? unsuffixedOwnerAgentId;
  return {
    ...(physicalOwnerAgentId ? { agentId: physicalOwnerAgentId } : {}),
    path: path.join(sessionsDir, `${sqliteName}.sqlite`),
    ownerSource,
    ...(unsuffixedOwnerAgentId ? { unsuffixedOwnerAgentId } : {}),
  };
}

/** Resolves the SQLite database target that owns a legacy session store path. */
export function resolveSqliteTargetFromSessionStorePath(
  storePath: string,
  options: {
    agentId?: string;
    defaultAgentId?: string;
    env?: NodeJS.ProcessEnv;
    registeredOwnerAgentIds?: readonly string[];
  } = {},
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
      ...resolveCustomStoreSqlitePath({
        ...(options.agentId ? { agentId: options.agentId } : {}),
        ...(options.defaultAgentId ? { defaultAgentId: options.defaultAgentId } : {}),
        ...(options.env ? { env: options.env } : {}),
        ...(options.registeredOwnerAgentIds
          ? { registeredOwnerAgentIds: options.registeredOwnerAgentIds }
          : {}),
        storePath: resolved,
      }),
    };
  }
  if (path.basename(sessionsDir) !== "sessions") {
    return {
      ...resolveCustomStoreSqlitePath({
        ...(options.agentId ? { agentId: options.agentId } : {}),
        ...(options.defaultAgentId ? { defaultAgentId: options.defaultAgentId } : {}),
        ...(options.env ? { env: options.env } : {}),
        ...(options.registeredOwnerAgentIds
          ? { registeredOwnerAgentIds: options.registeredOwnerAgentIds }
          : {}),
        sqliteBaseName: "openclaw-agent",
        storePath: resolved,
      }),
    };
  }
  const agentDir = path.dirname(sessionsDir);
  if (path.basename(path.dirname(agentDir)) !== "agents") {
    return {
      ...resolveCustomStoreSqlitePath({
        ...(options.agentId ? { agentId: options.agentId } : {}),
        ...(options.defaultAgentId ? { defaultAgentId: options.defaultAgentId } : {}),
        ...(options.env ? { env: options.env } : {}),
        ...(options.registeredOwnerAgentIds
          ? { registeredOwnerAgentIds: options.registeredOwnerAgentIds }
          : {}),
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
