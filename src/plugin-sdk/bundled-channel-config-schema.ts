/**
 * Bundled-channel config schemas for OpenClaw-maintained plugins.
 *
 * Third-party plugins should define plugin-local schemas and import primitives
 * from openclaw/plugin-sdk/channel-config-schema instead of depending on these
 * bundled channel schemas. Internal callers use this subpath only for the
 * bundled provider schemas; generic primitives come from channel-config-schema.
 */
import { z, type ZodObject, type ZodOptional, type ZodType } from "zod";
import type { OpenClawConfig } from "./config-contracts.js";
import {
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-loader.js";

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

function createLegacyExternalChannelConfigSchema() {
  return z.object({}).passthrough();
}

/**
 * @deprecated Compatibility for external channel packages published through 2026.7.1.
 * Their package manifests remain the validation owner. Remove after the minimum supported
 * Slack, Discord, Signal, and Teams packages use plugin-owned config schemas.
 */
export const SlackConfigSchema = createLegacyExternalChannelConfigSchema();
/** @deprecated See SlackConfigSchema. */
export const DiscordConfigSchema = createLegacyExternalChannelConfigSchema();
/** @deprecated See SlackConfigSchema. */
export const SignalConfigSchema = createLegacyExternalChannelConfigSchema();
/** @deprecated See SlackConfigSchema. */
export const MSTeamsConfigSchema = createLegacyExternalChannelConfigSchema();

type ChannelConfig = NonNullable<OpenClawConfig["channels"]>;
type ConfigSchemaShape<TOutput extends object> = {
  -readonly [K in keyof TOutput]-?: Pick<TOutput, K> extends Required<Pick<TOutput, K>>
    ? ZodType<TOutput[K]>
    : ZodOptional<ZodType<Exclude<TOutput[K], undefined>>>;
};
type BundledObjectConfigSchema<TOutput extends object> = ZodObject<ConfigSchemaShape<TOutput>>;
type BundledConfigSchemaModule<TOutput extends object> = Record<
  string,
  BundledObjectConfigSchema<TOutput>
>;

function loadBundledConfigSchema<TOutput extends object>(
  dirName: string,
  exportName: string,
): BundledObjectConfigSchema<TOutput> {
  const schema = loadBundledPluginPublicSurfaceModuleSync<BundledConfigSchemaModule<TOutput>>({
    dirName,
    artifactBasename: "config-api.js",
  })[exportName];
  if (!schema) {
    throw new Error(`Bundled plugin ${dirName} config API does not export ${exportName}`);
  }
  return schema;
}

export const IMessageConfigSchema = createLazyFacadeObjectValue<
  BundledObjectConfigSchema<NonNullable<ChannelConfig["imessage"]>>
>(() =>
  loadBundledConfigSchema<NonNullable<ChannelConfig["imessage"]>>(
    "imessage",
    "IMessageConfigSchema",
  ),
);
export const TelegramConfigSchema = createLazyFacadeObjectValue<
  BundledObjectConfigSchema<NonNullable<ChannelConfig["telegram"]>>
>(() =>
  loadBundledConfigSchema<NonNullable<ChannelConfig["telegram"]>>(
    "telegram",
    "TelegramConfigSchema",
  ),
);
export { GoogleChatConfigSchema } from "../config/zod-schema.providers-googlechat.js";
export { WhatsAppConfigSchema } from "../config/zod-schema.providers-whatsapp.js";
