/**
 * Shared config-schema primitives for channel plugins with DM/group policy knobs.
 *
 * Canonical config-schema module: internal/bundled code imports this subpath;
 * the primitives/bundled/legacy facades are re-export shells over it.
 */
export {
  AllowFromListSchema,
  ChannelGroupEntrySchema,
  buildChannelConfigSchema,
  buildCatchallMultiAccountChannelSchema,
  buildGroupEntrySchema,
  buildJsonChannelConfigSchema,
  buildMultiAccountChannelSchema,
  buildNestedDmConfigSchema,
} from "../channels/plugins/config-schema.js";
export {
  BlockStreamingChunkSchema,
  BlockStreamingCoalesceSchema,
  ChannelDeliveryStreamingConfigSchema,
  ChannelStreamingBlockSchema,
  ContextVisibilityModeSchema,
  DmConfigSchema,
  DmPolicySchema,
  ExecutableTokenSchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  MentionPatternsPolicySchema,
  ProviderCommandsSchema,
  ReplyToModeSchema,
  ReplyRuntimeConfigSchemaShape,
  TextChunkModeSchema,
  requireAllowlistAllowFrom,
  requireOpenAllowFrom,
} from "../config/zod-schema.core.js";
export {
  buildChannelAllowBotsSchema,
  buildChannelExecApprovalsSchema,
  buildChannelReactionShape,
  buildCommonChannelAccountShape,
  ChannelBotLoopProtectionSchema,
  ChannelDangerouslyAllowNameMatchingSchema,
  ChannelPreviewStreamingConfigSchema,
  ChannelSendReadReceiptsSchema,
  ChannelStreamingProgressSchema,
  ChannelStreamingPreviewSchema,
  UnifiedStreamingModeSchema,
} from "../config/zod-schema.channel-messaging-common.js";
export { ChannelImplicitMentionsSchema } from "../config/zod-schema.implicit-mentions.js";
export { ToolPolicySchema } from "../config/zod-schema.agent-runtime.js";
