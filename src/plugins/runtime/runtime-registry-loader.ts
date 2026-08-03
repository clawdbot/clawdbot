// Runtime registry loader assembles process-root plugin runtimes from config metadata.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withActivatedPluginIds } from "../activation-context.js";
import {
  resolveChannelPluginIds,
  resolveConfiguredChannelPluginIds,
} from "../channel-plugin-ids.js";
import { resolveEffectivePluginIds } from "../effective-plugin-ids.js";
import { loadOpenClawPlugins } from "../loader.js";
import { hasNonEmptyPluginIdScope } from "../plugin-scope.js";
import {
  buildPluginRuntimeLoadOptionsFromValues,
  resolvePluginRuntimeLoadContext,
} from "./load-context.js";

export type PluginRegistryScope = "configured-channels" | "channels" | "all";

function resolveScopePluginIds(params: {
  scope: PluginRegistryScope;
  context: ReturnType<typeof resolvePluginRuntimeLoadContext>;
}): string[] {
  if (params.scope === "configured-channels") {
    return resolveConfiguredChannelPluginIds({
      config: params.context.config,
      activationSourceConfig: params.context.activationSourceConfig,
      workspaceDir: params.context.workspaceDir,
      env: params.context.env,
    });
  }
  if (params.scope === "channels") {
    return resolveChannelPluginIds({
      config: params.context.config,
      workspaceDir: params.context.workspaceDir,
      env: params.context.env,
    });
  }
  return resolveEffectivePluginIds({
    config: params.context.rawConfig,
    workspaceDir: params.context.workspaceDir,
    env: params.context.env,
  });
}

export function ensurePluginRegistryLoaded(options?: {
  scope?: PluginRegistryScope;
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
}): void {
  const scope = options?.scope ?? "all";
  const context = resolvePluginRuntimeLoadContext(options);
  const pluginIds = resolveScopePluginIds({ scope, context });
  const activateConfigured = scope === "configured-channels" && pluginIds.length > 0;
  const config = activateConfigured
    ? (withActivatedPluginIds({ config: context.config, pluginIds }) ?? context.config)
    : context.config;
  const activationSourceConfig = activateConfigured
    ? (withActivatedPluginIds({ config: context.activationSourceConfig, pluginIds }) ??
      context.activationSourceConfig)
    : context.activationSourceConfig;
  loadOpenClawPlugins(
    buildPluginRuntimeLoadOptionsFromValues(
      { ...context, config, activationSourceConfig },
      {
        throwOnLoadError: true,
        ...(scope === "configured-channels" ||
        scope === "all" ||
        hasNonEmptyPluginIdScope(pluginIds)
          ? { onlyPluginIds: pluginIds }
          : {}),
      },
    ),
  );
}
