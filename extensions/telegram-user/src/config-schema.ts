import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

const TelegramUserTopicSchema = z
  .object({
    requireMention: z.boolean().optional(),
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(allowFromEntry).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

const TelegramUserGroupSchema = z
  .object({
    requireMention: z.boolean().optional(),
    skills: z.array(z.string()).optional(),
    topics: z.record(z.string(), TelegramUserTopicSchema.optional()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(allowFromEntry).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

const TelegramUserAccountSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    apiId: z.number().int().positive().optional(),
    apiHash: z.string().optional(),
    dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
    allowFrom: z.array(allowFromEntry).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    mediaMaxMb: z.number().positive().optional(),
    groupAllowFrom: z.array(allowFromEntry).optional(),
    groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
    groups: z.record(z.string(), TelegramUserGroupSchema.optional()).optional(),
  })
  .strict();

export const TelegramUserConfigSchema = TelegramUserAccountSchema.extend({
  accounts: z.record(z.string(), TelegramUserAccountSchema.optional()).optional(),
});
