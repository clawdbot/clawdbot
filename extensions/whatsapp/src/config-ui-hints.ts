import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
// Whatsapp helper module supports config ui hints behavior.
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";

export const whatsAppChannelConfigUiHints = {
  "": {
    label: "WhatsApp",
    help: "WhatsApp channel provider configuration for access policy and message batching behavior. Use this section to tune responsiveness and direct-message routing safety for WhatsApp chats.",
  },
  ...createChannelConfigUiHints({
    channelLabel: "WhatsApp",
    dmPolicy: { channelKey: "whatsapp" },
  }),
  selfChatMode: {
    label: "WhatsApp Self-Phone Mode",
    help: "Same-phone setup (bot uses your personal WhatsApp number).",
  },
  debounceMs: {
    label: "WhatsApp Message Debounce (ms)",
    help: "Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable).",
  },
  ...createChannelConfigUiHints({ channelLabel: "WhatsApp", configWrites: true }),
  "actions.calls": {
    label: "WhatsApp Voice Calls",
    help: "Expose the experimental requester-bound WhatsApp voice-call tool. Default: false. Requires a separately paired MeowCaller CLI.",
  },
  ...createChannelConfigUiHints({
    channelLabel: "WhatsApp",
    mentionPatterns: {
      targetDescription: "WhatsApp conversation IDs",
      policyTargetDescription: "WhatsApp conversation IDs such as 123@g.us",
    },
  }),
} satisfies Record<string, ChannelConfigUiHint>;
