import { z } from "zod";

const DmPolicySchema = z.enum(["open", "allowlist", "pairing", "disabled"]);
const GroupPolicySchema = z.enum(["open", "allowlist", "disabled"]);

const LineGroupConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    requireMention: z.boolean().optional(),
    systemPrompt: z.string().optional(),
    skills: z.array(z.string()).optional(),
  })
  .strict();

const LineAccountConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    channelAccessToken: z.string().optional(),
    channelSecret: z.string().optional(),
    tokenFile: z.string().optional(),
    secretFile: z.string().optional(),
    name: z.string().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    mediaMaxMb: z.number().optional(),
    webhookPath: z.string().optional(),
    groups: z.record(z.string(), LineGroupConfigSchema.optional()).optional(),
  })
  .strict();

export const LineConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    channelAccessToken: z.string().optional(),
    channelSecret: z.string().optional(),
    tokenFile: z.string().optional(),
    secretFile: z.string().optional(),
    name: z.string().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    mediaMaxMb: z.number().optional(),
    webhookPath: z.string().optional(),
    accounts: z.record(z.string(), LineAccountConfigSchema.optional()).optional(),
    groups: z.record(z.string(), LineGroupConfigSchema.optional()).optional(),
  })
  .strict();

export type LineConfigSchemaType = z.infer<typeof LineConfigSchema>;
