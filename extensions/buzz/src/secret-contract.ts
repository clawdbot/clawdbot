import {
  collectSecretInputAssignment,
  createChannelSecretTargetRegistryEntries,
  getChannelRecord,
  isRecord,
  type ResolverContext,
  type SecretDefaults,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveBuzzAccountConfig } from "./types.js";

const fields = ["privateKey", "authTag"] as const;

export const secretTargetRegistryEntries = createChannelSecretTargetRegistryEntries({
  channelKey: "buzz",
  account: fields,
  channel: fields,
});

export function collectRuntimeConfigAssignments(params: {
  config: OpenClawConfig;
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const root = getChannelRecord(params.config, "buzz");
  if (!root) {
    return;
  }
  const collect = (accountId: string, account: Record<string, unknown>, rootIdentity = false) => {
    const resolved = resolveBuzzAccountConfig({ cfg: params.config, accountId });
    const active = resolved.config.enabled !== false && (!rootIdentity || resolved.allowEnv);
    const configPath = rootIdentity ? "channels.buzz" : resolved.configPath;
    for (const field of fields) {
      collectSecretInputAssignment({
        value: account[field],
        path: `${configPath}.${field}`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active,
        inactiveReason: "Buzz identity is disabled or replaced by accounts.default.",
        owner: {
          ownerKind: "account",
          ownerId: `buzz:${accountId}`,
          requiredForGateway: false,
          disposition: "isolate",
          // Recovery follows this identity and its effective policy, never another account's key.
          contract: resolved.config,
        },
        apply: (value) => {
          account[field] = value;
        },
      });
    }
  };
  collect("default", root, true);
  if (isRecord(root.accounts)) {
    for (const [accountId, account] of Object.entries(root.accounts).toSorted(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (isRecord(account)) {
        collect(accountId, account);
      }
    }
  }
}

export const channelSecrets = { secretTargetRegistryEntries, collectRuntimeConfigAssignments };
