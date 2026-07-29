// Provider-index loader normalizes bundled installable-provider metadata and falls back to an empty index.
import { normalizeOpenClawProviderIndex } from "./normalize.js";
import { OPENCLAW_PROVIDER_INDEX } from "./openclaw-provider-index.js";
import type { OpenClawProviderIndex } from "./types.js";

// Load the bundled provider index through the normalizer. Invalid generated or
// caller-supplied data falls back to an empty v1 index instead of leaking shape.
export function loadOpenClawProviderIndex(
  source: unknown = OPENCLAW_PROVIDER_INDEX,
): OpenClawProviderIndex {
  return normalizeOpenClawProviderIndex(source) ?? { version: 1, providers: {} };
}
