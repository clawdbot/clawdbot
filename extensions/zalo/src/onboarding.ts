import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "../../src/channels/plugins/onboarding-types.js";
import type { WizardPrompter } from "../../src/wizard/prompts.js";

import { addWildcardAllowFrom, promptAccountId } from "./shared/onboarding.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "./shared/account-ids.js";
import {
  listZaloAccountIds,
  resolveDefaultZaloAccountId,
  resolveZaloAccount,
} from "./accounts.js";
import type { CoreConfig } from "./types.js";

const channel = "zalo" as const;

type UpdateMode = "polling" | "webhook";

function setZaloDmPolicy(cfg: CoreConfig, dmPolicy: "pairing" | "allowlist" | "open" | "disabled") {
  const allowFrom = dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.zalo?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      zalo: {
        ...cfg.channels?.zalo,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  } as CoreConfig;
}

function setZaloUpdateMode(
  cfg: CoreConfig,
  accountId: string,
  mode: UpdateMode,
  webhookUrl?: string,
  webhookSecret?: string,
  webhookPath?: string,
): CoreConfig {
  const isDefault = accountId === DEFAULT_ACCOUNT_ID;
  if (mode === "polling") {
    if (isDefault) {
      const {
        webhookUrl: _url,
        webhookSecret: _secret,
        webhookPath: _path,
        ...rest
      } = cfg.channels?.zalo ?? {};
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          zalo: rest,
        },
      } as CoreConfig;
    }
    const accounts = { ...(cfg.channels?.zalo?.accounts ?? {}) } as Record<
      string,
      Record<string, unknown>
    >;
    const existing = accounts[accountId] ?? {};
    const {
      webhookUrl: _url,
      webhookSecret: _secret,
      webhookPath: _path,
      ...rest
    } = existing;
    accounts[accountId] = rest;
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        zalo: {
          ...cfg.channels?.zalo,
          accounts,
        },
      },
    } as CoreConfig;
  }

  if (isDefault) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        zalo: {
          ...cfg.channels?.zalo,
          webhookUrl,
          webhookSecret,
          webhookPath,
        },
      },
    } as CoreConfig;
  }

  const accounts = { ...(cfg.channels?.zalo?.accounts ?? {}) } as Record<
    string,
    Record<string, unknown>
  >;
  accounts[accountId] = {
    ...(accounts[accountId] ?? {}),
    webhookUrl,
    webhookSecret,
    webhookPath,
  };
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      zalo: {
        ...cfg.channels?.zalo,
        accounts,
      },
    },
  } as CoreConfig;
}

async function noteZaloTokenHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Open Zalo Bot Platform: https://bot.zaloplatforms.com",
      "2) Create a bot and get the token",
      "3) Token looks like 12345689:abc-xyz",
      "Tip: you can also set ZALO_BOT_TOKEN in your env.",
      "Docs: https://docs.clawd.bot/channels/zalo",
    ].join("\n"),
    "Zalo bot token",
  );
}

async function promptZaloAllowFrom(params: {
  cfg: CoreConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<CoreConfig> {
  const { cfg, prompter, accountId } = params;
  const resolved = resolveZaloAccount({ cfg, accountId });
  const existingAllowFrom = resolved.config.allowFrom ?? [];
  const entry = await prompter.text({
    message: "Zalo allowFrom (user id)",
    placeholder: "123456789",
    initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) return "Required";
      if (!/^\d+$/.test(raw)) return "Use a numeric Zalo user id";
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
      channels: {
        ...cfg.channels,
        zalo: {
          ...cfg.channels?.zalo,
          enabled: true,
          dmPolicy: "allowlist",
          allowFrom: unique,
        },
      },
    } as CoreConfig;
  }

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      zalo: {
        ...cfg.channels?.zalo,
        enabled: true,
        accounts: {
          ...(cfg.channels?.zalo?.accounts ?? {}),
          [accountId]: {
            ...(cfg.channels?.zalo?.accounts?.[accountId] ?? {}),
            enabled: cfg.channels?.zalo?.accounts?.[accountId]?.enabled ?? true,
            dmPolicy: "allowlist",
            allowFrom: unique,
          },
        },
      },
    },
  } as CoreConfig;
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Zalo",
  channel,
  policyKey: "channels.zalo.dmPolicy",
  allowFromKey: "channels.zalo.allowFrom",
  getCurrent: (cfg) => (cfg.channels?.zalo?.dmPolicy ?? "pairing") as "pairing",
  setPolicy: (cfg, policy) => setZaloDmPolicy(cfg as CoreConfig, policy),
};

