import type { ClawdbotConfig } from "../../config/config.js";
import type { DmPolicy } from "../../config/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import type { ProviderChoice } from "../onboard-types.js";

export type SetupProvidersOptions = {
  allowDisable?: boolean;
  allowSignalInstall?: boolean;
  onSelection?: (selection: ProviderChoice[]) => void;
  accountIds?: Partial<Record<ProviderChoice, string>>;
  onAccountId?: (provider: ProviderChoice, accountId: string) => void;
  promptAccountIds?: boolean;
  whatsappAccountId?: string;
  promptWhatsAppAccountId?: boolean;
  onWhatsAppAccountId?: (accountId: string) => void;
  forceAllowFromProviders?: ProviderChoice[];
  skipDmPolicyPrompt?: boolean;
  skipConfirm?: boolean;
  quickstartDefaults?: boolean;
  initialSelection?: ProviderChoice[];
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
  provider: ProviderChoice;
  configured: boolean;
  statusLines: string[];
  selectionHint?: string;
  quickstartScore?: number;
};

export type ProviderOnboardingStatusContext = {
  cfg: ClawdbotConfig;
  options?: SetupProvidersOptions;
  accountOverrides: Partial<Record<ProviderChoice, string>>;
};

export type ProviderOnboardingConfigureContext = {
  cfg: ClawdbotConfig;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  options?: SetupProvidersOptions;
  accountOverrides: Partial<Record<ProviderChoice, string>>;
  shouldPromptAccountIds: boolean;
  forceAllowFrom: boolean;
};

export type ProviderOnboardingResult = {
  cfg: ClawdbotConfig;
  accountId?: string;
};

export type ProviderOnboardingDmPolicy = {
  label: string;
  provider: ProviderChoice;
  policyKey: string;
  allowFromKey: string;
  getCurrent: (cfg: ClawdbotConfig) => DmPolicy;
  setPolicy: (cfg: ClawdbotConfig, policy: DmPolicy) => ClawdbotConfig;
};

export type ProviderOnboardingAdapter = {
  provider: ProviderChoice;
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
