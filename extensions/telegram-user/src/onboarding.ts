import {
  addWildcardAllowFrom,
  formatDocsLink,
  promptAccountId,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type ChannelOnboardingAdapter,
  type ChannelOnboardingDmPolicy,
  type ClawdbotConfig,
  type DmPolicy,
  type WizardPrompter,
} from "clawdbot/plugin-sdk";

import {
  listTelegramUserAccountIds,
  resolveDefaultTelegramUserAccountId,
  resolveTelegramUserAccount,
} from "./accounts.js";
import { loginTelegramUser } from "./login.js";
import { resolveTelegramUserSessionPath } from "./session.js";
import type { CoreConfig } from "./types.js";

const channel = "telegram-user" as const;
type TelegramUserChannelConfig = NonNullable<CoreConfig["channels"]>["telegram-user"];

function setTelegramUserDmPolicy(
  cfg: ClawdbotConfig,
  policy: DmPolicy,
  accountId?: string,
): ClawdbotConfig {
  const resolvedAccountId = normalizeAccountId(accountId) ?? DEFAULT_ACCOUNT_ID;
  const current = cfg.channels?.["telegram-user"] as TelegramUserChannelConfig | undefined;
  const allowFrom =
    policy === "open"
      ? addWildcardAllowFrom(current?.allowFrom)
      : undefined;

  if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
    channels: {
      ...cfg.channels,
      "telegram-user": {
        ...(current ?? {}),
        dmPolicy: policy,
        ...(allowFrom ? { allowFrom } : {}),
      },
      },
    };
  }

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      "telegram-user": {
        ...(current ?? {}),
        accounts: {
          ...(current?.accounts ?? {}),
          [resolvedAccountId]: {
            ...(current?.accounts?.[resolvedAccountId] ?? {}),
            dmPolicy: policy,
            ...(allowFrom ? { allowFrom } : {}),
          },
        },
      },
    },
  };
}

async function noteTelegramUserAuthHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Telegram User (MTProto) needs an API ID + API hash from my.telegram.org.",
      "You can store them in config or set TELEGRAM_USER_API_ID/TELEGRAM_USER_API_HASH.",
      "Login happens via `clawdbot channels login --channel telegram-user`.",
      `Docs: ${formatDocsLink("/channels/telegram-user", "channels/telegram-user")}`,
    ].join("\n"),
    "Telegram user setup",
  );
}

function parseAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) =>
      entry
        .trim()
        .replace(/^(telegram-user|telegram|tg):/i, "")
        .replace(/^user:/i, "")
        .trim(),
    )
    .filter(Boolean);
}

async function promptTelegramUserAllowFrom(params: {
  cfg: ClawdbotConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<ClawdbotConfig> {
  const accountId = normalizeAccountId(params.accountId) ?? DEFAULT_ACCOUNT_ID;
  const resolved = resolveTelegramUserAccount({
    cfg: params.cfg as CoreConfig,
    accountId,
  });
  const existingAllowFrom = resolved.config.allowFrom ?? [];

  const entry = await params.prompter.text({
    message: "Telegram user allowFrom (user id or @username)",
    placeholder: "@username",
    initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  });

  const parsed = parseAllowFromInput(String(entry));
  const merged = [
    ...existingAllowFrom.map((item) => String(item).trim()).filter(Boolean),
    ...parsed,
  ];
  const unique = [...new Set(merged)];
  const current = params.cfg.channels?.["telegram-user"] as TelegramUserChannelConfig | undefined;

  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        "telegram-user": {
          ...(current ?? {}),
          enabled: true,
          dmPolicy: "allowlist",
          allowFrom: unique,
        },
      },
    };
  }

  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      "telegram-user": {
        ...(current ?? {}),
        enabled: true,
        accounts: {
          ...(current?.accounts ?? {}),
          [accountId]: {
            ...(current?.accounts?.[accountId] ?? {}),
            enabled: true,
            dmPolicy: "allowlist",
            allowFrom: unique,
          },
        },
      },
    },
  };
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Telegram User",
  channel,
  policyKey: "channels.telegram-user.dmPolicy",
  allowFromKey: "channels.telegram-user.allowFrom",
  getCurrent: (cfg) =>
    (cfg as CoreConfig).channels?.["telegram-user"]?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setTelegramUserDmPolicy(cfg, policy),
  promptAllowFrom: async ({ cfg, prompter, accountId }) =>
    await promptTelegramUserAllowFrom({ cfg, prompter, accountId }),
};

