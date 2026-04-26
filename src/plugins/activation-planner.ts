import { normalizeProviderId } from "../agents/provider-id.js";
import type { OpenClawConfig } from "../config/types.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import type { PluginManifestActivationCapability } from "./manifest.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";
import { createPluginIdScopeSet, normalizePluginIdScope } from "./plugin-scope.js";

export type PluginActivationPlannerTrigger =
  | { kind: "command"; command: string }
  | { kind: "provider"; provider: string }
  | { kind: "agentHarness"; runtime: string }
  | { kind: "channel"; channel: string }
  | { kind: "route"; route: string }
  | { kind: "capability"; capability: PluginManifestActivationCapability };

export type PluginActivationPlannerHintReason =
  | "activation-agent-harness-hint"
  | "activation-capability-hint"
  | "activation-channel-hint"
  | "activation-command-hint"
  | "activation-provider-hint"
  | "activation-route-hint";

export type PluginActivationPlannerManifestReason =
  | "manifest-channel-owner"
  | "manifest-command-alias"
  | "manifest-hook-owner"
  | "manifest-provider-owner"
  | "manifest-setup-provider-owner"
  | "manifest-tool-contract";

export type PluginActivationPlannerReason =
  | PluginActivationPlannerHintReason
  | PluginActivationPlannerManifestReason;

export type PluginActivationPlanEntry = {
  pluginId: string;
  origin: PluginOrigin;
  reasons: readonly PluginActivationPlannerReason[];
};

export type PluginActivationPlan = {
  trigger: PluginActivationPlannerTrigger;
  pluginIds: readonly string[];
  entries: readonly PluginActivationPlanEntry[];
  diagnostics: readonly PluginDiagnostic[];
};

type ResolveManifestActivationPlanParams = {
  trigger: PluginActivationPlannerTrigger;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  cache?: boolean;
  origin?: PluginOrigin;
  onlyPluginIds?: readonly string[];
  manifestRecords?: readonly PluginManifestRecord[];
};

export function resolveManifestActivationPlan(
  params: ResolveManifestActivationPlanParams,
): PluginActivationPlan {
  const onlyPluginIdSet = createPluginIdScopeSet(normalizePluginIdScope(params.onlyPluginIds));
  const registry = params.manifestRecords
    ? { plugins: params.manifestRecords, diagnostics: [] }
    : loadPluginManifestRegistryForPluginRegistry({
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        cache: params.cache,
        includeDisabled: true,
      });
  const entries = registry.plugins
    .flatMap((plugin) => {
      if (params.origin && plugin.origin !== params.origin) {
        return [];
      }
      if (onlyPluginIdSet && !onlyPluginIdSet.has(plugin.id)) {
        return [];
      }
      const reasons = listManifestActivationTriggerReasons(plugin, params.trigger);
      if (reasons.length === 0) {
        return [];
      }
      return [
        {
          pluginId: plugin.id,
          origin: plugin.origin,
          reasons,
        } satisfies PluginActivationPlanEntry,
      ];
    })
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));

  return {
    trigger: params.trigger,
    pluginIds: [...new Set(entries.map((entry) => entry.pluginId))],
    entries,
    diagnostics: registry.diagnostics,
  };
}

export function resolveManifestActivationPluginIds(
  params: ResolveManifestActivationPlanParams,
): string[] {
  return [...resolveManifestActivationPlan(params).pluginIds];
}

function listManifestActivationTriggerReasons(
  plugin: PluginManifestRecord,
  trigger: PluginActivationPlannerTrigger,
): PluginActivationPlannerReason[] {
  switch (trigger.kind) {
    case "command":
      return listCommandTriggerReasons(plugin, normalizeCommandId(trigger.command));
    case "provider":
      return listProviderTriggerReasons(plugin, normalizeProviderId(trigger.provider));
    case "agentHarness":
      return listAgentHarnessTriggerReasons(plugin, normalizeCommandId(trigger.runtime));
    case "channel":
      return listChannelTriggerReasons(plugin, normalizeCommandId(trigger.channel));
    case "route":
      return listRouteTriggerReasons(plugin, normalizeCommandId(trigger.route));
    case "capability":
      return listCapabilityTriggerReasons(plugin, trigger.capability);
  }
  const unreachableTrigger: never = trigger;
  return unreachableTrigger;
}

