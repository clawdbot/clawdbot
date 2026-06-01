import {
  collectConditionalChannelFieldAssignments,
  getChannelSurface,
  hasOwnProperty,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

const DEFAULT_ACCOUNT_ID = "default";

export const secretTargetRegistryEntries = [
  {
    id: "channels.sms.accounts.*.authToken",
    targetType: "channels.sms.accounts.*.authToken",
    configFile: "openclaw.json",
    pathPattern: "channels.sms.accounts.*.authToken",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.sms.authToken",
    targetType: "channels.sms.authToken",
    configFile: "openclaw.json",
    pathPattern: "channels.sms.authToken",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
] satisfies SecretTargetRegistryEntry[];

function hasTopLevelSmsAccount(channel: Record<string, unknown>): boolean {
  for (const field of ["accountSid", "fromNumber", "messagingServiceSid", "defaultTo"]) {
    if (typeof channel[field] === "string" && channel[field].trim().length > 0) {
      return true;
    }
  }
  return false;
}

function hasEnvBackedDefaultSmsAccount(env: NodeJS.ProcessEnv): boolean {
  for (const name of [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_PHONE_NUMBER",
    "TWILIO_SMS_FROM",
    "TWILIO_MESSAGING_SERVICE_SID",
  ]) {
    if (typeof env[name] === "string" && env[name].trim().length > 0) {
      return true;
    }
  }
  return false;
}

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "sms");
  if (!resolved) {
    return;
  }
  const { channel: sms, surface } = resolved;
  const hasExplicitDefaultAccount = surface.accounts.some(
    ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
  );
  const topLevelSmsAccountActive =
    (hasTopLevelSmsAccount(sms) || hasEnvBackedDefaultSmsAccount(params.context.env)) &&
    !hasExplicitDefaultAccount;
  collectConditionalChannelFieldAssignments({
    channelKey: "sms",
    field: "authToken",
    channel: sms,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActiveWithoutAccounts: true,
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      topLevelSmsAccountActive || (enabled && !hasOwnProperty(account, "authToken")),
    accountActive: ({ enabled }) => enabled,
    topInactiveReason: "no enabled SMS surface inherits this top-level authToken.",
    accountInactiveReason: "SMS account is disabled.",
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
