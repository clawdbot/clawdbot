/**
 * Dynamic live-model candidate expansion.
 * Adds prioritized plugin-discovered live models to static catalog candidates
 * while keeping the hot catalog path provider-agnostic.
 */
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import type {
  prepareProviderDynamicModel,
  runProviderDynamicModel,
} from "../plugins/provider-runtime.js";
import type { ProviderResolveDynamicModelContext } from "../plugins/types.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { listPrioritizedHighSignalLiveModelRefs } from "./live-model-filter.js";

type ProviderRuntimeModule = typeof import("../plugins/provider-runtime.js");
type DynamicModelResolver = typeof runProviderDynamicModel;
type DynamicModelPreparer = typeof prepareProviderDynamicModel;
type DynamicModelNormalizer = (model: Model, agentDir: string) => Model | Promise<Model>;

const providerRuntimeLoader = createLazyImportLoader<ProviderRuntimeModule>(
  () => import("../plugins/provider-runtime.js"),
);

async function prepareProviderDynamicModelDefault(
  params: Parameters<DynamicModelPreparer>[0],
): Promise<void> {
  const { prepareProviderDynamicModel } = await providerRuntimeLoader.load();
  await prepareProviderDynamicModel(params);
}

async function runProviderDynamicModelDefault(
  params: Parameters<DynamicModelResolver>[0],
): Promise<ReturnType<DynamicModelResolver>> {
  const { runProviderDynamicModel } = await providerRuntimeLoader.load();
  return runProviderDynamicModel(params);
}

async function normalizeDynamicModelDefault(model: Model, agentDir: string): Promise<Model> {
  const { normalizeDiscoveredAgentModel } = await import("./agent-model-discovery.js");
  return normalizeDiscoveredAgentModel(model, agentDir);
}

function liveModelKey(provider: string, id: string): string | null {
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedId = normalizeLowercaseStringOrEmpty(id);
  return normalizedProvider && normalizedId ? `${normalizedProvider}/${normalizedId}` : null;
}

/**
 * Append prioritized dynamic live models that are not already present.
 *
 * Provider hooks can prepare credentials/session state, resolve the current
 * model metadata, and then pass through the same model normalizer used by agent
 * discovery so downstream catalog code sees one canonical shape.
 */
export async function appendPrioritizedDynamicLiveModels(params: {
  models: Model[];
  config?: OpenClawConfig;
  agentDir: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  modelRegistry: ProviderResolveDynamicModelContext["modelRegistry"];
  resolveDynamicModel?: DynamicModelResolver;
  prepareDynamicModel?: DynamicModelPreparer;
  normalizeModel?: DynamicModelNormalizer;
  refs?: Array<{ provider: string; id: string }>;
}): Promise<{ models: Model[]; added: Model[] }> {
  const resolveDynamicModel = params.resolveDynamicModel ?? runProviderDynamicModelDefault;
  const prepareDynamicModel = params.prepareDynamicModel ?? prepareProviderDynamicModelDefault;
  const normalizeModel = params.normalizeModel ?? normalizeDynamicModelDefault;
  const refs = params.refs ?? listPrioritizedHighSignalLiveModelRefs();
  const seen = new Set<string>();
  for (const model of params.models) {
    const key = liveModelKey(model.provider, model.id);
    if (key) {
      seen.add(key);
    }
  }

  const models = [...params.models];
  const added: Model[] = [];
  for (const ref of refs) {
    const requestedKey = liveModelKey(ref.provider, ref.id);
    if (!requestedKey || seen.has(requestedKey)) {
      continue;
    }
    const providerConfig = findNormalizedProviderValue(
      params.config?.models?.providers,
      ref.provider,
    );
    // Dynamic model hooks receive the originally requested provider/id so they
    // can map aliases or live service identifiers before returning a catalog row.
    const context = {
      config: params.config,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      provider: ref.provider,
      modelId: ref.id,
      modelRegistry: params.modelRegistry,
      providerConfig,
    };
    await prepareDynamicModel({
      provider: ref.provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      context,
    });
    const resolved = await resolveDynamicModel({
      provider: ref.provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      context,
    });
    if (!resolved) {
      continue;
    }
    const model = await normalizeModel(resolved as Model, params.agentDir);
    const resolvedKey = liveModelKey(model.provider, model.id);
    // De-dupe against the resolved identity as well as the requested ref; hooks
    // may canonicalize provider ids or return aliases.
    if (!resolvedKey || seen.has(resolvedKey)) {
      continue;
    }
    seen.add(resolvedKey);
    models.push(model);
    added.push(model);
  }
  return { models, added };
}
