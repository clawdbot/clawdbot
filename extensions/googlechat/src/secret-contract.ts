import {
  getChannelSurface,
  hasOwnProperty,
  pushAssignment,
  pushInactiveSurfaceWarning,
  pushWarning,
  resolveChannelAccountSurface,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { coerceSecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";

type GoogleChatAccountLike = {
  serviceAccount?: unknown;
  serviceAccountRef?: unknown;
  accounts?: Record<string, unknown>;
};

export const secretTargetRegistryEntries = [
  {
    id: "channels.googlechat.accounts.*.serviceAccount",
    targetType: "channels.googlechat.serviceAccount",
    targetTypeAliases: ["channels.googlechat.accounts.*.serviceAccount"],
    configFile: "openclaw.json",
    pathPattern: "channels.googlechat.accounts.*.serviceAccount",
    refPathPattern: "channels.googlechat.accounts.*.serviceAccountRef",
    secretShape: "sibling_ref",
    expectedResolvedValue: "string-or-object",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    accountIdPathSegmentIndex: 3,
  },
  {
    id: "channels.googlechat.serviceAccount",
    targetType: "channels.googlechat.serviceAccount",
    configFile: "openclaw.json",
    pathPattern: "channels.googlechat.serviceAccount",
    refPathPattern: "channels.googlechat.serviceAccountRef",
    secretShape: "sibling_ref",
    expectedResolvedValue: "string-or-object",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
] satisfies SecretTargetRegistryEntry[];

function resolveSecretInputRef(params: {
  value: unknown;
  refValue?: unknown;
  defaults?: SecretDefaults;
}) {
  const explicitRef = coerceSecretRef(params.refValue, params.defaults);
  const inlineRef = explicitRef ? null : coerceSecretRef(params.value, params.defaults);
  return {
    explicitRef,
    inlineRef,
    ref: explicitRef ?? inlineRef,
  };
}

function collectGoogleChatAccountAssignment(params: {
  target: GoogleChatAccountLike;
  path: string;
  defaults?: SecretDefaults;
  context: ResolverContext;
  active?: boolean;
  inactiveReason?: string;
}): void {
  const { explicitRef, ref } = resolveSecretInputRef({
    value: params.target.serviceAccount,
    refValue: params.target.serviceAccountRef,
    defaults: params.defaults,
  });
  if (!ref) {
    return;
  }
  if (params.active === false) {
    pushInactiveSurfaceWarning({
      context: params.context,
      path: `${params.path}.serviceAccount`,
      details: params.inactiveReason,
    });
    return;
  }
  if (
    explicitRef &&
    params.target.serviceAccount !== undefined &&
    !coerceSecretRef(params.target.serviceAccount, params.defaults)
  ) {
    pushWarning(params.context, {
      code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
      path: params.path,
      message: `${params.path}: serviceAccountRef is set; runtime will ignore plaintext serviceAccount.`,
    });
  }
  pushAssignment(params.context, {
    ref,
    path: `${params.path}.serviceAccount`,
    expected: "string-or-object",
    apply: (value) => {
      params.target.serviceAccount = value;
    },
  });
}

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "googlechat");
  if (!resolved) {
    return;
  }
  const googleChat = resolved.channel as GoogleChatAccountLike;
  const surface = resolveChannelAccountSurface(googleChat as Record<string, unknown>);
  const topLevelServiceAccountActive = !surface.channelEnabled
    ? false
    : !surface.hasExplicitAccounts
      ? true
      : surface.accounts.some(
          ({ account, enabled }) =>
            enabled &&
            !hasOwnProperty(account, "serviceAccount") &&
            !hasOwnProperty(account, "serviceAccountRef"),
        );
  collectGoogleChatAccountAssignment({
    target: googleChat,
    path: "channels.googlechat",
    defaults: params.defaults,
    context: params.context,
    active: topLevelServiceAccountActive,
    inactiveReason: "no enabled account inherits this top-level Google Chat serviceAccount.",
  });
  if (!surface.hasExplicitAccounts) {
    return;
  }
  for (const { accountId, account, enabled } of surface.accounts) {
    if (
      !hasOwnProperty(account, "serviceAccount") &&
      !hasOwnProperty(account, "serviceAccountRef")
    ) {
      continue;
    }
    collectGoogleChatAccountAssignment({
      target: account as GoogleChatAccountLike,
      path: `channels.googlechat.accounts.${accountId}`,
      defaults: params.defaults,
      context: params.context,
      active: enabled,
      inactiveReason: "Google Chat account is disabled.",
    });
  }
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
