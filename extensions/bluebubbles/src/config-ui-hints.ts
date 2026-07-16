import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";

export const bluebubblesChannelConfigUiHints = {
  "": {
    label: "BlueBubbles",
    help: "BlueBubbles channel provider configuration used for Apple messaging bridge integrations. Keep DM policy aligned with your trusted sender model in shared deployments.",
  },
  dmPolicy: {
    label: "BlueBubbles DM Policy",
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.bluebubbles.allowFrom=["*"].',
  },
} satisfies Record<string, ChannelConfigUiHint>;
