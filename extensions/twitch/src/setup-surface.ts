/**
 * Twitch setup wizard surface for CLI setup.
 */

import { normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-id";
import { getChatChannelMeta, type ChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  formatDocsLink,
  type ChannelSetupAdapter,
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
  type OpenClawConfig,
  type WizardPrompter,
  normalizeAccountId,
} from "openclaw/plugin-sdk/setup";
import {
  DEFAULT_ACCOUNT_ID,
  getAccountConfig,
  listAccountIds,
  resolveDefaultTwitchAccountId,
  resolveTwitchAccountContext,
} from "./config.js";
import type { TwitchAccountConfig, TwitchRole } from "./types.js";
import { isAccountConfigured } from "./utils/twitch.js";

const channel = "twitch" as const;
const INVALID_ACCOUNT_ID_MESSAGE = "Invalid Twitch account id";

function normalizeRequestedSetupAccountId(accountId: string): string {
  const normalized = normalizeOptionalAccountId(accountId);
  if (!normalized) {
    throw new Error(INVALID_ACCOUNT_ID_MESSAGE);
  }
  return normalized;
}

function resolveSetupAccountId(cfg: OpenClawConfig, requestedAccountId?: string): string {
  const requested = requestedAccountId?.trim();
  if (requested) {
    return normalizeRequestedSetupAccountId(requested);
  }

  const preferred = cfg.channels?.twitch?.defaultAccount?.trim();
  return preferred ? normalizeAccountId(preferred) : resolveDefaultTwitchAccountId(cfg);
}

export function setTwitchAccount(
  cfg: OpenClawConfig,
  account: Partial<TwitchAccountConfig>,
  accountId: string = resolveSetupAccountId(cfg),
): OpenClawConfig {
  const resolvedAccountId = accountId.trim()
    ? normalizeRequestedSetupAccountId(accountId)
    : resolveSetupAccountId(cfg);
  const existing = getAccountConfig(cfg, resolvedAccountId);
  const merged: TwitchAccountConfig = {
    username: account.username ?? existing?.username ?? "",
    accessToken: account.accessToken ?? existing?.accessToken ?? "",
    clientId: account.clientId ?? existing?.clientId ?? "",
    channel: account.channel ?? existing?.channel ?? "",
    enabled: account.enabled ?? existing?.enabled ?? true,
    allowFrom: account.allowFrom ?? existing?.allowFrom,
    allowedRoles: account.allowedRoles ?? existing?.allowedRoles,
    requireMention: account.requireMention ?? existing?.requireMention,
    clientSecret: account.clientSecret ?? existing?.clientSecret,
    refreshToken: account.refreshToken ?? existing?.refreshToken,
    expiresIn: account.expiresIn ?? existing?.expiresIn,
    obtainmentTimestamp: account.obtainmentTimestamp ?? existing?.obtainmentTimestamp,
  };

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      twitch: {
        ...((cfg.channels as Record<string, unknown>)?.twitch as
          | Record<string, unknown>
          | undefined),
        enabled: true,
        accounts: {
          ...((
            (cfg.channels as Record<string, unknown>)?.twitch as Record<string, unknown> | undefined
          )?.accounts as Record<string, unknown> | undefined),
          [resolvedAccountId]: merged,
        },
      },
    },
  };
}

async function noteTwitchSetupHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Twitch requires a bot account with OAuth token.",
      "1. Create a Twitch application at https://dev.twitch.tv/console",
      "2. Generate a token with scopes: chat:read and chat:write",
      "   Use https://twitchtokengenerator.com/ or https://twitchapps.com/tmi/",
      "3. Copy the token (starts with 'oauth:') and Client ID",
      "Env vars supported: OPENCLAW_TWITCH_ACCESS_TOKEN",
      `Docs: ${formatDocsLink("/channels/twitch", "channels/twitch")}`,
    ].join("\n"),
    "Twitch setup",
  );
}

