import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";

export const iMessageChannelConfigUiHints = {
  "": {
    label: "iMessage",
    help: "iMessage channel provider configuration for CLI integration and DM access policy handling. Use explicit CLI paths when runtime environments have non-standard binary locations.",
  },
  dmPolicy: {
    label: "iMessage DM Policy",
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.imessage.allowFrom=["*"].',
  },
  configWrites: {
    label: "iMessage Config Writes",
    help: "Allow iMessage to write config in response to channel events/commands (default: true).",
  },
  cliPath: {
    label: "iMessage CLI Path",
    help: "Filesystem path to the iMessage bridge CLI binary used for send/receive operations. Set explicitly when the binary is not on PATH in service runtime environments.",
  },
} satisfies Record<string, ChannelConfigUiHint>;
