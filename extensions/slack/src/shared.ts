// Slack plugin module implements shared behavior.
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { adaptScopedAccountAccessor } from "openclaw/plugin-sdk/channel-config-helpers";
import { isSlackPluginAccountConfigured } from "./account-configured.js";
import { inspectSlackAccount } from "./account-inspect.js";
import type { ResolvedSlackAccount } from "./accounts.js";
import { getChatChannelMeta, type ChannelPlugin } from "./channel-api.js";
import { slackSetupPlugin } from "./channel.setup.js";
import { slackBaseConfigAdapter } from "./config-adapter.js";
import { slackDoctor } from "./doctor.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { slackSecurityAdapter } from "./security.js";

export { SLACK_CHANNEL } from "./setup-shared.js";

export { isSlackPluginAccountConfigured };

export const slackConfigAdapter = {
  ...slackBaseConfigAdapter,
  inspectAccount: adaptScopedAccountAccessor(inspectSlackAccount),
};

export function createSlackPluginBase(params: {
  setupWizard: NonNullable<ChannelPlugin<ResolvedSlackAccount>["setupWizard"]>;
  setupContract: NonNullable<ChannelPlugin<ResolvedSlackAccount>["setupContract"]>;
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
  | "setupContract"
  | "security"
  | "secrets"
> {
  return {
    ...slackSetupPlugin,
    meta: {
      ...getChatChannelMeta(slackSetupPlugin.id),
      preferSessionLookupForAnnounceTarget: true,
    },
    setupWizard: params.setupWizard,
    setupContract: params.setupContract,
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
    security: slackSecurityAdapter,
    config: {
      ...slackSetupPlugin.config,
      ...slackConfigAdapter,
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
  };
}
