import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input";
import { patchChannelConfigForAccount } from "openclaw/plugin-sdk/setup-runtime";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { inspectSlackAccount } from "./account-inspect.js";
import {
  listSlackAccountIds,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
  type ResolvedSlackAccount,
} from "./accounts.js";
import { getChatChannelMeta, type ChannelPlugin, type OpenClawConfig } from "./channel-api.js";
import { SlackChannelConfigSchema } from "./config-schema.js";
import { slackDoctor } from "./doctor.js";
import { isSlackInteractiveRepliesEnabled } from "./interactive-replies.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";

export const SLACK_CHANNEL = "slack" as const;

function buildSlackManifest(botName: string) {
  const safeName = botName.trim() || "OpenClaw";
  const manifest = {
    display_information: {
      name: safeName,
      description: `${safeName} connector for OpenClaw`,
    },
    features: {
      bot_user: {
        display_name: safeName,
        always_online: true,
      },
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      slash_commands: [
        {
          command: "/openclaw",
          description: "Send a message to OpenClaw",
          should_escape: false,
        },
      ],
    },
    oauth_config: {
      scopes: {
        bot: [
          "app_mentions:read",
          "assistant:write",
          "channels:history",
          "channels:read",
          "chat:write",
          "commands",
          "emoji:read",
          "files:read",
          "files:write",
          "groups:history",
          "groups:read",
          "im:history",
          "im:read",
          "im:write",
          "mpim:history",
          "mpim:read",
          "mpim:write",
          "pins:read",
          "pins:write",
          "reactions:read",
          "reactions:write",
          "users:read",
        ],
      },
    },
    settings: {
      socket_mode_enabled: true,
      event_subscriptions: {
        bot_events: [
          "app_mention",
          "channel_rename",
          "member_joined_channel",
          "member_left_channel",
          "message.channels",
          "message.groups",
          "message.im",
          "message.mpim",
          "pin_added",
          "pin_removed",
          "reaction_added",
          "reaction_removed",
        ],
      },
    },
  };
  return JSON.stringify(manifest, null, 2);
}

export function buildSlackSetupLines(botName = "OpenClaw"): string[] {
  return [
    "1) Slack API -> Create App -> From scratch or From manifest (with the JSON below)",
    "2) Add Socket Mode + enable it to get the app-level token (xapp-...)",
    "3) Install App to workspace to get the xoxb- bot token",
    "4) Enable Event Subscriptions (socket) for message events",
    "5) App Home -> enable the Messages tab for DMs",
    "Tip: set SLACK_BOT_TOKEN + SLACK_APP_TOKEN in your env.",
    `Docs: ${formatDocsLink("/slack", "slack")}`,
    "",
    "Manifest (JSON):",
    buildSlackManifest(botName),
  ];
}

export function setSlackChannelAllowlist(
  cfg: OpenClawConfig,
  accountId: string,
  channelKeys: string[],
): OpenClawConfig {
  const channels = Object.fromEntries(channelKeys.map((key) => [key, { enabled: true }]));
  return patchChannelConfigForAccount({
    cfg,
    channel: SLACK_CHANNEL,
    accountId,
    patch: { channels },
  });
}

export function isSlackPluginAccountConfigured(account: ResolvedSlackAccount): boolean {
  const mode = account.config.mode ?? "socket";
  const hasBotToken = Boolean(account.botToken?.trim());
  if (!hasBotToken) {
    return false;
  }
  if (mode === "http") {
    return Boolean(account.config.signingSecret?.trim());
  }
  return Boolean(account.appToken?.trim());
}

export function isSlackSetupAccountConfigured(account: ResolvedSlackAccount): boolean {
  const hasConfiguredBotToken =
    Boolean(account.botToken?.trim()) || hasConfiguredSecretInput(account.config.botToken);
  const hasConfiguredAppToken =
    Boolean(account.appToken?.trim()) || hasConfiguredSecretInput(account.config.appToken);
  return hasConfiguredBotToken && hasConfiguredAppToken;
}

