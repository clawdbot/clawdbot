import type {
  ChannelCapabilities,
  ChannelId,
  ChannelMessagingAdapter,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../channels/plugins/types.public.js";
import type { PluginRegistry } from "../plugins/registry.js";

export type TestChannelRegistration = {
  pluginId: string;
  plugin: unknown;
  source: string;
};

export const createTestRegistry = (channels: TestChannelRegistration[] = []): PluginRegistry => ({
  plugins: [],
  tools: [],
  hooks: [],
  typedHooks: [],
  channels: channels as unknown as PluginRegistry["channels"],
  channelSetups: channels.map((entry) => ({
    pluginId: entry.pluginId,
    plugin: entry.plugin as PluginRegistry["channelSetups"][number]["plugin"],
    source: entry.source,
    enabled: true,
  })),
  providers: [],
  modelCatalogProviders: [],
  speechProviders: [],
  realtimeTranscriptionProviders: [],
  realtimeVoiceProviders: [],
  mediaUnderstandingProviders: [],
  imageGenerationProviders: [],
  videoGenerationProviders: [],
  musicGenerationProviders: [],
  webFetchProviders: [],
  webSearchProviders: [],
  migrationProviders: [],
  codexAppServerExtensionFactories: [],
  agentToolResultMiddlewares: [],
  memoryEmbeddingProviders: [],
  textTransforms: [],
  agentHarnesses: [],
  gatewayHandlers: {},
  gatewayMethodScopes: {},
  httpRoutes: [],
  cliRegistrars: [],
  reloads: [],
  nodeHostCommands: [],
  securityAuditCollectors: [],
  services: [],
  gatewayDiscoveryServices: [],
  commands: [],
  conversationBindingResolvedHandlers: [],
  diagnostics: [],
});

export const createChannelTestPluginBase = (params: {
  id: ChannelId;
  label?: string;
  docsPath?: string;
  markdownCapable?: boolean;
  capabilities?: ChannelCapabilities;
  config?: Partial<ChannelPlugin["config"]>;
}): Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config"> => ({
  id: params.id,
  meta: {
    id: params.id,
    label: params.label ?? String(params.id),
    selectionLabel: params.label ?? String(params.id),
    docsPath: params.docsPath ?? `/channels/${params.id}`,
    blurb: "test stub.",
    ...(params.markdownCapable !== undefined ? { markdownCapable: params.markdownCapable } : {}),
  },
  capabilities: params.capabilities ?? { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({}),
    ...params.config,
  },
});

export const createMSTeamsTestPluginBase = (): Pick<
  ChannelPlugin,
  "id" | "meta" | "capabilities" | "config"
> => {
  const base = createChannelTestPluginBase({
    id: "msteams",
    label: "Microsoft Teams",
    docsPath: "/channels/msteams",
    config: { listAccountIds: () => [], resolveAccount: () => ({}) },
  });
  return {
    ...base,
    meta: {
      ...base.meta,
      selectionLabel: "Microsoft Teams (Bot Framework)",
      blurb: "Teams SDK; enterprise support.",
      aliases: ["teams"],
    },
  };
};

export const createMSTeamsTestPlugin = (params?: {
  aliases?: string[];
  outbound?: ChannelOutboundAdapter;
}): ChannelPlugin => {
  const base = createMSTeamsTestPluginBase();
  return {
    ...base,
    meta: {
      ...base.meta,
      ...(params?.aliases ? { aliases: params.aliases } : {}),
    },
    ...(params?.outbound ? { outbound: params.outbound } : {}),
  };
};

export const createOutboundTestPlugin = (params: {
  id: ChannelId;
  outbound: ChannelOutboundAdapter;
  messaging?: ChannelMessagingAdapter;
  label?: string;
  docsPath?: string;
  capabilities?: ChannelCapabilities;
}): ChannelPlugin => ({
  ...createChannelTestPluginBase({
    id: params.id,
    label: params.label,
    docsPath: params.docsPath,
    capabilities: params.capabilities,
    config: { listAccountIds: () => [] },
  }),
  outbound: params.outbound,
  ...(params.messaging ? { messaging: params.messaging } : {}),
});

export type BindingResolverTestPlugin = Pick<
  ChannelPlugin,
  "id" | "meta" | "capabilities" | "config"
> & {
  setup?: Pick<NonNullable<ChannelPlugin["setup"]>, "resolveBindingAccountId">;
};

export const createBindingResolverTestPlugin = (params: {
  id: ChannelId;
  label?: string;
  docsPath?: string;
  capabilities?: ChannelCapabilities;
  config?: Partial<ChannelPlugin["config"]>;
  resolveBindingAccountId?: NonNullable<ChannelPlugin["setup"]>["resolveBindingAccountId"];
}): BindingResolverTestPlugin => ({
  ...createChannelTestPluginBase({
    id: params.id,
    label: params.label,
    docsPath: params.docsPath,
    capabilities: params.capabilities,
    config: params.config,
  }),
  ...(params.resolveBindingAccountId
    ? {
        setup: {
          resolveBindingAccountId: params.resolveBindingAccountId,
        },
      }
    : {}),
});
