import type { ClawdbotConfig } from "../../config/config.js";
import type { DmPolicy } from "../../config/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import type { ChatProviderId } from "../registry.js";

export type SetupProvidersOptions = {
  allowDisable?: boolean;
  allowSignalInstall?: boolean;
  onSelection?: (selection: ChatProviderId[]) => void;
  accountIds?: Partial<Record<ChatProviderId, string>>;
  onAccountId?: (provider: ChatProviderId, accountId: string) => void;
  promptAccountIds?: boolean;
  whatsappAccountId?: string;
  promptWhatsAppAccountId?: boolean;
  onWhatsAppAccountId?: (accountId: string) => void;
  forceAllowFromProviders?: ChatProviderId[];
  skipDmPolicyPrompt?: boolean;
  skipConfirm?: boolean;
  quickstartDefaults?: boolean;
  initialSelection?: ChatProviderId[];
};

export type PromptAccountIdParams = {
  cfg: ClawdbotConfig;
  prompter: WizardPrompter;
  label: string;
  currentId?: string;
  listAccountIds: (cfg: ClawdbotConfig) => string[];
  defaultAccountId: string;
};

export type PromptAccountId = (
  params: PromptAccountIdParams,
) => Promise<string>;

export type ProviderOnboardingStatus = {
  provider: ChatProviderId;
  configured: boolean;
  statusLines: string[];
  selectionHint?: string;
  quickstartScore?: number;
};

export type ProviderOnboardingStatusContext = {
  cfg: ClawdbotConfig;
  options?: SetupProvidersOptions;
  accountOverrides: Partial<Record<ChatProviderId, string>>;
};

export type ProviderOnboardingConfigureContext = {
  cfg: ClawdbotConfig;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  options?: SetupProvidersOptions;
  accountOverrides: Partial<Record<ChatProviderId, string>>;
  shouldPromptAccountIds: boolean;
  forceAllowFrom: boolean;
};

export type ProviderOnboardingResult = {
  cfg: ClawdbotConfig;
  accountId?: string;
};

export type ProviderOnboardingDmPolicy = {
  label: string;
  provider: ChatProviderId;
  policyKey: string;
  allowFromKey: string;
  getCurrent: (cfg: ClawdbotConfig) => DmPolicy;
  setPolicy: (cfg: ClawdbotConfig, policy: DmPolicy) => ClawdbotConfig;
};

export type ProviderOnboardingAdapter = {
  provider: ChatProviderId;
  getStatus: (
    ctx: ProviderOnboardingStatusContext,
  ) => Promise<ProviderOnboardingStatus>;
  configure: (
    ctx: ProviderOnboardingConfigureContext,
  ) => Promise<ProviderOnboardingResult>;
  dmPolicy?: ProviderOnboardingDmPolicy;
  onAccountRecorded?: (
    accountId: string,
    options?: SetupProvidersOptions,
  ) => void;
  disable?: (cfg: ClawdbotConfig) => ClawdbotConfig;
};