export async function promptToken(
  prompter: WizardPrompter,
  account: TwitchAccountConfig | null,
  envToken: string | undefined,
): Promise<string> {
  const existingToken = account?.accessToken ?? "";

  if (existingToken && !envToken) {
    const keepToken = await prompter.confirm({
      message: "Access token already configured. Keep it?",
      initialValue: true,
    });
    if (keepToken) {
      return existingToken;
    }
  }

  return (
    await prompter.text({
      message: "Twitch OAuth token (oauth:...)",
      initialValue: envToken ?? "",
      validate: (value) => {
        const raw = value?.trim() ?? "";
        if (!raw) {
          return "Required";
        }
        if (!raw.startsWith("oauth:")) {
          return "Token should start with 'oauth:'";
        }
        return undefined;
      },
    })
  ).trim();
}

export async function promptUsername(
  prompter: WizardPrompter,
  account: TwitchAccountConfig | null,
): Promise<string> {
  return (
    await prompter.text({
      message: "Twitch bot username",
      initialValue: account?.username ?? "",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    })
  ).trim();
}

export async function promptClientId(
  prompter: WizardPrompter,
  account: TwitchAccountConfig | null,
): Promise<string> {
  return (
    await prompter.text({
      message: "Twitch Client ID",
      initialValue: account?.clientId ?? "",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    })
  ).trim();
}

export async function promptChannelName(
  prompter: WizardPrompter,
  account: TwitchAccountConfig | null,
): Promise<string> {
  return (
    await prompter.text({
      message: "Channel to join",
      initialValue: account?.channel ?? "",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    })
  ).trim();
}

export async function promptRefreshTokenSetup(
  prompter: WizardPrompter,
  account: TwitchAccountConfig | null,
): Promise<{ clientSecret?: string; refreshToken?: string }> {
  const useRefresh = await prompter.confirm({
    message: "Enable automatic token refresh (requires client secret and refresh token)?",
    initialValue: Boolean(account?.clientSecret && account?.refreshToken),
  });

  if (!useRefresh) {
    return {};
  }

  const clientSecret =
    (
      await prompter.text({
        message: "Twitch Client Secret (for token refresh)",
        initialValue: account?.clientSecret ?? "",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      })
    ).trim() || undefined;

  const refreshToken =
    (
      await prompter.text({
        message: "Twitch Refresh Token",
        initialValue: account?.refreshToken ?? "",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      })
    ).trim() || undefined;

  return { clientSecret, refreshToken };
}

export async function configureWithEnvToken(
  cfg: OpenClawConfig,
  prompter: WizardPrompter,
  account: TwitchAccountConfig | null,
  envToken: string,
  forceAllowFrom: boolean,
  dmPolicy: ChannelSetupDmPolicy,
  accountId: string = resolveSetupAccountId(cfg),
): Promise<{ cfg: OpenClawConfig } | null> {
  const resolvedAccountId = accountId.trim()
    ? normalizeRequestedSetupAccountId(accountId)
    : resolveSetupAccountId(cfg);
  if (resolvedAccountId !== DEFAULT_ACCOUNT_ID) {
    return null;
  }

  const useEnv = await prompter.confirm({
    message: "Twitch env var OPENCLAW_TWITCH_ACCESS_TOKEN detected. Use env token?",
    initialValue: true,
  });
  if (!useEnv) {
    return null;
  }

  const username = await promptUsername(prompter, account);
  const clientId = await promptClientId(prompter, account);

  const cfgWithAccount = setTwitchAccount(
    cfg,
    {
      username,
      clientId,
      accessToken: "",
      enabled: true,
    },
    resolvedAccountId,
  );

  if (forceAllowFrom && dmPolicy.promptAllowFrom) {
    return {
      cfg: await dmPolicy.promptAllowFrom({
        cfg: cfgWithAccount,
        prompter,
        accountId: resolvedAccountId,
      }),
    };
  }

  return { cfg: cfgWithAccount };
}

function setTwitchAccessControl(
  cfg: OpenClawConfig,
  allowedRoles: TwitchRole[],
  requireMention: boolean,
  accountId?: string,
): OpenClawConfig {
  const resolvedAccountId = resolveSetupAccountId(cfg, accountId);
  const account = getAccountConfig(cfg, resolvedAccountId);
  if (!account) {
    return cfg;
  }

  return setTwitchAccount(
    cfg,
    {
      ...account,
      allowedRoles,
      requireMention,
    },
    resolvedAccountId,
  );
}

