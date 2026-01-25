import { MarkdownConfigSchema, ToolPolicySchema } from "clawdbot/plugin-sdk";
import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

const matrixActionSchema = z
  .object({
    reactions: z.boolean().optional(),
    messages: z.boolean().optional(),
    pins: z.boolean().optional(),
    memberInfo: z.boolean().optional(),
    channelInfo: z.boolean().optional(),
  })
  .optional();

const matrixDmSchema = z
  .object({
    enabled: z.boolean().optional(),
    policy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
    allowFrom: z.array(allowFromEntry).optional(),
  })
  .optional();

const matrixRoomSchema = z
  .object({
    enabled: z.boolean().optional(),
    allow: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    autoReply: z.boolean().optional(),
    users: z.array(allowFromEntry).optional(),
    skills: z.array(z.string()).optional(),
    systemPrompt: z.string().optional(),
  })
  .optional();

export const MatrixConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  markdown: MarkdownConfigSchema,
  homeserver: z.string().optional(),
  userId: z.string().optional(),
  accessToken: z.string().optional(),
  password: z.string().optional(),
  deviceName: z.string().optional(),
  initialSyncLimit: z.number().optional(),
  encryption: z.boolean().optional(),
  allowlistOnly: z.boolean().optional(),
  groupPolicy: z.enum(["open", "disabled", "allowlist"]).optional(),
  replyToMode: z.enum(["off", "first", "all"]).optional(),
  threadReplies: z.enum(["off", "inbound", "always"]).optional(),
  textChunkLimit: z.number().optional(),
  chunkMode: z.enum(["length", "newline"]).optional(),
  mediaMaxMb: z.number().optional(),
  autoJoin: z.enum(["always", "allowlist", "off"]).optional(),
  autoJoinAllowlist: z.array(allowFromEntry).optional(),
  groupAllowFrom: z.array(allowFromEntry).optional(),
  dm: matrixDmSchema,
  groups: z.object({}).catchall(matrixRoomSchema).optional(),
  rooms: z.object({}).catchall(matrixRoomSchema).optional(),
  actions: matrixActionSchema,
});
