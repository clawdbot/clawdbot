// Nextcloud Talk plugin module implements secret contract behavior.
import {
  collectConditionalChannelFieldAssignments,
  createChannelSecretTargetRegistryEntries,
  getChannelSurface,
  hasOwnProperty,
  type ChannelAccountEntry,
  type ResolverContext,
  type SecretDefaults,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries = createChannelSecretTargetRegistryEntries({
  channelKey: "nextcloud-talk",
  account: ["apiPassword", "botSecret"],
  channel: ["apiPassword", "botSecret"],
});

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "nextcloud-talk");
  if (!resolved) {
    return;
  }
  const { channel: nextcloudTalk, surface } = resolved;
  const inheritsField =
    (field: string) =>
    ({ account, enabled }: ChannelAccountEntry) =>
      enabled && !hasOwnProperty(account, field);
  collectConditionalChannelFieldAssignments({
    channelKey: "nextcloud-talk",
    field: "botSecret",
    channel: nextcloudTalk,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActiveWithoutAccounts: true,
    topLevelInheritedAccountActive: inheritsField("botSecret"),
    accountActive: ({ enabled }) => enabled,
    topInactiveReason: "no enabled Nextcloud Talk surface inherits this top-level botSecret.",
    accountInactiveReason: "Nextcloud Talk account is disabled.",
  });
  collectConditionalChannelFieldAssignments({
    channelKey: "nextcloud-talk",
    field: "apiPassword",
    channel: nextcloudTalk,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActiveWithoutAccounts: true,
    topLevelInheritedAccountActive: inheritsField("apiPassword"),
    accountActive: ({ enabled }) => enabled,
    topInactiveReason: "no enabled Nextcloud Talk surface inherits this top-level apiPassword.",
    accountInactiveReason: "Nextcloud Talk account is disabled.",
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