export const slackConfigAdapter = createScopedChannelConfigAdapter<ResolvedSlackAccount>({
  sectionKey: SLACK_CHANNEL,
  listAccountIds: listSlackAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveSlackAccount),
  inspectAccount: adaptScopedAccountAccessor(inspectSlackAccount),
  defaultAccountId: resolveDefaultSlackAccountId,
  clearBaseFields: ["botToken", "appToken", "name"],
  resolveAllowFrom: (account: ResolvedSlackAccount) => account.dm?.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
  resolveDefaultTo: (account: ResolvedSlackAccount) => account.config.defaultTo,
});

export function createSlackPluginBase(params: {
  setupWizard: NonNullable<ChannelPlugin<ResolvedSlackAccount>["setupWizard"]>;
  setup: NonNullable<ChannelPlugin<ResolvedSlackAccount>["setup"]>;
}): Pick<
  ChannelPlugin<ResolvedSlackAccount>,
  | "id"
  | "meta"
  | "setupWizard"
  | "capabilities"
  | "commands"
  | "doctor"
  | "agentPrompt"
  | "streaming"
  | "reload"
  | "configSchema"
  | "config"
  | "setup"
  | "secrets"
> {
  return {
    id: SLACK_CHANNEL,
    meta: {
      ...getChatChannelMeta(SLACK_CHANNEL),
      preferSessionLookupForAnnounceTarget: true,
    },
    setupWizard: params.setupWizard,
    capabilities: {
      chatTypes: ["direct", "channel", "thread"],
      reactions: true,
      threads: true,
      media: true,
      nativeCommands: true,
    },
    commands: {
      nativeCommandsAutoEnabled: false,
      nativeSkillsAutoEnabled: false,
      resolveNativeCommandName: ({ commandKey, defaultName }) =>
        commandKey === "status" ? "agentstatus" : defaultName,
    },
    doctor: slackDoctor,
    agentPrompt: {
      inboundFormattingHints: () => ({
        text_markup: "slack_mrkdwn",
        rules: [
          "Use Slack mrkdwn, not standard Markdown.",
          "Bold uses *single asterisks*.",
          "Links use <url|label>.",
          "Code blocks use triple backticks without a language identifier.",
          "Do not use markdown headings or pipe tables.",
        ],
      }),
      messageToolHints: ({ cfg, accountId }) =>
        isSlackInteractiveRepliesEnabled({ cfg, accountId })
          ? [
              "- Prefer Slack buttons/selects for 2-5 discrete choices or parameter picks instead of asking the user to type one.",
              "- Slack interactive replies: use `[[slack_buttons: Label:value, Other:other]]` to add action buttons that route clicks back as Slack interaction system events.",
              "- Slack selects: use `[[slack_select: Placeholder | Label:value, Other:other]]` to add a static select menu that routes the chosen value back as a Slack interaction system event.",
            ]
          : [
              "- Slack interactive replies are disabled. If needed, ask to set `channels.slack.capabilities.interactiveReplies=true` (or the same under `channels.slack.accounts.<account>.capabilities`).",
            ],
    },
    streaming: {
      blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
    },
    reload: { configPrefixes: ["channels.slack"] },
    configSchema: SlackChannelConfigSchema,
    config: {
      ...slackConfigAdapter,
      hasConfiguredState: ({ env }) =>
        ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "SLACK_USER_TOKEN"].some(
          (key) => typeof env?.[key] === "string" && env[key]?.trim().length > 0,
        ),
      isConfigured: (account) => isSlackPluginAccountConfigured(account),
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: isSlackPluginAccountConfigured(account),
          extra: {
            botTokenSource: account.botTokenSource,
            appTokenSource: account.appTokenSource,
          },
        }),
    },
    secrets: {
      secretTargetRegistryEntries,
      collectRuntimeConfigAssignments,
    },
    setup: params.setup,
  } as Pick<
    ChannelPlugin<ResolvedSlackAccount>,
    | "id"
    | "meta"
    | "setupWizard"
    | "capabilities"
    | "commands"
    | "doctor"
    | "agentPrompt"
    | "streaming"
    | "reload"
    | "configSchema"
    | "config"
    | "setup"
    | "secrets"
  >;
}
