/** Pure, non-resolving credential availability checks shared by status and route selection. */
import { hasNonEmptyString as hasSecret } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  isSecretRef,
  LEGACY_DOUBLE_UNDERSCORE_ENV_MARKER_PREFIX,
  resolveSecretInputRef,
} from "../../config/types.secrets.js";
import { canResolveEnvSecretRefInReadOnlyPath } from "../../plugin-sdk/secret-ref-readonly.internal.js";
import {
  isBuiltInDefaultSecretProviderRef,
  isValidSecretRef,
  SINGLE_VALUE_FILE_REF_ID,
} from "../../secrets/ref-contract.js";
import {
  isKnownEnvApiKeyMarker,
  isNonSecretApiKeyMarker,
  SECRETREF_ENV_HEADER_MARKER_PREFIX,
} from "../model-auth-markers.js";
import { hasUsableOAuthCredential, resolveTokenExpiryState } from "./credential-state.js";
import type { AuthProfileCredential } from "./types.js";

type ReadOnlyCredentialAvailability = boolean | undefined;

export function hasMalformedSecretInputSyntax(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  return (
    trimmed.startsWith(SECRETREF_ENV_HEADER_MARKER_PREFIX) ||
    trimmed.startsWith(LEGACY_DOUBLE_UNDERSCORE_ENV_MARKER_PREFIX) ||
    trimmed.startsWith("$")
  );
}

export function resolveSecretRefReadOnlyAvailability(
  value: unknown,
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): ReadOnlyCredentialAvailability {
  if (!isSecretRef(value) || !isValidSecretRef(value)) {
    return false;
  }
  if (value.source === "env") {
    if (
      !canResolveEnvSecretRefInReadOnlyPath({
        cfg,
        provider: value.provider,
        id: value.id,
      })
    ) {
      return false;
    }
    return hasSecret(env[value.id]) ? true : undefined;
  }
  const source = cfg.secrets?.providers?.[value.provider];
  if (source?.source !== value.source && !isBuiltInDefaultSecretProviderRef(cfg, value)) {
    return false;
  }
  if (
    value.source === "file" &&
    source?.source === "file" &&
    (source.mode === "singleValue") !== (value.id === SINGLE_VALUE_FILE_REF_ID)
  ) {
    return false;
  }
  return undefined;
}

function resolveSecretInputReadOnlyAvailability(
  value: unknown,
  refValue: unknown,
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): ReadOnlyCredentialAvailability {
  const { ref } = resolveSecretInputRef({
    value,
    refValue,
    defaults: cfg.secrets?.defaults,
  });
  if (ref) {
    return resolveSecretRefReadOnlyAvailability(ref, cfg, env);
  }
  if (!hasSecret(value)) {
    return false;
  }
  if (hasMalformedSecretInputSyntax(value)) {
    return false;
  }
  return isKnownEnvApiKeyMarker(value)
    ? hasSecret(env[value.trim()])
    : isNonSecretApiKeyMarker(value)
      ? undefined
      : true;
}

export function resolveStoredCredentialReadOnlyAvailability(params: {
  credential: AuthProfileCredential;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  now?: number;
  canRefreshOAuth?: boolean;
}): ReadOnlyCredentialAvailability {
  const { credential, cfg, env } = params;
  const now = params.now ?? Date.now();
  if (credential.type === "api_key") {
    return resolveSecretInputReadOnlyAvailability(credential.key, credential.keyRef, cfg, env);
  }
  if (credential.type === "token") {
    const expiryState = resolveTokenExpiryState(credential.expires, now);
    if (expiryState === "expired" || expiryState === "invalid_expires") {
      return false;
    }
    return resolveSecretInputReadOnlyAvailability(credential.token, credential.tokenRef, cfg, env);
  }
  if (hasUsableOAuthCredential(credential, { now })) {
    return true;
  }
  // Refresh material is runnable only when the caller owns a refresh path.
  // Ref-only OAuth may hydrate from the runtime snapshot, so it stays unknown.
  if (hasSecret(credential.refresh)) {
    return params.canRefreshOAuth ? true : undefined;
  }
  return credential.oauthRef && !hasSecret(credential.access) ? undefined : false;
}
