import { z } from "zod";

import {
  DmPolicySchema,
  GroupPolicySchema,
  ToolPolicySchema,
  requireOpenAllowFrom,
} from "clawdbot/plugin-sdk";

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
    tools: ToolPolicySchema,
    topics: z.record(z.string(), TelegramUserTopicSchema.optional()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(allowFromEntry).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

const TelegramUserAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    apiId: z.number().int().positive().optional(),
    apiHash: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(allowFromEntry).optional(),
    replyToMode: z.enum(["off", "first", "all"]).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    mediaMaxMb: z.number().positive().optional(),
    groupAllowFrom: z.array(allowFromEntry).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groups: z.record(z.string(), TelegramUserGroupSchema.optional()).optional(),
  })
  .strict();

const TelegramUserAccountSchema = TelegramUserAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.telegram-user.dmPolicy="open" requires channels.telegram-user.allowFrom to include "*"',
  });
});

export const TelegramUserConfigSchema = TelegramUserAccountSchemaBase.extend({
  accounts: z.record(z.string(), TelegramUserAccountSchema.optional()).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.telegram-user.dmPolicy="open" requires channels.telegram-user.allowFrom to include "*"',
  });
});
