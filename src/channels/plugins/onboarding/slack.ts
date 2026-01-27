import type { MoltbotConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
import {
  listSlackAccountIds,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
} from "../../../slack/accounts.js";
import { resolveSlackChannelAllowlist } from "../../../slack/resolve-channels.js";
import { resolveSlackUserAllowlist } from "../../../slack/resolve-users.js";
import { formatDocsLink } from "../../../terminal/links.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "../onboarding-types.js";
import { promptChannelAccessConfig } from "./channel-access.js";
import { addWildcardAllowFrom, promptAccountId } from "./helpers.js";

const channel = "slack" as const;

function setSlackDmPolicy(cfg: MoltbotConfig, dmPolicy: DmPolicy) {
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.slack?.dm?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      slack: {
        ...cfg.channels?.slack,
        dm: {
          ...cfg.channels?.slack?.dm,
          enabled: cfg.channels?.slack?.dm?.enabled ?? true,
          policy: dmPolicy,
          ...(allowFrom ? { allowFrom } : {}),
        },
      },
    },
  };
}

function buildSlackManifest(botName: string) {
  const safeName = botName.trim() || "Moltbot";
  const manifest = {
    display_information: {
      name: safeName,
      description: `${safeName} connector for Moltbot`,
    },
    features: {
      bot_user: {
        display_name: safeName,
        always_online: false,
      },
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      slash_commands: [
        {
          command: "/clawd",
          description: "Send a message to Moltbot",
          should_escape: false,
        },
      ],
    },
    oauth_config: {
      scopes: {
        bot: [
          "chat:write",
          "channels:history",
          "channels:read",
          "groups:history",
          "im:history",
          "mpim:history",
          "users:read",
          "app_mentions:read",
          "reactions:read",
          "reactions:write",
          "pins:read",
          "pins:write",
          "emoji:read",
          "commands",
          "files:read",
          "files:write",
        ],
      },
    },
    settings: {
      socket_mode_enabled: true,
      event_subscriptions: {
        bot_events: [
          "app_mention",
          "message.channels",
          "message.groups",
          "message.im",
          "message.mpim",
          "reaction_added",
          "reaction_removed",
          "member_joined_channel",
          "member_left_channel",
          "channel_rename",
          "pin_added",
          "pin_removed",
        ],
      },
    },
  };
  return JSON.stringify(manifest, null, 2);
}

async function noteSlackTokenHelp(prompter: WizardPrompter, botName: string): Promise<void> {
  const manifest = buildSlackManifest(botName);
  await prompter.note(
    [
      "1) Slack API → Create App → From scratch",
      "2) Add Socket Mode + enable it to get the app-level token (xapp-...)",
      "3) OAuth & Permissions → install app to workspace (xoxb- bot token)",
      "4) Enable Event Subscriptions (socket) for message events",
      "5) App Home → enable the Messages tab for DMs",
      "Tip: set SLACK_BOT_TOKEN + SLACK_APP_TOKEN in your env.",
      `Docs: ${formatDocsLink("/slack", "slack")}`,
      "",
      "Manifest (JSON):",
      manifest,
    ].join("\n"),
    "Slack socket mode tokens",
  );
}

function setSlackGroupPolicy(
  cfg: MoltbotConfig,
  accountId: string,
  groupPolicy: "open" | "allowlist" | "disabled",
): MoltbotConfig {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        slack: {
          ...cfg.channels?.slack,
          enabled: true,
          groupPolicy,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      slack: {
        ...cfg.channels?.slack,
        enabled: true,
        accounts: {
          ...cfg.channels?.slack?.accounts,
          [accountId]: {
            ...cfg.channels?.slack?.accounts?.[accountId],
            enabled: cfg.channels?.slack?.accounts?.[accountId]?.enabled ?? true,
            groupPolicy,
          },
        },
      },
    },
  };
}

function setSlackChannelAllowlist(
  cfg: MoltbotConfig,
  accountId: string,
  channelKeys: string[],
): MoltbotConfig {
  const channels = Object.fromEntries(channelKeys.map((key) => [key, { allow: true }]));
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        slack: {
          ...cfg.channels?.slack,
          enabled: true,
          channels,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      slack: {
        ...cfg.channels?.slack,
        enabled: true,
        accounts: {
          ...cfg.channels?.slack?.accounts,
          [accountId]: {
            ...cfg.channels?.slack?.accounts?.[accountId],
            enabled: cfg.channels?.slack?.accounts?.[accountId]?.enabled ?? true,
            channels,
          },
        },
      },
    },
  };
}

