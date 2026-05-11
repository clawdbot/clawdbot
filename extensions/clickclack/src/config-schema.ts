import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

const ClickClackAccountConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    baseUrl: z.string().url().optional(),
    token: buildSecretInputSchema().optional(),
    workspace: z.string().optional(),
    botUserId: z.string().optional(),
    agentId: z.string().optional(),
    replyMode: z.enum(["agent", "model"]).optional(),
    model: z.string().optional(),
    systemPrompt: z.string().optional(),
    timeoutSeconds: z.number().int().min(1).max(3_600).optional(),
    toolsAllow: z.array(z.string()).optional(),
    senderIsOwner: z.boolean().optional(),
    defaultTo: z.string().optional(),
    allowFrom: z.array(z.string()).optional(),
    reconnectMs: z.number().int().min(100).max(60_000).optional(),
  })
  .strict();

const ClickClackConfigSchema = ClickClackAccountConfigSchema.extend({
  accounts: z.record(z.string(), ClickClackAccountConfigSchema.partial()).optional(),
  defaultAccount: z.string().optional(),
}).strict();

export const clickClackConfigSchema = buildChannelConfigSchema(ClickClackConfigSchema);
