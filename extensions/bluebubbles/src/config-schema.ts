import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

const bluebubblesActionSchema = z
  .object({
    reactions: z.boolean().optional(),
  })
  .optional();

const bluebubblesGroupConfigSchema = z.object({
  requireMention: z.boolean().optional(),
});

const bluebubblesAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  serverUrl: z.string().optional(),
  password: z.string().optional(),
  webhookPath: z.string().optional(),
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
  allowFrom: z.array(allowFromEntry).optional(),
  groupAllowFrom: z.array(allowFromEntry).optional(),
  groupPolicy: z.enum(["open", "disabled", "allowlist"]).optional(),
  historyLimit: z.number().int().min(0).optional(),
  dmHistoryLimit: z.number().int().min(0).optional(),
  textChunkLimit: z.number().int().positive().optional(),
  mediaMaxMb: z.number().int().positive().optional(),
  sendReadReceipts: z.boolean().optional(),
  blockStreaming: z.boolean().optional(),
  groups: z.object({}).catchall(bluebubblesGroupConfigSchema).optional(),
});

export const BlueBubblesConfigSchema = bluebubblesAccountSchema.extend({
  accounts: z.object({}).catchall(bluebubblesAccountSchema).optional(),
  actions: bluebubblesActionSchema,
});
