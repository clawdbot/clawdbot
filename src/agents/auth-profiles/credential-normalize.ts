import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import type { AuthProfileCredential } from "./types.js";

// Upsert paths normalize literal secret strings but preserve SecretRef-backed
// credentials for the secret resolver.
export function normalizeAuthProfileCredential(
  credential: AuthProfileCredential,
): AuthProfileCredential {
  if (credential.type === "api_key") {
    if (typeof credential.key !== "string") {
      return credential;
    }
    const { key: _key, ...rest } = credential;
    const key = normalizeSecretInput(credential.key);
    return {
      ...rest,
      ...(key ? { key } : {}),
    };
  }
  if (credential.type === "token") {
    if (typeof credential.token !== "string") {
      return credential;
    }
    const { token: _token, ...rest } = credential;
    const token = normalizeSecretInput(credential.token);
    return { ...rest, ...(token ? { token } : {}) };
  }
  return credential;
}
