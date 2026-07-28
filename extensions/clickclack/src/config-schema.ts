/**
 * Zod-backed config schema for ClickClack channel accounts.
 */
import {
  buildChannelConfigSchema,
  buildMultiAccountChannelSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

const ClickClackAccountConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    baseUrl: z.string().url().optional(),
    apiBaseUrl: z.string().url().optional(),
    token: buildSecretInputSchema().optional(),
    tokenFile: z.string().optional(),
    workspace: z.string().optional(),
    botUserId: z.string().optional(),
    agentId: z.string().optional(),
    replyMode: z.enum(["agent", "model"]).optional(),
    model: z.string().optional(),
    systemPrompt: z.string().optional(),
    toolsAllow: z.array(z.string()).optional(),
    defaultTo: z.string().optional(),
    allowFrom: z.array(z.string()).optional(),
    reconnectMs: z.number().int().min(100).max(60_000).optional(),
    agentActivity: z.boolean().optional(),
    commandMenu: z.boolean().optional(),
    discussions: z
      .object({
        enabled: z.boolean().optional(),
        workspace: z.string().optional(),
        controlUrlBase: z.string().url().optional(),
        section: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const ClickClackConfigSchema = buildMultiAccountChannelSchema(ClickClackAccountConfigSchema, {
  accountSchema: ClickClackAccountConfigSchema.partial(),
});

/**
 * Config schema exported to core so `openclaw doctor` and config validation
 * understand both default and named ClickClack accounts.
 */
export const clickClackConfigSchema = buildChannelConfigSchema(ClickClackConfigSchema);
