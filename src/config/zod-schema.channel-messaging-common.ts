// Shared Zod leaves for bundled channel messaging configuration.
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { NativeExecApprovalEnableModeSchema } from "./zod-schema.approvals.js";
import { ChannelBotLoopProtectionSchema } from "./zod-schema.channels-config.js";
import {
  ChannelHealthMonitorSchema,
  ChannelHeartbeatVisibilitySchema,
} from "./zod-schema.channels.js";
import {
  BlockStreamingChunkSchema,
  ChannelDeliveryStreamingConfigSchema,
  ChannelStreamingBlockSchema,
  ContextVisibilityModeSchema,
  DmConfigSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  MentionPatternsPolicySchema,
  ReplyToModeSchema,
  TextChunkModeSchema,
} from "./zod-schema.core.js";

export const UnifiedStreamingModeSchema = z.enum(["off", "partial", "block", "progress"]);
export const ChannelStreamingPreviewSchema = z
  .object({
    chunk: BlockStreamingChunkSchema.optional(),
    toolProgress: z.boolean().optional(),
    commandText: z.enum(["raw", "status"]).optional(),
  })
  .strict();
export const ChannelStreamingProgressSchema = z
  .object({
    label: z.union([z.string(), z.literal(false)]).optional(),
    labels: z.array(z.string()).optional(),
    maxLines: z.number().int().positive().optional(),
    maxLineChars: z.number().int().positive().optional(),
    toolProgress: z.boolean().optional(),
    commandText: z.enum(["raw", "status"]).optional(),
    commentary: z.boolean().optional(),
    narration: z.boolean().optional(),
  })
  .strict();
export const ChannelPreviewStreamingConfigSchema = z
  .object({
    mode: UnifiedStreamingModeSchema.optional(),
    chunkMode: TextChunkModeSchema.optional(),
    preview: ChannelStreamingPreviewSchema.optional(),
    progress: ChannelStreamingProgressSchema.optional(),
    block: ChannelStreamingBlockSchema.optional(),
  })
  .strict();

const CommonCapabilitiesSchema = z.array(z.string()).optional();
const CommonIdListSchema = z.array(z.union([z.string(), z.number()])).optional();
const CommonDefaultToSchema = z.string().optional();
const CommonMentionPatternsSchema = MentionPatternsPolicySchema.optional();
const CommonStreamingSchema = ChannelDeliveryStreamingConfigSchema.optional();
const CommonMediaMaxMbSchema = z.number().positive().optional();
const CommonReplyToModeSchema = ReplyToModeSchema.optional();

// Defaults belong only to the channel root: materializing them on an account
// shadows explicit root policy, while removing them entirely can fail open.
const ChannelAccountPolicyDefaults = {
  dmPolicy: DmPolicySchema.optional().default("pairing"),
  groupPolicy: GroupPolicySchema.optional().default("allowlist"),
};

type CommonChannelAccountShapeOptions<
  TCapabilities extends ZodTypeAny = typeof CommonCapabilitiesSchema,
  TAllowFrom extends z.ZodType<Array<string | number> | undefined> = typeof CommonIdListSchema,
  TDefaultTo extends z.ZodType<string | number | undefined> = typeof CommonDefaultToSchema,
  TGroupAllowFrom extends z.ZodType<Array<string | number> | undefined> = typeof CommonIdListSchema,
  TMentionPatterns extends ZodTypeAny = typeof CommonMentionPatternsSchema,
  TStreaming extends ZodTypeAny = typeof CommonStreamingSchema,
  TMediaMaxMb extends ZodTypeAny = typeof CommonMediaMaxMbSchema,
  TReplyToMode extends ZodTypeAny = typeof CommonReplyToModeSchema,
> = {
  omit?: readonly CommonChannelAccountField[];
  capabilities?: TCapabilities;
  allowFrom?: TAllowFrom;
  defaultTo?: TDefaultTo;
  groupAllowFrom?: TGroupAllowFrom;
  mentionPatterns?: TMentionPatterns;
  streaming?: TStreaming;
  mediaMaxMb?: TMediaMaxMb;
  replyToMode?: TReplyToMode;
};

function createCommonChannelAccountShape<
  TCapabilities extends ZodTypeAny = typeof CommonCapabilitiesSchema,
  TAllowFrom extends z.ZodType<Array<string | number> | undefined> = typeof CommonIdListSchema,
  TDefaultTo extends z.ZodType<string | number | undefined> = typeof CommonDefaultToSchema,
  TGroupAllowFrom extends z.ZodType<Array<string | number> | undefined> = typeof CommonIdListSchema,
  TMentionPatterns extends ZodTypeAny = typeof CommonMentionPatternsSchema,
  TStreaming extends ZodTypeAny = typeof CommonStreamingSchema,
  TMediaMaxMb extends ZodTypeAny = typeof CommonMediaMaxMbSchema,
  TReplyToMode extends ZodTypeAny = typeof CommonReplyToModeSchema,
