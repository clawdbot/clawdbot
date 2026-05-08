/**
 * @deprecated Legacy compat surface for external plugins that still depend on
 * older broad plugin-sdk imports. Use focused openclaw/plugin-sdk subpaths
 * instead.
 */

import {
  createChannelReplyPipeline as createChannelReplyPipelineCompat,
  createReplyPrefixContext as createReplyPrefixContextCompat,
  createReplyPrefixOptions as createReplyPrefixOptionsCompat,
  createTypingCallbacks as createTypingCallbacksCompat,
  resolveChannelSourceReplyDeliveryMode as resolveChannelSourceReplyDeliveryModeCompat,
  type ChannelReplyPipeline as ChannelReplyPipelineCompat,
  type CreateTypingCallbacksParams as CreateTypingCallbacksParamsCompat,
  type ReplyPrefixContext as ReplyPrefixContextCompat,
  type ReplyPrefixContextBundle as ReplyPrefixContextBundleCompat,
  type ReplyPrefixOptions as ReplyPrefixOptionsCompat,
  type SourceReplyDeliveryMode as SourceReplyDeliveryModeCompat,
  type TypingCallbacks as TypingCallbacksCompat,
} from "./channel-reply-core.js";

const shouldWarnCompatImport =
  process.env.VITEST !== "true" &&
  process.env.NODE_ENV !== "test" &&
  process.env.OPENCLAW_SUPPRESS_PLUGIN_SDK_COMPAT_WARNING !== "1";

if (shouldWarnCompatImport) {
  process.emitWarning(
    "openclaw/plugin-sdk/compat is deprecated for new plugins. Migrate to focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration",
    {
      code: "OPENCLAW_PLUGIN_SDK_COMPAT_DEPRECATED",
      detail:
        "Bundled plugins must use scoped plugin-sdk subpaths. External plugins may keep compat temporarily while migrating. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration",
    },
  );
}

export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type {
  MemoryPluginCapability,
  MemoryPluginPublicArtifact,
  MemoryPluginPublicArtifactsProvider,
} from "../plugins/memory-state.js";
export { resolveControlCommandGate } from "../channels/command-gating.js";
export {
  buildMemorySystemPromptAddition,
  delegateCompactionToRuntime,
} from "../context-engine/delegate.js";
export { registerContextEngine } from "../context-engine/registry.js";
export type { DiagnosticEventPayload } from "../infra/diagnostic-events.js";
export { onDiagnosticEvent } from "../infra/diagnostic-events.js";
export { optionalStringEnum, stringEnum } from "../agents/schema/typebox.js";
export {
  applyAuthProfileConfig,
  buildApiKeyCredential,
  upsertApiKeyProfile,
  writeOAuthCredentials,
  type ApiKeyStorageOptions,
  type WriteOAuthCredentialsOptions,
} from "../plugins/provider-auth-helpers.js";

export { createAccountStatusSink } from "./channel-lifecycle.core.js";
export { createPluginRuntimeStore } from "./runtime-store.js";
export { KeyedAsyncQueue } from "./keyed-async-queue.js";
export { normalizeAccountId } from "./account-id.js";
export { resolvePreferredOpenClawTmpDir } from "./temp-path.js";

export {
  createHybridChannelConfigAdapter,
  createHybridChannelConfigBase,
  createScopedAccountConfigAccessors,
  createScopedChannelConfigAdapter,
  createScopedChannelConfigBase,
  createScopedDmSecurityResolver,
  createTopLevelChannelConfigAdapter,
  createTopLevelChannelConfigBase,
  mapAllowFromEntries,
} from "./channel-config-helpers.js";
export { formatAllowFromLowercase, formatNormalizedAllowFromEntries } from "./allow-from.js";
export * from "./channel-config-schema.js";
export * from "./channel-policy.js";
export { collectOpenGroupPolicyConfiguredRouteWarnings } from "./channel-policy.js";
export * from "./reply-history.js";
export * from "./directory-runtime.js";
export { mapAllowlistResolutionInputs } from "./allow-from.js";

/** @deprecated Use `openclaw/plugin-sdk/channel-message`. */
export const createChannelReplyPipeline = createChannelReplyPipelineCompat;
/** @deprecated Use `openclaw/plugin-sdk/channel-message`. */
export const createReplyPrefixContext = createReplyPrefixContextCompat;
/** @deprecated Use `openclaw/plugin-sdk/channel-message`. */
export const createReplyPrefixOptions = createReplyPrefixOptionsCompat;
/** @deprecated Use `openclaw/plugin-sdk/channel-message`. */
export const createTypingCallbacks = createTypingCallbacksCompat;
/** @deprecated Use `openclaw/plugin-sdk/channel-message`. */
export const resolveChannelSourceReplyDeliveryMode = resolveChannelSourceReplyDeliveryModeCompat;
/** @deprecated Use `openclaw/plugin-sdk/channel-message`. */
export type ChannelReplyPipeline = ChannelReplyPipelineCompat;
/** @deprecated Use `openclaw/plugin-sdk/channel-message`. */
export type CreateTypingCallbacksParams = CreateTypingCallbacksParamsCompat;
/** @deprecated Use `openclaw/plugin-sdk/channel-message`. */
export type ReplyPrefixContext = ReplyPrefixContextCompat;
/** @deprecated Use `openclaw/plugin-sdk/channel-message`. */
export type ReplyPrefixContextBundle = ReplyPrefixContextBundleCompat;
/** @deprecated Use `openclaw/plugin-sdk/channel-message`. */
export type ReplyPrefixOptions = ReplyPrefixOptionsCompat;
/** @deprecated Use `openclaw/plugin-sdk/channel-message`. */
export type SourceReplyDeliveryMode = SourceReplyDeliveryModeCompat;
/** @deprecated Use `openclaw/plugin-sdk/channel-message`. */
export type TypingCallbacks = TypingCallbacksCompat;
