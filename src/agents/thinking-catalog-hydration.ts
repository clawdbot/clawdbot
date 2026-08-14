/** Scoped thinking-catalog hydration shared by initial model selection and mid-run overrides. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import type { ModelManifestNormalizationContext } from "./model-ref-shared.js";
import { createModelVisibilityPolicy } from "./model-visibility-policy.js";
import {
  hasResolvedThinkingCatalogEntry,
  normalizeThinkingCatalogProviders,
} from "./thinking-runtime.js";

/**
 * Resolves a provider/model thinking entry through the manifest -> scoped-static ->
 * scoped-live ladder. Thinking capability is a per-model fact; the full live catalog
 * is never materialized here. Returns the visibility-filtered catalog only when the
 * target entry actually resolved, so callers keep their previous catalog otherwise.
 */
export async function hydrateProviderScopedThinkingCatalog(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  agentId?: string;
  workspaceDir?: string;
  defaultProvider: string;
  defaultModel?: string;
  allowPluginNormalization: boolean;
  modelManifestContext: ModelManifestNormalizationContext;
}): Promise<ModelCatalogEntry[] | undefined> {
  const { loadProviderScopedThinkingCatalog } = await import("./model-catalog.runtime.js");
  const runtimeCatalog = normalizeThinkingCatalogProviders(
    await loadProviderScopedThinkingCatalog({
      config: params.cfg,
      provider: params.provider,
      model: params.model,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    }),
  );
  const allowedCatalog = createModelVisibilityPolicy({
    cfg: params.cfg,
    catalog: runtimeCatalog,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    agentId: params.agentId,
    allowManifestNormalization: true,
    allowPluginNormalization: params.allowPluginNormalization,
    ...params.modelManifestContext,
  }).allowedCatalog;
  return hasResolvedThinkingCatalogEntry({
    catalog: allowedCatalog,
    provider: params.provider,
    model: params.model,
  })
    ? allowedCatalog
    : undefined;
}
