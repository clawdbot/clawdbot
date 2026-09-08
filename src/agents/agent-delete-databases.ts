import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { assertNoOpenClawAgentDatabaseLeases } from "../state/openclaw-agent-db-lease.js";
import { invalidateRegisteredAgentDatabasesMemo } from "../state/openclaw-agent-db-registry-listing.js";
import {
  closeOpenClawAgentDatabaseByPath,
  listOpenClawRegisteredAgentDatabases,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { findOverlappingWorkspaceAgentIds } from "./agent-delete-safety.js";
import {
  isPathOwnedByAnotherRegisteredAgent,
  normalizeAgentDirRegistryPath,
} from "./agent-dir-registry.js";

export type AgentDeleteDatabasePlan = {
  registrationPaths: string[];
  fileGroups: string[][];
  relocatedFileGroups: string[][];
};

/** Destructive planning includes every registered owner, regardless of runtime schema readiness. */
export function readAgentDeleteDatabaseRegistry(options: OpenClawStateDatabaseOptions = {}) {
  invalidateRegisteredAgentDatabasesMemo(options);
  return listOpenClawRegisteredAgentDatabases({
    ...options,
    includeIncompatibleSchemaVersions: true,
  });
}

export function resolveSurvivingDatabaseFilePaths(
  registeredDatabases: ReturnType<typeof listOpenClawRegisteredAgentDatabases>,
  agentId: string,
  env?: NodeJS.ProcessEnv,
): string[] {
  return [
    ...new Set(
      registeredDatabases
        .filter((entry) => normalizeAgentId(entry.agentId) !== agentId)
        .flatMap((entry) => resolveSqliteDatabaseFilePaths(entry.path))
        .map((pathname) => normalizeAgentDirRegistryPath(pathname, env)),
    ),
  ];
}

export function isPathOwnedBySurvivingAgent(
  cfg: OpenClawConfig,
  agentId: string,
  pathname: string,
  survivingDatabaseFilePaths: readonly string[] = [],
  env?: NodeJS.ProcessEnv,
): boolean {
  const canonicalPath = normalizeAgentDirRegistryPath(pathname, env);
  return (
    isPathOwnedByAnotherRegisteredAgent({ agentId, pathname, env }) ||
    findOverlappingWorkspaceAgentIds(cfg, agentId, pathname, env).length > 0 ||
    survivingDatabaseFilePaths.some(
      (databasePath) =>
        databasePath === canonicalPath ||
        isPathInside(databasePath, canonicalPath) ||
        isPathInside(canonicalPath, databasePath),
    )
  );
}

export function prepareAgentDeleteDatabases(
  cfg: OpenClawConfig,
  agentId: string,
  agentDir: string,
  options: OpenClawStateDatabaseOptions = {},
): AgentDeleteDatabasePlan {
  const registeredDatabases = readAgentDeleteDatabaseRegistry(options);
  const survivingDatabaseFilePaths = resolveSurvivingDatabaseFilePaths(
    registeredDatabases,
    agentId,
    options.env,
  );
  const registeredDatabasePaths = new Set([
    resolveOpenClawAgentSqlitePath({
      agentId,
      env: options.env,
      path: path.join(agentDir, "openclaw-agent.sqlite"),
    }),
    ...registeredDatabases
      .filter((entry) => normalizeAgentId(entry.agentId) === agentId)
      .map((entry) => entry.path),
  ]);
  // A surviving directory retains files, not the deleted agent's connection. Check the
  // actual cached owner so stale registration cannot close a surviving agent's handle.
  for (const databasePath of registeredDatabasePaths) {
    closeOpenClawAgentDatabaseByPath(databasePath, agentId);
  }
  const databasePaths = [...registeredDatabasePaths].filter((pathname) =>
    resolveSqliteDatabaseFilePaths(pathname).every(
      (filePath) =>
        !isPathOwnedBySurvivingAgent(
          cfg,
          agentId,
          filePath,
          survivingDatabaseFilePaths,
          options.env,
        ),
    ),
  );
  assertNoOpenClawAgentDatabaseLeases(agentId, options);
  const fileGroups = databasePaths.map(resolveSqliteDatabaseFilePaths);
  const relocatedFileGroups = fileGroups.filter((fileGroup) => {
    const relative = path.relative(agentDir, fileGroup[0] ?? agentDir);
    return relative.startsWith("..") || path.isAbsolute(relative);
  });
  return {
    registrationPaths: [...registeredDatabasePaths],
    fileGroups,
    relocatedFileGroups,
  };
}
