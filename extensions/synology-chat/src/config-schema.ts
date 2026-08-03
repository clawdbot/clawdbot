// Synology Chat helper module supports config schema behavior.
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

export const SynologyChatChannelConfigSchema = buildChannelConfigSchema(
  z
    .object({
      dangerouslyAllowFileUrlFetch: z
        .boolean()
        .optional()
        .describe(
          "Dangerous opt-in that lets Synology Chat fetch remote media URLs for automatic attachments. The NAS resolves and downloads these URLs outside OpenClaw's network controls.",
        ),
      dangerouslyAllowNameMatching: z.boolean().optional(),
      dangerouslyAllowInheritedWebhookPath: z.boolean().optional(),
    })
    .passthrough(),
);
