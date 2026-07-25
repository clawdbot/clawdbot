// Mattermost plugin module implements setup core behavior.
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  defineChannelSetupContract,
  type ChannelSetupAdapter,
  type ChannelSetupInput,
} from "openclaw/plugin-sdk/channel-setup";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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

type MattermostSetupInput = ChannelSetupInput & {
  botToken?: string;
  httpUrl?: string;
};

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

export function applyMattermostSetupConfigPatch(params: {
  cfg: OpenClawConfig;
  accountId: string;
  name?: string;
  patch: Record<string, unknown>;
}): OpenClawConfig {
  const namedConfig = applyAccountNameToChannelSection({
    cfg: params.cfg,
    channelKey: channel,
    accountId: params.accountId,
    name: params.name,
  });
  const next =
    params.accountId !== DEFAULT_ACCOUNT_ID
      ? migrateBaseNameToDefaultAccount({
          cfg: namedConfig,
          channelKey: channel,
        })
      : namedConfig;
  return applySetupAccountConfigPatch({
    cfg: next,
    channelKey: channel,
    accountId: params.accountId,
    patch: params.patch,
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
      const setupInput = input as MattermostSetupInput;
      const token = setupInput.botToken ?? setupInput.token;
      const baseUrl = normalizeMattermostBaseUrl(setupInput.httpUrl);
      if (!setupInput.useEnv && (!token || !baseUrl)) {
        return "Mattermost requires --bot-token and --http-url (or --use-env).";
      }
      if (setupInput.httpUrl && !baseUrl) {
        return "Mattermost --http-url must include a valid base URL.";
      }
      return null;
    },
  }),
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const setupInput = input as MattermostSetupInput;
    const token = setupInput.botToken ?? setupInput.token;
    const baseUrl = normalizeMattermostBaseUrl(setupInput.httpUrl);
    return applyMattermostSetupConfigPatch({
      cfg,
      accountId,
      name: setupInput.name,
      patch: setupInput.useEnv
        ? {}
        : {
            ...(token ? { botToken: token } : {}),
            ...(baseUrl ? { baseUrl } : {}),
          },
    });
  },
};

export const mattermostSetupContract = defineChannelSetupContract({
  fields: {
    token: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--token <token>", description: "Mattermost bot token" },
    },
    botToken: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--bot-token <token>", description: "Mattermost bot token" },
    },
    httpUrl: {
      kind: "string",
      cli: { flags: "--http-url <url>", description: "Mattermost server URL" },
    },
    useEnv: {
      kind: "boolean",
      cli: { flags: "--use-env", description: "Use Mattermost environment credentials" },
    },
  },
  legacyAdapter: mattermostSetupAdapter,
});
