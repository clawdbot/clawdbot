// Discord plugin module implements account token inspect behavior.
import {
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import type { DiscordCredentialStatus } from "./token.js";

export type InspectedDiscordConfiguredToken = {
  token: string;
  tokenSource: "config";
  tokenStatus: Exclude<DiscordCredentialStatus, "missing">;
};

export function inspectDiscordConfiguredToken(
  value: unknown,
): InspectedDiscordConfiguredToken | null {
  const normalized = normalizeSecretInputString(value);
  if (normalized) {
    return {
      token: normalized.replace(/^Bot\s+/i, ""),
      tokenSource: "config",
      tokenStatus: "available",
    };
  }
  if (hasConfiguredSecretInput(value)) {
    return {
      token: "",
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
    };
  }
  return null;
}
