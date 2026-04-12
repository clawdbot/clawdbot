import { normalizeProviderId } from "../agents/provider-id.js";
import type { OpenClawConfig } from "../config/types.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { loadPluginManifestRegistry, type PluginManifestRecord } from "./manifest-registry.js";
import type { PluginManifestActivationCapability } from "./manifest.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { createPluginIdScopeSet, normalizePluginIdScope } from "./plugin-scope.js";

export type PluginActivationPlannerTrigger =
  | { kind: "command"; command: string }
  | { kind: "provider"; provider: string }
  | { kind: "channel"; channel: string }
  | { kind: "route"; route: string }
  | { kind: "capability"; capability: PluginManifestActivationCapability };

export function resolveManifestActivationPluginIds(params: {
  trigger: PluginActivationPlannerTrigger;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  cache?: boolean;
  origin?: PluginOrigin;
  onlyPluginIds?: readonly string[];
}): string[] {
  const onlyPluginIdSet = createPluginIdScopeSet(normalizePluginIdScope(params.onlyPluginIds));

  return [
    ...new Set(
      loadPluginManifestRegistry({
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        cache: params.cache,
      })
        .plugins.filter(
          (plugin) =>
            (!params.origin || plugin.origin === params.origin) &&
            (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)) &&
            matchesManifestActivationTrigger(plugin, params.trigger),
        )
        .map((plugin) => plugin.id),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

function matchesManifestActivationTrigger(
  plugin: PluginManifestRecord,
  trigger: PluginActivationPlannerTrigger,
): boolean {
  switch (trigger.kind) {
    case "command":
      return listActivationCommandIds(plugin).includes(normalizeCommandId(trigger.command));
    case "provider":
      return listActivationProviderIds(plugin).includes(normalizeProviderId(trigger.provider));
    case "channel":
      return listActivationChannelIds(plugin).includes(normalizeCommandId(trigger.channel));
    case "route":
      return listActivationRouteIds(plugin).includes(normalizeCommandId(trigger.route));
    case "capability":
      return hasActivationCapability(plugin, trigger.capability);
  }
  const unreachableTrigger: never = trigger;
  return unreachableTrigger;
}

function listActivationCommandIds(plugin: PluginManifestRecord): string[] {
  return [
    ...(plugin.activation?.onCommands ?? []),
    ...(plugin.commandAliases ?? []).flatMap((alias) => alias.cliCommand ?? alias.name),
  ]
    .map(normalizeCommandId)
    .filter(Boolean);
}

function listActivationProviderIds(plugin: PluginManifestRecord): string[] {
  return [
    ...(plugin.activation?.onProviders ?? []),
    ...plugin.providers,
    ...(plugin.setup?.providers?.map((provider) => provider.id) ?? []),
  ]
    .map((value) => normalizeProviderId(value))
    .filter(Boolean);
}

function listActivationChannelIds(plugin: PluginManifestRecord): string[] {
  return [...(plugin.activation?.onChannels ?? []), ...plugin.channels]
    .map(normalizeCommandId)
    .filter(Boolean);
}

function listActivationRouteIds(plugin: PluginManifestRecord): string[] {
  return (plugin.activation?.onRoutes ?? []).map(normalizeCommandId).filter(Boolean);
}

function hasActivationCapability(
  plugin: PluginManifestRecord,
  capability: PluginManifestActivationCapability,
): boolean {
  if (plugin.activation?.onCapabilities?.includes(capability)) {
    return true;
  }
  switch (capability) {
    case "provider":
      return listActivationProviderIds(plugin).length > 0;
    case "channel":
      return listActivationChannelIds(plugin).length > 0;
    case "tool":
      return (plugin.contracts?.tools?.length ?? 0) > 0;
    case "hook":
      return plugin.hooks.length > 0;
  }
  const unreachableCapability: never = capability;
  return unreachableCapability;
}

function normalizeCommandId(value: string | undefined): string {
  return normalizeOptionalLowercaseString(value) ?? "";
}
