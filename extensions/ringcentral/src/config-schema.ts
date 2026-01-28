import { z } from "zod";

import {
  BlockStreamingCoalesceSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  requireOpenAllowFrom,
} from "moltbot/plugin-sdk";

const RingCentralGroupConfigSchema = z
  .object({
    chatId: z.string().optional(),
    requireMention: z.boolean().optional(),
    allow: z.boolean().optional(),
    enabled: z.boolean().optional(),
    users: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

const RingCentralAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    jwt: z.string().optional(),
    server: z.string().optional(),
    markdown: MarkdownConfigSchema,
    dmPolicy: DmPolicySchema.optional().default("allowlist"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groups: z.record(z.string(), RingCentralGroupConfigSchema.optional()).optional(),
    requireMention: z.boolean().optional(),
    mediaMaxMb: z.number().int().positive().optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    allowBots: z.boolean().optional(),
    botExtensionId: z.string().optional(),
    selfOnly: z.boolean().optional(),
    useAdaptiveCards: z.boolean().optional(), // Use Adaptive Cards for code blocks (default: false)
  })
  .strict();

const RingCentralAccountSchema = RingCentralAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.ringcentral.dmPolicy="open" requires channels.ringcentral.allowFrom to include "*"',
  });
});

export const RingCentralConfigSchema = RingCentralAccountSchemaBase.extend({
  accounts: z.record(z.string(), RingCentralAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.ringcentral.dmPolicy="open" requires channels.ringcentral.allowFrom to include "*"',
  });
});

export type { RingCentralAccountConfig, RingCentralConfig } from "./types.js";
