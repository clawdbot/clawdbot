// Builds model picker choices and endpoint labels for model directives.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { findNormalizedProviderValue, normalizeProviderId } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Catalog entry shown by the model picker directive UI. */
export type ModelPickerCatalogEntry = {
  provider: string;
  id: string;
  name?: string;
};

/** Resolves optional endpoint/API labels for a provider in picker details. */
export function resolveProviderEndpointLabel(
  provider: string,
  cfg: OpenClawConfig,
): { endpoint?: string; api?: string } {
  const normalized = normalizeProviderId(provider);
  const providers = (cfg.models?.providers ?? {}) as Record<
    string,
    { baseUrl?: string; api?: string } | undefined
  >;
  const entry = findNormalizedProviderValue(providers, normalized);
  const endpoint = normalizeOptionalString(entry?.baseUrl);
  const api = normalizeOptionalString(entry?.api);
  return {
    endpoint: endpoint || undefined,
    api: api || undefined,
  };
}
