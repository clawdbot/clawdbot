import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const LEGACY_OAUTH_REF_SOURCE = "openclaw-credentials";
export const LEGACY_OAUTH_REF_PROVIDER = "openai-codex";

export type LegacyOAuthRef = {
  source: typeof LEGACY_OAUTH_REF_SOURCE;
  provider: typeof LEGACY_OAUTH_REF_PROVIDER;
  id: string;
};

export function isLegacyOAuthRef(value: unknown): value is LegacyOAuthRef {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.source === LEGACY_OAUTH_REF_SOURCE &&
    value.provider === LEGACY_OAUTH_REF_PROVIDER &&
    typeof value.id === "string" &&
    /^[a-f0-9]{32}$/.test(value.id)
  );
}
