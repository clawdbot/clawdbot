import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";

export const whatsAppChannelConfigUiHints = {
  "": {
    label: "WhatsApp",
    help: "WhatsApp channel provider configuration for access policy and message batching behavior. Use this section to tune responsiveness and direct-message routing safety for WhatsApp chats.",
  },
  dmPolicy: {
    label: "WhatsApp DM Policy",
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.whatsapp.allowFrom=["*"].',
  },
  selfChatMode: {
    label: "WhatsApp Self-Phone Mode",
    help: "Same-phone setup (bot uses your personal WhatsApp number).",
  },
  debounceMs: {
    label: "WhatsApp Message Debounce (ms)",
    help: "Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable).",
  },
  configWrites: {
    label: "WhatsApp Config Writes",
    help: "Allow WhatsApp to write config in response to channel events/commands (default: true).",
  },
  exposeErrorText: {
    label: "WhatsApp Error Text",
    help: "Deliver user-visible agent/provider error text into WhatsApp (default: true). Disable to keep failures quiet on WhatsApp.",
  },
} satisfies Record<string, ChannelConfigUiHint>;
