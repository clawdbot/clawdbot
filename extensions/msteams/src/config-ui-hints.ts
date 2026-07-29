import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";

export const msTeamsChannelConfigUiHints = {
  "": {
    label: "MS Teams",
    help: "Microsoft Teams channel provider configuration and provider-specific policy toggles. Use this section to isolate Teams behavior from other enterprise chat providers.",
  },
  configWrites: {
    label: "MS Teams Config Writes",
    help: "Allow Microsoft Teams to write config in response to channel events/commands (default: true).",
  },
  cloud: {
    label: "MS Teams Cloud",
    help: 'Teams SDK cloud environment for auth, token validation, and token services: "Public", "USGov", "USGovDoD", or "China" (default: Public).',
  },
  serviceUrl: {
    label: "MS Teams Service URL",
    help: "Bot Connector service URL for SDK proactive sends/edits/deletes. Set with cloud for USGov/DoD; set alone for GCC.",
  },
  graphMediaFallback: {
    label: "MS Teams Graph Media Fallback",
    help: "Query Microsoft Graph for unresolved channel or group-chat HTML media. Adds one lookup per matching message when enabled (default: false).",
  },
  ...createChannelConfigUiHints({
    channelLabel: "MS Teams",
    streaming: {
      "": {
        label: "MS Teams Streaming",
        help: 'Microsoft Teams preview/progress streaming mode: "off" | "partial" | "block" | "progress". Personal chats use Teams native streaminfo progress when available.',
      },
    },
    progress: {
      labels: "openclaw",
      titleWording: true,
    },
  }),
} satisfies Record<string, ChannelConfigUiHint>;
