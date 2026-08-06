// Matrix plugin module implements secret contract behavior.
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  collectSecretInputAssignment,
  createChannelSecretTargetRegistryEntries,
  getChannelSurface,
  hasConfiguredSecretInputValue,
  hasOwnProperty,
  normalizeSecretStringValue,
  type ResolverContext,
  type SecretDefaults,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { getMatrixScopedEnvVarNames } from "./env-vars.js";

function accountSecretOwner(accountId: string) {
  return {
    ownerKind: "account" as const,
    ownerId: `matrix:${normalizeAccountId(accountId)}`,
    requiredForGateway: false,
    disposition: "isolate" as const,
  };
}

export const secretTargetRegistryEntries = createChannelSecretTargetRegistryEntries({
  channelKey: "matrix",
  account: ["accessToken", "password"],
  channel: ["accessToken", "password"],
});

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "matrix");
  if (!resolved) {
    return;
  }
  const { channel: matrix, surface } = resolved;
  const envAccessTokenConfigured =
    normalizeSecretStringValue(params.context.env.MATRIX_ACCESS_TOKEN).length > 0;
  const defaultScopedAccessTokenConfigured =
    normalizeSecretStringValue(
      params.context.env[getMatrixScopedEnvVarNames("default").accessToken],
    ).length > 0;
  const defaultScopedPasswordConfigured =
    normalizeSecretStringValue(params.context.env[getMatrixScopedEnvVarNames("default").password])
      .length > 0;
  const defaultAccount = surface.hasExplicitAccounts
    ? surface.accounts.find(({ accountId }) => normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID)
    : undefined;
  const defaultAccountEnabled = surface.channelEnabled && (defaultAccount?.enabled ?? true);
  const defaultAccountAccessTokenConfigured = hasConfiguredSecretInputValue(
    defaultAccount?.account.accessToken,
    params.defaults,
  );
  const defaultAccountPasswordConfigured = hasConfiguredSecretInputValue(
    defaultAccount?.account.password,
    params.defaults,
  );
  const baseAccessTokenConfigured = hasConfiguredSecretInputValue(
    matrix.accessToken,
    params.defaults,
  );
  collectSecretInputAssignment({
    value: matrix.accessToken,
    path: "channels.matrix.accessToken",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active:
      defaultAccountEnabled &&
      !defaultAccountAccessTokenConfigured &&
      !defaultScopedAccessTokenConfigured,
    inactiveReason:
      "Matrix channel or default account is disabled, or default-account access-token auth overrides the top-level accessToken.",
    owner: accountSecretOwner(DEFAULT_ACCOUNT_ID),
    apply: (value) => {
      matrix.accessToken = value;
    },
  });
  collectSecretInputAssignment({
    value: matrix.password,
    path: "channels.matrix.password",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active:
      defaultAccountEnabled &&
      !(
        baseAccessTokenConfigured ||
        envAccessTokenConfigured ||
        defaultScopedAccessTokenConfigured ||
        defaultAccountAccessTokenConfigured ||
        defaultAccountPasswordConfigured ||
        defaultScopedPasswordConfigured
      ),
    inactiveReason:
      "Matrix channel or default account is disabled, or higher-precedence default-account auth is configured.",
    owner: accountSecretOwner(DEFAULT_ACCOUNT_ID),
    apply: (value) => {
      matrix.password = value;
    },
  });
  if (!surface.hasExplicitAccounts) {
    return;
  }
  for (const { accountId, account, enabled } of surface.accounts) {
    if (hasOwnProperty(account, "accessToken")) {
      collectSecretInputAssignment({
        value: account.accessToken,
        path: `channels.matrix.accounts.${accountId}.accessToken`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: enabled,
        inactiveReason: "Matrix account is disabled.",
        owner: accountSecretOwner(accountId),
        apply: (value) => {
          account.accessToken = value;
        },
      });
    }
    if (!hasOwnProperty(account, "password")) {
      continue;
    }
    const accountAccessTokenConfigured = hasConfiguredSecretInputValue(
      account.accessToken,
      params.defaults,
    );
    const scopedEnvAccessTokenConfigured =
      normalizeSecretStringValue(
        params.context.env[getMatrixScopedEnvVarNames(accountId).accessToken],
      ).length > 0;
    const inheritedDefaultAccountAccessTokenConfigured =
      normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID &&
      (baseAccessTokenConfigured || envAccessTokenConfigured);
    collectSecretInputAssignment({
      value: account.password,
      path: `channels.matrix.accounts.${accountId}.password`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active:
        enabled &&
        !(
          accountAccessTokenConfigured ||
          scopedEnvAccessTokenConfigured ||
          inheritedDefaultAccountAccessTokenConfigured
        ),
      inactiveReason: "Matrix account is disabled or this account has an accessToken configured.",
      owner: accountSecretOwner(accountId),
      apply: (value) => {
        account.password = value;
      },
    });
  }
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
