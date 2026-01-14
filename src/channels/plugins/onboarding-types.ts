import type { ClawdbotConfig } from "../../config/config.js";
import type { DmPolicy } from "../../config/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import type { ChatChannelId } from "../registry.js";

export type SetupChannelsOptions = {
  allowDisable?: boolean;
  allowSignalInstall?: boolean;
  onSelection?: (selection: ChatChannelId[]) => void;
  accountIds?: Partial<Record<ChatChannelId, string>>;
  onAccountId?: (channel: ChatChannelId, accountId: string) => void;
  promptAccountIds?: boolean;
  whatsappAccountId?: string;
  promptWhatsAppAccountId?: boolean;
  onWhatsAppAccountId?: (accountId: string) => void;
  forceAllowFromChannels?: ChatChannelId[];
  skipDmPolicyPrompt?: boolean;
  skipConfirm?: boolean;
  quickstartDefaults?: boolean;
  initialSelection?: ChatChannelId[];
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

export type ChannelOnboardingStatus = {
  channel: ChatChannelId;
  configured: boolean;
  statusLines: string[];
  selectionHint?: string;
  quickstartScore?: number;
};

export type ChannelOnboardingStatusContext = {
  cfg: ClawdbotConfig;
  options?: SetupChannelsOptions;
  accountOverrides: Partial<Record<ChatChannelId, string>>;
};

export type ChannelOnboardingConfigureContext = {
  cfg: ClawdbotConfig;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  options?: SetupChannelsOptions;
  accountOverrides: Partial<Record<ChatChannelId, string>>;
  shouldPromptAccountIds: boolean;
  forceAllowFrom: boolean;
};

export type ChannelOnboardingResult = {
  cfg: ClawdbotConfig;
  accountId?: string;
};

export type ChannelOnboardingDmPolicy = {
  label: string;
  channel: ChatChannelId;
  policyKey: string;
  allowFromKey: string;
  getCurrent: (cfg: ClawdbotConfig) => DmPolicy;
  setPolicy: (cfg: ClawdbotConfig, policy: DmPolicy) => ClawdbotConfig;
};

export type ChannelOnboardingAdapter = {
  channel: ChatChannelId;
  getStatus: (
    ctx: ChannelOnboardingStatusContext,
  ) => Promise<ChannelOnboardingStatus>;
  configure: (
    ctx: ChannelOnboardingConfigureContext,
  ) => Promise<ChannelOnboardingResult>;
  dmPolicy?: ChannelOnboardingDmPolicy;
  onAccountRecorded?: (
    accountId: string,
    options?: SetupChannelsOptions,
  ) => void;
  disable?: (cfg: ClawdbotConfig) => ClawdbotConfig;
};
