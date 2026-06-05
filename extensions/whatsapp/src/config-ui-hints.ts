// Whatsapp helper module supports config ui hints behavior.
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
  mentionPatterns: {
    label: "WhatsApp Mention Pattern Policy",
    help: "Scopes configured groupChat mentionPatterns to selected WhatsApp conversation IDs such as 123@g.us.",
  },
  "mentionPatterns.mode": {
    label: "WhatsApp Mention Pattern Mode",
    help: '"allow" enables configured regex mention patterns unless denyIn matches; "deny" disables them unless allowIn matches.',
  },
  "mentionPatterns.allowIn": {
    label: "WhatsApp Mention Pattern Allowlist",
    help: "WhatsApp conversation IDs where configured regex mention patterns are enabled when mode is deny.",
  },
  "mentionPatterns.denyIn": {
    label: "WhatsApp Mention Pattern Denylist",
    help: "WhatsApp conversation IDs where configured regex mention patterns are disabled.",
  },
} satisfies Record<string, ChannelConfigUiHint>;
