/**
 * Nexforce Router model provider builder.
 */
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

/** Builds the Nexforce Router OpenAI-compatible model provider config. */
export function buildNexforceProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: "nexforce",
    catalog: manifest.modelCatalog.providers.nexforce,
  });
}
