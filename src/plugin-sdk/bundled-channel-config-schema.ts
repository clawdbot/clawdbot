/**
 * Bundled-channel config schemas for OpenClaw-maintained plugins.
 *
 * Third-party plugins should define plugin-local schemas and import primitives
 * from openclaw/plugin-sdk/channel-config-schema instead of depending on these
 * bundled channel schemas. Internal callers use this subpath only for the
 * bundled provider schemas; generic primitives come from channel-config-schema.
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
  ContextVisibilityModeSchema,
  DmConfigSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ReplyRuntimeConfigSchemaShape,
  requireAllowlistAllowFrom,
  requireOpenAllowFrom,
  ToolPolicySchema,
} from "./channel-config-schema.js";
export {
  DiscordConfigSchema,
  IMessageConfigSchema,
  MSTeamsConfigSchema,
  TelegramConfigSchema,
} from "../config/zod-schema.providers-core.js";
export { GoogleChatConfigSchema } from "../config/zod-schema.providers-googlechat.js";
export { WhatsAppConfigSchema } from "../config/zod-schema.providers-whatsapp.js";
