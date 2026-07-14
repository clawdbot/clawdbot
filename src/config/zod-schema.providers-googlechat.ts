// Defines Google Chat provider schema fragments.
import { z } from "zod";
import { ChannelBotLoopProtectionSchema } from "./zod-schema.channels-config.js";
import { ChannelHealthMonitorSchema } from "./zod-schema.channels.js";
import {
  ChannelDeliveryStreamingConfigSchema,
  DmConfigSchema,
  DmPolicySchema,
  GroupPolicySchema,
  ReplyToModeSchema,
  SecretRefSchema,
  requireAllowlistAllowFrom,
  requireOpenAllowFrom,
} from "./zod-schema.core.js";
import { sensitive } from "./zod-schema.sensitive.js";

/** DM policy schema for Google Chat accounts. */
const GoogleChatDmSchema = z
  .object({
    enabled: z.boolean().optional(),
    policy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    requireOpenAllowFrom({
      policy: value.policy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message:
        'channels.googlechat.dm.policy="open" requires channels.googlechat.dm.allowFrom to include "*"',
    });
    requireAllowlistAllowFrom({
      policy: value.policy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message:
        'channels.googlechat.dm.policy="allowlist" requires channels.googlechat.dm.allowFrom to contain at least one sender ID',
    });
  });

const GoogleChatGroupSchema = z
  .object({
    enabled: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    botLoopProtection: ChannelBotLoopProtectionSchema.optional(),
    users: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

const GoogleChatAccountSchema = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    allowBots: z.boolean().optional(),
    botLoopProtection: ChannelBotLoopProtectionSchema.optional(),
    dangerouslyAllowNameMatching: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groups: z.record(z.string(), GoogleChatGroupSchema.optional()).optional(),
    defaultTo: z.string().optional(),
    serviceAccount: z
      .union([z.string(), z.record(z.string(), z.unknown()), SecretRefSchema])
      .optional()
      .register(sensitive),
    serviceAccountRef: SecretRefSchema.optional().register(sensitive),
    serviceAccountFile: z.string().optional(),
    audienceType: z.enum(["app-url", "project-number"]).optional(),
    audience: z.string().optional(),
    appPrincipal: z.string().optional(),
    webhookPath: z.string().optional(),
    webhookUrl: z.string().optional(),
    botUser: z.string().optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    streaming: ChannelDeliveryStreamingConfigSchema.optional(),
    mediaMaxMb: z.number().positive().optional(),
    replyToMode: ReplyToModeSchema.optional(),
    actions: z
      .object({
        reactions: z.boolean().optional(),
      })
      .strict()
      .optional(),
    dm: GoogleChatDmSchema.optional(),
    healthMonitor: ChannelHealthMonitorSchema,
    typingIndicator: z.enum(["none", "message", "reaction"]).optional(),
    responsePrefix: z.string().optional(),
  })
  .strict();

export const GoogleChatConfigSchema = GoogleChatAccountSchema.extend({
  accounts: z.record(z.string(), GoogleChatAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
});
