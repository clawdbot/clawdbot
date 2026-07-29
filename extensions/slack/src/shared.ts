// Slack plugin module implements shared behavior.
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { adaptScopedAccountAccessor } from "openclaw/plugin-sdk/channel-config-helpers";
import { isSlackPluginAccountConfigured } from "./account-configured.js";
import { inspectSlackAccount } from "./account-inspect.js";
import type { ResolvedSlackAccount } from "./accounts.js";
import { getChatChannelMeta, type ChannelPlugin } from "./channel-api.js";
import { slackBaseConfigAdapter } from "./config-adapter.js";
import { SlackChannelConfigSchema } from "./config-schema.js";
import { slackDoctor } from "./doctor.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { slackSecurityAdapter } from "./security.js";
import { SLACK_CHANNEL } from "./setup-shared.js";

export { SLACK_CHANNEL } from "./setup-shared.js";

export { isSlackPluginAccountConfigured };

export const slackConfigAdapter = {
  ...slackBaseConfigAdapter,
  inspectAccount: adaptScopedAccountAccessor(inspectSlackAccount),
};

export function createSlackPluginBase(params: {
  setupWizard: NonNullable<ChannelPlugin<ResolvedSlackAccount>["setupWizard"]>;
  setup: NonNullable<ChannelPlugin<ResolvedSlackAccount>["setup"]>;
  setupContract?: NonNullable<ChannelPlugin<ResolvedSlackAccount>["setupContract"]>;
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
  | "setupContract"
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
    ...(params.setupContract ? { setupContract: params.setupContract } : {}),
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
      messageToolHints: () => [
        "- Use `presentation` buttons/selects for discrete choices or parameter picks instead of asking the user to type one.",
        "- For line, bar, area, or pie data, use a `presentation` chart block; Slack renders it as a native chart and retains a text data summary for accessibility.",
        "- For row-and-column data, use an explicit `presentation` table block; Slack renders it as a native table and retains a linear text summary for accessibility. Markdown pipe tables are not auto-promoted.",
        "- Slack plain text sends: write standard Markdown; OpenClaw converts it to Slack mrkdwn, including `**bold**`, headings, lists, and `[label](url)` links.",
        "- When mentioning Slack users, use the stable `<@USER_ID>` token from Slack context instead of plain `@name` text so Slack notifies and links the user.",
        "- Slack Block Kit or presentation text fields are sent as Slack mrkdwn directly; use `*bold*`, `_italic_`, `~strike~`, `<url|label>` links, and avoid Markdown headings or pipe tables there.",
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
