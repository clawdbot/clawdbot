/** Collects auth-profile and OAuth secret refs for runtime preparation. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { resolveAuthProfileEligibility } from "../agents/auth-profiles/order.js";
import { assertNoOAuthSecretRefPolicyViolations } from "../agents/auth-profiles/policy.js";
import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { ProviderAuthAliasLookupParams } from "../agents/provider-auth-aliases.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { setSecretAssignmentSource } from "./runtime-assignment-provenance.js";
import { resolveAuthProfileSecretOwnerId } from "./runtime-auth-profile-owner.js";
import {
  collectRuntimeSecretInputAssignment,
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

function resolveAuthProfileOwnerContract(
  profile: ApiKeyCredentialLike | TokenCredentialLike,
  context: ResolverContext,
): unknown {
  const providerId = normalizeOptionalLowercaseString(profile.provider) ?? profile.provider;
  const configuredProvider = Object.entries(context.sourceConfig.models?.providers ?? {}).find(
    ([candidateId]) =>
      (normalizeOptionalLowercaseString(candidateId) ?? candidateId) === providerId,
  );
  return {
    profile: structuredClone(profile),
    providerId,
    configuredProvider,
  };
}

function collectAuthStoreSecretInputAssignment(
  params: Parameters<typeof collectRuntimeSecretInputAssignment>[0],
): void {
  const previousCount = params.context.assignments.length;
  collectRuntimeSecretInputAssignment(params);
  for (const assignment of params.context.assignments.slice(previousCount)) {
    setSecretAssignmentSource(assignment, "auth-store");
  }
}

function collectApiKeyProfileAssignment(params: {
  profile: ApiKeyCredentialLike;
  profileId: string;
  store: AuthProfileStore;
  agentDir: string;
  defaults: SecretDefaults | undefined;
  authAliasLookupParams: ProviderAuthAliasLookupParams;
  context: ResolverContext;
}): void {
  const ownerContract = resolveAuthProfileOwnerContract(params.profile, params.context);
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
  // Inline SecretRefs are normalized into keyRef so runtime snapshots preserve the
  // explicit auth-profile ref surface instead of leaving a template string in key.
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
  // Only successful runtime materialization may populate the authoritative secret slot.
  params.profile.key = undefined;
  const eligibility = resolveAuthProfileEligibility({
    cfg: params.context.sourceConfig,
    authAliasLookupParams: params.authAliasLookupParams,
    store: params.store,
    provider: params.profile.provider,
    profileId: params.profileId,
  });
  collectAuthStoreSecretInputAssignment({
    value: resolvedKeyRef,
    path: `${params.agentDir}.auth-profiles.${params.profileId}.key`,
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: eligibility.eligible,
    inactiveReason: `auth profile is not eligible (${eligibility.reasonCode}); skipping resolution until it becomes eligible.`,
    owner: {
      ownerKind: "account",
      ownerId: resolveAuthProfileSecretOwnerId(params),
      requiredForGateway: false,
      disposition: "isolate",
      contract: ownerContract,
    },
    apply: (value) => {
      params.profile.key = String(value);
    },
    applyUnavailable: () => {
      params.profile.key = undefined;
    },
  });
}

function collectTokenProfileAssignment(params: {
  profile: TokenCredentialLike;
  profileId: string;
  store: AuthProfileStore;
  agentDir: string;
  defaults: SecretDefaults | undefined;
  authAliasLookupParams: ProviderAuthAliasLookupParams;
  context: ResolverContext;
}): void {
  const ownerContract = resolveAuthProfileOwnerContract(params.profile, params.context);
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
  // Token profiles follow the same precedence contract as API keys: explicit refs win over
  // plaintext and inline refs are promoted to the dedicated ref field.
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
  // Only successful runtime materialization may populate the authoritative secret slot.
  params.profile.token = undefined;
  const eligibility = resolveAuthProfileEligibility({
    cfg: params.context.sourceConfig,
    authAliasLookupParams: params.authAliasLookupParams,
    store: params.store,
    provider: params.profile.provider,
    profileId: params.profileId,
  });
  collectAuthStoreSecretInputAssignment({
    value: resolvedTokenRef,
    path: `${params.agentDir}.auth-profiles.${params.profileId}.token`,
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: eligibility.eligible,
    inactiveReason: `auth profile is not eligible (${eligibility.reasonCode}); skipping resolution until it becomes eligible.`,
    owner: {
      ownerKind: "account",
      ownerId: resolveAuthProfileSecretOwnerId(params),
      requiredForGateway: false,
      disposition: "isolate",
      contract: ownerContract,
    },
    apply: (value) => {
      params.profile.token = String(value);
    },
    applyUnavailable: () => {
      params.profile.token = undefined;
    },
  });
}

/** Collects SecretRef assignments from agent auth-profile stores for runtime materialization. */
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
  const authAliasLookupParams: ProviderAuthAliasLookupParams = {
    env: params.context.env,
    ...(params.context.manifestRegistry
      ? { metadataSnapshot: params.context.manifestRegistry }
      : {}),
  };
  for (const [profileId, profile] of Object.entries(params.store.profiles)) {
    if (profile.type === "api_key") {
      collectApiKeyProfileAssignment({
        profile: profile as ApiKeyCredentialLike,
        profileId,
        store: params.store,
        agentDir: params.agentDir,
        defaults,
        authAliasLookupParams,
        context: params.context,
      });
      continue;
    }
    if (profile.type === "token") {
      collectTokenProfileAssignment({
        profile: profile as TokenCredentialLike,
        profileId,
        store: params.store,
        agentDir: params.agentDir,
        defaults,
        authAliasLookupParams,
        context: params.context,
      });
    }
  }
}
