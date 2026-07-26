import { createChannelDmPolicy } from "openclaw/plugin-sdk/channel-dm-policy";
import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
// Zalo plugin module implements setup core behavior.
import {
  createDelegatedSetupWizardProxy,
  createPatchedAccountSetupAdapter,
  createSetupInputPresenceValidator,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  createSetupTranslator,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup";
import { resolveDefaultZaloAccountId, resolveZaloAccount } from "./accounts.js";
import { promptZaloAllowFrom } from "./setup-allow-from.js";

const t = createSetupTranslator();

const channel = "zalo" as const;

type ZaloAccountSetupConfig = {
  enabled?: boolean;
  dmPolicy?: string;
  allowFrom?: Array<string | number> | ReadonlyArray<string | number>;
};

export const zaloSetupAdapter = {
  ...createPatchedAccountSetupAdapter({
    channelKey: channel,
    validateInput: createSetupInputPresenceValidator({
      defaultAccountOnlyEnvError: "ZALO_BOT_TOKEN can only be used for the default account.",
      whenNotUseEnv: [
        {
          someOf: ["token", "tokenFile"],
          message: "Zalo requires token or --token-file (or --use-env).",
        },
      ],
    }),
    buildPatch: (input) =>
      input.useEnv
        ? {}
        : input.tokenFile
          ? { tokenFile: input.tokenFile }
          : input.token
            ? { botToken: input.token }
            : {},
  }),
  singleAccountKeysToMove: ["webhookSecret", "tokenFile"],
};

export const zaloSetupContract = defineChannelSetupContract({
  fields: {
    token: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--token <token>", description: "Zalo bot token" },
    },
    tokenFile: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--token-file <path>", description: "Zalo bot token file" },
    },
    useEnv: {
      kind: "boolean",
      cli: { flags: "--use-env", description: "Use ZALO_BOT_TOKEN" },
    },
  },
  legacyAdapter: zaloSetupAdapter,
});

export const zaloDmPolicy = createChannelDmPolicy({
  label: "Zalo",
  channel,
  resolveAccount: (cfg, accountId) => {
    const resolvedAccountId =
      accountId && normalizeAccountId(accountId)
        ? (normalizeAccountId(accountId) ?? DEFAULT_ACCOUNT_ID)
        : resolveDefaultZaloAccountId(cfg);
    return resolveZaloAccount({ cfg, accountId: resolvedAccountId });
  },
  applyPatch: ({ cfg, account, patch }) => {
    if (account.accountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          zalo: {
            ...cfg.channels?.zalo,
            enabled: true,
            ...patch,
          },
        },
      };
    }
    const currentAccount = cfg.channels?.zalo?.accounts?.[account.accountId] as
      | ZaloAccountSetupConfig
      | undefined;
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        zalo: {
          ...cfg.channels?.zalo,
          enabled: true,
          accounts: {
            ...cfg.channels?.zalo?.accounts,
            [account.accountId]: {
              ...currentAccount,
              enabled: currentAccount?.enabled ?? true,
              ...patch,
            },
          },
        },
      },
    };
  },
  promptAllowFrom: async ({ cfg, prompter, accountId }) =>
    promptZaloAllowFrom({
      cfg,
      prompter,
      accountId: accountId ?? resolveDefaultZaloAccountId(cfg),
    }),
});

export function createZaloSetupWizardProxy(
  loadWizard: () => Promise<ChannelSetupWizard>,
): ChannelSetupWizard {
  return createDelegatedSetupWizardProxy({
    channel,
    loadWizard,
    status: {
      configuredLabel: t("wizard.channels.statusConfigured"),
      unconfiguredLabel: t("wizard.channels.statusNeedsToken"),
      configuredHint: t("wizard.channels.statusRecommendedConfigured"),
      unconfiguredHint: t("wizard.channels.statusRecommendedNewcomerFriendly"),
      configuredScore: 1,
      unconfiguredScore: 10,
    },
    credentials: [],
    delegateFinalize: true,
    dmPolicy: zaloDmPolicy,
    disable: (cfg) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        zalo: {
          ...cfg.channels?.zalo,
          enabled: false,
        },
      },
    }),
  });
}
