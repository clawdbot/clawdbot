/** Adapts the shared configured-model projection to CLI provider aliases. */
import { resolveConfiguredModelEntries } from "../../agents/configured-model-entries.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { createModelCatalogProviderAliasCanonicalizer } from "./provider-aliases.js";

export function resolveConfiguredEntries(
  cfg: OpenClawConfig,
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "manifestRegistry">,
  agentId?: string,
) {
  const canonicalizer = createModelCatalogProviderAliasCanonicalizer({ cfg, metadataSnapshot });
  return resolveConfiguredModelEntries({
    cfg,
    agentId,
    allowPluginNormalization: false,
    manifestPlugins: metadataSnapshot?.manifestRegistry.plugins,
    canonicalizeRef: canonicalizer.ref,
  });
}
