import fsSync from "node:fs";
import path from "node:path";
import { hasErrnoCode, isErrno } from "../../infra/errno.js";
import { isValidAgentId, LEGACY_IMPLICIT_AGENT_ID } from "../../routing/session-key.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import type { SessionStoreTarget } from "./targets-collision.js";

const NON_FATAL_DISCOVERY_ERROR_CODES = new Set([
  "EACCES",
  "ELOOP",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
  "ESTALE",
]);

export function dedupeTargetsByStorePath(targets: SessionStoreTarget[]): SessionStoreTarget[] {
  const deduped = new Map<string, SessionStoreTarget>();
  for (const target of targets) {
    if (!deduped.has(target.storePath)) {
      deduped.set(target.storePath, target);
    }
  }
  return [...deduped.values()];
}

export function shouldSkipDiscoveryError(err: unknown): boolean {
  const code = isErrno(err) ? err.code : undefined;
  return typeof code === "string" && NON_FATAL_DISCOVERY_ERROR_CODES.has(code);
}

export function createRealAgentsRootResolver(): (agentsRoot: string) => string | undefined {
  // Freeze successes and skippable failures for one discovery pass; each caller gets a fresh cache.
  const realAgentsRoots = new Map<string, string | undefined>();
  return (agentsRoot) => {
    if (realAgentsRoots.has(agentsRoot)) {
      return realAgentsRoots.get(agentsRoot);
    }
    try {
      const realAgentsRoot = fsSync.realpathSync.native(agentsRoot);
      realAgentsRoots.set(agentsRoot, realAgentsRoot);
      return realAgentsRoot;
    } catch (err) {
      if (shouldSkipDiscoveryError(err)) {
        realAgentsRoots.set(agentsRoot, undefined);
        return undefined;
      }
      throw err;
    }
  };
}

function isWithinRoot(realPath: string, realRoot: string): boolean {
  return realPath === realRoot || realPath.startsWith(`${realRoot}${path.sep}`);
}

export function shouldSkipDiscoveredAgentDirName(dirName: string, agentId: string): boolean {
  return (
    !/[a-z0-9]/i.test(dirName) ||
    !isValidAgentId(agentId) ||
    (agentId === LEGACY_IMPLICIT_AGENT_ID && dirName.toLowerCase() !== LEGACY_IMPLICIT_AGENT_ID)
  );
}

function resolveValidatedManagedFilePathSync(params: {
  agentsRoot: string;
  filePath: string;
  realAgentsRoot?: string;
}): string | undefined {
  try {
    const stat = fsSync.lstatSync(params.filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return undefined;
    }
    const realFilePath = fsSync.realpathSync.native(params.filePath);
    const realAgentsRoot = params.realAgentsRoot ?? fsSync.realpathSync.native(params.agentsRoot);
    return isWithinRoot(realFilePath, realAgentsRoot) ? params.filePath : undefined;
  } catch (err) {
    if (shouldSkipDiscoveryError(err)) {
      return undefined;
    }
    throw err;
  }
}

export function resolveValidatedDiscoveredStorePathSync(params: {
  sessionsDir: string;
  agentsRoot: string;
  realAgentsRoot?: string;
  sqliteOnly?: boolean;
}): string | undefined {
  const storePath = path.join(params.sessionsDir, "sessions.json");
  if (!params.sqliteOnly) {
    const validatedStorePath = resolveValidatedManagedFilePathSync({
      agentsRoot: params.agentsRoot,
      filePath: storePath,
      realAgentsRoot: params.realAgentsRoot,
    });
    if (validatedStorePath) {
      return validatedStorePath;
    }
  }
  const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath).path;
  if (!sqlitePath) {
    return undefined;
  }
  return resolveValidatedManagedFilePathSync({
    agentsRoot: params.agentsRoot,
    filePath: sqlitePath,
    realAgentsRoot: params.realAgentsRoot,
  })
    ? storePath
    : undefined;
}

export function isValidatedRecoveryCandidateSessionsDir(params: {
  allowMissingAgentDir?: boolean;
  realAgentsRoot: string;
  sessionsDir: string;
}): boolean {
  const agentDir = path.dirname(params.sessionsDir);
  try {
    const agentStat = fsSync.lstatSync(agentDir);
    if (agentStat.isSymbolicLink() || !agentStat.isDirectory()) {
      return false;
    }
    if (!isWithinRoot(fsSync.realpathSync.native(agentDir), params.realAgentsRoot)) {
      return false;
    }
    try {
      const sessionsStat = fsSync.lstatSync(params.sessionsDir);
      return (
        !sessionsStat.isSymbolicLink() &&
        sessionsStat.isDirectory() &&
        isWithinRoot(fsSync.realpathSync.native(params.sessionsDir), params.realAgentsRoot)
      );
    } catch (err) {
      return hasErrnoCode(err, "ENOENT");
    }
  } catch (err) {
    if (hasErrnoCode(err, "ENOENT")) {
      return params.allowMissingAgentDir === true;
    }
    if (shouldSkipDiscoveryError(err)) {
      return false;
    }
    throw err;
  }
}