function resolveTwitchGroupPolicy(
  cfg: OpenClawConfig,
  accountId?: string,
): "open" | "allowlist" | "disabled" {
  const account = getAccountConfig(cfg, resolveSetupAccountId(cfg, accountId));
  if (account?.allowedRoles?.includes("all")) {
    return "open";
  }
  if (account?.allowedRoles?.includes("moderator")) {
    return "allowlist";
  }
  return "disabled";
}

function setTwitchGroupPolicy(
  cfg: OpenClawConfig,
  policy: "open" | "allowlist" | "disabled",
  accountId?: string,
): OpenClawConfig {
  const allowedRoles: TwitchRole[] =
    policy === "open" ? ["all"] : policy === "allowlist" ? ["moderator", "vip"] : [];
  return setTwitchAccessControl(cfg, allowedRoles, true, accountId);
}

const twitchDmPolicy: ChannelSetupDmPolicy = {
  label: "Twitch",
  channel,
  policyKey: "channels.twitch.accounts.default.allowedRoles",
  allowFromKey: "channels.twitch.accounts.default.allowFrom",
  resolveConfigKeys: (cfg, accountId) => {
    const resolvedAccountId = resolveSetupAccountId(cfg, accountId);
    return {
      policyKey: `channels.twitch.accounts.${resolvedAccountId}.allowedRoles`,
      allowFromKey: `channels.twitch.accounts.${resolvedAccountId}.allowFrom`,
    };
  },
  getCurrent: (cfg, accountId) => {
    const account = getAccountConfig(cfg, resolveSetupAccountId(cfg, accountId));
    if (account?.allowedRoles?.includes("all")) {
      return "open";
    }
    if (account?.allowFrom && account.allowFrom.length > 0) {
      return "allowlist";
    }
    return "disabled";
  },
  setPolicy: (cfg, policy, accountId) => {
    const allowedRoles: TwitchRole[] =
      policy === "open" ? ["all"] : policy === "allowlist" ? [] : ["moderator"];
    return setTwitchAccessControl(cfg, allowedRoles, true, accountId);
  },
  promptAllowFrom: async ({ cfg, prompter, accountId }) => {
    const resolvedAccountId = resolveSetupAccountId(cfg, accountId);
    const account = getAccountConfig(cfg, resolvedAccountId);
    const existingAllowFrom = account?.allowFrom ?? [];

    const entry = await prompter.text({
      message: "Twitch allowFrom (user IDs, one per line, recommended for security)",
      placeholder: "123456789",
      initialValue: existingAllowFrom[0] || undefined,
    });

    const allowFrom = (entry ?? "")
      .split(/[\n,;]+/g)
      .map((s) => s.trim())
      .filter(Boolean);

    return setTwitchAccount(
      cfg,
      {
        ...(account ?? undefined),
        allowFrom,
      },
      resolvedAccountId,
    );
  },
};

const twitchGroupAccess: NonNullable<ChannelSetupWizard["groupAccess"]> = {
  label: "Twitch chat",
  placeholder: "",
  skipAllowlistEntries: true,
  currentPolicy: ({ cfg, accountId }) => resolveTwitchGroupPolicy(cfg, accountId),
  currentEntries: ({ cfg, accountId }) => {
    const account = getAccountConfig(cfg, resolveSetupAccountId(cfg, accountId));
    return account?.allowFrom ?? [];
  },
  updatePrompt: ({ cfg, accountId }) => {
    const account = getAccountConfig(cfg, resolveSetupAccountId(cfg, accountId));
    return Boolean(account?.allowedRoles?.length || account?.allowFrom?.length);
  },
  setPolicy: ({ cfg, accountId, policy }) => setTwitchGroupPolicy(cfg, policy, accountId),
  resolveAllowlist: async () => [],
  applyAllowlist: ({ cfg }) => cfg,
};

export const twitchSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ cfg }) => resolveSetupAccountId(cfg),
  applyAccountConfig: ({ cfg, accountId }) =>
    setTwitchAccount(
      cfg,
      {
        enabled: true,
      },
      accountId,
    ),
};

