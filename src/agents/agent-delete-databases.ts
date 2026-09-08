import path from "node:path";
import { resolveSessionStoreCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { assertNoOpenClawAgentDatabaseLeases } from "../state/openclaw-agent-db-lease.js";
import { invalidateRegisteredAgentDatabasesMemo } from "../state/openclaw-agent-db-registry-listing.js";
import {
  closeOpenClawAgentDatabaseByPath,
  inspectOpenClawAgentDatabaseOwner,
  listOpenClawRegisteredAgentDatabases,
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { findOverlappingWorkspaceAgentIds } from "./agent-delete-safety.js";
import {
  isPathOwnedByAnotherRegisteredAgent,
  normalizeAgentDirRegistryPath,
} from "./agent-dir-registry.js";
import { listAgentIds } from "./agent-scope.js";

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

export class AgentSharedStoreOwnerError extends Error {}

/** Check before journaling: retaining the file alone would still fence its shared owner. */
export function assertAgentSessionStoreDeletionSafe(
  cfg: OpenClawConfig,
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  if (!cfg.session?.store?.trim()) {
    return;
  }
  const id = normalizeAgentId(agentId);
  const defaultAgentId = resolveSessionStoreCompatibilityAgentId(cfg);
  const registeredDatabases = readAgentDeleteDatabaseRegistry(options);
  for (const survivorId of listAgentIds(cfg)) {
    if (normalizeAgentId(survivorId) === id) {
      continue;
    }
    const storePath = resolveSessionStorePathCore(cfg.session.store, {
      agentId: survivorId,
      env: options.env,
    });
    const target = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: survivorId,
      defaultAgentId,
      env: options.env,
      registeredDatabases,
    });
    const owner = inspectOpenClawAgentDatabaseOwner(target.path);
    if (owner.status === "owned" && owner.agentId === id) {
      throw new AgentSharedStoreOwnerError(
        `Agent "${id}" owns the session database still used by agent "${survivorId}" and cannot be deleted. Keep this owner configured until shared history can be moved with a supported migration; no such migration is currently available.`,
      );
    }
  }
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
  // Incognito has no registry row or files, but retained statements must also be retired.
  closeOpenClawAgentDatabaseByPath(
    resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: options.env }),
    agentId,
  );
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
