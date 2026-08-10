// Slack plugin module implements secret contract behavior.
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  collectConditionalChannelFieldAssignments,
  collectNestedChannelFieldAssignments,
  collectSimpleChannelFieldAssignments,
  createChannelSecretTargetRegistryEntries,
  getChannelSurface,
  hasConfiguredSecretInputValue,
  hasOwnProperty,
  type ResolverContext,
  type SecretDefaults,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { slackChannelHasImplicitDefaultAccount } from "./accounts.js";

export const secretTargetRegistryEntries = createChannelSecretTargetRegistryEntries({
  channelKey: "slack",
  account: ["appToken", "relay.authToken", "botToken", "signingSecret", "userToken"],
  channel: ["appToken", "botToken", "relay.authToken", "signingSecret", "userToken"],
});

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
  // Slack account listing starts an implicit default account from top-level
  // credentials even when every named account overrides them.  The shared
  // surface helper only lists explicit accounts, so top-level SecretRefs would
  // be marked inactive and orphaned when all accounts override.  Synthesize the
  // implicit default surface entry here, reusing the same eligibility predicate
  // as account listing (see slackChannelHasImplicitDefaultAccount) so the two
  // paths agree on when a default account exists.
  const hasValue = (value: unknown) => hasConfiguredSecretInputValue(value, params.defaults);
  if (
    surface.channelEnabled &&
    surface.hasExplicitAccounts &&
    slackChannelHasImplicitDefaultAccount(slack, hasValue) &&
    !surface.accounts.some(({ accountId }) => normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID)
  ) {
    surface.accounts.push({ accountId: DEFAULT_ACCOUNT_ID, account: {}, enabled: true });
  }
  const resolveMode = (value: unknown) =>
    value === "http" || value === "socket" || value === "relay" ? value : undefined;
  const baseMode = resolveMode(slack.mode) ?? "socket";
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
    resolveMode(account.mode) ?? baseMode;
  const hasNestedAuthTokenOverride = (account: Record<string, unknown>) => {
    const relay = account.relay;
    return (
      relay !== null &&
      typeof relay === "object" &&
      !Array.isArray(relay) &&
      hasOwnProperty(relay as Record<string, unknown>, "authToken")
    );
  };
  collectConditionalChannelFieldAssignments({
    channelKey: "slack",
    field: "appToken",
    channel: slack,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActiveWithoutAccounts: baseMode === "socket",
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      enabled && !hasOwnProperty(account, "appToken") && resolveAccountMode(account) === "socket",
    accountActive: ({ account, enabled }) => enabled && resolveAccountMode(account) === "socket",
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
  collectNestedChannelFieldAssignments({
    channelKey: "slack",
    nestedKey: "relay",
    field: "authToken",
    channel: slack,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActive:
      surface.channelEnabled &&
      ((!surface.hasExplicitAccounts && baseMode === "relay") ||
        surface.accounts.some(
          ({ account, enabled }) =>
            enabled &&
            resolveAccountMode(account) === "relay" &&
            !hasNestedAuthTokenOverride(account),
        )),
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      enabled && resolveAccountMode(account) === "relay" && !hasNestedAuthTokenOverride(account),
    topInactiveReason:
      "no enabled Slack relay-mode surface inherits this top-level relay authToken.",
    accountActive: ({ account, enabled }) => enabled && resolveAccountMode(account) === "relay",
    accountInactiveReason: "Slack account is disabled or not running in relay mode.",
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
