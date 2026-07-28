// Feishu plugin module implements secret contract behavior.
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  collectConditionalChannelFieldAssignments,
  createChannelSecretTargetRegistryEntries,
  getChannelSurface,
  hasConfiguredSecretInputValue,
  hasOwnProperty,
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
  if (
    hasImplicitDefaultAccount &&
    surface.hasExplicitAccounts &&
    !surface.accounts.some(({ accountId }) => normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID)
  ) {
    surface.accounts.push({ accountId: "default", account: {}, enabled: true });
  }
  collectConditionalChannelFieldAssignments({
    channelKey: "feishu",
    field: "appSecret",
    channel: feishu,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActiveWithoutAccounts: surface.channelEnabled,
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      enabled && !hasOwnProperty(account, "appSecret"),
    accountActive: ({ enabled }) => enabled,
    topInactiveReason: "no enabled account inherits this top-level Feishu appSecret.",
    accountInactiveReason: "Feishu account is disabled.",
  });
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
