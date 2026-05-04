import {
  collectConditionalChannelFieldAssignments,
  getChannelSurface,
  hasConfiguredSecretInputValue,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

const DEFAULT_ACCOUNT_ID = "default";

export const secretTargetRegistryEntries = [
  {
    id: "channels.qqbot.accounts.*.clientSecret",
    targetType: "channels.qqbot.accounts.*.clientSecret",
    configFile: "openclaw.json",
    pathPattern: "channels.qqbot.accounts.*.clientSecret",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.qqbot.clientSecret",
    targetType: "channels.qqbot.clientSecret",
    configFile: "openclaw.json",
    pathPattern: "channels.qqbot.clientSecret",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
] satisfies SecretTargetRegistryEntry[];

function hasTopLevelAppId(qqbot: Record<string, unknown>): boolean {
  if (typeof qqbot.appId === "string") {
    return qqbot.appId.trim().length > 0;
  }
  return typeof qqbot.appId === "number";
}

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "qqbot");
  if (!resolved) {
    return;
  }

  const { channel: qqbot, surface } = resolved;
  const hasExplicitDefaultAccount = surface.accounts.some(
    ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
  );

  collectConditionalChannelFieldAssignments({
    channelKey: "qqbot",
    field: "clientSecret",
    channel: qqbot,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActiveWithoutAccounts: true,
    topLevelInheritedAccountActive: ({ accountId, account, enabled }) => {
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return enabled && !hasConfiguredSecretInputValue(account.clientSecret, params.defaults);
      }
      return !hasExplicitDefaultAccount && hasTopLevelAppId(qqbot);
    },
    accountActive: ({ enabled }) => enabled,
    topInactiveReason: "no enabled QQ Bot default surface uses this top-level clientSecret.",
    accountInactiveReason: "QQ Bot account is disabled.",
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
