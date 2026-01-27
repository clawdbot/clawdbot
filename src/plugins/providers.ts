import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadMoltbotPlugins, type PluginLoadOptions } from "./loader.js";
import type { ProviderPlugin } from "./types.js";

const log = createSubsystemLogger("plugins");

export function resolvePluginProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
}): ProviderPlugin[] {
  const registry = loadMoltbotPlugins({
    config: params.config,
    workspaceDir: params.workspaceDir,
    logger: {
      info: (msg) => log.info(msg),
      warn: (msg) => log.warn(msg),
      error: (msg) => log.error(msg),
      debug: (msg) => log.debug(msg),
    },
  });

  return registry.providers.map((entry) => entry.provider);
}
