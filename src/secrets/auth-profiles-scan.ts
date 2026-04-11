import { isNonEmptyString, isRecord } from "./shared.js";
import { listAuthProfileSecretTargetEntries } from "./target-registry.js";

export type AuthProfileCredentialType = "api_key" | "token";

type AuthProfileFieldSpec = {
  valueField: string;
  refField: string;
};

type ApiKeyCredentialVisit = {
  kind: "api_key";
  profileId: string;
  provider: string;
  profile: Record<string, unknown>;
  valueField: string;
  refField: string;
  value: unknown;
  refValue: unknown;
};

type TokenCredentialVisit = {
  kind: "token";
  profileId: string;
  provider: string;
  profile: Record<string, unknown>;
  valueField: string;
  refField: string;
  value: unknown;
  refValue: unknown;
};

type OauthCredentialVisit = {
  kind: "oauth";
  profileId: string;
  provider: string;
  profile: Record<string, unknown>;
  hasAccess: boolean;
  hasRefresh: boolean;
};

export type AuthProfileCredentialVisit =
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

export function getAuthProfileFieldSpec(type: AuthProfileCredentialType): AuthProfileFieldSpec {
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
