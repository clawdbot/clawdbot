/**
 * Twitch setup wizard surface for CLI setup.
 */

import {
  formatDocsLink,
  type ChannelSetupAdapter,
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
  type OpenClawConfig,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import { DEFAULT_ACCOUNT_ID, getAccountConfig, resolveDefaultTwitchAccountId } from "./config.js";
import type { TwitchAccountConfig, TwitchRole } from "./types.js";
import { isAccountConfigured } from "./utils/twitch.js";

const channel = "twitch" as const;

function resolveSetupAccountId(cfg: OpenClawConfig): string {
  const preferred = cfg.channels?.twitch?.defaultAccount?.trim();
  return preferred || resolveDefaultTwitchAccountId(cfg);
}

export function setTwitchAccount(
  cfg: OpenClawConfig,
  account: Partial<TwitchAccountConfig>,
  accountId: string = resolveSetupAccountId(cfg),
): OpenClawConfig {
  const existing = getAccountConfig(cfg, accountId);
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
          [accountId]: merged,
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
): Promise<{ cfg: OpenClawConfig } | null> {
  const useEnv = await prompter.confirm({
    message: "Twitch env var OPENCLAW_TWITCH_ACCESS_TOKEN detected. Use env token?",
    initialValue: true,
  });
  if (!useEnv) {
    return null;
  }

  const username = await promptUsername(prompter, account);
  const clientId = await promptClientId(prompter, account);

  const cfgWithAccount = setTwitchAccount(cfg, {
    username,
    clientId,
    accessToken: "",
    enabled: true,
  });

  if (forceAllowFrom && dmPolicy.promptAllowFrom) {
    return { cfg: await dmPolicy.promptAllowFrom({ cfg: cfgWithAccount, prompter }) };
  }

  return { cfg: cfgWithAccount };
}

function setTwitchAccessControl(
  cfg: OpenClawConfig,
  allowedRoles: TwitchRole[],
  requireMention: boolean,
): OpenClawConfig {
  const accountId = resolveSetupAccountId(cfg);
  const account = getAccountConfig(cfg, accountId);
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
    accountId,
  );
}

function resolveTwitchGroupPolicy(cfg: OpenClawConfig): "open" | "allowlist" | "disabled" {
  const account = getAccountConfig(cfg, resolveSetupAccountId(cfg));
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
): OpenClawConfig {
  const allowedRoles: TwitchRole[] =
    policy === "open" ? ["all"] : policy === "allowlist" ? ["moderator", "vip"] : [];
  return setTwitchAccessControl(cfg, allowedRoles, true);
}

const twitchDmPolicy: ChannelSetupDmPolicy = {
  label: "Twitch",
  channel,
  policyKey: "channels.twitch.allowedRoles",
  allowFromKey: "channels.twitch.accounts.<default>.allowFrom",
  getCurrent: (cfg) => {
    const account = getAccountConfig(cfg, resolveSetupAccountId(cfg));
    if (account?.allowedRoles?.includes("all")) {
      return "open";
    }
    if (account?.allowFrom && account.allowFrom.length > 0) {
      return "allowlist";
    }
    return "disabled";
  },
  setPolicy: (cfg, policy) => {
    const allowedRoles: TwitchRole[] =
      policy === "open" ? ["all"] : policy === "allowlist" ? [] : ["moderator"];
    return setTwitchAccessControl(cfg, allowedRoles, true);
  },
  promptAllowFrom: async ({ cfg, prompter }) => {
    const accountId = resolveSetupAccountId(cfg);
    const account = getAccountConfig(cfg, accountId);
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
      accountId,
    );
  },
};

const twitchGroupAccess: NonNullable<ChannelSetupWizard["groupAccess"]> = {
  label: "Twitch chat",
  placeholder: "",
  skipAllowlistEntries: true,
  currentPolicy: ({ cfg }) => resolveTwitchGroupPolicy(cfg),
  currentEntries: ({ cfg }) => {
    const account = getAccountConfig(cfg, resolveSetupAccountId(cfg));
    return account?.allowFrom ?? [];
  },
  updatePrompt: ({ cfg }) => {
    const account = getAccountConfig(cfg, resolveSetupAccountId(cfg));
    return Boolean(account?.allowedRoles?.length || account?.allowFrom?.length);
  },
  setPolicy: ({ cfg, policy }) => setTwitchGroupPolicy(cfg, policy),
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
  resolveAccountIdForConfigure: ({ defaultAccountId }) => defaultAccountId,
  resolveShouldPromptAccountIds: () => false,
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs username, token, and clientId",
    configuredHint: "configured",
    unconfiguredHint: "needs setup",
    resolveConfigured: ({ cfg }) => {
      const account = getAccountConfig(cfg, resolveSetupAccountId(cfg));
      return account ? isAccountConfigured(account) : false;
    },
    resolveStatusLines: ({ cfg }) => {
      const accountId = resolveSetupAccountId(cfg);
      const account = getAccountConfig(cfg, accountId);
      const configured = account ? isAccountConfigured(account) : false;
      return [
        `Twitch${accountId !== DEFAULT_ACCOUNT_ID ? ` (${accountId})` : ""}: ${configured ? "configured" : "needs username, token, and clientId"}`,
      ];
    },
  },
  credentials: [],
  finalize: async ({ cfg, prompter, forceAllowFrom }) => {
    const accountId = resolveSetupAccountId(cfg);
    const account = getAccountConfig(cfg, accountId);

    if (!account || !isAccountConfigured(account)) {
      await noteTwitchSetupHelp(prompter);
    }

    const envToken = process.env.OPENCLAW_TWITCH_ACCESS_TOKEN?.trim();

    if (envToken && !account?.accessToken) {
      const envResult = await configureWithEnvToken(
        cfg,
        prompter,
        account,
        envToken,
        forceAllowFrom,
        twitchDmPolicy,
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
        ? await twitchDmPolicy.promptAllowFrom({ cfg: cfgWithAccount, prompter })
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
