import type { CodexPluginConfig, CodexRuntimeProfile } from "./app-server/config-contracts.js";

/**
 * Keeps the default Codex registration narrow. Full exposes the operator and
 * supervision surfaces that are useful for advanced integrations, but are not
 * required for ordinary coding turns.
 */
export function resolveCodexRuntimeProfile(config: CodexPluginConfig): CodexRuntimeProfile {
  if (config.runtimeProfile) {
    return config.runtimeProfile;
  }
  // Existing configs that mention an advanced surface keep their historical
  // behavior. New/unconfigured installs get the lean default.
  if (
    config.sessionCatalog !== undefined ||
    config.supervision !== undefined ||
    config.appServer?.homeScope === "user"
  ) {
    return "full";
  }
  return "lean";
}

export function isCodexFullRuntime(config: CodexPluginConfig): boolean {
  return resolveCodexRuntimeProfile(config) === "full";
}
