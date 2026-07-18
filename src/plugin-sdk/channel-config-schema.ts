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
  BlockStreamingCoalesceSchema,
  ContextVisibilityModeSchema,
  DmConfigSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  MentionPatternsPolicySchema,
  ReplyRuntimeConfigSchemaShape,
  requireAllowlistAllowFrom,
  requireOpenAllowFrom,
} from "../config/zod-schema.core.js";
export { ChannelImplicitMentionsSchema } from "../config/zod-schema.implicit-mentions.js";
export { ToolPolicySchema } from "../config/zod-schema.agent-runtime.js";
