import {
  ToolPolicySchema,
  buildChannelConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "openclaw/plugin-sdk/zod";

const QaChannelActionConfigSchema = z
  .object({
    messages: z.boolean().optional(),
    reactions: z.boolean().optional(),
    search: z.boolean().optional(),
    threads: z.boolean().optional(),
  })
  .strict();

const QaChannelGroupConfigSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema.optional(),
    toolsBySender: z.record(z.string(), ToolPolicySchema).optional(),
  })
  .strict();

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

const QaChannelConfigSchema = QaChannelAccountConfigSchema.extend({
  accounts: z.record(z.string(), QaChannelAccountConfigSchema.partial()).optional(),
  defaultAccount: z.string().optional(),
}).strict();

export const qaChannelPluginConfigSchema = buildChannelConfigSchema(QaChannelConfigSchema);
