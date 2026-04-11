import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { AuthProfileCredential, AuthProfileStore } from "./auth-profiles.js";
import { normalizeProviderId } from "./model-selection.js";

export type PiApiKeyCredential = { type: "api_key"; key: string };
export type PiOAuthCredential = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
};

export type PiCredential = PiApiKeyCredential | PiOAuthCredential;
export type PiCredentialMap = Record<string, PiCredential>;

export function convertAuthProfileCredentialToPi(cred: AuthProfileCredential): PiCredential | null {
  if (cred.type === "api_key") {
    const key = normalizeOptionalString(cred.key) ?? "";
    if (!key) {
      return null;
    }
    return { type: "api_key", key };
  }

  if (cred.type === "token") {
    const token = normalizeOptionalString(cred.token) ?? "";
    if (!token) {
      return null;
    }
    if (
      typeof cred.expires === "number" &&
      Number.isFinite(cred.expires) &&
      Date.now() >= cred.expires
    ) {
      return null;
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

export function resolvePiCredentialMapFromStore(store: AuthProfileStore): PiCredentialMap {
  const credentials: PiCredentialMap = {};
  for (const credential of Object.values(store.profiles)) {
    const provider = normalizeProviderId(credential.provider ?? "");
    if (!provider || credentials[provider]) {
      continue;
    }
    const converted = convertAuthProfileCredentialToPi(credential);
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
