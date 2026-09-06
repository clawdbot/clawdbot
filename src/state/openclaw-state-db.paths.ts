// State database path helpers resolve shared OpenClaw state DB paths.
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

/** Resolve the directory that contains the shared state SQLite file. */
export function resolveOpenClawStateSqliteDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "state");
}

/** Resolve the shared state SQLite file path. */
export function resolveOpenClawStateSqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveOpenClawStateSqliteDir(env), "openclaw.sqlite");
}

/** Resolve the state owner directory for a canonical or explicit shared database path. */
export function resolveOpenClawStateDirForDatabasePath(databasePath: string): string {
  const databaseDir = path.dirname(path.resolve(databasePath));
  return path.basename(databaseDir) === "state" ? path.dirname(databaseDir) : databaseDir;
}

/** Resolve the durable registry form for one agent database path. */
export function resolveOpenClawAgentDatabaseStoredPath(
  registryDatabasePath: string,
  agentDatabasePath: string,
): string {
  const stateDir = resolveOpenClawStateDirForDatabasePath(registryDatabasePath);
  const absolutePath = path.resolve(agentDatabasePath);
  const relativePath = path.relative(stateDir, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return absolutePath;
  }
  const statePrefix = `${stateDir}${stateDir.endsWith(path.sep) ? "" : path.sep}`;
  return path.isAbsolute(agentDatabasePath) && agentDatabasePath.startsWith(statePrefix)
    ? agentDatabasePath.slice(statePrefix.length)
    : relativePath;
}

/** Resolve one stored agent database registry path for runtime consumers. */
export function resolveOpenClawRegisteredAgentDatabasePath(
  registryDatabasePath: string,
  storedPath: string,
): string {
  return path.isAbsolute(storedPath)
    ? storedPath
    : `${resolveOpenClawStateDirForDatabasePath(registryDatabasePath)}${path.sep}${storedPath}`;
}

type AgentPathMigrationObservation = {
  relativized: number;
  reanchored: string[];
  deleted: string[];
};

type AgentPathMigrationLogger = {
  warn: (
    message: string,
    fields: { reanchored: string[]; deleted: string[]; path: string },
  ) => void;
};

export function describeAgentPathMigration(summary: AgentPathMigrationObservation): string[] {
  const { relativized, reanchored, deleted } = summary;
  if (relativized === 0 && reanchored.length === 0 && deleted.length === 0) {
    return [];
  }
  const decisions = reanchored.length + deleted.length;
  const counts = [
    `${relativized} relativized`,
    reanchored.length > 0 && `${reanchored.length} re-anchored`,
    deleted.length > 0 && `${deleted.length} removed`,
  ].filter(Boolean);
  return [
    `Migrated agent database registry paths to state-relative storage${decisions > 0 ? ` (${counts.join(", ")})` : ""}`,
    ...reanchored.map(
      (registeredPath) =>
        `Re-anchored agent database registry path ${registeredPath} to the current state directory`,
    ),
    ...deleted.map(
      (registeredPath) => `Removed duplicate agent database registry path ${registeredPath}`,
    ),
  ];
}

export function warnAgentPathMigration(
  log: AgentPathMigrationLogger,
  summary: AgentPathMigrationObservation,
  databasePath: string,
): void {
  if (summary.reanchored.length === 0 && summary.deleted.length === 0) {
    return;
  }
  log.warn("agent database registry rows re-anchored or removed during v9 migration", {
    reanchored: summary.reanchored,
    deleted: summary.deleted,
    path: databasePath,
  });
}