function listAgentHarnessTriggerReasons(
  plugin: PluginManifestRecord,
  runtime: string,
): PluginActivationPlannerReason[] {
  return listHasNormalizedValue(plugin.activation?.onAgentHarnesses, runtime, normalizeCommandId)
    ? ["activation-agent-harness-hint"]
    : [];
}

function listCommandTriggerReasons(
  plugin: PluginManifestRecord,
  command: string,
): PluginActivationPlannerReason[] {
  return dedupeReasons([
    listHasNormalizedValue(plugin.activation?.onCommands, command, normalizeCommandId)
      ? "activation-command-hint"
      : null,
    listHasNormalizedValue(
      (plugin.commandAliases ?? []).flatMap((alias) => alias.cliCommand ?? alias.name),
      command,
      normalizeCommandId,
    )
      ? "manifest-command-alias"
      : null,
  ]);
}

function listProviderTriggerReasons(
  plugin: PluginManifestRecord,
  provider: string,
): PluginActivationPlannerReason[] {
  return dedupeReasons([
    listHasNormalizedValue(plugin.activation?.onProviders, provider, normalizeProviderId)
      ? "activation-provider-hint"
      : null,
    listHasNormalizedValue(plugin.providers, provider, normalizeProviderId)
      ? "manifest-provider-owner"
      : null,
    listHasNormalizedValue(
      plugin.setup?.providers?.map((setupProvider) => setupProvider.id),
      provider,
      normalizeProviderId,
    )
      ? "manifest-setup-provider-owner"
      : null,
  ]);
}

function listChannelTriggerReasons(
  plugin: PluginManifestRecord,
  channel: string,
): PluginActivationPlannerReason[] {
  return dedupeReasons([
    listHasNormalizedValue(plugin.activation?.onChannels, channel, normalizeCommandId)
      ? "activation-channel-hint"
      : null,
    listHasNormalizedValue(plugin.channels, channel, normalizeCommandId)
      ? "manifest-channel-owner"
      : null,
  ]);
}

function listRouteTriggerReasons(
  plugin: PluginManifestRecord,
  route: string,
): PluginActivationPlannerReason[] {
  return listHasNormalizedValue(plugin.activation?.onRoutes, route, normalizeCommandId)
    ? ["activation-route-hint"]
    : [];
}

function listCapabilityTriggerReasons(
  plugin: PluginManifestRecord,
  capability: PluginManifestActivationCapability,
): PluginActivationPlannerReason[] {
  switch (capability) {
    case "provider":
      return dedupeReasons([
        plugin.activation?.onCapabilities?.includes(capability)
          ? "activation-capability-hint"
          : null,
        hasValues(plugin.activation?.onProviders) ? "activation-provider-hint" : null,
        hasValues(plugin.providers) ? "manifest-provider-owner" : null,
        hasValues(plugin.setup?.providers) ? "manifest-setup-provider-owner" : null,
      ]);
    case "channel":
      return dedupeReasons([
        plugin.activation?.onCapabilities?.includes(capability)
          ? "activation-capability-hint"
          : null,
        hasValues(plugin.activation?.onChannels) ? "activation-channel-hint" : null,
        hasValues(plugin.channels) ? "manifest-channel-owner" : null,
      ]);
    case "tool":
      return dedupeReasons([
        plugin.activation?.onCapabilities?.includes(capability)
          ? "activation-capability-hint"
          : null,
        hasValues(plugin.contracts?.tools) ? "manifest-tool-contract" : null,
      ]);
    case "hook":
      return dedupeReasons([
        plugin.activation?.onCapabilities?.includes(capability)
          ? "activation-capability-hint"
          : null,
        hasValues(plugin.hooks) ? "manifest-hook-owner" : null,
      ]);
  }
  const unreachableCapability: never = capability;
  return unreachableCapability;
}

function listHasNormalizedValue(
  values: readonly string[] | undefined,
  expected: string,
  normalize: (value: string) => string,
): boolean {
  return values?.some((value) => normalize(value) === expected) ?? false;
}

function hasValues(values: readonly unknown[] | undefined): boolean {
  return (values?.length ?? 0) > 0;
}

function dedupeReasons(
  reasons: readonly (PluginActivationPlannerReason | null)[],
): PluginActivationPlannerReason[] {
  return [
    ...new Set(reasons.filter((reason): reason is PluginActivationPlannerReason => !!reason)),
  ];
}

function normalizeCommandId(value: string | undefined): string {
  return normalizeOptionalLowercaseString(value) ?? "";
}
