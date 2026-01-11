import type { ClawdbotConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "../../../routing/session-key.js";
import {
  listTelegramAccountIds,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
} from "../../../telegram/accounts.js";
import { formatDocsLink } from "../../../terminal/links.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type {
  ProviderOnboardingAdapter,
  ProviderOnboardingDmPolicy,
} from "../onboarding-types.js";
import { addWildcardAllowFrom, promptAccountId } from "./helpers.js";

const provider = "telegram" as const;

function setTelegramDmPolicy(cfg: ClawdbotConfig, dmPolicy: DmPolicy) {
  const allowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(cfg.telegram?.allowFrom)
      : undefined;
  return {
    ...cfg,
    telegram: {
      ...cfg.telegram,
      dmPolicy,
      ...(allowFrom ? { allowFrom } : {}),
    },
  };
}

async function noteTelegramTokenHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Open Telegram and chat with @BotFather",
      "2) Run /newbot (or /mybots)",
      "3) Copy the token (looks like 123456:ABC...)",
      "Tip: you can also set TELEGRAM_BOT_TOKEN in your env.",
      `Docs: ${formatDocsLink("/telegram")}`,
      "Website: https://clawd.bot",
    ].join("\n"),
    "Telegram bot token",
  );
}

async function promptTelegramAllowFrom(params: {
  cfg: ClawdbotConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<ClawdbotConfig> {
  const { cfg, prompter, accountId } = params;
  const resolved = resolveTelegramAccount({ cfg, accountId });
  const existingAllowFrom = resolved.config.allowFrom ?? [];
  const entry = await prompter.text({
    message: "Telegram allowFrom (user id)",
    placeholder: "123456789",
    initialValue: existingAllowFrom[0]
      ? String(existingAllowFrom[0])
      : undefined,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) return "Required";
      if (!/^\d+$/.test(raw)) return "Use a numeric Telegram user id";
      return undefined;
    },
  });
  const normalized = String(entry).trim();
  const merged = [
    ...existingAllowFrom.map((item) => String(item).trim()).filter(Boolean),
    normalized,
  ];
  const unique = [...new Set(merged)];

  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      telegram: {
        ...cfg.telegram,
        enabled: true,
        dmPolicy: "allowlist",
        allowFrom: unique,
      },
    };
  }

  return {
    ...cfg,
    telegram: {
      ...cfg.telegram,
      enabled: true,
      accounts: {
        ...cfg.telegram?.accounts,
        [accountId]: {
          ...cfg.telegram?.accounts?.[accountId],
          enabled: cfg.telegram?.accounts?.[accountId]?.enabled ?? true,
          dmPolicy: "allowlist",
          allowFrom: unique,
        },
      },
    },
  };
}

const dmPolicy: ProviderOnboardingDmPolicy = {
  label: "Telegram",
  provider,
  policyKey: "telegram.dmPolicy",
  allowFromKey: "telegram.allowFrom",
  getCurrent: (cfg) => cfg.telegram?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setTelegramDmPolicy(cfg, policy),
};

export const telegramOnboardingAdapter: ProviderOnboardingAdapter = {
  provider,
  getStatus: async ({ cfg }) => {
    const configured = listTelegramAccountIds(cfg).some((accountId) =>
      Boolean(resolveTelegramAccount({ cfg, accountId }).token),
    );
    return {
      provider,
      configured,
      statusLines: [`Telegram: ${configured ? "configured" : "needs token"}`],
      selectionHint: configured
        ? "recommended · configured"
        : "recommended · newcomer-friendly",
      quickstartScore: configured ? 1 : 10,
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
  }) => {
    const telegramOverride = accountOverrides.telegram?.trim();
    const defaultTelegramAccountId = resolveDefaultTelegramAccountId(cfg);
    let telegramAccountId = telegramOverride
      ? normalizeAccountId(telegramOverride)
      : defaultTelegramAccountId;
    if (shouldPromptAccountIds && !telegramOverride) {
      telegramAccountId = await promptAccountId({
        cfg,
        prompter,
        label: "Telegram",
        currentId: telegramAccountId,
        listAccountIds: listTelegramAccountIds,
        defaultAccountId: defaultTelegramAccountId,
      });
    }

    let next = cfg;
    const resolvedAccount = resolveTelegramAccount({
      cfg: next,
      accountId: telegramAccountId,
    });
    const accountConfigured = Boolean(resolvedAccount.token);
    const allowEnv = telegramAccountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv =
      allowEnv && Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());
    const hasConfigToken = Boolean(
      resolvedAccount.config.botToken || resolvedAccount.config.tokenFile,
    );

    let token: string | null = null;
    if (!accountConfigured) {
      await noteTelegramTokenHelp(prompter);
    }
    if (canUseEnv && !resolvedAccount.config.botToken) {
      const keepEnv = await prompter.confirm({
        message: "TELEGRAM_BOT_TOKEN detected. Use env var?",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          telegram: {
            ...next.telegram,
            enabled: true,
          },
        };
      } else {
        token = String(
          await prompter.text({
            message: "Enter Telegram bot token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else if (hasConfigToken) {
      const keep = await prompter.confirm({
        message: "Telegram token already configured. Keep it?",
        initialValue: true,
      });
      if (!keep) {
        token = String(
          await prompter.text({
            message: "Enter Telegram bot token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      token = String(
        await prompter.text({
          message: "Enter Telegram bot token",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    if (token) {
      if (telegramAccountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          telegram: {
            ...next.telegram,
            enabled: true,
            botToken: token,
          },
        };
      } else {
        next = {
          ...next,
          telegram: {
            ...next.telegram,
            enabled: true,
            accounts: {
              ...next.telegram?.accounts,
              [telegramAccountId]: {
                ...next.telegram?.accounts?.[telegramAccountId],
                enabled:
                  next.telegram?.accounts?.[telegramAccountId]?.enabled ?? true,
                botToken: token,
              },
            },
          },
        };
      }
    }

    if (forceAllowFrom) {
      next = await promptTelegramAllowFrom({
        cfg: next,
        prompter,
        accountId: telegramAccountId,
      });
    }

    return { cfg: next, accountId: telegramAccountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    telegram: { ...cfg.telegram, enabled: false },
  }),
};
