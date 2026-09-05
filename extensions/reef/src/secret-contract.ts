import {
  collectSecretInputAssignment,
  createChannelSecretTargetRegistryEntries,
  getChannelRecord,
  isRecord,
  type ResolverContext,
  type SecretDefaults,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries = createChannelSecretTargetRegistryEntries({
  channelKey: "reef",
  channel: ["guard.apiKey"],
});

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const channel = getChannelRecord(params.config, "reef");
  if (!channel || !isRecord(channel.guard)) {
    return;
  }
  const guard = channel.guard;
  collectSecretInputAssignment({
    value: guard.apiKey,
    path: "channels.reef.guard.apiKey",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: channel.enabled !== false,
    inactiveReason: "Reef channel is disabled.",
    owner: {
      ownerKind: "account",
      ownerId: "reef:default",
      requiredForGateway: false,
      disposition: "isolate",
      contract: channel,
    },
    apply: (value) => {
      guard.apiKey = value;
    },
  });
}

export const channelSecrets = { secretTargetRegistryEntries, collectRuntimeConfigAssignments };