export const telegramUserOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listTelegramUserAccountIds(cfg as CoreConfig).some((accountId) => {
      const resolved = resolveTelegramUserAccount({ cfg: cfg as CoreConfig, accountId });
      return Boolean(resolved.credentials.apiId && resolved.credentials.apiHash);
    });
    return {
      channel,
      configured,
      statusLines: [
        `Telegram User: ${configured ? "configured" : "needs API ID + API hash"}`,
      ],
      selectionHint: configured ? "configured" : "needs credentials",
    };
  },
  configure: async ({
    cfg,
    runtime,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
  }) => {
    const override = accountOverrides["telegram-user"]?.trim();
    const defaultAccountId = resolveDefaultTelegramUserAccountId(cfg as CoreConfig);
    let accountId = override ? normalizeAccountId(override) : defaultAccountId;
    if (shouldPromptAccountIds && !override) {
      accountId = await promptAccountId({
        cfg: cfg as ClawdbotConfig,
        prompter,
        label: "Telegram User",
        currentId: accountId ?? defaultAccountId,
        listAccountIds: (next) => listTelegramUserAccountIds(next as CoreConfig),
        defaultAccountId,
      });
    }
    const resolvedAccountId = normalizeAccountId(accountId) ?? defaultAccountId;

    let next = cfg as CoreConfig;
    const resolved = resolveTelegramUserAccount({
      cfg: next,
      accountId: resolvedAccountId,
    });
    const configured = Boolean(resolved.credentials.apiId && resolved.credentials.apiHash);

    if (!configured) {
      await noteTelegramUserAuthHelp(prompter);
    }

    const envApiId = process.env.TELEGRAM_USER_API_ID?.trim();
    const envApiHash = process.env.TELEGRAM_USER_API_HASH?.trim();
    const canUseEnv =
      resolvedAccountId === DEFAULT_ACCOUNT_ID && Boolean(envApiId && envApiHash);
    const hasConfig = Boolean(resolved.config.apiId && resolved.config.apiHash);

    let useEnv = false;
    if (canUseEnv && !hasConfig) {
      useEnv = await prompter.confirm({
        message: "Telegram user env vars detected. Use env values?",
        initialValue: true,
      });
    }

    let apiId = resolved.config.apiId;
    let apiHash = resolved.config.apiHash;
    if (!useEnv && (!apiId || !apiHash)) {
      if (configured) {
        const keep = await prompter.confirm({
          message: "Telegram user credentials already configured. Keep them?",
          initialValue: true,
        });
        if (!keep) {
          apiId = undefined;
          apiHash = undefined;
        }
      }
      if (!apiId || !apiHash) {
        const apiIdRaw = String(
          await prompter.text({
            message: "Telegram API ID",
            initialValue: apiId ? String(apiId) : envApiId,
            validate: (value) =>
              Number.isFinite(Number.parseInt(String(value ?? ""), 10))
                ? undefined
                : "Enter a numeric API ID",
          }),
        );
        apiId = Number.parseInt(apiIdRaw, 10);
        apiHash = String(
          await prompter.text({
            message: "Telegram API hash",
            initialValue: apiHash ?? envApiHash,
            validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    }

    const current = next.channels?.["telegram-user"] as TelegramUserChannelConfig | undefined;
    if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          "telegram-user": {
            ...(current ?? {}),
            enabled: true,
            ...(useEnv
              ? {}
              : {
                  apiId,
                  apiHash,
                }),
          },
        },
      };
    } else {
      next = {
        ...next,
        channels: {
          ...next.channels,
          "telegram-user": {
            ...(current ?? {}),
            enabled: true,
            accounts: {
              ...(current?.accounts ?? {}),
              [resolvedAccountId]: {
                ...(current?.accounts?.[resolvedAccountId] ?? {}),
                enabled: true,
                ...(useEnv
                  ? {}
                  : {
                      apiId,
                      apiHash,
                    }),
              },
            },
          },
        },
      };
    }

    if (forceAllowFrom) {
      next = await promptTelegramUserAllowFrom({
        cfg: next,
        prompter,
        accountId: resolvedAccountId,
      });
    }

    const wantsLogin = await prompter.confirm({
      message: "Link Telegram user now (QR or phone code)?",
      initialValue: !configured,
    });
    if (wantsLogin) {
      const refreshed = resolveTelegramUserAccount({
        cfg: next,
        accountId: resolvedAccountId,
      });
      if (!refreshed.credentials.apiId || !refreshed.credentials.apiHash) {
        await prompter.note(
          "Telegram API ID/hash missing. Add credentials first, then retry login.",
          "Telegram user login",
        );
      } else {
        try {
          await loginTelegramUser({
            apiId: refreshed.credentials.apiId,
            apiHash: refreshed.credentials.apiHash,
            storagePath: resolveTelegramUserSessionPath(resolvedAccountId),
            runtime,
          });
        } catch (err) {
          runtime.error(`Telegram user login failed: ${String(err)}`);
          await prompter.note(
            `Run \`clawdbot channels login --channel telegram-user\` later to link.`,
            "Telegram user login",
          );
        }
      }
    } else {
      await prompter.note(
        [
          "Next: link the account via QR or phone code.",
          "Run: clawdbot channels login --channel telegram-user",
        ].join("\n"),
        "Telegram user login",
      );
    }

    return { cfg: next, accountId: resolvedAccountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...(cfg as CoreConfig),
    channels: {
      ...(cfg as CoreConfig).channels,
      "telegram-user": {
        ...(cfg as CoreConfig).channels?.["telegram-user"],
        enabled: false,
      },
    },
  }),
};
