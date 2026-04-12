import type { ChannelOutboundAdapter } from "../channels/plugins/types.adapters.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

type StubChannelOptions = {
  id: ChannelPlugin["id"];
  label: string;
  summary?: Record<string, unknown>;
};

const createStubOutboundAdapter = (channelId: ChannelPlugin["id"]): ChannelOutboundAdapter => ({
  deliveryMode: "direct",
  sendText: async () => ({
    channel: channelId,
    messageId: `${channelId}-msg`,
  }),
  sendMedia: async () => ({
    channel: channelId,
    messageId: `${channelId}-msg`,
  }),
});

const createStubChannelPlugin = (params: StubChannelOptions): ChannelPlugin => ({
  id: params.id,
  meta: {
    id: params.id,
    label: params.label,
    selectionLabel: params.label,
    docsPath: `/channels/${params.id}`,
    blurb: "test stub.",
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: () => ({}),
    isConfigured: async () => false,
  },
  status: {
    buildChannelSummary: async () => ({
      configured: false,
      ...(params.summary ? params.summary : {}),
    }),
  },
  outbound: createStubOutboundAdapter(params.id),
  messaging: {
    normalizeTarget: (raw) => raw,
  },
  gateway: {
    logoutAccount: async () => ({
      cleared: false,
      envToken: false,
      loggedOut: false,
    }),
  },
});

export function createDefaultGatewayTestChannels() {
  return [
    {
      pluginId: "whatsapp",
      source: "test" as const,
      plugin: createStubChannelPlugin({ id: "whatsapp", label: "WhatsApp" }),
    },
    {
      pluginId: "telegram",
      source: "test" as const,
      plugin: createStubChannelPlugin({
        id: "telegram",
        label: "Telegram",
        summary: { tokenSource: "none", lastProbeAt: null },
      }),
    },
    {
      pluginId: "discord",
      source: "test" as const,
      plugin: createStubChannelPlugin({ id: "discord", label: "Discord" }),
    },
    {
      pluginId: "slack",
      source: "test" as const,
      plugin: createStubChannelPlugin({ id: "slack", label: "Slack" }),
    },
    {
      pluginId: "signal",
      source: "test" as const,
      plugin: createStubChannelPlugin({
        id: "signal",
        label: "Signal",
        summary: { lastProbeAt: null },
      }),
    },
    {
      pluginId: "imessage",
      source: "test" as const,
      plugin: createStubChannelPlugin({ id: "imessage", label: "iMessage" }),
    },
    {
      pluginId: "msteams",
      source: "test" as const,
      plugin: createStubChannelPlugin({ id: "msteams", label: "Microsoft Teams" }),
    },
    {
      pluginId: "matrix",
      source: "test" as const,
      plugin: createStubChannelPlugin({ id: "matrix", label: "Matrix" }),
    },
    {
      pluginId: "zalo",
      source: "test" as const,
      plugin: createStubChannelPlugin({ id: "zalo", label: "Zalo" }),
    },
    {
      pluginId: "zalouser",
      source: "test" as const,
      plugin: createStubChannelPlugin({ id: "zalouser", label: "Zalo Personal" }),
    },
    {
      pluginId: "bluebubbles",
      source: "test" as const,
      plugin: createStubChannelPlugin({ id: "bluebubbles", label: "BlueBubbles" }),
    },
  ];
}
