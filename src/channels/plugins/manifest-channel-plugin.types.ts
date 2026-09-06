import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChannelConfigSchema } from "./types.config.js";

type ManifestChannelAccount = {
  accountId: string;
  name?: string;
  config: Record<string, unknown>;
};

/** Metadata adapters expose account inspection without loading channel runtime contracts. */
export type ManifestChannelPlugin = {
  id: string;
  meta: {
    id: string;
    label: string;
    selectionLabel: string;
    docsPath: string;
    blurb: string;
    preferOver?: readonly string[];
  };
  capabilities: { chatTypes: ["direct"] };
  commands?: {
    nativeCommandsAutoEnabled?: boolean;
    nativeSkillsAutoEnabled?: boolean;
  };
  configSchema?: ChannelConfigSchema;
  config: {
    listAccountIds: (cfg: OpenClawConfig) => string[];
    defaultAccountId: (cfg: OpenClawConfig) => string;
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ManifestChannelAccount;
    isEnabled: (account: ManifestChannelAccount, cfg: OpenClawConfig) => boolean;
    isConfigured: (account: ManifestChannelAccount, cfg: OpenClawConfig) => boolean;
    hasConfiguredState: (params: { cfg: OpenClawConfig; env?: NodeJS.ProcessEnv }) => boolean;
  };
};
