// Shared setup wizard/types/helpers for extension setup surfaces and adapters.

export type { OpenClawConfig } from "../config/config.js";
export type { DmPolicy, GroupPolicy } from "../config/types.js";
export type { SecretInput } from "../config/types.secrets.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export type { ChannelSetupAdapter } from "../channels/plugins/types.adapters.js";
export type { ChannelSetupInput } from "../channels/plugins/types.core.js";
export type { ChannelSetupDmPolicy } from "../channels/plugins/setup-wizard-types.js";
export type {
  ChannelSetupWizard,
  ChannelSetupWizardAllowFromEntry,
  ChannelSetupWizardTextInput,
} from "../channels/plugins/setup-wizard.js";

export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
export { formatCliCommand } from "../cli/command-format.js";
export { detectBinary } from "../plugins/setup-binary.js";
export { installSignalCli } from "../plugins/signal-cli-install.js";
export { formatDocsLink } from "../terminal/links.js";
export { hasConfiguredSecretInput, normalizeSecretInputString } from "../config/types.secrets.js";
export { normalizeE164, pathExists } from "../utils.js";

export {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  createEnvPatchedAccountSetupAdapter,
  createPatchedAccountSetupAdapter,
  migrateBaseNameToDefaultAccount,
  patchScopedAccountConfig,
  prepareScopedSetupConfig,
} from "../channels/plugins/setup-helpers.js";
export {
  addWildcardAllowFrom,
  buildSingleChannelSecretPromptState,
  createAccountScopedAllowFromSection,
  createAccountScopedGroupAccessSection,
  createAllowFromSection,
  createLegacyCompatChannelDmPolicy,
  createNestedChannelAllowFromSetter,
  createNestedChannelDmPolicy,
  createNestedChannelDmPolicySetter,
  createTopLevelChannelAllowFromSetter,
  createTopLevelChannelDmPolicy,
  createTopLevelChannelDmPolicySetter,
  createTopLevelChannelGroupPolicySetter,
  mergeAllowFromEntries,
  normalizeAllowFromEntries,
  noteChannelLookupFailure,
  noteChannelLookupSummary,
  parseMentionOrPrefixedId,
  parseSetupEntriesAllowingWildcard,
  parseSetupEntriesWithParser,
  patchNestedChannelConfigSection,
  patchTopLevelChannelConfigSection,
  patchChannelConfigForAccount,
  promptLegacyChannelAllowFrom,
  promptLegacyChannelAllowFromForAccount,
  promptParsedAllowFromForAccount,
  promptParsedAllowFromForScopedChannel,
  promptSingleChannelSecretInput,
  promptResolvedAllowFrom,
  resolveParsedAllowFromEntries,
  resolveEntriesWithOptionalToken,
  resolveSetupAccountId,
  resolveGroupAllowlistWithLookupNotes,
  runSingleChannelSecretStep,
  setAccountAllowFromForChannel,
  setAccountDmAllowFromForChannel,
  setAccountGroupPolicyForChannel,
  setChannelDmPolicyWithAllowFrom,
  setLegacyChannelDmPolicyWithAllowFrom,
  setNestedChannelAllowFrom,
  setNestedChannelDmPolicyWithAllowFrom,
  setSetupChannelEnabled,
  setTopLevelChannelAllowFrom,
  setTopLevelChannelDmPolicyWithAllowFrom,
  setTopLevelChannelGroupPolicy,
  splitSetupEntries,
} from "../channels/plugins/setup-wizard-helpers.js";
export { createAllowlistSetupWizardProxy } from "../channels/plugins/setup-wizard-proxy.js";
export {
  createDelegatedFinalize,
  createDelegatedPrepare,
  createDelegatedResolveConfigured,
  createDelegatedSetupWizardProxy,
} from "../channels/plugins/setup-wizard-proxy.js";
export {
  createCliPathTextInput,
  createDelegatedSetupWizardStatusResolvers,
  createDelegatedTextInputShouldPrompt,
  createDetectedBinaryStatus,
} from "../channels/plugins/setup-wizard-binary.js";

export { formatResolvedUnresolvedNote } from "./resolution-notes.js";

function hasPresentSetupValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return value !== undefined && value !== null && value !== false;
}

export function createSetupInputPresenceValidator(params: {
  defaultAccountOnlyEnvError?: string;
  whenNotUseEnv?: Array<{ someOf: string[]; message: string }>;
  validate?: (params: { accountId: string; input: Record<string, unknown> }) => string | null | undefined;
}) {
  return (validationParams: { accountId: string; input: Record<string, unknown> }) => {
    const accountId = validationParams.accountId;
    const input = validationParams.input ?? {};
    const useEnv = input.useEnv === true;

    if (useEnv && params.defaultAccountOnlyEnvError && accountId !== DEFAULT_ACCOUNT_ID) {
      return params.defaultAccountOnlyEnvError;
    }

    if (!useEnv) {
      for (const rule of params.whenNotUseEnv ?? []) {
        const hasAny = rule.someOf.some((key) => hasPresentSetupValue(input[key]));
        if (!hasAny) {
          return rule.message;
        }
      }
    }

    return params.validate?.({ accountId, input }) ?? null;
  };
}

export function createStandardChannelSetupStatus(params: {
  channelLabel: string;
  configuredLabel: string;
  unconfiguredLabel: string;
  configuredHint: string;
  unconfiguredHint: string;
  configuredScore: number;
  unconfiguredScore: number;
  includeStatusLine?: boolean;
  resolveConfigured: (params: {
    cfg: OpenClawConfig;
    accountId?: string;
  }) => boolean | Promise<boolean>;
}) {
  return {
    configuredLabel: params.configuredLabel,
    unconfiguredLabel: params.unconfiguredLabel,
    configuredHint: params.configuredHint,
    unconfiguredHint: params.unconfiguredHint,
    configuredScore: params.configuredScore,
    unconfiguredScore: params.unconfiguredScore,
    resolveConfigured: params.resolveConfigured,
    resolveStatusLines: async (statusParams: { cfg: OpenClawConfig; accountId?: string; configured: boolean }) =>
      params.includeStatusLine === false
        ? []
        : [
            `${params.channelLabel}: ${
              statusParams.configured ? params.configuredLabel : params.unconfiguredLabel
            }`,
          ],
    resolveSelectionHint: async (hintParams: { cfg: OpenClawConfig; accountId?: string }) =>
      (await params.resolveConfigured(hintParams)) ? params.configuredHint : params.unconfiguredHint,
    resolveQuickstartScore: async (scoreParams: { cfg: OpenClawConfig; accountId?: string }) =>
      (await params.resolveConfigured(scoreParams))
        ? params.configuredScore
        : params.unconfiguredScore,
  };
}
