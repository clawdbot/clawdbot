import fs from "node:fs";
import path from "node:path";
import { sameFileIdentity } from "../../infra/fs-safe-advanced.js";
import { resolveStorePath } from "./paths.js";

export function isPerAgentSessionStoreConfig(storeConfig: string | undefined): boolean {
  return !storeConfig?.trim() || storeConfig.includes("{agentId}");
}

export function isSameFixedSessionStoreConfig(
  source: string | undefined,
  target: string | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  if (isPerAgentSessionStoreConfig(source) || isPerAgentSessionStoreConfig(target)) {
    return false;
  }
  const sourcePath = path.resolve(resolveStorePath(source, { env }));
  const targetPath = path.resolve(resolveStorePath(target, { env }));
  if (sourcePath === targetPath) {
    return true;
  }
  try {
    return sameFileIdentity(
      fs.statSync(sourcePath, { bigint: true }),
      fs.statSync(targetPath, { bigint: true }),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}