>(
  options: CommonChannelAccountShapeOptions<
    TCapabilities,
    TAllowFrom,
    TDefaultTo,
    TGroupAllowFrom,
    TMentionPatterns,
    TStreaming,
    TMediaMaxMb,
    TReplyToMode
  >,
) {
  return {
    name: z.string().optional(),
    capabilities: (options.capabilities ?? CommonCapabilitiesSchema) as TCapabilities,
    markdown: MarkdownConfigSchema,
    configWrites: z.boolean().optional(),
    enabled: z.boolean().optional(),
    dmPolicy: DmPolicySchema.optional(),
    allowFrom: (options.allowFrom ?? CommonIdListSchema) as TAllowFrom,
    defaultTo: (options.defaultTo ?? CommonDefaultToSchema) as TDefaultTo,
    groupAllowFrom: (options.groupAllowFrom ?? CommonIdListSchema) as TGroupAllowFrom,
    groupPolicy: GroupPolicySchema.optional(),
    mentionPatterns: (options.mentionPatterns ?? CommonMentionPatternsSchema) as TMentionPatterns,
    contextVisibility: ContextVisibilityModeSchema.optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    streaming: (options.streaming ?? CommonStreamingSchema) as TStreaming,
    heartbeatVisibility: ChannelHeartbeatVisibilitySchema,
    healthMonitor: ChannelHealthMonitorSchema,
    responsePrefix: z.string().optional(),
    mediaMaxMb: (options.mediaMaxMb ?? CommonMediaMaxMbSchema) as TMediaMaxMb,
    replyToMode: (options.replyToMode ?? CommonReplyToModeSchema) as TReplyToMode,
  };
}

type CommonChannelAccountShape = ReturnType<typeof createCommonChannelAccountShape>;
type CommonChannelAccountField = keyof CommonChannelAccountShape;

/** Build optional account leaves and separate root-only policy defaults. */
export function buildChannelAccountSchemaParts<
  TCapabilities extends ZodTypeAny = typeof CommonCapabilitiesSchema,
  TAllowFrom extends z.ZodType<Array<string | number> | undefined> = typeof CommonIdListSchema,
  TDefaultTo extends z.ZodType<string | number | undefined> = typeof CommonDefaultToSchema,
  TGroupAllowFrom extends z.ZodType<Array<string | number> | undefined> = typeof CommonIdListSchema,
  TMentionPatterns extends ZodTypeAny = typeof CommonMentionPatternsSchema,
  TStreaming extends ZodTypeAny = typeof CommonStreamingSchema,
  TMediaMaxMb extends ZodTypeAny = typeof CommonMediaMaxMbSchema,
  TReplyToMode extends ZodTypeAny = typeof CommonReplyToModeSchema,
  const TOmit extends readonly CommonChannelAccountField[] = [],
>(
  options: Omit<
    CommonChannelAccountShapeOptions<
      TCapabilities,
      TAllowFrom,
      TDefaultTo,
      TGroupAllowFrom,
      TMentionPatterns,
      TStreaming,
      TMediaMaxMb,
      TReplyToMode
    >,
    "omit"
  > & { omit?: TOmit } = {} as CommonChannelAccountShapeOptions<
    TCapabilities,
    TAllowFrom,
    TDefaultTo,
    TGroupAllowFrom,
    TMentionPatterns,
    TStreaming,
    TMediaMaxMb,
    TReplyToMode
  > & { omit?: TOmit },
) {
  const shape = createCommonChannelAccountShape(options);
  const omitted = new Set<CommonChannelAccountField>(options.omit ?? []);
  const accountShape = Object.fromEntries(
    Object.entries(shape).filter(([key]) => !omitted.has(key as CommonChannelAccountField)),
  ) as Omit<typeof shape, TOmit[number]>;
  return { accountShape, rootPolicyShape: ChannelAccountPolicyDefaults };
}

export const ChannelDangerouslyAllowNameMatchingSchema = z.boolean().optional();
export const ChannelSendReadReceiptsSchema = z.boolean().optional();

/** Build the shared allowBots leaf without widening boolean-only channels. */
export function buildChannelAllowBotsSchema(options?: { allowMentions?: boolean }) {
  return options?.allowMentions
    ? z.union([z.boolean(), z.literal("mentions")]).optional()
    : z.boolean().optional();
}

/** Build native exec-approval routing with channel-specific approver ids and extras. */
export function buildChannelExecApprovalsSchema<T extends ZodRawShape = Record<never, never>>(
  approverSchema: ZodTypeAny,
  extraShape?: T,
) {
  return z
    .object({
      enabled: NativeExecApprovalEnableModeSchema.optional(),
      approvers: z.array(approverSchema).optional(),
      agentFilter: z.array(z.string()).optional(),
      sessionFilter: z.array(z.string()).optional(),
      target: z.enum(["dm", "channel", "both"]).optional(),
      ...(extraShape ?? ({} as T)),
    })
    .strict()
    .optional();
}

export { ChannelBotLoopProtectionSchema };

type ChannelReactionShapeOptions = {
  notificationModes?: readonly [string, string, ...string[]];
  reactionLevels?: readonly [string, string, ...string[]];
  reactionAllowlist?: boolean;
  ackReaction?: ZodTypeAny;
};

/** Build the repeated reaction leaves while retaining each channel's exact enum. */
export function buildChannelReactionShape(options: ChannelReactionShapeOptions) {
  return {
    ...(options.notificationModes
      ? { reactionNotifications: z.enum(options.notificationModes).optional() }
      : {}),
    ...(options.reactionAllowlist
      ? {
          reactionAllowlist: z.array(z.union([z.string(), z.number()])).optional(),
        }
      : {}),
    ...(options.reactionLevels ? { reactionLevel: z.enum(options.reactionLevels).optional() } : {}),
    ...(options.ackReaction ? { ackReaction: options.ackReaction } : {}),
  };
}
