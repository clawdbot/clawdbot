// Qa Channel helper module supports config schema behavior.
import {
  buildChannelConfigSchema,
  buildGroupEntrySchema,
  buildMultiAccountChannelSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

const QaChannelActionConfigSchema = z
  .object({
    messages: z.boolean().optional(),
    reactions: z.boolean().optional(),
    search: z.boolean().optional(),
    threads: z.boolean().optional(),
  })
  .strict();

const QaChannelGroupConfigSchema = buildGroupEntrySchema().omit({
  skills: true,
  enabled: true,
  allowFrom: true,
  systemPrompt: true,
});

const QaChannelAccountConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    baseUrl: z.string().url().optional(),
    botUserId: z.string().optional(),
    botDisplayName: z.string().optional(),
    pollTimeoutMs: z.number().int().min(100).max(30_000).optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groups: z.record(z.string(), QaChannelGroupConfigSchema).optional(),
    defaultTo: z.string().optional(),
    actions: QaChannelActionConfigSchema.optional(),
  })
  .strict();

const QaChannelConfigSchema = buildMultiAccountChannelSchema(QaChannelAccountConfigSchema, {
  accountSchema: QaChannelAccountConfigSchema.partial(),
});

export const qaChannelPluginConfigSchema = buildChannelConfigSchema(QaChannelConfigSchema);
