/**
 * Cerebras model provider builder.
 */
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

/** Builds the Cerebras OpenAI-compatible model provider config. */
export function buildCerebrasProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: "cerebras",
    catalog: manifest.modelCatalog.providers.cerebras,
  });
}
