/**
 * Webex onboarding wizard
 *
 * CLI-based setup flow for configuring Webex bot integration.
 */

import type { DmPolicy, MoltbotConfig } from "clawdbot/plugin-sdk";
import {
  addWildcardAllowFrom,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  promptAccountId,
  type ChannelOnboardingAdapter,
  type ChannelOnboardingDmPolicy,
  type WizardPrompter,
} from "clawdbot/plugin-sdk";

import {
  listWebexAccountIds,
  resolveDefaultWebexAccountId,
  resolveWebexAccount,
} from "./accounts.js";
import { probeWebexConnection } from "./probe.js";
import type { ResolvedWebexAccount } from "./types.js";

const channel = "webex" as const;

const ENV_BOT_TOKEN = "WEBEX_BOT_TOKEN";

function setWebexDmPolicy(cfg: MoltbotConfig, policy: DmPolicy) {
  const allowFrom =
    policy === "open"
      ? addWildcardAllowFrom(cfg.channels?.["webex"]?.dm?.allowFrom)
      : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      webex: {
        ...(cfg.channels?.["webex"] ?? {}),
        dm: {
          ...(cfg.channels?.["webex"]?.dm ?? {}),
          policy,
          ...(allowFrom ? { allowFrom } : {}),
        },
      },
    },
  };
}

function parseAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function applyAccountConfig(params: {
  cfg: MoltbotConfig;
  accountId: string;
  patch: Record<string, unknown>;
}): MoltbotConfig {
  const { cfg, accountId, patch } = params;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        webex: {
          ...(cfg.channels?.["webex"] ?? {}),
          enabled: true,
          ...patch,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      webex: {
        ...(cfg.channels?.["webex"] ?? {}),
        enabled: true,
        accounts: {
          ...(cfg.channels?.["webex"]?.accounts ?? {}),
          [accountId]: {
            ...(cfg.channels?.["webex"]?.accounts?.[accountId] ?? {}),
            enabled: true,
            ...patch,
          },
        },
      },
    },
  };
}

async function promptCredentials(params: {
  cfg: MoltbotConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<{ cfg: MoltbotConfig; botInfo?: { id?: string; email?: string; displayName?: string } }> {
  const { cfg, prompter, accountId } = params;
  const envReady = accountId === DEFAULT_ACCOUNT_ID && Boolean(process.env[ENV_BOT_TOKEN]?.trim());

  let botToken: string | undefined;

  if (envReady) {
    const useEnv = await prompter.confirm({
      message: `Use ${ENV_BOT_TOKEN} environment variable?`,
      initialValue: true,
    });
    if (!useEnv) {
      botToken = await prompter.text({
        message: "Enter your Webex bot access token:",
        placeholder: "Bot access token from developer.webex.com",
      });
    }
  } else {
    botToken = await prompter.text({
      message: "Enter your Webex bot access token:",
      placeholder: "Bot access token from developer.webex.com",
    });
  }

  // Test the token
  const testAccount = resolveWebexAccount({ cfg, accountId });
  if (botToken) {
    testAccount.botToken = botToken;
  }

  const probe = await probeWebexConnection(testAccount);
  if (probe.ok && probe.bot) {
    await prompter.note(
      `Token valid: ${probe.bot.displayName ?? "Bot"} (${probe.bot.email ?? "no email"})`,
      "Webex Bot",
    );
  } else if (!probe.ok) {
    await prompter.note(`Token validation failed: ${probe.error}`, "Warning");
    const proceed = await prompter.confirm({
      message: "Continue anyway?",
      initialValue: false,
    });
    if (!proceed) {
      throw new Error("Token validation failed");
    }
  }

  const nextCfg = applyAccountConfig({
    cfg,
    accountId,
    patch: {
      ...(botToken ? { botToken } : {}),
      ...(probe.bot?.id ? { botId: probe.bot.id } : {}),
      ...(probe.bot?.email ? { botEmail: probe.bot.email } : {}),
    },
  });

  return { cfg: nextCfg, botInfo: probe.bot };
}

async function promptWebhook(params: {
  cfg: MoltbotConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<MoltbotConfig> {
  const { cfg, prompter, accountId } = params;

  const webhookSecretRaw = await prompter.text({
    message: "Enter a webhook secret (for signature verification):",
    placeholder: "A random string for HMAC-SHA1 verification",
  });

  const webhookPathRaw = await prompter.text({
    message: "Webhook path:",
    placeholder: "/webex",
    initialValue: "/webex",
  });

  // Defensive: ensure values are strings before trimming
  const webhookSecret =
    typeof webhookSecretRaw === "string" ? webhookSecretRaw.trim() : undefined;
  const webhookPath =
    typeof webhookPathRaw === "string" && webhookPathRaw.trim()
      ? webhookPathRaw.trim()
      : "/webex";

  return applyAccountConfig({
    cfg,
    accountId,
    patch: {
      webhookSecret: webhookSecret || undefined,
      webhookPath,
    },
  });
}

async function noteWebexSetup(prompter: WizardPrompter) {
  await prompter.note(
    [
      "Webex bots use OAuth token auth and HTTPS webhooks.",
      "1. Create a bot at https://developer.webex.com/my-apps",
      "2. Copy the bot access token",
      "3. Configure a webhook pointing to your gateway URL",
      "4. Use the same secret for webhook verification",
      `Docs: ${formatDocsLink("/channels/webex", "channels/webex")}`,
    ].join("\n"),
    "Webex setup",
  );
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Webex",
  channel,
  policyKey: "channels.webex.dm.policy",
  allowFromKey: "channels.webex.dm.allowFrom",
  getCurrent: (cfg) => cfg.channels?.["webex"]?.dm?.policy ?? "pairing",
  setPolicy: (cfg, policy) => setWebexDmPolicy(cfg, policy),
};

/**
 * Webex onboarding adapter
 */
export const webexOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  dmPolicy,

  getStatus: async ({ cfg }) => {
    const configured = listWebexAccountIds(cfg).some(
      (accountId) => resolveWebexAccount({ cfg, accountId }).credentialSource !== "none",
    );
    return {
      channel,
      configured,
      statusLines: [
        `Webex: ${configured ? "configured" : "needs bot token"}`,
      ],
      selectionHint: configured ? "configured" : "needs auth",
    };
  },

  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const override = accountOverrides["webex"]?.trim();
    const defaultAccountId = resolveDefaultWebexAccountId(cfg);
    let accountId = override ? normalizeAccountId(override) : defaultAccountId;

    if (shouldPromptAccountIds && !override) {
      accountId = await promptAccountId({
        cfg,
        prompter,
        label: "Webex",
        currentId: accountId,
        listAccountIds: listWebexAccountIds,
        defaultAccountId,
      });
    }

    let nextCfg = cfg;

    // Show setup notes
    await noteWebexSetup(prompter);

    // Prompt for credentials (bot token)
    const credResult = await promptCredentials({ cfg: nextCfg, prompter, accountId });
    nextCfg = credResult.cfg;

    // Prompt for webhook configuration
    nextCfg = await promptWebhook({ cfg: nextCfg, prompter, accountId });

    // Migrate config if needed
    const namedConfig = migrateBaseNameToDefaultAccount({
      cfg: nextCfg,
      channelKey: "webex",
    });

    return { cfg: namedConfig, accountId };
  },
};
