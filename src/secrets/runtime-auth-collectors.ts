import { assertNoOAuthSecretRefPolicyViolations } from "../agents/auth-profiles/policy.js";
import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles/types.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import {
  pushAssignment,
  pushWarning,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isNonEmptyString } from "./shared.js";

type ApiKeyCredentialLike = AuthProfileCredential & {
  type: "api_key";
  key?: string;
  keyRef?: unknown;
};

type TokenCredentialLike = AuthProfileCredential & {
  type: "token";
  token?: string;
  tokenRef?: unknown;
};

function collectApiKeyProfileAssignment(params: {
  profile: ApiKeyCredentialLike;
  profileId: string;
  agentDir: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const {
    explicitRef: keyRef,
    inlineRef: inlineKeyRef,
    ref: resolvedKeyRef,
  } = resolveSecretInputRef({
    value: params.profile.key,
    refValue: params.profile.keyRef,
    defaults: params.defaults,
  });
  if (!resolvedKeyRef) {
    return;
  }
  if (!keyRef && inlineKeyRef) {
    params.profile.keyRef = inlineKeyRef;
  }
  if (keyRef && isNonEmptyString(params.profile.key)) {
    pushWarning(params.context, {
      code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
      path: `${params.agentDir}.auth-profiles.${params.profileId}.key`,
      message: `auth-profiles ${params.profileId}: keyRef is set; runtime will ignore plaintext key.`,
    });
  }
  pushAssignment(params.context, {
    ref: resolvedKeyRef,
    path: `${params.agentDir}.auth-profiles.${params.profileId}.key`,
    expected: "string",
    apply: (value) => {
      params.profile.key = String(value);
    },
  });
}

function collectTokenProfileAssignment(params: {
  profile: TokenCredentialLike;
  profileId: string;
  agentDir: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const {
    explicitRef: tokenRef,
    inlineRef: inlineTokenRef,
    ref: resolvedTokenRef,
  } = resolveSecretInputRef({
    value: params.profile.token,
    refValue: params.profile.tokenRef,
    defaults: params.defaults,
  });
  if (!resolvedTokenRef) {
    return;
  }
  if (!tokenRef && inlineTokenRef) {
    params.profile.tokenRef = inlineTokenRef;
  }
  if (tokenRef && isNonEmptyString(params.profile.token)) {
    pushWarning(params.context, {
      code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
      path: `${params.agentDir}.auth-profiles.${params.profileId}.token`,
      message: `auth-profiles ${params.profileId}: tokenRef is set; runtime will ignore plaintext token.`,
    });
  }
  pushAssignment(params.context, {
    ref: resolvedTokenRef,
    path: `${params.agentDir}.auth-profiles.${params.profileId}.token`,
    expected: "string",
    apply: (value) => {
      params.profile.token = String(value);
    },
  });
}

export function collectAuthStoreAssignments(params: {
  store: AuthProfileStore;
  context: ResolverContext;
  agentDir: string;
}): void {
  assertNoOAuthSecretRefPolicyViolations({
    store: params.store,
    cfg: params.context.sourceConfig,
    context: `auth-profiles ${params.agentDir}`,
  });

  const defaults = params.context.sourceConfig.secrets?.defaults;
  for (const [profileId, profile] of Object.entries(params.store.profiles)) {
    if (profile.type === "api_key") {
      collectApiKeyProfileAssignment({
        profile: profile as ApiKeyCredentialLike,
        profileId,
        agentDir: params.agentDir,
        defaults,
        context: params.context,
      });
      continue;
    }
    if (profile.type === "token") {
      collectTokenProfileAssignment({
        profile: profile as TokenCredentialLike,
        profileId,
        agentDir: params.agentDir,
        defaults,
        context: params.context,
      });
    }
  }
}
