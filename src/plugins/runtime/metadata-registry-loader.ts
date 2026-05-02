import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadOpenClawPlugins } from "../loader.js";
import type { PluginManifestRegistry } from "../manifest-registry.js";
import { hasExplicitPluginIdScope } from "../plugin-scope.js";
import type { PluginRegistry } from "../registry.js";
import type { PluginLogger } from "../types.js";
import {
  buildPluginRuntimeLoadOptions,
  resolvePluginRuntimeLoadContext,
  type PluginRuntimeLoadContext,
} from "./load-context.js";

export function loadPluginMetadataRegistrySnapshot(options?: {
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
  workspaceDir?: string;
  onlyPluginIds?: string[];
  loadModules?: boolean;
  manifestRegistry?: PluginManifestRegistry;
  runtimeContext?: PluginRuntimeLoadContext;
}): PluginRegistry {
  const context = options?.runtimeContext ?? resolvePluginRuntimeLoadContext(options);

  return loadOpenClawPlugins(
    buildPluginRuntimeLoadOptions(context, {
      ...(options?.config !== undefined ? { config: options.config } : {}),
      ...(options?.activationSourceConfig !== undefined
        ? { activationSourceConfig: options.activationSourceConfig }
        : {}),
      ...(options?.workspaceDir !== undefined ? { workspaceDir: options.workspaceDir } : {}),
      ...(options?.env !== undefined ? { env: options.env } : {}),
      ...(options?.logger !== undefined ? { logger: options.logger } : {}),
      throwOnLoadError: true,
      cache: false,
      activate: false,
      mode: "validate",
      loadModules: options?.loadModules,
      ...(hasExplicitPluginIdScope(options?.onlyPluginIds)
        ? { onlyPluginIds: options?.onlyPluginIds }
        : {}),
      ...(options?.manifestRegistry ? { manifestRegistry: options.manifestRegistry } : {}),
    }),
  );
}
