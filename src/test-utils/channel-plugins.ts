// Constructs channel plugin registries and plugin fixtures for tests.
import type {
  ChannelCapabilities,
  ChannelId,
  ChannelMessagingAdapter,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../channels/plugins/types.public.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry.js";

/** Registry entry shape used by channel tests without loading real plugins. */
export type TestChannelRegistration = {
  pluginId: string;
  plugin: unknown;
  source: string;
  origin?: "bundled" | "global" | "workspace" | "config";
};

export const createTestRegistry = (channels: TestChannelRegistration[] = []): PluginRegistry => ({
  ...createEmptyPluginRegistry(),
  channels: channels as unknown as PluginRegistry["channels"],
  channelSetups: channels.map((entry) => ({
    pluginId: entry.pluginId,
    plugin: entry.plugin as PluginRegistry["channelSetups"][number]["plugin"],
    ...(entry.origin ? { origin: entry.origin } : {}),
    source: entry.source,
    enabled: true,
  })),
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

export const createDirectOutboundTestAdapter = (params: {
  channel: ChannelId;
  messageId?: string;
  resolveTarget?: ChannelOutboundAdapter["resolveTarget"];
}): ChannelOutboundAdapter => ({
  deliveryMode: "direct",
  ...(params.resolveTarget ? { resolveTarget: params.resolveTarget } : {}),
  sendText: async () => ({ channel: params.channel, messageId: params.messageId ?? "msg-test" }),
  sendMedia: async () => ({ channel: params.channel, messageId: params.messageId ?? "msg-test" }),
});

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