function setSlackAllowFrom(cfg: MoltbotConfig, allowFrom: string[]): MoltbotConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      slack: {
        ...cfg.channels?.slack,
        dm: {
          ...cfg.channels?.slack?.dm,
          enabled: cfg.channels?.slack?.dm?.enabled ?? true,
          allowFrom,
        },
      },
    },
  };
}

function parseSlackAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function promptSlackAllowFrom(params: {
  cfg: MoltbotConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<MoltbotConfig> {
  const accountId =
    params.accountId && normalizeAccountId(params.accountId)
      ? (normalizeAccountId(params.accountId) ?? DEFAULT_ACCOUNT_ID)
      : resolveDefaultSlackAccountId(params.cfg);
  const resolved = resolveSlackAccount({ cfg: params.cfg, accountId });
  const token = resolved.config.userToken ?? resolved.config.botToken ?? "";
  const existing = params.cfg.channels?.slack?.dm?.allowFrom ?? [];
  await params.prompter.note(
    [
      "Allowlist Slack DMs by username (we resolve to user ids).",
      "Examples:",
      "- U12345678",
      "- @alice",
      "Multiple entries: comma-separated.",
      `Docs: ${formatDocsLink("/slack", "slack")}`,
    ].join("\n"),
    "Slack allowlist",
  );
  const parseInputs = (value: string) => parseSlackAllowFromInput(value);
  const parseId = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const mention = trimmed.match(/^<@([A-Z0-9]+)>$/i);
    if (mention) return mention[1]?.toUpperCase();
    const prefixed = trimmed.replace(/^(slack:|user:)/i, "");
    if (/^[A-Z][A-Z0-9]+$/i.test(prefixed)) return prefixed.toUpperCase();
    return null;
  };

  while (true) {
    const entry = await params.prompter.text({
      message: "Slack allowFrom (usernames or ids)",
      placeholder: "@alice, U12345678",
      initialValue: existing[0] ? String(existing[0]) : undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const parts = parseInputs(String(entry));
    if (!token) {
      const ids = parts.map(parseId).filter(Boolean) as string[];
      if (ids.length !== parts.length) {
        await params.prompter.note(
          "Slack token missing; use user ids (or mention form) only.",
          "Slack allowlist",
        );
        continue;
      }
      const unique = [...new Set([...existing.map((v) => String(v).trim()), ...ids])].filter(
        Boolean,
      );
      return setSlackAllowFrom(params.cfg, unique);
    }

    const results = await resolveSlackUserAllowlist({
      token,
      entries: parts,
    }).catch(() => null);
    if (!results) {
      await params.prompter.note("Failed to resolve usernames. Try again.", "Slack allowlist");
      continue;
    }
    const unresolved = results.filter((res) => !res.resolved || !res.id);
    if (unresolved.length > 0) {
      await params.prompter.note(
        `Could not resolve: ${unresolved.map((res) => res.input).join(", ")}`,
        "Slack allowlist",
      );
      continue;
    }
    const ids = results.map((res) => res.id as string);
    const unique = [...new Set([...existing.map((v) => String(v).trim()).filter(Boolean), ...ids])];
    return setSlackAllowFrom(params.cfg, unique);
  }
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Slack",
  channel,
  policyKey: "channels.slack.dm.policy",
  allowFromKey: "channels.slack.dm.allowFrom",
  getCurrent: (cfg) => cfg.channels?.slack?.dm?.policy ?? "pairing",
  setPolicy: (cfg, policy) => setSlackDmPolicy(cfg, policy),
  promptAllowFrom: promptSlackAllowFrom,
};

export const slackOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listSlackAccountIds(cfg).some((accountId) => {
      const account = resolveSlackAccount({ cfg, accountId });
      return Boolean(account.botToken && account.appToken);
    });
    return {
      channel,
      configured,
      statusLines: [`Slack: ${configured ? "configured" : "needs tokens"}`],
      selectionHint: configured ? "configured" : "needs tokens",
      quickstartScore: configured ? 2 : 1,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const slackOverride = accountOverrides.slack?.trim();
    const defaultSlackAccountId = resolveDefaultSlackAccountId(cfg);
    let slackAccountId = slackOverride ? normalizeAccountId(slackOverride) : defaultSlackAccountId;
    if (shouldPromptAccountIds && !slackOverride) {
      slackAccountId = await promptAccountId({
        cfg,
        prompter,
        label: "Slack",
        currentId: slackAccountId,
        listAccountIds: listSlackAccountIds,
        defaultAccountId: defaultSlackAccountId,
      });
    }

    let next = cfg;
    const resolvedAccount = resolveSlackAccount({
      cfg: next,
      accountId: slackAccountId,
    });
    const accountConfigured = Boolean(resolvedAccount.botToken && resolvedAccount.appToken);
    const allowEnv = slackAccountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv =
      allowEnv &&
      Boolean(process.env.SLACK_BOT_TOKEN?.trim()) &&
      Boolean(process.env.SLACK_APP_TOKEN?.trim());
    const hasConfigTokens = Boolean(
      resolvedAccount.config.botToken && resolvedAccount.config.appToken,
    );

    let botToken: string | null = null;
    let appToken: string | null = null;
    const slackBotName = String(
      await prompter.text({
        message: "Slack bot display name (used for manifest)",
        initialValue: "Moltbot",
      }),
    ).trim();
    if (!accountConfigured) {
      await noteSlackTokenHelp(prompter, slackBotName);
    }
    if (canUseEnv && (!resolvedAccount.config.botToken || !resolvedAccount.config.appToken)) {
      const keepEnv = await prompter.confirm({
        message: "SLACK_BOT_TOKEN + SLACK_APP_TOKEN detected. Use env vars?",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            slack: { ...next.channels?.slack, enabled: true },
          },
        };
      } else {
        botToken = String(
          await prompter.text({
            message: "Enter Slack bot token (xoxb-...)",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        appToken = String(
          await prompter.text({
            message: "Enter Slack app token (xapp-...)",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else if (hasConfigTokens) {
      const keep = await prompter.confirm({
        message: "Slack tokens already configured. Keep them?",
        initialValue: true,
      });
      if (!keep) {
        botToken = String(
          await prompter.text({
            message: "Enter Slack bot token (xoxb-...)",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        appToken = String(
          await prompter.text({
            message: "Enter Slack app token (xapp-...)",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      botToken = String(
        await prompter.text({
          message: "Enter Slack bot token (xoxb-...)",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
      appToken = String(
        await prompter.text({
          message: "Enter Slack app token (xapp-...)",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    if (botToken && appToken) {
      if (slackAccountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            slack: {
              ...next.channels?.slack,
              enabled: true,
              botToken,
              appToken,
            },
          },
        };
      } else {
        next = {
          ...next,
          channels: {
            ...next.channels,
            slack: {
              ...next.channels?.slack,
              enabled: true,
              accounts: {
                ...next.channels?.slack?.accounts,
                [slackAccountId]: {
                  ...next.channels?.slack?.accounts?.[slackAccountId],
                  enabled: next.channels?.slack?.accounts?.[slackAccountId]?.enabled ?? true,
                  botToken,
                  appToken,
                },
              },
            },
          },
        };
      }
    }

    const accessConfig = await promptChannelAccessConfig({
      prompter,
      label: "Slack channels",
      currentPolicy: resolvedAccount.config.groupPolicy ?? "allowlist",
      currentEntries: Object.entries(resolvedAccount.config.channels ?? {})
        .filter(([, value]) => value?.allow !== false && value?.enabled !== false)
        .map(([key]) => key),
      placeholder: "#general, #private, C123",
      updatePrompt: Boolean(resolvedAccount.config.channels),
    });
    if (accessConfig) {
      if (accessConfig.policy !== "allowlist") {
        next = setSlackGroupPolicy(next, slackAccountId, accessConfig.policy);
      } else {
        let keys = accessConfig.entries;
        const accountWithTokens = resolveSlackAccount({
          cfg: next,
          accountId: slackAccountId,
        });
        if (accountWithTokens.botToken && accessConfig.entries.length > 0) {
          try {
            const resolved = await resolveSlackChannelAllowlist({
              token: accountWithTokens.botToken,
              entries: accessConfig.entries,
            });
            const resolvedKeys = resolved
              .filter((entry) => entry.resolved && entry.id)
              .map((entry) => entry.id as string);
            const unresolved = resolved
              .filter((entry) => !entry.resolved)
              .map((entry) => entry.input);
            keys = [...resolvedKeys, ...unresolved.map((entry) => entry.trim()).filter(Boolean)];
            if (resolvedKeys.length > 0 || unresolved.length > 0) {
              await prompter.note(
                [
                  resolvedKeys.length > 0 ? `Resolved: ${resolvedKeys.join(", ")}` : undefined,
                  unresolved.length > 0
                    ? `Unresolved (kept as typed): ${unresolved.join(", ")}`
                    : undefined,
                ]
                  .filter(Boolean)
                  .join("\n"),
                "Slack channels",
              );
            }
          } catch (err) {
            await prompter.note(
              `Channel lookup failed; keeping entries as typed. ${String(err)}`,
              "Slack channels",
            );
          }
        }
        next = setSlackGroupPolicy(next, slackAccountId, "allowlist");
        next = setSlackChannelAllowlist(next, slackAccountId, keys);
      }
    }

    return { cfg: next, accountId: slackAccountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      slack: { ...cfg.channels?.slack, enabled: false },
    },
  }),
};
