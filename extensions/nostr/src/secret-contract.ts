import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  collectSecretInputAssignment,
  createChannelSecretTargetRegistryEntries,
  getChannelRecord,
  type ResolverContext,
  type SecretDefaults,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries = createChannelSecretTargetRegistryEntries({
  channelKey: "nostr",
  channel: ["privateKey"],
});

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const nostr = getChannelRecord(params.config, "nostr");
  if (!nostr) {
    return;
  }
  const accountId = normalizeAccountId(
    typeof nostr.defaultAccount === "string" ? nostr.defaultAccount : undefined,
  );
  collectSecretInputAssignment({
    value: nostr.privateKey,
    path: "channels.nostr.privateKey",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: nostr.enabled !== false,
    inactiveReason: "Nostr channel is disabled.",
    owner: {
      ownerKind: "account",
      ownerId: `nostr:${accountId}`,
      requiredForGateway: false,
      disposition: "isolate",
      contract: nostr,
    },
    apply: (value) => {
      nostr.privateKey = value;
    },
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
