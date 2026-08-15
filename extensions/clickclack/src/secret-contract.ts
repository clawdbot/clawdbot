// ClickClack plugin module implements token secret contract behavior.
import {
  collectConditionalChannelFieldAssignments,
  createChannelSecretTargetRegistryEntries,
  getChannelSurface,
  hasConfiguredSecretInputValue,
  type ResolverContext,
  type SecretDefaults,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const secretTargetRegistryEntries = createChannelSecretTargetRegistryEntries({
  channelKey: "clickclack",
  account: ["token"],
  channel: ["token"],
});

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "clickclack");
  if (!resolved) {
    return;
  }
  const { channel: clickclack, surface } = resolved;
  const baseTokenFile = normalizeOptionalString(clickclack.tokenFile) ?? "";
  const accountTokenFile = (account: Record<string, unknown>) =>
    normalizeOptionalString(account.tokenFile) ?? "";
  const hasImplicitDefault =
    Boolean(normalizeOptionalString(clickclack.baseUrl)) &&
    Boolean(normalizeOptionalString(clickclack.workspace));

  collectConditionalChannelFieldAssignments({
    channelKey: "clickclack",
    field: "token",
    channel: clickclack,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActiveWithoutAccounts: baseTokenFile.length === 0,
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      (hasImplicitDefault && baseTokenFile.length === 0) ||
      (enabled &&
        baseTokenFile.length === 0 &&
        accountTokenFile(account).length === 0 &&
        !hasConfiguredSecretInputValue(account.token, params.defaults)),
    accountActive: ({ account, enabled }) => enabled && accountTokenFile(account).length === 0,
    topInactiveReason:
      "no enabled ClickClack account inherits this top-level token (tokenFile is configured).",
    accountInactiveReason: "ClickClack account is disabled or tokenFile is configured.",
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
