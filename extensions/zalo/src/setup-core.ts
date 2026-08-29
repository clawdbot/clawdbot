import { createChannelDmPolicy } from "openclaw/plugin-sdk/channel-dm-policy";
import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
// Zalo plugin module implements setup core behavior.
import {
  createDelegatedSetupWizardProxy,
  createPatchedAccountSetupAdapter,
  createSetupInputPresenceValidator,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  patchScopedAccountConfig,
  createSetupTranslator,
  setSetupChannelEnabled,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup";
import { resolveDefaultZaloAccountId, resolveZaloAccount } from "./accounts.js";
import { promptZaloAllowFrom } from "./setup-allow-from.js";

const t = createSetupTranslator();

const channel = "zalo" as const;

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
    // Resolution prefers inline botToken over tokenFile, so writing one source
    // has to retire the other or the stale credential keeps winning (see #132231).
    // The full pair is retired on any credential write because a promoted
    // accounts.default record outranks root regardless of which form it holds;
    // the patch re-adds the written source after the clear.
    buildClearFields: (input) =>
      input.useEnv || input.tokenFile || input.token ? ["tokenFile", "botToken"] : [],
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
      envVars: ["ZALO_BOT_TOKEN"],
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
  applyPatch: ({ cfg, account, patch }) =>
    patchScopedAccountConfig({ cfg, channelKey: channel, accountId: account.accountId, patch }),
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
    disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
  });
}
