// Synology Chat helper module supports config schema behavior.
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

export const SynologyChatChannelConfigSchema = buildChannelConfigSchema(
  z
    .object({
      dangerouslyAllowNasUrlFetches: z
        .boolean()
        .optional()
        .describe(
          "Dangerous opt-in that exposes raw HTTP(S) links and lets Synology Chat fetch remote media for previews and automatic attachments outside OpenClaw's network controls.",
        ),
      dangerouslyAllowNameMatching: z.boolean().optional(),
      dangerouslyAllowInheritedWebhookPath: z.boolean().optional(),
    })
    .passthrough(),
);
