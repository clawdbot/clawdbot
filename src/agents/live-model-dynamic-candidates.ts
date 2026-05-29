import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import type {
  prepareProviderDynamicModel,
  runProviderDynamicModel,
} from "../plugins/provider-runtime.js";
import type { ProviderResolveDynamicModelContext } from "../plugins/types.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { listPrioritizedHighSignalLiveModelRefs } from "./live-model-filter.js";
import { findNormalizedProviderValue, normalizeProviderId } from "./provider-id.js";

type DynamicModelResolver = typeof runProviderDynamicModel;
type DynamicModelPreparer = typeof prepareProviderDynamicModel;
type DynamicModelNormalizer = (model: Model, agentDir: string) => Model | Promise<Model>;

async function prepareProviderDynamicModelDefault(
  params: Parameters<DynamicModelPreparer>[0],
): Promise<void> {
  const { prepareProviderDynamicModel } = await import("../plugins/provider-runtime.js");
  await prepareProviderDynamicModel(params);
}

async function runProviderDynamicModelDefault(
  params: Parameters<DynamicModelResolver>[0],
): Promise<ReturnType<DynamicModelResolver>> {
  const { runProviderDynamicModel } = await import("../plugins/provider-runtime.js");
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
    if (!resolvedKey || seen.has(resolvedKey)) {
      continue;
    }
    seen.add(resolvedKey);
    models.push(model);
    added.push(model);
  }
  return { models, added };
}
