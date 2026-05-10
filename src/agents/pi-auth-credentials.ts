import { coerceSecretRef } from "../config/types.secrets.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { AuthProfileCredential, AuthProfileStore } from "./auth-profiles.js";
import { normalizeProviderId } from "./provider-id.js";

type PiApiKeyCredential = { type: "api_key"; key: string };
type PiOAuthCredential = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
};

export type PiCredential = PiApiKeyCredential | PiOAuthCredential;
export type PiCredentialMap = Record<string, PiCredential>;

export type ResolvePiCredentialMapOptions = {
  includeSecretRefPlaceholders?: boolean;
};

const PI_SECRET_REF_CONFIGURED_MARKER = "openclaw-secret-ref-configured";

function hasConfiguredSecretRef(value: unknown): boolean {
  return coerceSecretRef(value) !== null;
}

function secretRefPlaceholder(
  options: ResolvePiCredentialMapOptions | undefined,
): PiCredential | null {
  if (options?.includeSecretRefPlaceholders === true) {
    return { type: "api_key", key: PI_SECRET_REF_CONFIGURED_MARKER };
  }
  return null;
}

function convertAuthProfileCredentialToPi(
  cred: AuthProfileCredential,
  options?: ResolvePiCredentialMapOptions,
): PiCredential | null {
  if (cred.type === "api_key") {
    const key = normalizeOptionalString(cred.key) ?? "";
    if (!key) {
      return hasConfiguredSecretRef(cred.keyRef) ? secretRefPlaceholder(options) : null;
    }
    return { type: "api_key", key };
  }

  if (cred.type === "token") {
    if (
      typeof cred.expires === "number" &&
      Number.isFinite(cred.expires) &&
      Date.now() >= cred.expires
    ) {
      return null;
    }
    const token = normalizeOptionalString(cred.token) ?? "";
    if (!token) {
      return hasConfiguredSecretRef(cred.tokenRef) ? secretRefPlaceholder(options) : null;
    }
    return { type: "api_key", key: token };
  }

  if (cred.type === "oauth") {
    const access = normalizeOptionalString(cred.access) ?? "";
    const refresh = normalizeOptionalString(cred.refresh) ?? "";
    if (!access || !refresh || !Number.isFinite(cred.expires) || cred.expires <= 0) {
      return null;
    }
    return {
      type: "oauth",
      access,
      refresh,
      expires: cred.expires,
    };
  }

  return null;
}

export function resolvePiCredentialMapFromStore(
  store: AuthProfileStore,
  options?: ResolvePiCredentialMapOptions,
): PiCredentialMap {
  const credentials: PiCredentialMap = {};
  for (const credential of Object.values(store.profiles)) {
    const provider = normalizeProviderId(credential.provider ?? "");
    if (!provider || credentials[provider]) {
      continue;
    }
    const converted = convertAuthProfileCredentialToPi(credential, options);
    if (converted) {
      credentials[provider] = converted;
    }
  }
  return credentials;
}

export function piCredentialsEqual(a: PiCredential | undefined, b: PiCredential): boolean {
  if (!a || typeof a !== "object") {
    return false;
  }
  if (a.type !== b.type) {
    return false;
  }

  if (a.type === "api_key" && b.type === "api_key") {
    return a.key === b.key;
  }

  if (a.type === "oauth" && b.type === "oauth") {
    return a.access === b.access && a.refresh === b.refresh && a.expires === b.expires;
  }

  return false;
}
