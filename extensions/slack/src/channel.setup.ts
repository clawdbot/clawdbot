import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { type ResolvedSlackAccount } from "./accounts.js";
import {
  listSlackAccountIds,
  resolveSlackConfigAccessorAccount,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
  type SlackConfigAccessorAccount,
} from "./accounts.js";
import { type ChannelPlugin } from "./channel-api.js";
import { SlackChannelConfigSchema } from "./config-schema.js";
import { slackSetupAdapter, createSlackSetupWizardProxy } from "./setup-core.js";
import {
  describeSlackSetupAccount,
  isSlackSetupAccountConfigured,
  SLACK_CHANNEL,
} from "./setup-shared.js";

const slackSetupWizard = createSlackSetupWizardProxy(async () => ({
  slackSetupWizard: (await import("./setup-surface.js")).slackSetupWizard,
}));

const slackSetupConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedSlackAccount,
  SlackConfigAccessorAccount
>({
  sectionKey: SLACK_CHANNEL,
  listAccountIds: listSlackAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveSlackAccount),
  resolveAccessorAccount: resolveSlackConfigAccessorAccount,
  defaultAccountId: resolveDefaultSlackAccountId,
  clearBaseFields: ["botToken", "appToken", "name"],
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
  resolveDefaultTo: (account) => account.defaultTo,
});

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
    ...slackSetupConfigAdapter,
    hasConfiguredState: ({ env }) =>
      ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "SLACK_USER_TOKEN"].some(
        (key) => typeof env?.[key] === "string" && env[key]?.trim().length > 0,
      ),
    isConfigured: (account) => isSlackSetupAccountConfigured(account),
    describeAccount: (account) => describeSlackSetupAccount(account),
  },
  setup: slackSetupAdapter,
};
