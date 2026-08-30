import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";

const XAI_PROVIDER_IDS = new Set(["xai", "x-ai"]);

// Provider dispatch preserves the selected alias. Keep all xAI-owned runtime policy symmetric.
export function isXaiProviderId(provider: unknown): boolean {
  return typeof provider === "string" && XAI_PROVIDER_IDS.has(normalizeProviderId(provider));
}
