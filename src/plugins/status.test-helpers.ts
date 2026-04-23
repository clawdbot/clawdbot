import type { PluginLoadResult } from "./loader.js";
import type { PluginRecord } from "./registry.js";
import type { PluginCompatibilityNotice, PluginStatusReport } from "./status.js";
import type { PluginHookName } from "./types.js";

export const LEGACY_BEFORE_AGENT_START_MESSAGE =
  "still uses legacy before_agent_start; keep regression coverage on this plugin, and prefer before_model_resolve/before_prompt_build for new work.";
export const HOOK_ONLY_MESSAGE =
  "is hook-only. This remains a supported compatibility path, but it has not migrated to explicit capability registration yet.";

export function createCompatibilityNotice(
  params: Pick<PluginCompatibilityNotice, "pluginId" | "code">,
): PluginCompatibilityNotice {
  if (params.code === "legacy-before-agent-start") {
    return {
      pluginId: params.pluginId,
      code: params.code,
      severity: "warn",
      message: LEGACY_BEFORE_AGENT_START_MESSAGE,
    };
  }

  return {
    pluginId: params.pluginId,
    code: params.code,
    severity: "info",
    message: HOOK_ONLY_MESSAGE,
  };
}

export function createPluginRecord(
  overrides: Partial<PluginRecord> & Pick<PluginRecord, "id">,
): PluginRecord {
  const { id, ...rest } = overrides;
  return {
    id,
    name: overrides.name ?? id,
    description: overrides.description ?? "",
    source: overrides.source ?? `/tmp/${id}/index.ts`,
    origin: overrides.origin ?? "workspace",
    enabled: overrides.enabled ?? true,
    explicitlyEnabled: overrides.explicitlyEnabled ?? overrides.enabled ?? true,
    activated: overrides.activated ?? overrides.enabled ?? true,
    activationSource:
      overrides.activationSource ?? ((overrides.enabled ?? true) ? "explicit" : "disabled"),
    activationReason: overrides.activationReason,
    status: overrides.status ?? "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    cliBackendIds: [],
    providerIds: [],
    speechProviderIds: [],
    realtimeTranscriptionProviderIds: [],
    realtimeVoiceProviderIds: [],
    mediaUnderstandingProviderIds: [],
    imageGenerationProviderIds: [],
    videoGenerationProviderIds: [],
    musicGenerationProviderIds: [],
    webFetchProviderIds: [],
    webSearchProviderIds: [],
    contextEngineIds: [],
    memoryEmbeddingProviderIds: [],
    agentHarnessIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: false,
    ...rest,
  };
}

export function createTypedHook(params: {
  pluginId: string;
  hookName: PluginHookName;
  source?: string;
}): PluginLoadResult["typedHooks"][number] {
  return {
    pluginId: params.pluginId,
    hookName: params.hookName,
    handler: () => undefined,
    source: params.source ?? `/tmp/${params.pluginId}/index.ts`,
  };
}

export function createCustomHook(params: {
  pluginId: string;
  events: string[];
  name?: string;
}): PluginLoadResult["hooks"][number] {
  const source = `/tmp/${params.pluginId}/handler.ts`;
  return {
    pluginId: params.pluginId,
    events: params.events,
    source,
    entry: {
      hook: {
        name: params.name ?? "legacy",
        description: "",
        source: "openclaw-plugin",
        pluginId: params.pluginId,
        filePath: `/tmp/${params.pluginId}/HOOK.md`,
        baseDir: `/tmp/${params.pluginId}`,
        handlerPath: source,
      },
      frontmatter: {},
    },
  };
}

export function createPluginLoadResult(
  overrides: Partial<PluginLoadResult> & Pick<PluginLoadResult, "plugins"> = { plugins: [] },
): PluginLoadResult {
  const { plugins, realtimeTranscriptionProviders, realtimeVoiceProviders, ...rest } = overrides;
  return {
    plugins,
    diagnostics: [],
    channels: [],
    channelSetups: [],
    providers: [],
    speechProviders: [],
    mediaUnderstandingProviders: [],
    imageGenerationProviders: [],
    videoGenerationProviders: [],
    musicGenerationProviders: [],
    webFetchProviders: [],
    webSearchProviders: [],
    embeddedExtensionFactories: [],
    codexAppServerExtensionFactories: [],
    memoryEmbeddingProviders: [],
    textTransforms: [],
    agentHarnesses: [],
    tools: [],
    hooks: [],
    typedHooks: [],
    httpRoutes: [],
    gatewayHandlers: {},
    cliRegistrars: [],
    services: [],
    commands: [],
    conversationBindingResolvedHandlers: [],
    ...rest,
    realtimeTranscriptionProviders: realtimeTranscriptionProviders ?? [],
    realtimeVoiceProviders: realtimeVoiceProviders ?? [],
  };
}

export function createPluginStatusReport(
  overrides: Partial<PluginStatusReport> & Pick<PluginStatusReport, "plugins">,
): PluginStatusReport {
  const { workspaceDir, ...loadResultOverrides } = overrides;
  return {
    workspaceDir,
    ...createPluginLoadResult(loadResultOverrides),
  };
}
