import type { ClawdbotConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import {
  listDiscordAccountIds,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccount,
} from "../../../discord/accounts.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "../../../routing/session-key.js";
import { formatDocsLink } from "../../../terminal/links.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type {
  ProviderOnboardingAdapter,
  ProviderOnboardingDmPolicy,
} from "../onboarding-types.js";
import { addWildcardAllowFrom, promptAccountId } from "./helpers.js";

const provider = "discord" as const;

function setDiscordDmPolicy(cfg: ClawdbotConfig, dmPolicy: DmPolicy) {
  const allowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(cfg.discord?.dm?.allowFrom)
      : undefined;
  return {
    ...cfg,
    discord: {
      ...cfg.discord,
      dm: {
        ...cfg.discord?.dm,
        enabled: cfg.discord?.dm?.enabled ?? true,
        policy: dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

async function noteDiscordTokenHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Discord Developer Portal → Applications → New Application",
      "2) Bot → Add Bot → Reset Token → copy token",
      "3) OAuth2 → URL Generator → scope 'bot' → invite to your server",
      "Tip: enable Message Content Intent if you need message text.",
      `Docs: ${formatDocsLink("/discord", "discord")}`,
    ].join("\n"),
    "Discord bot token",
  );
}

const dmPolicy: ProviderOnboardingDmPolicy = {
  label: "Discord",
  provider,
  policyKey: "discord.dm.policy",
  allowFromKey: "discord.dm.allowFrom",
  getCurrent: (cfg) => cfg.discord?.dm?.policy ?? "pairing",
  setPolicy: (cfg, policy) => setDiscordDmPolicy(cfg, policy),
};

export const discordOnboardingAdapter: ProviderOnboardingAdapter = {
  provider,
  getStatus: async ({ cfg }) => {
    const configured = listDiscordAccountIds(cfg).some((accountId) =>
      Boolean(resolveDiscordAccount({ cfg, accountId }).token),
    );
    return {
      provider,
      configured,
      statusLines: [`Discord: ${configured ? "configured" : "needs token"}`],
      selectionHint: configured ? "configured" : "needs token",
      quickstartScore: configured ? 2 : 1,
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
  }) => {
    const discordOverride = accountOverrides.discord?.trim();
    const defaultDiscordAccountId = resolveDefaultDiscordAccountId(cfg);
    let discordAccountId = discordOverride
      ? normalizeAccountId(discordOverride)
      : defaultDiscordAccountId;
    if (shouldPromptAccountIds && !discordOverride) {
      discordAccountId = await promptAccountId({
        cfg,
        prompter,
        label: "Discord",
        currentId: discordAccountId,
        listAccountIds: listDiscordAccountIds,
        defaultAccountId: defaultDiscordAccountId,
      });
    }

    let next = cfg;
    const resolvedAccount = resolveDiscordAccount({
      cfg: next,
      accountId: discordAccountId,
    });
    const accountConfigured = Boolean(resolvedAccount.token);
    const allowEnv = discordAccountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv =
      allowEnv && Boolean(process.env.DISCORD_BOT_TOKEN?.trim());
    const hasConfigToken = Boolean(resolvedAccount.config.token);

    let token: string | null = null;
    if (!accountConfigured) {
      await noteDiscordTokenHelp(prompter);
    }
    if (canUseEnv && !resolvedAccount.config.token) {
      const keepEnv = await prompter.confirm({
        message: "DISCORD_BOT_TOKEN detected. Use env var?",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          discord: {
            ...next.discord,
            enabled: true,
          },
        };
      } else {
        token = String(
          await prompter.text({
            message: "Enter Discord bot token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else if (hasConfigToken) {
      const keep = await prompter.confirm({
        message: "Discord token already configured. Keep it?",
        initialValue: true,
      });
      if (!keep) {
        token = String(
          await prompter.text({
            message: "Enter Discord bot token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      token = String(
        await prompter.text({
          message: "Enter Discord bot token",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    if (token) {
      if (discordAccountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          discord: {
            ...next.discord,
            enabled: true,
            token,
          },
        };
      } else {
        next = {
          ...next,
          discord: {
            ...next.discord,
            enabled: true,
            accounts: {
              ...next.discord?.accounts,
              [discordAccountId]: {
                ...next.discord?.accounts?.[discordAccountId],
                enabled:
                  next.discord?.accounts?.[discordAccountId]?.enabled ?? true,
                token,
              },
            },
          },
        };
      }
    }

    return { cfg: next, accountId: discordAccountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    discord: { ...cfg.discord, enabled: false },
  }),
};
