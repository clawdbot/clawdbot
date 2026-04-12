import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadOpenClawPlugins } from "../loader.js";
import { hasExplicitPluginIdScope } from "../plugin-scope.js";
import type { PluginRegistry } from "../registry.js";
import { buildPluginRuntimeLoadOptions, resolvePluginRuntimeLoadContext } from "./load-context.js";

export function loadPluginMetadataRegistrySnapshot(options?: {
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  onlyPluginIds?: string[];
  loadModules?: boolean;
}): PluginRegistry {
  const context = resolvePluginRuntimeLoadContext(options);

  return loadOpenClawPlugins(
    buildPluginRuntimeLoadOptions(context, {
      throwOnLoadError: true,
      cache: false,
      activate: false,
      mode: "validate",
      loadModules: options?.loadModules,
      ...(hasExplicitPluginIdScope(options?.onlyPluginIds)
        ? { onlyPluginIds: options?.onlyPluginIds }
        : {}),
    }),
  );
}
