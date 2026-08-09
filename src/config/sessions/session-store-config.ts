import { resolveStorePath } from "./paths.js";

export function isPerAgentSessionStoreConfig(storeConfig: string | undefined): boolean {
  return !storeConfig?.trim() || storeConfig.includes("{agentId}");
}

export function isSameFixedSessionStoreConfig(
  source: string | undefined,
  target: string | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  return (
    !isPerAgentSessionStoreConfig(source) &&
    !isPerAgentSessionStoreConfig(target) &&
    resolveStorePath(source, { env }) === resolveStorePath(target, { env })
  );
}
