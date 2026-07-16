import {
  collectConditionalChannelFieldAssignments,
  getChannelSurface,
  hasOwnProperty,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries = [
  {
    id: "channels.zalo.accounts.*.botToken",
    targetType: "channels.zalo.accounts.*.botToken",
    configFile: "openclaw.json",
    pathPattern: "channels.zalo.accounts.*.botToken",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.zalo.accounts.*.webhookSecret",
    targetType: "channels.zalo.accounts.*.webhookSecret",
    configFile: "openclaw.json",
    pathPattern: "channels.zalo.accounts.*.webhookSecret",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.zalo.botToken",
    targetType: "channels.zalo.botToken",
    configFile: "openclaw.json",
    pathPattern: "channels.zalo.botToken",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.zalo.webhookSecret",
    targetType: "channels.zalo.webhookSecret",
    configFile: "openclaw.json",
    pathPattern: "channels.zalo.webhookSecret",
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
  const resolved = getChannelSurface(params.config, "zalo");
  if (!resolved) {
    return;
  }
  const { channel: zalo, surface } = resolved;
  collectConditionalChannelFieldAssignments({
    channelKey: "zalo",
    field: "botToken",
    channel: zalo,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActiveWithoutAccounts: true,
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      enabled && !hasOwnProperty(account, "botToken"),
    accountActive: ({ enabled }) => enabled,
    topInactiveReason: "no enabled Zalo surface inherits this top-level botToken.",
    accountInactiveReason: "Zalo account is disabled.",
  });
  const baseWebhookUrl = typeof zalo.webhookUrl === "string" ? zalo.webhookUrl.trim() : "";
  const accountWebhookUrl = (account: Record<string, unknown>) =>
    hasOwnProperty(account, "webhookUrl")
      ? typeof account.webhookUrl === "string"
        ? account.webhookUrl.trim()
        : ""
      : baseWebhookUrl;
  collectConditionalChannelFieldAssignments({
    channelKey: "zalo",
    field: "webhookSecret",
    channel: zalo,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActiveWithoutAccounts: baseWebhookUrl.length > 0,
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      enabled && !hasOwnProperty(account, "webhookSecret") && accountWebhookUrl(account).length > 0,
    accountActive: ({ account, enabled }) => enabled && accountWebhookUrl(account).length > 0,
    topInactiveReason:
      "no enabled Zalo webhook surface inherits this top-level webhookSecret (webhook mode is not active).",
    accountInactiveReason:
      "Zalo account is disabled or webhook mode is not active for this account.",
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
