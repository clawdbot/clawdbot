import {
  collectConditionalChannelFieldAssignments,
  collectSimpleChannelFieldAssignments,
  getChannelSurface,
  hasOwnProperty,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries = [
  {
    id: "channels.slack.accounts.*.appToken",
    targetType: "channels.slack.accounts.*.appToken",
    configFile: "openclaw.json",
    pathPattern: "channels.slack.accounts.*.appToken",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.slack.accounts.*.botToken",
    targetType: "channels.slack.accounts.*.botToken",
    configFile: "openclaw.json",
    pathPattern: "channels.slack.accounts.*.botToken",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.slack.accounts.*.signingSecret",
    targetType: "channels.slack.accounts.*.signingSecret",
    configFile: "openclaw.json",
    pathPattern: "channels.slack.accounts.*.signingSecret",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.slack.accounts.*.userToken",
    targetType: "channels.slack.accounts.*.userToken",
    configFile: "openclaw.json",
    pathPattern: "channels.slack.accounts.*.userToken",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.slack.appToken",
    targetType: "channels.slack.appToken",
    configFile: "openclaw.json",
    pathPattern: "channels.slack.appToken",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.slack.botToken",
    targetType: "channels.slack.botToken",
    configFile: "openclaw.json",
    pathPattern: "channels.slack.botToken",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.slack.signingSecret",
    targetType: "channels.slack.signingSecret",
    configFile: "openclaw.json",
    pathPattern: "channels.slack.signingSecret",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.slack.userToken",
    targetType: "channels.slack.userToken",
    configFile: "openclaw.json",
    pathPattern: "channels.slack.userToken",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
] satisfies SecretTargetRegistryEntry[];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "slack");
  if (!resolved) {
    return;
  }
  const { channel: slack, surface } = resolved;
  const baseMode = slack.mode === "http" || slack.mode === "socket" ? slack.mode : "socket";
  const fields = ["botToken", "userToken"] as const;
  for (const field of fields) {
    collectSimpleChannelFieldAssignments({
      channelKey: "slack",
      field,
      channel: slack,
      surface,
      defaults: params.defaults,
      context: params.context,
      topInactiveReason: `no enabled account inherits this top-level Slack ${field}.`,
      accountInactiveReason: "Slack account is disabled.",
    });
  }
  const resolveAccountMode = (account: Record<string, unknown>) =>
    account.mode === "http" || account.mode === "socket" ? account.mode : baseMode;
  collectConditionalChannelFieldAssignments({
    channelKey: "slack",
    field: "appToken",
    channel: slack,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActiveWithoutAccounts: baseMode !== "http",
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      enabled && !hasOwnProperty(account, "appToken") && resolveAccountMode(account) !== "http",
    accountActive: ({ account, enabled }) => enabled && resolveAccountMode(account) !== "http",
    topInactiveReason: "no enabled Slack socket-mode surface inherits this top-level appToken.",
    accountInactiveReason: "Slack account is disabled or not running in socket mode.",
  });
  collectConditionalChannelFieldAssignments({
    channelKey: "slack",
    field: "signingSecret",
    channel: slack,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActiveWithoutAccounts: baseMode === "http",
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      enabled &&
      !hasOwnProperty(account, "signingSecret") &&
      resolveAccountMode(account) === "http",
    accountActive: ({ account, enabled }) => enabled && resolveAccountMode(account) === "http",
    topInactiveReason: "no enabled Slack HTTP-mode surface inherits this top-level signingSecret.",
    accountInactiveReason: "Slack account is disabled or not running in HTTP mode.",
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
