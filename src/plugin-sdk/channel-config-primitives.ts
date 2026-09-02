/**
 * Narrow channel config-schema primitives without provider-schema re-exports.
 *
 * Re-export shell over openclaw/plugin-sdk/channel-config-schema, kept for
 * third-party plugins until the next SDK break train. Internal and bundled
 * code imports openclaw/plugin-sdk/channel-config-schema directly.
 */
export {
  AllowFromListSchema,
  ChannelGroupEntrySchema,
  BlockStreamingCoalesceSchema,
  buildCatchallMultiAccountChannelSchema,
  buildChannelConfigSchema,
  buildNestedDmConfigSchema,
  buildGroupEntrySchema,
  buildMultiAccountChannelSchema,
  DmConfigSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ReplyRuntimeConfigSchemaShape,
  requireAllowlistAllowFrom,
  requireOpenAllowFrom,
} from "./channel-config-schema.js";
