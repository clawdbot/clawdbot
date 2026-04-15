import {
  AllowFromListSchema,
  buildNestedDmConfigSchema,
  ContextVisibilityModeSchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ToolPolicySchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "openclaw/plugin-sdk/zod";

const matrixActionSchema = z
  .object({
    reactions: z.boolean().optional(),
    messages: z.boolean().optional(),
    pins: z.boolean().optional(),
    profile: z.boolean().optional(),
    memberInfo: z.boolean().optional(),
    channelInfo: z.boolean().optional(),
    verification: z.boolean().optional(),
  })
  .optional();

const matrixThreadBindingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    idleHours: z.number().nonnegative().optional(),
    maxAgeHours: z.number().nonnegative().optional(),
    spawnSubagentSessions: z.boolean().optional(),
    spawnAcpSessions: z.boolean().optional(),
  })
  .optional();

const matrixExecApprovalsSchema = z
  .object({
    enabled: z.boolean().optional(),
    approvers: AllowFromListSchema,
    agentFilter: z.array(z.string()).optional(),
    sessionFilter: z.array(z.string()).optional(),
    target: z.enum(["dm", "channel", "both"]).optional(),
  })
  .optional();

const matrixRoomSchema = z
  .object({
    account: z.string().optional(),
    enabled: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    allowBots: z.union([z.boolean(), z.literal("mentions")]).optional(),
    tools: ToolPolicySchema,
    autoReply: z.boolean().optional(),
    users: AllowFromListSchema,
    skills: z.array(z.string()).optional(),
    systemPrompt: z.string().optional(),
  })
  .optional();

const matrixNetworkSchema = z
  .object({
    dangerouslyAllowPrivateNetwork: z.boolean().optional(),
  })
  .strict()
  .optional();

export const MatrixConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  defaultAccount: z.string().optional(),
  accounts: z.record(z.string(), z.unknown()).optional(),
  markdown: MarkdownConfigSchema,
  homeserver: z.string().optional(),
  network: matrixNetworkSchema,
  proxy: z.string().optional(),
  userId: z.string().optional(),
  accessToken: buildSecretInputSchema().optional(),
  password: buildSecretInputSchema().optional(),
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
  avatarUrl: z.string().optional(),
  initialSyncLimit: z.number().optional(),
  encryption: z.boolean().optional(),
  allowlistOnly: z.boolean().optional(),
  allowBots: z.union([z.boolean(), z.literal("mentions")]).optional(),
  groupPolicy: GroupPolicySchema.optional(),
  contextVisibility: ContextVisibilityModeSchema.optional(),
  blockStreaming: z.boolean().optional(),
  streaming: z.union([z.enum(["partial", "quiet", "off"]), z.boolean()]).optional(),
  replyToMode: z.enum(["off", "first", "all", "batched"]).optional(),
  threadReplies: z.enum(["off", "inbound", "always"]).optional(),
  textChunkLimit: z.number().optional(),
  chunkMode: z.enum(["length", "newline"]).optional(),
  responsePrefix: z.string().optional(),
  ackReaction: z.string().optional(),
  ackReactionScope: z
    .enum(["group-mentions", "group-all", "direct", "all", "none", "off"])
    .optional(),
  reactionNotifications: z.enum(["off", "own"]).optional(),
  threadBindings: matrixThreadBindingsSchema,
  startupVerification: z.enum(["off", "if-unverified"]).optional(),
  startupVerificationCooldownHours: z.number().optional(),
  mediaMaxMb: z.number().optional(),
  historyLimit: z.number().int().min(0).optional(),
  autoJoin: z.enum(["always", "allowlist", "off"]).optional(),
  autoJoinAllowlist: AllowFromListSchema,
  groupAllowFrom: AllowFromListSchema,
  dm: buildNestedDmConfigSchema({
    sessionScope: z.enum(["per-user", "per-room"]).optional(),
    threadReplies: z.enum(["off", "inbound", "always"]).optional(),
  }),
  execApprovals: matrixExecApprovalsSchema,
  groups: z.object({}).catchall(matrixRoomSchema).optional(),
  rooms: z.object({}).catchall(matrixRoomSchema).optional(),
  actions: matrixActionSchema,
});
