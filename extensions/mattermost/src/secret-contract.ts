import {
  collectSimpleChannelFieldAssignments,
  getChannelSurface,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries: SecretTargetRegistryEntry[] = [
  {
    id: "channels.mattermost.accounts.*.botToken",
    targetType: "channels.mattermost.accounts.*.botToken",
    configFile: "openclaw.json",
    pathPattern: "channels.mattermost.accounts.*.botToken",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.mattermost.botToken",
    targetType: "channels.mattermost.botToken",
    configFile: "openclaw.json",
    pathPattern: "channels.mattermost.botToken",
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
