// Private helper surface for the bundled googlechat plugin.
// Keep this list additive and scoped to the bundled Google Chat surface.

import { resolveChannelGroupRequireMention } from "./channel-policy.js";
import { createOptionalChannelSetupSurface } from "./channel-setup.js";

export {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
} from "../agents/tools/common.js";
export {
  resolveMentionGating,
  resolveMentionGatingWithBypass,
  resolveInboundMentionDecision,
} from "../channels/mention-gating.js";
export { getChatChannelMeta } from "../channels/chat-meta.js";
export {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
export {
  listDirectoryGroupEntriesFromMapKeys,
  listDirectoryUserEntriesFromAllowFrom,
} from "../channels/plugins/directory-config-helpers.js";
export { buildComputedAccountStatusSnapshot } from "./status-helpers.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export { createAccountStatusSink, runPassiveAccountLifecycle } from "./channel-lifecycle.core.js";
export { formatPairingApproveHint } from "../channels/plugins/helpers.js";
export { fetchRemoteMedia } from "../media/fetch.js";
export { resolveChannelMediaMaxBytes } from "../channels/plugins/media-limits.js";
export { loadOutboundMediaFromUrl } from "./outbound-media.js";
export { loadWebMedia } from "./web-media.js";
export { chunkTextForOutbound } from "./text-chunking.js";
export {
  addWildcardAllowFrom,
  mergeAllowFromEntries,
  splitSetupEntries,
  setTopLevelChannelDmPolicyWithAllowFrom,
} from "../channels/plugins/setup-wizard-helpers.js";
export { PAIRING_APPROVED_MESSAGE } from "../channels/plugins/pairing-message.js";
export {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  migrateBaseNameToDefaultAccount,
} from "../channels/plugins/setup-helpers.js";
export { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
export type {
  ChannelAccountSnapshot,
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelStatusIssue,
} from "../channels/plugins/types.public.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export { createChannelReplyPipeline } from "./channel-reply-pipeline.js";
export type { OpenClawConfig } from "../config/config.js";
export { isDangerousNameMatchingEnabled } from "../config/dangerous-name-matching.js";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../config/runtime-group-policy.js";
export type { DmPolicy, GoogleChatAccountConfig, GoogleChatConfig } from "../config/types.js";
export { isSecretRef } from "../config/types.secrets.js";
export { GoogleChatConfigSchema } from "../config/zod-schema.providers-core.js";
export { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
export { missingTargetError } from "../infra/outbound/target-errors.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
export { resolveDmGroupAccessWithLists } from "../security/dm-policy-shared.js";
export { formatDocsLink } from "../terminal/links.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export { resolveInboundRouteEnvelopeBuilderWithRuntime } from "./inbound-envelope.js";
export { createChannelPairingController } from "./channel-pairing.js";
export {
  evaluateGroupRouteAccessForPolicy,
  resolveSenderScopedGroupPolicy,
} from "./group-access.js";
export { extractToolSend } from "./tool-send.js";
export {
  beginWebhookRequestPipelineOrReject,
  createWebhookInFlightLimiter,
  readJsonWebhookBodyOrReject,
  registerWebhookTargetWithPluginRoute,
  resolveWebhookPath,
  resolveWebhookTargetWithAuthOrReject,
  resolveWebhookTargets,
  type WebhookInFlightLimiter,
  withResolvedWebhookRequestPipeline,
} from "./webhook-ingress.js";

type GoogleChatGroupContext = {
  cfg: import("../config/config.js").OpenClawConfig;
  accountId?: string | null;
  groupId?: string | null;
};

export function resolveGoogleChatGroupRequireMention(params: GoogleChatGroupContext): boolean {
  return resolveChannelGroupRequireMention({
    cfg: params.cfg,
    channel: "googlechat",
    groupId: params.groupId,
    accountId: params.accountId,
  });
}

const googlechatSetup = createOptionalChannelSetupSurface({
  channel: "googlechat",
  label: "Google Chat",
  npmSpec: "@openclaw/googlechat",
  docsPath: "/channels/googlechat",
});

export const googlechatSetupAdapter = googlechatSetup.setupAdapter;
export const googlechatSetupWizard = googlechatSetup.setupWizard;