export const zaloOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  dmPolicy,
  getStatus: async ({ cfg }) => {
    const configured = listZaloAccountIds(cfg as CoreConfig).some((accountId) =>
      Boolean(resolveZaloAccount({ cfg: cfg as CoreConfig, accountId }).token),
    );
    return {
      channel,
      configured,
      statusLines: [`Zalo: ${configured ? "configured" : "needs token"}`],
      selectionHint: configured ? "recommended · configured" : "recommended · newcomer-friendly",
      quickstartScore: configured ? 1 : 10,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds, forceAllowFrom }) => {
    const zaloOverride = accountOverrides.zalo?.trim();
    const defaultZaloAccountId = resolveDefaultZaloAccountId(cfg as CoreConfig);
    let zaloAccountId = zaloOverride
      ? normalizeAccountId(zaloOverride)
      : defaultZaloAccountId;
    if (shouldPromptAccountIds && !zaloOverride) {
      zaloAccountId = await promptAccountId({
        cfg: cfg as CoreConfig,
        prompter,
        label: "Zalo",
        currentId: zaloAccountId,
        listAccountIds: listZaloAccountIds,
        defaultAccountId: defaultZaloAccountId,
      });
    }

    let next = cfg as CoreConfig;
    const resolvedAccount = resolveZaloAccount({ cfg: next, accountId: zaloAccountId });
    const accountConfigured = Boolean(resolvedAccount.token);
    const allowEnv = zaloAccountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv = allowEnv && Boolean(process.env.ZALO_BOT_TOKEN?.trim());
    const hasConfigToken = Boolean(
      resolvedAccount.config.botToken || resolvedAccount.config.tokenFile,
    );

    let token: string | null = null;
    if (!accountConfigured) {
      await noteZaloTokenHelp(prompter);
    }
    if (canUseEnv && !resolvedAccount.config.botToken) {
      const keepEnv = await prompter.confirm({
        message: "ZALO_BOT_TOKEN detected. Use env var?",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            zalo: {
              ...next.channels?.zalo,
              enabled: true,
            },
          },
        } as CoreConfig;
      } else {
        token = String(
          await prompter.text({
            message: "Enter Zalo bot token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else if (hasConfigToken) {
      const keep = await prompter.confirm({
        message: "Zalo token already configured. Keep it?",
        initialValue: true,
      });
      if (!keep) {
        token = String(
          await prompter.text({
            message: "Enter Zalo bot token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      token = String(
        await prompter.text({
          message: "Enter Zalo bot token",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    if (token) {
      if (zaloAccountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            zalo: {
              ...next.channels?.zalo,
              enabled: true,
              botToken: token,
            },
          },
        } as CoreConfig;
      } else {
        next = {
          ...next,
          channels: {
            ...next.channels,
            zalo: {
              ...next.channels?.zalo,
              enabled: true,
              accounts: {
                ...(next.channels?.zalo?.accounts ?? {}),
                [zaloAccountId]: {
                  ...(next.channels?.zalo?.accounts?.[zaloAccountId] ?? {}),
                  enabled: true,
                  botToken: token,
                },
              },
            },
          },
        } as CoreConfig;
      }
    }

    const wantsWebhook = await prompter.confirm({
      message: "Use webhook mode for Zalo?",
      initialValue: false,
    });
    if (wantsWebhook) {
      const webhookUrl = String(
        await prompter.text({
          message: "Webhook URL (https://...) ",
          validate: (value) => (value?.trim()?.startsWith("https://") ? undefined : "HTTPS URL required"),
        }),
      ).trim();
      const defaultPath = (() => {
        try {
          return new URL(webhookUrl).pathname || "/zalo-webhook";
        } catch {
          return "/zalo-webhook";
        }
      })();
      const webhookSecret = String(
        await prompter.text({
          message: "Webhook secret (8-256 chars)",
          validate: (value) => {
            const raw = String(value ?? "");
            if (raw.length < 8 || raw.length > 256) return "8-256 chars";
            return undefined;
          },
        }),
      ).trim();
      const webhookPath = String(
        await prompter.text({
          message: "Webhook path (optional)",
          initialValue: defaultPath,
        }),
      ).trim();
      next = setZaloUpdateMode(
        next,
        zaloAccountId,
        "webhook",
        webhookUrl,
        webhookSecret,
        webhookPath || undefined,
      );
    } else {
      next = setZaloUpdateMode(next, zaloAccountId, "polling");
    }

    if (forceAllowFrom) {
      next = await promptZaloAllowFrom({
        cfg: next,
        prompter,
        accountId: zaloAccountId,
      });
    }

    return { cfg: next, accountId: zaloAccountId };
  },
};
