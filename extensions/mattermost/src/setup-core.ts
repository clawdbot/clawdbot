import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { ChannelSetupAdapter } from "openclaw/plugin-sdk/channel-setup";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  migrateBaseNameToDefaultAccount,
} from "openclaw/plugin-sdk/setup";
import { createSetupInputPresenceValidator } from "openclaw/plugin-sdk/setup-runtime";
import {
  resolveMattermostAccount,
  type ResolvedMattermostAccount,
} from "./setup.accounts.runtime.js";
import { normalizeMattermostBaseUrl } from "./setup.client.runtime.js";
import { hasConfiguredSecretInput } from "./setup.secret-input.runtime.js";

const channel = "mattermost" as const;

export function isMattermostConfigured(account: ResolvedMattermostAccount): boolean {
  const tokenConfigured =
    Boolean(account.botToken?.trim()) || hasConfiguredSecretInput(account.config.botToken);
  return tokenConfigured && Boolean(account.baseUrl);
}

export function resolveMattermostAccountWithSecrets(cfg: OpenClawConfig, accountId: string) {
  return resolveMattermostAccount({
    cfg,
    accountId,
    allowUnresolvedSecretRef: true,
  });
}

export const mattermostSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name,
    }),
  validateInput: createSetupInputPresenceValidator({
    defaultAccountOnlyEnvError: "Mattermost env vars can only be used for the default account.",
    whenNotUseEnv: [
      {
        someOf: ["botToken", "token"],
        message: "Mattermost requires --bot-token and --http-url (or --use-env).",
      },
      {
        someOf: ["httpUrl"],
        message: "Mattermost requires --bot-token and --http-url (or --use-env).",
      },
    ],
    validate: ({ input }) => {
      const token = input.botToken ?? input.token;
      const baseUrl = normalizeMattermostBaseUrl(input.httpUrl);
      if (!input.useEnv && (!token || !baseUrl)) {
        return "Mattermost requires --bot-token and --http-url (or --use-env).";
      }
      if (input.httpUrl && !baseUrl) {
        return "Mattermost --http-url must include a valid base URL.";
      }
      return null;
    },
  }),
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const token = input.botToken ?? input.token;
    const baseUrl = normalizeMattermostBaseUrl(input.httpUrl);
    const namedConfig = applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name: input.name,
    });
    const next =
      accountId !== DEFAULT_ACCOUNT_ID
        ? migrateBaseNameToDefaultAccount({
            cfg: namedConfig,
            channelKey: channel,
          })
        : namedConfig;
    return applySetupAccountConfigPatch({
      cfg: next,
      channelKey: channel,
      accountId,
      patch: input.useEnv
        ? {}
        : {
            ...(token ? { botToken: token } : {}),
            ...(baseUrl ? { baseUrl } : {}),
          },
    });
  },
};
