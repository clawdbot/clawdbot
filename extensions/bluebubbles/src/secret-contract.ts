import {
  collectSimpleChannelFieldAssignments,
  getChannelSurface,
  type ResolverContext,
  type SecretDefaults,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries: import("openclaw/plugin-sdk/channel-secret-basic-runtime").SecretTargetRegistryEntry[] =
  [
    {
      id: "channels.bluebubbles.accounts.*.password",
      targetType: "channels.bluebubbles.accounts.*.password",
      configFile: "openclaw.json",
      pathPattern: "channels.bluebubbles.accounts.*.password",
      secretShape: "secret_input",
      expectedResolvedValue: "string",
      includeInPlan: true,
      includeInConfigure: true,
      includeInAudit: true,
    },
    {
      id: "channels.bluebubbles.password",
      targetType: "channels.bluebubbles.password",
      configFile: "openclaw.json",
      pathPattern: "channels.bluebubbles.password",
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
  const resolved = getChannelSurface(params.config, "bluebubbles");
  if (!resolved) {
    return;
  }
  const { channel: bluebubbles, surface } = resolved;
  collectSimpleChannelFieldAssignments({
    channelKey: "bluebubbles",
    field: "password",
    channel: bluebubbles,
    surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: "no enabled account inherits this top-level BlueBubbles password.",
    accountInactiveReason: "BlueBubbles account is disabled.",
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
