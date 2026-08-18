import {
  hasConfiguredSecretInput,
  normalizeSecretInputString,
  type SecretInput,
} from "openclaw/plugin-sdk/secret-input";

export const NOSTR_PRIVATE_KEY_ENV_VAR = "NOSTR_PRIVATE_KEY";

export function resolveNostrPrivateKey(value: SecretInput | undefined): string {
  const configured = normalizeSecretInputString(value);
  if (configured || hasConfiguredSecretInput(value)) {
    return configured ?? "";
  }
  return process.env[NOSTR_PRIVATE_KEY_ENV_VAR]?.trim() ?? "";
}
