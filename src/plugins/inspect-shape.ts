// Inspects plugin registry shape for diagnostics and snapshots.
import type { PluginRegistry } from "./registry.js";
import { hasKind } from "./slots.js";

export type PluginCapabilityKind = ReturnType<typeof buildPluginCapabilityEntries>[number]["kind"];

export type PluginInspectShape =
  | "hook-only"
  | "plain-capability"
  | "hybrid-capability"
  | "non-capability";

export type PluginCapabilityEntry = {
  kind: PluginCapabilityKind;
  ids: string[];
};

type PluginShapeSummary = {
  shape: PluginInspectShape;
  capabilityMode: "none" | "plain" | "hybrid";
  capabilityCount: number;
  capabilities: PluginCapabilityEntry[];
};

function buildPluginCapabilityEntries(
  plugin: PluginRegistry["plugins"][number],
  report: Pick<PluginRegistry, "sessionCatalogs">,
) {
  return [
    { kind: "cli-backend" as const, ids: plugin.cliBackendIds ?? [] },
    { kind: "text-inference" as const, ids: plugin.providerIds },
    { kind: "embedding" as const, ids: plugin.embeddingProviderIds },
    { kind: "speech" as const, ids: plugin.speechProviderIds },
    { kind: "realtime-transcription" as const, ids: plugin.realtimeTranscriptionProviderIds },
    { kind: "realtime-voice" as const, ids: plugin.realtimeVoiceProviderIds },
    { kind: "media-understanding" as const, ids: plugin.mediaUnderstandingProviderIds },
    { kind: "transcript-source" as const, ids: plugin.transcriptSourceProviderIds },
    { kind: "document-extractors" as const, ids: plugin.contracts?.documentExtractors ?? [] },
    { kind: "image-generation" as const, ids: plugin.imageGenerationProviderIds },
    { kind: "video-generation" as const, ids: plugin.videoGenerationProviderIds },
    { kind: "music-generation" as const, ids: plugin.musicGenerationProviderIds },
    { kind: "web-content-extractors" as const, ids: plugin.contracts?.webContentExtractors ?? [] },
    { kind: "web-fetch" as const, ids: plugin.webFetchProviderIds },
    { kind: "web-search" as const, ids: plugin.webSearchProviderIds },
    { kind: "migration-provider" as const, ids: plugin.migrationProviderIds },
    { kind: "worker-provider" as const, ids: plugin.contracts?.workerProviders ?? [] },
    {
      kind: "session-catalog" as const,
      ids: report.sessionCatalogs
        .filter((entry) => entry.pluginId === plugin.id)
        .map((entry) => entry.provider.id),
    },
    { kind: "agent-harness" as const, ids: plugin.agentHarnessIds },
    {
      kind: "context-engine" as const,
      ids:
        plugin.status === "loaded" && hasKind(plugin.kind, "context-engine")
          ? (plugin.contextEngineIds ?? [])
          : [],
    },
    { kind: "channel" as const, ids: plugin.channelIds },
    { kind: "gateway-discovery" as const, ids: plugin.gatewayDiscoveryServiceIds },
  ].filter((entry) => entry.ids.length > 0);
}

function derivePluginInspectShape(params: {
  capabilityCount: number;
  typedHookCount: number;
  customHookCount: number;
  toolCount: number;
  commandCount: number;
  cliCount: number;
  serviceCount: number;
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
    params.gatewayMethodCount === 0 &&
    params.httpRouteCount === 0;
  if (hasOnlyHooks) {
    return "hook-only";
  }
  return "non-capability";
}

export function buildPluginShapeSummary(params: {
  plugin: PluginRegistry["plugins"][number];
  report: Pick<
    PluginRegistry,
    "hooks" | "typedHooks" | "tools" | "gatewayMethodDescriptors" | "sessionCatalogs"
  >;
}): PluginShapeSummary {
  const capabilities = buildPluginCapabilityEntries(params.plugin, params.report);
  const typedHookCount = params.report.typedHooks.filter(
    (entry) => entry.pluginId === params.plugin.id,
  ).length;
  const customHookCount = params.report.hooks.filter(
    (entry) => entry.pluginId === params.plugin.id,
  ).length;
  const toolCount = params.report.tools.filter(
    (entry) => entry.pluginId === params.plugin.id,
  ).length;
  const gatewayMethodCount = (params.report.gatewayMethodDescriptors ?? []).filter(
    (descriptor) =>
      descriptor.owner.kind === "plugin" && descriptor.owner.pluginId === params.plugin.id,
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
    gatewayMethodCount,
    httpRouteCount: params.plugin.httpRoutes,
  });

  return {
    shape,
    capabilityMode: capabilityCount === 0 ? "none" : capabilityCount === 1 ? "plain" : "hybrid",
    capabilityCount,
    capabilities,
  };
}
