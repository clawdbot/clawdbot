// Shared setup wizard/types/helpers for plugin and channel setup surfaces.

export type { OpenClawConfig } from "../config/config.js";
export type { DmPolicy } from "../config/types.js";
// Registry readers (2026-07-22): @nodeskai/feishu, openclaw-channel-whatsapp-official,
// openclaw-vk, openclaw-ndr, moltbot-channel-feishu, @kagura-agent/openclaw-zulip,
// @jeik/dingtalk-connector, @xzq-xu/feishu, @dingtalk-real-ai/dingtalk-connector,
// @openclaw-vk/vk, yzw-dingtalk-connector, and openclaw-channel-zulip.
export type { GroupPolicy } from "../config/types.js";
export type { SecretInput } from "../config/types.secrets.js";
export type {
  WizardMultiSelectParams,
  WizardProgress,
  WizardPrompter,
  // Registry reader (2026-07-22): @ama2/openclaw-channel.
  WizardSelectParams,
} from "../wizard/prompts.js";
export { WizardCancelledError } from "../wizard/prompts.js";
export { createSetupTranslator } from "../wizard/i18n/index.js";
export type { ChannelSetupAdapter } from "../channels/plugins/types.adapters.js";
export type { ChannelSetupInput } from "../channels/plugins/types.core.js";
export type {
  ChannelSetupDmPolicy,
  ChannelSetupWizardAdapter,
  ChannelSetupWizard,
} from "../channels/plugins/setup-wizard-types.js";

export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
export { formatCliCommand } from "../cli/command-format.js";
export { detectBinary } from "../infra/detect-binary.js";
export { formatDocsLink } from "../../packages/terminal-core/src/links.js";
export { hasConfiguredSecretInput, normalizeSecretInputString } from "../config/types.secrets.js";
// Registry readers (2026-07-22): @cyzlmh/openclaw-sms, @spicerhome/claw-messenger,
// @chatu-ai/webhub, @rowger_go/chatu, and @emotion-machine/claw-messenger.
export { normalizeE164 } from "../utils.js";
// Registry readers (2026-07-22): openclaw-rcs, @woowonjae/rol-websocket-channel,
// openclaw-swarm-layer, rol-websocket-channel, @clawling/clawchat-plugin-openclaw,
// @workclaw/openclaw-workclaw, clawspec, and @privateclaw/privateclaw.
export { pathExists } from "../utils.js";

export {
  moveSingleAccountChannelSectionToDefaultAccount,
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  createSetupInputPresenceValidator,
  createPatchedAccountSetupAdapter,
  migrateBaseNameToDefaultAccount,
  patchScopedAccountConfig,
  prepareScopedSetupConfig,
} from "../channels/plugins/setup-helpers.js";
export {
  addWildcardAllowFrom,
  buildSingleChannelSecretPromptState,
  // Registry reader (2026-07-22): @lansenger-pm/openclaw-lansenger-channel.
  createAccountScopedAllowFromSection,
  createAllowFromSection,
  createPromptParsedAllowFromForAccount,
  createStandardChannelSetupStatus,
  createTopLevelChannelAllowFromSetter,
  createTopLevelChannelDmPolicy,
  createTopLevelChannelDmPolicySetter,
  createTopLevelChannelGroupPolicySetter,
  createTopLevelChannelParsedAllowFromPrompt,
  mergeAllowFromEntries,
  normalizeAllowFromEntries,
  parseSetupEntriesWithParser,
  patchTopLevelChannelConfigSection,
  patchChannelConfigForAccount,
  promptAccountId,
  promptSingleChannelSecretInput,
  // Registry reader (2026-07-22): openclaw-channel-xiaozhu.
  resolveSetupAccountId,
  runSingleChannelSecretStep,
  setSetupChannelEnabled,
  // Registry readers (2026-07-22): openclaw-vk and @openclaw-vk/vk.
  setTopLevelChannelDmPolicyWithAllowFrom,
  splitSetupEntries,
} from "../channels/plugins/setup-wizard-helpers.js";
export { promptChannelAccessConfig } from "../channels/plugins/setup-group-access.js";
export { createDelegatedSetupWizardProxy } from "../channels/plugins/setup-wizard-proxy.js";
export { createDetectedBinaryStatus } from "../channels/plugins/setup-wizard-binary.js";

export { formatResolvedUnresolvedNote } from "./resolution-notes.js";
export { baseUrlTextInput, defineTokenCredential } from "./setup-credential.js";
