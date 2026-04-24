import type { PluginRegistry } from "./registry.js";
import { hasKind } from "./slots.js";

export type PluginCapabilityKind =
  | "cli-backend"
  | "text-inference"
  | "speech"
  | "realtime-transcription"
  | "realtime-voice"
  | "media-understanding"
  | "image-generation"
  | "web-search"
  | "agent-harness"
  | "context-engine"
  | "channel";

export type PluginInspectShape =
  | "hook-only"
  | "plain-capability"
  | "hybrid-capability"
  | "non-capability";

export type PluginCapabilityEntry = {
  kind: PluginCapabilityKind;
  ids: string[];
};

export type PluginShapeSummary = {
  shape: PluginInspectShape;
  capabilityMode: "none" | "plain" | "hybrid";
  capabilityCount: number;
  capabilities: PluginCapabilityEntry[];
  usesLegacyBeforeAgentStart: boolean;
};

export function buildPluginCapabilityEntries(
  plugin: PluginRegistry["plugins"][number],
): PluginCapabilityEntry[] {
  return [
    { kind: "cli-backend" as const, ids: plugin.cliBackendIds ?? [] },
    { kind: "text-inference" as const, ids: plugin.providerIds },
    { kind: "speech" as const, ids: plugin.speechProviderIds },
    { kind: "realtime-transcription" as const, ids: plugin.realtimeTranscriptionProviderIds },
    { kind: "realtime-voice" as const, ids: plugin.realtimeVoiceProviderIds },
    { kind: "media-understanding" as const, ids: plugin.mediaUnderstandingProviderIds },
    { kind: "image-generation" as const, ids: plugin.imageGenerationProviderIds },
    { kind: "web-search" as const, ids: plugin.webSearchProviderIds },
    { kind: "agent-harness" as const, ids: plugin.agentHarnessIds },
    {
      kind: "context-engine" as const,
      ids:
        plugin.status === "loaded" && hasKind(plugin.kind, "context-engine")
          ? (plugin.contextEngineIds ?? [])
          : [],
    },
    { kind: "channel" as const, ids: plugin.channelIds },
  ].filter((entry) => entry.ids.length > 0);
}

export function derivePluginInspectShape(params: {
  capabilityCount: number;
  typedHookCount: number;
  customHookCount: number;
  toolCount: number;
  commandCount: number;
  cliCount: number;
  serviceCount: number;
  gatewayDiscoveryServiceCount: number;
  gatewayMethodCount: number;
  httpRouteCount: number;
}): PluginInspectShape {
  if (params.capabilityCount > 1) {
    return "hybrid-capability";
  }
  if (params.capabilityCount === 1) {
    return "plain-capability";
  }
  const hasOnlyHooks =
    params.typedHookCount + params.customHookCount > 0 &&
    params.toolCount === 0 &&
    params.commandCount === 0 &&
    params.cliCount === 0 &&
    params.serviceCount === 0 &&
    params.gatewayDiscoveryServiceCount === 0 &&
    params.gatewayMethodCount === 0 &&
    params.httpRouteCount === 0;
  if (hasOnlyHooks) {
    return "hook-only";
  }
  return "non-capability";
}

export function buildPluginShapeSummary(params: {
  plugin: PluginRegistry["plugins"][number];
  report: Pick<PluginRegistry, "hooks" | "typedHooks" | "tools">;
}): PluginShapeSummary {
  const capabilities = buildPluginCapabilityEntries(params.plugin);
  const typedHookCount = params.report.typedHooks.filter(
    (entry) => entry.pluginId === params.plugin.id,
  ).length;
  const customHookCount = params.report.hooks.filter(
    (entry) => entry.pluginId === params.plugin.id,
  ).length;
  const toolCount = params.report.tools.filter(
    (entry) => entry.pluginId === params.plugin.id,
  ).length;
  const capabilityCount = capabilities.length;
  const shape = derivePluginInspectShape({
    capabilityCount,
    typedHookCount,
    customHookCount,
    toolCount,
    commandCount: params.plugin.commands.length,
    cliCount: params.plugin.cliCommands.length,
    serviceCount: params.plugin.services.length,
    gatewayDiscoveryServiceCount: params.plugin.gatewayDiscoveryServiceIds.length,
    gatewayMethodCount: params.plugin.gatewayMethods.length,
    httpRouteCount: params.plugin.httpRoutes,
  });

  return {
    shape,
    capabilityMode: capabilityCount === 0 ? "none" : capabilityCount === 1 ? "plain" : "hybrid",
    capabilityCount,
    capabilities,
    usesLegacyBeforeAgentStart: params.report.typedHooks.some(
      (entry) => entry.pluginId === params.plugin.id && entry.hookName === "before_agent_start",
    ),
  };
}