export const twitchSetupWizard: ChannelSetupWizard = {
  channel,
  resolveAccountIdForConfigure: ({ cfg, accountOverride }) =>
    resolveSetupAccountId(cfg, accountOverride),
  resolveShouldPromptAccountIds: () => false,
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs username, token, and clientId",
    configuredHint: "configured",
    unconfiguredHint: "needs setup",
    resolveConfigured: ({ cfg, accountId }) => {
      return resolveTwitchAccountContext(cfg, resolveSetupAccountId(cfg, accountId)).configured;
    },
    resolveStatusLines: ({ cfg, accountId }) => {
      const resolvedAccountId = resolveSetupAccountId(cfg, accountId);
      const configured = resolveTwitchAccountContext(cfg, resolvedAccountId).configured;
      return [
        `Twitch${resolvedAccountId !== DEFAULT_ACCOUNT_ID ? ` (${resolvedAccountId})` : ""}: ${configured ? "configured" : "needs username, token, and clientId"}`,
      ];
    },
  },
  credentials: [],
  finalize: async ({ cfg, accountId: requestedAccountId, prompter, forceAllowFrom }) => {
    const accountId = resolveSetupAccountId(cfg, requestedAccountId);
    const account = getAccountConfig(cfg, accountId);

    if (!account || !isAccountConfigured(account)) {
      await noteTwitchSetupHelp(prompter);
    }

    const envToken = process.env.OPENCLAW_TWITCH_ACCESS_TOKEN?.trim();

    if (accountId === DEFAULT_ACCOUNT_ID && envToken && !account?.accessToken) {
      const envResult = await configureWithEnvToken(
        cfg,
        prompter,
        account,
        envToken,
        forceAllowFrom,
        twitchDmPolicy,
        accountId,
      );
      if (envResult) {
        return envResult;
      }
    }

    const username = await promptUsername(prompter, account);
    const token = await promptToken(prompter, account, envToken);
    const clientId = await promptClientId(prompter, account);
    const channelName = await promptChannelName(prompter, account);
    const { clientSecret, refreshToken } = await promptRefreshTokenSetup(prompter, account);

    const cfgWithAccount = setTwitchAccount(
      cfg,
      {
        username,
        accessToken: token,
        clientId,
        channel: channelName,
        clientSecret,
        refreshToken,
        enabled: true,
      },
      accountId,
    );

    const cfgWithAllowFrom =
      forceAllowFrom && twitchDmPolicy.promptAllowFrom
        ? await twitchDmPolicy.promptAllowFrom({ cfg: cfgWithAccount, prompter, accountId })
        : cfgWithAccount;

    return { cfg: cfgWithAllowFrom };
  },
  dmPolicy: twitchDmPolicy,
  groupAccess: twitchGroupAccess,
  disable: (cfg) => {
    const twitch = (cfg.channels as Record<string, unknown>)?.twitch as
      | Record<string, unknown>
      | undefined;
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        twitch: { ...twitch, enabled: false },
      },
    };
  },
};

type ResolvedTwitchAccount = TwitchAccountConfig & { accountId?: string | null };

export const twitchSetupPlugin: ChannelPlugin<ResolvedTwitchAccount> = {
  id: channel,
  meta: getChatChannelMeta(channel),
  capabilities: {
    chatTypes: ["group"],
  },
  config: {
    listAccountIds: (cfg) => listAccountIds(cfg),
    resolveAccount: (cfg, accountId) => {
      const resolvedAccountId = normalizeAccountId(accountId ?? resolveDefaultTwitchAccountId(cfg));
      const account = getAccountConfig(cfg, resolvedAccountId);
      if (!account) {
        return {
          accountId: resolvedAccountId,
          username: "",
          accessToken: "",
          clientId: "",
          channel: "",
          enabled: false,
        };
      }
      return {
        accountId: resolvedAccountId,
        ...account,
      };
    },
    defaultAccountId: (cfg) => resolveDefaultTwitchAccountId(cfg),
    isConfigured: (account, cfg) => resolveTwitchAccountContext(cfg, account?.accountId).configured,
    isEnabled: (account) => account.enabled !== false,
  },
  setup: twitchSetupAdapter,
  setupWizard: twitchSetupWizard,
};
