import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { inspectSlackAccount } from "./account-inspect.js";
import {
  listSlackAccountIds,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
  type ResolvedSlackAccount,
} from "./accounts.js";
import { getChatChannelMeta, type ChannelPlugin } from "./channel-api.js";
import { SlackChannelConfigSchema } from "./config-schema.js";
import { slackDoctor } from "./doctor.js";
import { isSlackInteractiveRepliesEnabled } from "./interactive-replies.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { slackSecurityAdapter } from "./security.js";
import { SLACK_CHANNEL } from "./setup-shared.js";

export {
  buildSlackSetupLines,
  isSlackSetupAccountConfigured,
  setSlackChannelAllowlist,
  SLACK_CHANNEL,
} from "./setup-shared.js";

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
  | "security"
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
    security: slackSecurityAdapter,
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
    | "security"
    | "secrets"
  >;
}
