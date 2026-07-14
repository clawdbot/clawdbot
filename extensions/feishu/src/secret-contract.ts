// Feishu plugin module implements secret contract behavior.
import {
  collectConditionalChannelFieldAssignments,
  collectSecretInputAssignment,
  createChannelSecretTargetRegistryEntries,
  getChannelSurface,
  hasConfiguredSecretInputValue,
  hasOwnProperty,
  isBaseFieldActiveForChannelSurface,
  normalizeSecretStringValue,
  type ResolverContext,
  type SecretDefaults,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries = createChannelSecretTargetRegistryEntries({
  channelKey: "feishu",
  account: ["appSecret", "encryptKey", "verificationToken"],
  channel: ["appSecret", "encryptKey", "verificationToken"],
});

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "feishu");
  if (!resolved) {
    return;
  }
  const { channel: feishu, surface } = resolved;
  // Feishu account listing starts an implicit default account from top-level
  // appId+appSecret even when every named account overrides appSecret.  The
  // shared helper's isBaseFieldActiveForChannelSurface only checks whether any
  // explicit account inherits the field, so top-level appSecret refs would be
  // skipped when all accounts override.  Account for the implicit default here.
  const hasImplicitDefaultAccount =
    surface.channelEnabled &&
    hasConfiguredSecretInputValue(feishu.appId, params.defaults) &&
    hasConfiguredSecretInputValue(feishu.appSecret, params.defaults);
  const topLevelAppSecretActive =
    hasImplicitDefaultAccount || isBaseFieldActiveForChannelSurface(surface, "appSecret");
  collectSecretInputAssignment({
    value: feishu.appSecret,
    path: "channels.feishu.appSecret",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: topLevelAppSecretActive,
    inactiveReason: "no enabled account inherits this top-level Feishu appSecret.",
    apply: (value) => {
      feishu.appSecret = value;
    },
  });
  if (surface.hasExplicitAccounts) {
    for (const { accountId, account, enabled } of surface.accounts) {
      if (!hasOwnProperty(account, "appSecret")) {
        continue;
      }
      collectSecretInputAssignment({
        value: account.appSecret,
        path: `channels.feishu.accounts.${accountId}.appSecret`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: enabled,
        inactiveReason: "Feishu account is disabled.",
        apply: (value) => {
          account.appSecret = value;
        },
      });
    }
  }
  const baseConnectionMode =
    normalizeSecretStringValue(feishu.connectionMode) === "webhook" ? "webhook" : "websocket";
  const resolveAccountMode = (account: Record<string, unknown>) =>
    hasOwnProperty(account, "connectionMode")
      ? normalizeSecretStringValue(account.connectionMode)
      : baseConnectionMode;
  collectConditionalChannelFieldAssignments({
    channelKey: "feishu",
    field: "encryptKey",
    channel: feishu,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActiveWithoutAccounts: baseConnectionMode === "webhook",
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      enabled &&
      !hasOwnProperty(account, "encryptKey") &&
      resolveAccountMode(account) === "webhook",
    accountActive: ({ account, enabled }) => enabled && resolveAccountMode(account) === "webhook",
    topInactiveReason: "no enabled Feishu webhook-mode surface inherits this top-level encryptKey.",
    accountInactiveReason: "Feishu account is disabled or not running in webhook mode.",
  });
  collectConditionalChannelFieldAssignments({
    channelKey: "feishu",
    field: "verificationToken",
    channel: feishu,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActiveWithoutAccounts: baseConnectionMode === "webhook",
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      enabled &&
      !hasOwnProperty(account, "verificationToken") &&
      resolveAccountMode(account) === "webhook",
    accountActive: ({ account, enabled }) => enabled && resolveAccountMode(account) === "webhook",
    topInactiveReason:
      "no enabled Feishu webhook-mode surface inherits this top-level verificationToken.",
    accountInactiveReason: "Feishu account is disabled or not running in webhook mode.",
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
