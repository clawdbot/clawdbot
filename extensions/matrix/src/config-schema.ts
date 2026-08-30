// Matrix helper module supports config schema behavior.
import {
  AllowFromListSchema,
  BlockStreamingCoalesceSchema,
  buildChannelConfigSchema,
  buildGroupEntrySchema,
  buildNestedDmConfigSchema,
  ContextVisibilityModeSchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  MentionPatternsPolicySchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";
import { matrixChannelConfigUiHints } from "./config-ui-hints.js";

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
    spawnSessions: z.boolean().optional(),
    defaultSpawnContext: z.enum(["isolated", "fork"]).optional(),
  })
  .optional();

const matrixExecApprovalsSchema = z
  .object({
    enabled: z.union([z.boolean(), z.literal("auto")]).optional(),
    approvers: AllowFromListSchema,
    agentFilter: z.array(z.string()).optional(),
    sessionFilter: z.array(z.string()).optional(),
    target: z.enum(["dm", "channel", "both"]).optional(),
  })
  .optional();

const botLoopProtectionSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxEventsPerWindow: z.number().int().positive().optional(),
    windowSeconds: z.number().int().positive().optional(),
    cooldownSeconds: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

const matrixRoomSchema = buildGroupEntrySchema({
  account: z.string().optional(),
  allowBots: z.union([z.boolean(), z.literal("mentions")]).optional(),
  botLoopProtection: botLoopProtectionSchema,
  autoReply: z.boolean().optional(),
  users: AllowFromListSchema,
  turnTaking: z.literal(false).optional(),
})
  .omit({ toolsBySender: true, allowFrom: true })
  .strict()
  .optional();

const matrixNetworkSchema = z
  .object({
    dangerouslyAllowPrivateNetwork: z.boolean().optional(),
  })
  .strict()
  .optional();

const matrixStreamingSchema = z
  .object({
    mode: z.enum(["partial", "quiet", "progress", "off"]).optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    block: z
      .object({
        enabled: z.boolean().optional(),
        coalesce: BlockStreamingCoalesceSchema.optional(),
      })
      .strict()
      .optional(),
    progress: z
      .object({
        label: z.union([z.string(), z.literal(false)]).optional(),
        labels: z.array(z.string()).optional(),
        maxLines: z.number().int().positive().optional(),
        maxLineChars: z.number().int().positive().optional(),
        toolProgress: z.boolean().optional(),
        commandText: z.enum(["raw", "status"]).optional(),
      })
      .strict()
      .optional(),
    preview: z
      .object({
        toolProgress: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const matrixTurnTakingNextStepSchema = z.discriminatedUnion("decider", [
  z.object({ decider: z.literal("ai") }).strict(),
  z
    .object({
      decider: z.literal("user"),
      action: z.enum(["redraft", "discard", "send-as-is"]),
    })
    .strict(),
]);

const matrixTurnTakingSchema = z
  .object({
    enabled: z.boolean().optional(),
    redraftDepth: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    nextStep: matrixTurnTakingNextStepSchema.optional(),
  })
  .strict()
  .optional();

const retiredMatrixAccountStreamingKeys = [
  "streamMode",
  "chunkMode",
  "blockStreaming",
  "blockStreamingCoalesce",
  "draftChunk",
] as const;

function hasCanonicalMatrixAccountStreaming(account: unknown): boolean {
  if (typeof account !== "object" || account === null || Array.isArray(account)) {
    return true;
  }
  if (retiredMatrixAccountStreamingKeys.some((key) => Object.hasOwn(account, key))) {
    return false;
  }
  if (!Object.hasOwn(account, "streaming")) {
    return true;
  }
  const streaming = (account as { streaming?: unknown }).streaming;
  return typeof streaming === "object" && streaming !== null && !Array.isArray(streaming);
}

function hasNoMatrixAccountTurnTakingOverride(account: unknown): boolean {
  if (typeof account !== "object" || account === null || Array.isArray(account)) {
    return true;
  }
  // SAFETY: This refinement's guards prove the account is a non-array object before field reads.
  const record = account as Record<string, unknown>;
  if (Object.hasOwn(record, "turnTaking")) {
    return false;
  }
  for (const roomMapKey of ["groups", "rooms"] as const) {
    const roomMap = record[roomMapKey];
    if (typeof roomMap !== "object" || roomMap === null || Array.isArray(roomMap)) {
      continue;
    }
    for (const entry of Object.values(roomMap)) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        Object.hasOwn(entry, "turnTaking")
      ) {
        return false;
      }
    }
  }
  return true;
}

const MatrixConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  configWrites: z.boolean().optional(),
  joinIntro: z.boolean().optional(),
  defaultAccount: z.string().optional(),
  // Accounts stay schema-open, but retired scalar streaming must fail loudly
  // instead of silently resolving to "off"; doctor migrates the old spelling.
  accounts: z
    .record(
      z.string(),
      z
        .object({ joinIntro: z.boolean().optional() })
        .passthrough()
        .refine(hasCanonicalMatrixAccountStreaming, {
          message:
            'flat or scalar streaming values are no longer supported; use streaming.* and run "openclaw doctor --fix"',
        })
        .refine(hasNoMatrixAccountTurnTakingOverride, {
          message:
            "turnTaking is channel-wide; configure channels.matrix.turnTaking and top-level Matrix room opt-outs only",
        }),
    )
    .optional(),
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
  dangerouslyAllowNameMatching: z.boolean().optional(),
  allowBots: z.union([z.boolean(), z.literal("mentions")]).optional(),
  botLoopProtection: botLoopProtectionSchema,
  groupPolicy: GroupPolicySchema.optional(),
  mentionPatterns: MentionPatternsPolicySchema.optional(),
  contextVisibility: ContextVisibilityModeSchema.optional(),
  streaming: matrixStreamingSchema.optional(),
  turnTaking: matrixTurnTakingSchema,
  replyToMode: z.enum(["off", "first", "all", "batched"]).optional(),
  threadReplies: z.enum(["off", "inbound", "always"]).optional(),
  textChunkLimit: z.number().optional(),
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

export const MatrixChannelConfigSchema = buildChannelConfigSchema(MatrixConfigSchema, {
  uiHints: matrixChannelConfigUiHints,
});
