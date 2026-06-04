/**
 * Runtime-only owner display secret retention for config IO.
 * Generated secrets stay in memory by config path and are never written back into config files.
 */
import type { OpenClawConfig } from "./types.openclaw.js";

/** Runtime-only owner display secrets keyed by config path during config IO. */
export type OwnerDisplaySecretRuntimeState = {
  pendingByPath: Map<string, string>;
};

/** Retains generated owner display secrets in memory without persisting them into config. */
export function retainGeneratedOwnerDisplaySecret(params: {
  config: OpenClawConfig;
  configPath: string;
  generatedSecret?: string;
  state: OwnerDisplaySecretRuntimeState;
}): OpenClawConfig {
  const { config, configPath, generatedSecret, state } = params;
  if (!generatedSecret) {
    // Clear stale pending secrets once the config load no longer generated one for this path.
    state.pendingByPath.delete(configPath);
    return config;
  }

  // Keep the generated secret available to runtime callers while preserving config object identity
  // and avoiding a write of the secret back to disk.
  state.pendingByPath.set(configPath, generatedSecret);
  return config;
}
