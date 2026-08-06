// Root-help config probe for plugin-sensitive help rendering.
import type { RootHelpRenderOptions } from "./program/root-help.js";

function hasEntries(value: object | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

function hasListEntries(value: string[] | undefined): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** Load render options only when config/env can affect plugin help output. */
export async function loadRootHelpRenderOptionsForConfigSensitivePlugins(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RootHelpRenderOptions | null> {
  const configModule = await import("../config/config.js");
  const snapshot = await configModule.readConfigFileSnapshot({
    observe: false,
    skipPluginValidation: true,
  });
  if (!snapshot.valid) {
    return null;
  }
  const plugins = snapshot.sourceConfig.plugins;
  const configAffectsPluginHelp =
    plugins &&
    (plugins.enabled === false ||
      hasListEntries(plugins.allow) ||
      hasListEntries(plugins.deny) ||
      hasListEntries(plugins.load?.paths) ||
      hasEntries(plugins.slots) ||
      hasEntries(plugins.entries) ||
      hasEntries(plugins.installs));
  const envAffectsPluginHelp = Boolean(
    env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim() || env.OPENCLAW_DISABLE_BUNDLED_PLUGINS?.trim(),
  );
  if (!envAffectsPluginHelp && !configAffectsPluginHelp) {
    return null;
  }
  return {
    config: snapshot.runtimeConfig,
    env,
  };
}
