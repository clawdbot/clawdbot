// Synology Chat helper module supports config schema behavior.
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

export const SynologyChatChannelConfigSchema = buildChannelConfigSchema(
  z
    .object({
      webhookUrl: z.string().optional(),
      dangerouslyAllowNameMatching: z.boolean().optional(),
      dangerouslyAllowInheritedWebhookPath: z.boolean().optional(),
    })
    .passthrough(),
  {
    uiHints: {
      incomingUrl: { sensitive: true },
      "accounts.*.incomingUrl": { sensitive: true },
      webhookUrl: { sensitive: true },
      "accounts.*.webhookUrl": { sensitive: true },
    },
  },
);
