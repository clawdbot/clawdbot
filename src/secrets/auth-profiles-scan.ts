/** Scans auth-profile stores for plaintext credentials, SecretRefs, and OAuth tokens. */
import { isNonEmptyString, isRecord } from "./shared.js";
import { listAuthProfileSecretTargetEntries } from "./target-registry.js";

/** Auth-profile credential kinds that can carry SecretRef-backed values. */
type AuthProfileCredentialType = "api_key" | "token";

type AuthProfileFieldSpec = {
  valueField: string;
  refField: string;
};

type ApiKeyCredentialVisit = {
  kind: "api_key";
  profileId: string;
  provider: string;
  /** Original mutable profile record from auth-profiles.json. */
  profile: Record<string, unknown>;
  /** Plaintext value field name derived from the secret target registry. */
  valueField: string;
  /** SecretRef sibling field name derived from the secret target registry. */
  refField: string;
  value: unknown;
  refValue: unknown;
};

type TokenCredentialVisit = {
  kind: "token";
  profileId: string;
  provider: string;
  /** Original mutable profile record from auth-profiles.json. */
  profile: Record<string, unknown>;
  /** Plaintext value field name derived from the secret target registry. */
  valueField: string;
  /** SecretRef sibling field name derived from the secret target registry. */
  refField: string;
  value: unknown;
  refValue: unknown;
};

type OauthCredentialVisit = {
  kind: "oauth";
  profileId: string;
  provider: string;
  profile: Record<string, unknown>;
  /** Whether the profile currently stores a materialized OAuth access token. */
  hasAccess: boolean;
  /** Whether the profile currently stores a materialized OAuth refresh token. */
  hasRefresh: boolean;
};

type AuthProfileCredentialVisit =
  | ApiKeyCredentialVisit
  | TokenCredentialVisit
  | OauthCredentialVisit;

function getAuthProfileFieldName(pathPattern: string): string {
  const segments = pathPattern.split(".").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

const AUTH_PROFILE_FIELD_SPEC_BY_TYPE = (() => {
  const defaults: Record<AuthProfileCredentialType, AuthProfileFieldSpec> = {
    api_key: { valueField: "key", refField: "keyRef" },
    token: { valueField: "token", refField: "tokenRef" },
  };
  for (const target of listAuthProfileSecretTargetEntries()) {
    if (!target.authProfileType) {
      continue;
    }
    // Target registry owns shipped auth-profile field names; derive scan fields from it so
    // policy checks and runtime collection cannot drift when a ref path changes.
    defaults[target.authProfileType] = {
      valueField: getAuthProfileFieldName(target.pathPattern),
      refField:
        target.refPathPattern !== undefined
          ? getAuthProfileFieldName(target.refPathPattern)
          : defaults[target.authProfileType].refField,
    };
  }
  return defaults;
})();

/** Returns the value/ref field names for one auth-profile credential type. */
function getAuthProfileFieldSpec(type: AuthProfileCredentialType): AuthProfileFieldSpec {
  return AUTH_PROFILE_FIELD_SPEC_BY_TYPE[type];
}

function toSecretCredentialVisit(params: {
  kind: AuthProfileCredentialType;
  profileId: string;
  provider: string;
  profile: Record<string, unknown>;
}): ApiKeyCredentialVisit | TokenCredentialVisit {
  const spec = getAuthProfileFieldSpec(params.kind);
  return {
    kind: params.kind,
    profileId: params.profileId,
    provider: params.provider,
    profile: params.profile,
    valueField: spec.valueField,
    refField: spec.refField,
    value: params.profile[spec.valueField],
    refValue: params.profile[spec.refField],
  };
}

/** Iterates credential-bearing auth profiles with normalized field metadata for audit/apply. */
export function* iterateAuthProfileCredentials(
  profiles: Record<string, unknown>,
): Iterable<AuthProfileCredentialVisit> {
  for (const [profileId, value] of Object.entries(profiles)) {
    if (!isRecord(value) || !isNonEmptyString(value.provider)) {
      continue;
    }
    const provider = value.provider;
    if (value.type === "api_key" || value.type === "token") {
      yield toSecretCredentialVisit({
        kind: value.type,
        profileId,
        provider,
        profile: value,
      });
      continue;
    }
    if (value.type === "oauth") {
      yield {
        kind: "oauth",
        profileId,
        provider,
        profile: value,
        hasAccess: isNonEmptyString(value.access),
        hasRefresh: isNonEmptyString(value.refresh),
      };
    }
  }
}
