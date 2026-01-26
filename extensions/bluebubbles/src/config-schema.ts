import { MarkdownConfigSchema, ToolPolicySchema } from "clawdbot/plugin-sdk";
import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

const bluebubblesActionSchema = z
  .object({
    reactions: z.boolean().default(true),
    edit: z.boolean().default(true),
    unsend: z.boolean().default(true),
    reply: z.boolean().default(true),
    sendWithEffect: z.boolean().default(true),
    renameGroup: z.boolean().default(true),
    setGroupIcon: z.boolean().default(true),
    addParticipant: z.boolean().default(true),
    removeParticipant: z.boolean().default(true),
    leaveGroup: z.boolean().default(true),
    sendAttachment: z.boolean().default(true),
  })
  .optional();

const bluebubblesGroupConfigSchema = z.object({
  requireMention: z.boolean().optional(),
  tools: ToolPolicySchema,
});

const bluebubblesAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  markdown: MarkdownConfigSchema,
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
  chunkMode: z.enum(["length", "newline"]).optional(),
  mediaMaxMb: z.number().int().positive().optional(),
  sendReadReceipts: z.boolean().optional(),
  blockStreaming: z.boolean().optional(),
  groups: z.object({}).catchall(bluebubblesGroupConfigSchema).optional(),
});

export const BlueBubblesConfigSchema = bluebubblesAccountSchema.extend({
  accounts: z.object({}).catchall(bluebubblesAccountSchema).optional(),
  actions: bluebubblesActionSchema,
});
