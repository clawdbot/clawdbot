// Synology Chat helper module supports config schema behavior.
import {
  buildChannelConfigSchema,
  buildMultiAccountChannelSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

const SynologyChatAccountConfigSchema = z
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
  .passthrough();

const SynologyChatConfigSchema = buildMultiAccountChannelSchema(SynologyChatAccountConfigSchema, {
  accountSchema: SynologyChatAccountConfigSchema,
});

export const SynologyChatChannelConfigSchema = buildChannelConfigSchema(SynologyChatConfigSchema);
