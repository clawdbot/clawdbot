import { mergeAccountConfig } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  collectSecretInputAssignment,
  createChannelSecretTargetRegistryEntries,
  getChannelSurface,
  hasOwnProperty,
  type ResolverContext,
  type SecretDefaults,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

const CREDENTIAL_FIELDS = ["privateKey", "authTag"] as const;
const ACCOUNT_OWNED_FIELDS = [
  "name",
  "relayUrl",
  "privateKey",
  "authTag",
  "groups",
  "defaultTo",
] as const;

function createBuzzAccountSecretOwner(
  accountId: string,
  channel: Record<string, unknown>,
  account: Record<string, unknown>,
) {
  const normalizedAccountId = normalizeAccountId(accountId);
  const contract = mergeAccountConfig({
    channelConfig: channel,
    accountConfig: account,
    omitKeys: [
      "defaultAccount",
      ...(normalizedAccountId === DEFAULT_ACCOUNT_ID ? [] : ACCOUNT_OWNED_FIELDS),
    ],
  });

  return {
    ownerKind: "account" as const,
    ownerId: `buzz:${normalizedAccountId}`,
    requiredForGateway: false,
    disposition: "isolate" as const,
    contract,
  };
}

export const secretTargetRegistryEntries = createChannelSecretTargetRegistryEntries({
  channelKey: "buzz",
  account: CREDENTIAL_FIELDS,
  channel: CREDENTIAL_FIELDS,
});

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "buzz");
  if (!resolved) {
    return;
  }
  const { channel: buzz, surface } = resolved;
  const defaultAccount = surface.hasExplicitAccounts
    ? surface.accounts.find(({ accountId }) => normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID)
    : undefined;
  const defaultAccountEnabled = surface.channelEnabled && (defaultAccount?.enabled ?? true);

  for (const field of CREDENTIAL_FIELDS) {
    collectSecretInputAssignment({
      value: buzz[field],
      path: `channels.buzz.${field}`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: defaultAccountEnabled && !hasOwnProperty(defaultAccount?.account ?? {}, field),
      inactiveReason:
        "Buzz channel or default account is disabled, or the scoped default account overrides the legacy root credential.",
      owner: createBuzzAccountSecretOwner(DEFAULT_ACCOUNT_ID, buzz, defaultAccount?.account ?? {}),
      apply: (value) => {
        buzz[field] = value;
      },
    });
  }

  if (!surface.hasExplicitAccounts) {
    return;
  }
  for (const { accountId, account, enabled } of surface.accounts) {
    for (const field of CREDENTIAL_FIELDS) {
      if (!hasOwnProperty(account, field)) {
        continue;
      }
      collectSecretInputAssignment({
        value: account[field],
        path: `channels.buzz.accounts.${accountId}.${field}`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: enabled,
        inactiveReason: "Buzz account is disabled.",
        owner: createBuzzAccountSecretOwner(accountId, buzz, account),
        apply: (value) => {
          account[field] = value;
        },
      });
    }
  }
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
