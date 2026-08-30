// Msteams plugin module implements secret contract behavior.
import {
  collectSecretInputAssignment,
  createChannelSecretTargetRegistryEntries,
  getChannelSurface,
  hasOwnProperty,
  isBaseFieldActiveForChannelSurface,
  type ResolverContext,
  type SecretDefaults,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/setup";

export const secretTargetRegistryEntries = createChannelSecretTargetRegistryEntries({
  channelKey: "msteams",
  account: ["appPassword"],
  channel: ["appPassword"],
});

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "msteams");
  if (!resolved) {
    return;
  }
  const { channel: msteams, surface } = resolved;

  collectSecretInputAssignment({
    value: msteams.appPassword,
    path: "channels.msteams.appPassword",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active:
      isBaseFieldActiveForChannelSurface(surface, "appPassword") ||
      isRootDefaultIdentityActive(msteams, surface),
    inactiveReason: "no enabled account inherits this top-level Microsoft Teams appPassword.",
    owner: {
      ownerKind: "account",
      ownerId: "msteams:default",
      requiredForGateway: false,
      disposition: "isolate",
      contract: msteams,
    },
    apply: (value) => {
      msteams.appPassword = value;
    },
  });

  if (!surface.hasExplicitAccounts) {
    return;
  }
  for (const { accountId, account, enabled } of surface.accounts) {
    if (!hasOwnProperty(account, "appPassword")) {
      continue;
    }
    collectSecretInputAssignment({
      value: account.appPassword,
      path: `channels.msteams.accounts.${accountId}.appPassword`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: enabled,
      inactiveReason: "Microsoft Teams account is disabled.",
      apply: (value) => {
        account.appPassword = value;
      },
    });
  }
}

function isConfiguredIdentityField(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return value !== undefined && value !== null;
}

function isRootDefaultIdentityActive(
  channel: Record<string, unknown>,
  surface: {
    channelEnabled: boolean;
    hasExplicitAccounts: boolean;
    accounts: readonly { accountId: string; enabled: boolean }[];
  },
): boolean {
  const explicitDefault = surface.hasExplicitAccounts
    ? surface.accounts.find(({ accountId }) => normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID)
    : undefined;
  const defaultEnabled = explicitDefault?.enabled ?? surface.channelEnabled;
  return (
    defaultEnabled &&
    (isConfiguredIdentityField(channel.appId) || isConfiguredIdentityField(channel.appPassword))
  );
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
