import {
  collectNestedChannelFieldAssignments,
  collectSimpleChannelFieldAssignments,
  getChannelSurface,
  isBaseFieldActiveForChannelSurface,
  isEnabledFlag,
  isRecord,
  type ResolverContext,
  type SecretDefaults,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries: import("openclaw/plugin-sdk/channel-secret-basic-runtime").SecretTargetRegistryEntry[] =
  [
    {
      id: "channels.irc.accounts.*.nickserv.password",
      targetType: "channels.irc.accounts.*.nickserv.password",
      configFile: "openclaw.json",
      pathPattern: "channels.irc.accounts.*.nickserv.password",
      secretShape: "secret_input",
      expectedResolvedValue: "string",
      includeInPlan: true,
      includeInConfigure: true,
      includeInAudit: true,
    },
    {
      id: "channels.irc.accounts.*.password",
      targetType: "channels.irc.accounts.*.password",
      configFile: "openclaw.json",
      pathPattern: "channels.irc.accounts.*.password",
      secretShape: "secret_input",
      expectedResolvedValue: "string",
      includeInPlan: true,
      includeInConfigure: true,
      includeInAudit: true,
    },
    {
      id: "channels.irc.nickserv.password",
      targetType: "channels.irc.nickserv.password",
      configFile: "openclaw.json",
      pathPattern: "channels.irc.nickserv.password",
      secretShape: "secret_input",
      expectedResolvedValue: "string",
      includeInPlan: true,
      includeInConfigure: true,
      includeInAudit: true,
    },
    {
      id: "channels.irc.password",
      targetType: "channels.irc.password",
      configFile: "openclaw.json",
      pathPattern: "channels.irc.password",
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
  const resolved = getChannelSurface(params.config, "irc");
  if (!resolved) {
    return;
  }
  const { channel: irc, surface } = resolved;
  collectSimpleChannelFieldAssignments({
    channelKey: "irc",
    field: "password",
    channel: irc,
    surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: "no enabled account inherits this top-level IRC password.",
    accountInactiveReason: "IRC account is disabled.",
  });
  collectNestedChannelFieldAssignments({
    channelKey: "irc",
    nestedKey: "nickserv",
    field: "password",
    channel: irc,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActive:
      isBaseFieldActiveForChannelSurface(surface, "nickserv") &&
      isRecord(irc.nickserv) &&
      isEnabledFlag(irc.nickserv),
    topInactiveReason:
      "no enabled account inherits this top-level IRC nickserv config or NickServ is disabled.",
    accountActive: ({ account, enabled }) =>
      enabled && isRecord(account.nickserv) && isEnabledFlag(account.nickserv),
    accountInactiveReason: "IRC account is disabled or NickServ is disabled for this account.",
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
