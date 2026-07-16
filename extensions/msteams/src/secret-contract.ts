import {
  collectSecretInputAssignment,
  getChannelRecord,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries = [
  {
    id: "channels.msteams.appPassword",
    targetType: "channels.msteams.appPassword",
    configFile: "openclaw.json",
    pathPattern: "channels.msteams.appPassword",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
] satisfies SecretTargetRegistryEntry[];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const msteams = getChannelRecord(params.config, "msteams");
  if (!msteams) {
    return;
  }
  collectSecretInputAssignment({
    value: msteams.appPassword,
    path: "channels.msteams.appPassword",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: msteams.enabled !== false,
    inactiveReason: "Microsoft Teams channel is disabled.",
    apply: (value) => {
      msteams.appPassword = value;
    },
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
