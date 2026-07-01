// Nostr plugin module implements secret contract behavior.
import {
  collectSimpleChannelFieldAssignments,
  getChannelSurface,
  type ResolverContext,
  type SecretDefaults,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries: import("openclaw/plugin-sdk/channel-secret-basic-runtime").SecretTargetRegistryEntry[] =
  [
    {
      id: "channels.nostr.privateKey",
      targetType: "channels.nostr.privateKey",
      configFile: "openclaw.json",
      pathPattern: "channels.nostr.privateKey",
      secretShape: "secret_input",
      expectedResolvedValue: "string",
      includeInPlan: true,
      includeInConfigure: true,
      includeInAudit: true,
    },
  ];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "nostr");
  if (!resolved) {
    return;
  }
  const { channel: nostr, surface } = resolved;
  collectSimpleChannelFieldAssignments({
    channelKey: "nostr",
    field: "privateKey",
    channel: nostr,
    surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: "no enabled account inherits this top-level Nostr private key.",
    accountInactiveReason: "Nostr account is disabled.",
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
