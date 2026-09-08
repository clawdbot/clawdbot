/** Provider spellings accepted only by legacy migration boundaries. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
const LEGACY_CODEX_PROVIDER_IDS = new Set(["codex", "openai-codex"]);
export function isLegacyCodexProviderId(provider: unknown): boolean {
  const normalized = normalizeOptionalLowercaseString(provider);
  return normalized ? LEGACY_CODEX_PROVIDER_IDS.has(normalized) : false;
}
