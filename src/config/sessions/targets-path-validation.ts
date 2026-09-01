import fsSync from "node:fs";
import path from "node:path";
import { isValidAgentId, LEGACY_IMPLICIT_AGENT_ID } from "../../routing/session-key.js";
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
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && NON_FATAL_DISCOVERY_ERROR_CODES.has(code);
}

export function isWithinRoot(realPath: string, realRoot: string): boolean {
  return realPath === realRoot || realPath.startsWith(`${realRoot}${path.sep}`);
}

export function shouldSkipDiscoveredAgentDirName(dirName: string, agentId: string): boolean {
  return (
    !/[a-z0-9]/i.test(dirName) ||
    !isValidAgentId(agentId) ||
    (agentId === LEGACY_IMPLICIT_AGENT_ID && dirName.toLowerCase() !== LEGACY_IMPLICIT_AGENT_ID)
  );
}

export function resolveValidatedManagedFilePathSync(params: {
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
