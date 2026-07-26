import {
  collectSimpleChannelFieldAssignments,
  createChannelSecretTargetRegistryEntries,
  getChannelSurface,
  type ResolverContext,
  type SecretDefaults,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries = createChannelSecretTargetRegistryEntries({
  channelKey: "buzz",
  channel: ["privateKey", "authTag"],
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
  const { channel, surface } = resolved;
  for (const field of ["privateKey", "authTag"]) {
    collectSimpleChannelFieldAssignments({
      channelKey: "buzz",
      field,
      channel,
      surface,
      defaults: params.defaults,
      context: params.context,
      topInactiveReason: "Buzz channel is disabled.",
      accountInactiveReason: "Buzz channel is disabled.",
    });
  }
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
