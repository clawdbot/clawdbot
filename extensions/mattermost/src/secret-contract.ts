// Mattermost plugin module implements secret contract behavior.
import {
  collectSimpleChannelFieldAssignments,
  createChannelSecretTargetRegistryEntries,
  getChannelSurface,
  type ResolverContext,
  type SecretDefaults,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries = createChannelSecretTargetRegistryEntries({
  channelKey: "mattermost",
  account: ["botToken"],
  channel: ["botToken"],
});

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "mattermost");
  if (!resolved) {
    return;
  }
  const { channel: mattermost, surface } = resolved;
  collectSimpleChannelFieldAssignments({
    channelKey: "mattermost",
    field: "botToken",
    channel: mattermost,
    surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: "no enabled account inherits this top-level Mattermost botToken.",
    accountInactiveReason: "Mattermost account is disabled.",
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
