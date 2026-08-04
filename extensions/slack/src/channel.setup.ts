// Slack plugin module implements channel.setup behavior.
import type { ResolvedSlackAccount } from "./accounts.js";
import type { ChannelPlugin } from "./channel-api.js";
import { slackBaseConfigAdapter } from "./config-adapter.js";
import { SlackChannelConfigSchema } from "./config-schema.js";
import { slackSetupContract, createSlackSetupWizardProxy } from "./setup-core.js";
import {
  describeSlackSetupAccount,
  isSlackSetupAccountConfigured,
  SLACK_CHANNEL,
} from "./setup-shared.js";

const slackSetupWizard = createSlackSetupWizardProxy(async () => ({
  slackSetupWizard: (await import("./setup-surface.js")).slackSetupWizard,
}));

export const slackSetupPlugin: ChannelPlugin<ResolvedSlackAccount> = {
  id: SLACK_CHANNEL,
  meta: {
    id: SLACK_CHANNEL,
    label: "Slack",
    selectionLabel: "Slack (Socket Mode)",
    detailLabel: "Slack Bot",
    docsPath: "/channels/slack",
    docsLabel: "slack",
    blurb: "supported (Socket Mode).",
    systemImage: "number",
    markdownCapable: true,
    preferSessionLookupForAnnounceTarget: true,
  },
  setupWizard: slackSetupWizard,
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
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.slack"] },
  configSchema: SlackChannelConfigSchema,
  config: {
    ...slackBaseConfigAdapter,
    hasConfiguredState: ({ env }) =>
      ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "SLACK_USER_TOKEN"].some(
        (key) => typeof env?.[key] === "string" && env[key]?.trim().length > 0,
      ),
    isConfigured: (account) => isSlackSetupAccountConfigured(account),
    describeAccount: (account) => describeSlackSetupAccount(account),
  },
  setupContract: slackSetupContract,
};
