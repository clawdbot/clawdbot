import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolveBundledProviderPolicySurface } from "../../plugins/provider-public-artifacts.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { type ListRowModel, toListRowInput } from "./list.model-row.js";

type ProviderRuntimeModule = typeof import("../../plugins/provider-runtime.js");

const providerRuntimeModuleLoader = createLazyImportLoader<ProviderRuntimeModule>(
  () => import("../../plugins/provider-runtime.js"),
);

function mergeNormalizedListRow(
  model: ListRowModel,
  normalized: ProviderRuntimeModel,
): ListRowModel {
  return {
    ...model,
    id: normalized.id,
    name: normalized.name,
    provider: normalized.provider,
    api: normalized.api ?? model.api,
    baseUrl: normalized.baseUrl ?? model.baseUrl,
    input: toListRowInput(normalized.input),
    contextWindow: normalized.contextWindow,
    contextTokens: normalized.contextTokens,
  };
}

/** Projects one authored provider row while keeping full runtime loading optional. */
export async function normalizeConfiguredProviderListRow(params: {
  model: ListRowModel;
  context: {
    cfg: OpenClawConfig;
    agentDir: string;
    workspaceDir?: string;
    metadataSnapshot?: PluginMetadataSnapshot;
  };
}): Promise<ListRowModel> {
  const normalizationContext = {
    config: params.context.cfg,
    agentDir: params.context.agentDir,
    workspaceDir: params.context.workspaceDir,
    provider: params.model.provider,
    modelId: params.model.id,
    model: params.model as ProviderRuntimeModel,
  };
  const policySurface = resolveBundledProviderPolicySurface(params.model.provider, {
    manifestRegistry: params.context.metadataSnapshot?.manifestRegistry,
  });
  if (policySurface?.projectConfiguredModelRow) {
    const projected = policySurface.projectConfiguredModelRow(normalizationContext);
    if (projected === null) {
      return params.model;
    }
    if (projected !== undefined) {
      return mergeNormalizedListRow(params.model, projected);
    }
  }
  const { normalizeProviderResolvedModelWithPlugin } = await providerRuntimeModuleLoader.load();
  const normalized = normalizeProviderResolvedModelWithPlugin({
    provider: params.model.provider,
    config: params.context.cfg,
    workspaceDir: params.context.workspaceDir,
    pluginMetadataSnapshot: params.context.metadataSnapshot,
    context: normalizationContext,
  });
  return normalized ? mergeNormalizedListRow(params.model, normalized) : params.model;
}
