import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { resolveDefaultAgentDir } from "../agent-scope.js";
import type { AuthProfileCredential } from "../auth-profiles/types.js";
import { resolveLegacyInheritedAuthDir } from "../legacy-inherited-auth-dir.js";
import { resolveModelWorkspaceDir } from "../model-discovery-context.js";
import { modelKey } from "../model-ref-shared.js";
import { findNormalizedProviderValue, normalizeProviderId } from "../model-selection.js";
import { buildSuppressedBuiltInModelError } from "../model-suppression.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  getPreparedModelRuntimeSnapshot,
  loadPreparedModelRuntimeSnapshot,
  type PreparedModelRuntimeSnapshot,
} from "../prepared-model-runtime.js";
import {
  AuthStorage as AgentAuthStorageClass,
  ModelRegistry as AgentModelRegistryClass,
  type AuthStorage,
  type ModelRegistry,
} from "../sessions/index.js";
import { mergeModelMediaInput } from "./model.compat.js";
import { buildConfiguredFallbackModel } from "./model.configured-fallback.js";
import {
  applyConfiguredProviderOverrides,
  resolveConfiguredProviderConfig,
} from "./model.configured-overrides.js";
import {
  DEFAULT_PROVIDER_RUNTIME_HOOKS,
  normalizeResolvedModel,
  type ProviderRuntimeHooks,
  resolveRuntimeHooks,
} from "./model.provider-hooks.js";
import {
  normalizeProviderModelRef,
  resolveDynamicModelAuthProfile,
  resolveExplicitModelWithRegistry,
  resolveModelWithPreparedRegistry,
  resolveRuntimePreferredSuppressedModel,
  shouldCompareProviderRuntimeResolvedModel,
} from "./model.registry-resolution.js";
import {
  resolveBundledProviderStaticCatalogModel,
  resolveBundledStaticCatalogModel,
} from "./model.static-catalog.js";
import { staticModelIdMatches } from "./model.static-id.js";

export { resolveModelWithRegistry } from "./model.registry-resolution.js";

type CommonModelResolutionOptions = {
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
  agentId?: string;
  runtimeHooks?: ProviderRuntimeHooks;
  skipProviderRuntimeHooks?: boolean;
  workspaceDir?: string;
  authProfileId?: string;
  authProfileMode?: AuthProfileCredential["type"] | "aws-sdk";
  preferredProfile?: string;
};

type AsyncModelResolutionOptions = CommonModelResolutionOptions & {
  allowBundledStaticCatalogFallback?: boolean;
  preferBundledStaticCatalogTransport?: boolean;
  agentRuntimeId?: string;
  skipAgentDiscovery?: boolean;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
};

/** Creates isolated model/auth stores for harnesses that own model discovery themselves. */
export function createEmptyAgentDiscoveryStores(): {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
} {
  const authStorage =
    typeof AgentAuthStorageClass.inMemory === "function"
      ? AgentAuthStorageClass.inMemory({})
      : AgentAuthStorageClass.create();
  const modelRegistry =
    typeof AgentModelRegistryClass.inMemory === "function"
      ? AgentModelRegistryClass.inMemory(authStorage)
      : AgentModelRegistryClass.create(authStorage);
  return { authStorage, modelRegistry };
}

function resolvePreparedAgentSnapshot(
  resolvedAgentDir: string,
  cfg: OpenClawConfig | undefined,
  explicitWorkspaceDir: string | undefined,
  derivedWorkspaceDir: string | undefined,
  agentId: string | undefined,
): ReturnType<typeof getPreparedModelRuntimeSnapshot> {
  const base = {
    ...(agentId ? { agentId } : {}),
    agentDir: resolvedAgentDir,
    config: cfg ?? {},
    inheritedAuthDir: resolveLegacyInheritedAuthDir(cfg ?? {}),
  };
  const published = getPreparedModelRuntimeSnapshot({
    ...base,
    ...(explicitWorkspaceDir ? { workspaceDir: explicitWorkspaceDir } : {}),
  });
  if (published || explicitWorkspaceDir || !derivedWorkspaceDir) {
    return published;
  }
  // Standalone runs publish an exact workspace owner. Gateway owners may instead carry an
  // authoritative launch workspace, which the workspace-free lookup above resolves by agent.
  return getPreparedModelRuntimeSnapshot({ ...base, workspaceDir: derivedWorkspaceDir });
}

export function resolveModel(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: OpenClawConfig,
  options?: CommonModelResolutionOptions,
): {
  model?: Model;
  error?: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
} {
  const resolvedAgentDir = agentDir ?? resolveDefaultAgentDir(cfg ?? {});
  const derivedWorkspaceDir = resolveModelWorkspaceDir(
    cfg,
    options?.workspaceDir,
    options?.agentId,
  );
  const preparedSnapshot =
    !options?.authStorage || !options?.modelRegistry
      ? resolvePreparedAgentSnapshot(
          resolvedAgentDir,
          cfg,
          options?.workspaceDir,
          derivedWorkspaceDir,
          options?.agentId,
        )
      : undefined;
  if ((!options?.authStorage || !options?.modelRegistry) && !preparedSnapshot) {
    // Synchronous callers must enter through a lifecycle that already published discovery.
    // Falling back to an empty registry turns a stale/pending generation into a false model miss.
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      `prepared model runtime is not published for synchronous model resolution (${resolvedAgentDir}); use resolveModelAsync before lifecycle publication`,
    );
  }
  const workspaceDir =
    options?.workspaceDir ?? preparedSnapshot?.workspaceDir ?? derivedWorkspaceDir;
  const normalizedRef = normalizeProviderModelRef({ provider, modelId, cfg, workspaceDir });
  const preparedStores = preparedSnapshot?.createStores();
  const authStorage = options?.authStorage ?? preparedStores!.authStorage;
  const modelRegistry =
    options?.modelRegistry ??
    (options?.authStorage
      ? preparedStores!.modelRegistry.fork(authStorage)
      : preparedStores!.modelRegistry);
  const runtimeHooks = resolveRuntimeHooks(options);
  const model = resolveModelWithPreparedRegistry({
    provider: normalizedRef.provider,
    modelId: normalizedRef.model,
    modelRegistry,
    cfg,
    agentDir: resolvedAgentDir,
    manifestAlias: normalizedRef.manifestAlias,
    workspaceDir,
    authProfileId: options?.authProfileId,
    authProfileMode: options?.authProfileMode,
    preferredProfile: options?.preferredProfile,
    runtimeHooks,
  });
  if (model) {
    return { model, authStorage, modelRegistry };
  }
  return {
    error: buildUnknownModelError({
      provider: normalizedRef.provider,
      modelId: normalizedRef.model,
      cfg,
      agentDir: resolvedAgentDir,
      workspaceDir,
      runtimeHooks,
    }),
    authStorage,
    modelRegistry,
  };
}

export async function resolveModelAsync(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: OpenClawConfig,
  options?: AsyncModelResolutionOptions,
): Promise<{
  model?: Model;
  error?: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
}> {
  const resolvedAgentDir = agentDir ?? resolveDefaultAgentDir(cfg ?? {});
  const derivedWorkspaceDir = resolveModelWorkspaceDir(
    cfg,
    options?.workspaceDir,
    options?.agentId,
  );
  const emptyDiscoveryStores =
    options?.skipAgentDiscovery && (!options.authStorage || !options.modelRegistry)
      ? createEmptyAgentDiscoveryStores()
      : undefined;
  const publishedSnapshot =
    !emptyDiscoveryStores && (!options?.authStorage || !options?.modelRegistry)
      ? resolvePreparedAgentSnapshot(
          resolvedAgentDir,
          cfg,
          options?.workspaceDir,
          derivedWorkspaceDir,
          options?.agentId,
        )
      : undefined;
  const preparedSnapshot =
    publishedSnapshot ??
    (!emptyDiscoveryStores && (!options?.authStorage || !options?.modelRegistry)
      ? await loadPreparedModelRuntimeSnapshot({
          ...(options?.agentId ? { agentId: options.agentId } : {}),
          agentDir: resolvedAgentDir,
          config: cfg ?? {},
          inheritedAuthDir: resolveLegacyInheritedAuthDir(cfg ?? {}),
          ...(derivedWorkspaceDir ? { workspaceDir: derivedWorkspaceDir } : {}),
        })
      : undefined);
  const workspaceDir =
    options?.workspaceDir ?? preparedSnapshot?.workspaceDir ?? derivedWorkspaceDir;
  const normalizedRef = normalizeProviderModelRef({ provider, modelId, cfg, workspaceDir });
  const preparedStores = preparedSnapshot?.createStores();
  const fallbackStores =
    emptyDiscoveryStores ?? preparedStores ?? createEmptyAgentDiscoveryStores();
  const authStorage = options?.authStorage ?? fallbackStores.authStorage;
  const modelRegistry =
    options?.modelRegistry ??
    (options?.authStorage
      ? fallbackStores.modelRegistry.fork(authStorage)
      : fallbackStores.modelRegistry);
  const runtimeHooks = resolveRuntimeHooks(options);
  // Route-projected cfg owns transport/auth; the snapshot contributes generation facts only.
  const preparedModelRuntime = options?.preparedModelRuntime ?? preparedSnapshot;
  const preparedStaticCatalogModel = preparedModelRuntime?.configuredRuntimeModels?.find(
    ({ modelId: candidateId, provider: rowProvider }) =>
      staticModelIdMatches({
        candidateId,
        rowProvider,
        provider: normalizedRef.provider,
        modelId: normalizedRef.model,
      }),
  )?.model;
  if (normalizedRef.manifestAlias.ambiguous) {
    return {
      error: buildUnknownModelError({
        provider: normalizedRef.provider,
        modelId: normalizedRef.model,
        cfg,
        agentDir: resolvedAgentDir,
        workspaceDir,
        runtimeHooks,
      }),
      authStorage,
      modelRegistry,
    };
  }
  const explicitModel = resolveExplicitModelWithRegistry({
    provider: normalizedRef.provider,
    modelId: normalizedRef.model,
    modelRegistry,
    cfg,
    agentDir: resolvedAgentDir,
    manifestAlias: normalizedRef.manifestAlias,
    workspaceDir,
    runtimeHooks,
    preparedInlineProviderModels: preparedModelRuntime?.inlineProviderModels,
    preparedStaticCatalogModel,
  });
  if (explicitModel?.kind === "suppressed") {
    const suppressedRuntimeModel = resolveRuntimePreferredSuppressedModel({
      provider: normalizedRef.provider,
      modelId: normalizedRef.model,
      modelRegistry,
      cfg,
      agentDir: resolvedAgentDir,
      ...(options?.agentRuntimeId ? { agentRuntimeId: options.agentRuntimeId } : {}),
      manifestAlias: normalizedRef.manifestAlias,
      workspaceDir,
      authProfileId: options?.authProfileId,
      authProfileMode: options?.authProfileMode,
      preferredProfile: options?.preferredProfile,
      runtimeHooks,
    });
    if (suppressedRuntimeModel) {
      return { model: suppressedRuntimeModel, authStorage, modelRegistry };
    }
    return {
      error: buildUnknownModelError({
        provider: normalizedRef.provider,
        modelId: normalizedRef.model,
        cfg,
        agentDir: resolvedAgentDir,
        workspaceDir,
        runtimeHooks,
      }),
      authStorage,
      modelRegistry,
    };
  }
  const providerConfig = resolveConfiguredProviderConfig(cfg, normalizedRef.provider);
  const authProfile = resolveDynamicModelAuthProfile({
    provider: normalizedRef.provider,
    modelId: normalizedRef.model,
    cfg,
    agentDir: resolvedAgentDir,
    authProfileId: options?.authProfileId,
    authProfileMode: options?.authProfileMode,
    preferredProfile: options?.preferredProfile,
  });
  const preparedMetadataSnapshot = preparedModelRuntime?.metadataSnapshot;
  let staticCatalogLookup: Promise<ProviderRuntimeModel | undefined> | undefined;
  const resolveStaticCatalogModel = async () => {
    if (!options?.allowBundledStaticCatalogFallback) {
      return undefined;
    }
    staticCatalogLookup ??= (async () => {
      if (preparedStaticCatalogModel) {
        return preparedStaticCatalogModel;
      }
      const manifestModel = resolveBundledStaticCatalogModel({
        provider: normalizedRef.provider,
        modelId: normalizedRef.model,
        cfg,
        workspaceDir,
        includeRuntimeDiscovery: true,
        ...(preparedMetadataSnapshot ? { metadataSnapshot: preparedMetadataSnapshot } : {}),
      });
      if (manifestModel) {
        return manifestModel;
      }
      return await resolveBundledProviderStaticCatalogModel({
        provider: normalizedRef.provider,
        modelId: normalizedRef.model,
        cfg,
        workspaceDir,
        ...(preparedMetadataSnapshot ? { metadataSnapshot: preparedMetadataSnapshot } : {}),
      });
    })();
    return await staticCatalogLookup;
  };
  const resolveStaticCatalogFallbackModel = async () => {
    const catalogModel = await resolveStaticCatalogModel();
    if (!catalogModel) {
      return undefined;
    }
    const overriddenStaticCatalogModel = applyConfiguredProviderOverrides({
      provider: normalizedRef.provider,
      discoveredModel: catalogModel,
      providerConfig,
      modelId: normalizedRef.model,
      cfg,
      manifestAlias: normalizedRef.manifestAlias,
      runtimeHooks,
      workspaceDir,
      preferDiscoveredModelMetadata: true,
      preferDiscoveredTransport: options?.preferBundledStaticCatalogTransport,
      staticCatalogModel: catalogModel,
    });
    return normalizeResolvedModel({
      provider: normalizedRef.provider,
      cfg,
      agentDir: resolvedAgentDir,
      workspaceDir,
      model: overriddenStaticCatalogModel,
      runtimeHooks,
    });
  };
  const resolveDynamicAttempt = async () => {
    await runtimeHooks.prepareProviderDynamicModel({
      provider: normalizedRef.provider,
      config: cfg,
      workspaceDir,
      context: {
        config: cfg,
        agentDir: resolvedAgentDir,
        ...(options?.agentRuntimeId ? { agentRuntimeId: options.agentRuntimeId } : {}),
        workspaceDir,
        provider: normalizedRef.provider,
        modelId: normalizedRef.model,
        modelRegistry,
        providerConfig,
        ...authProfile,
      },
    });
    return resolveModelWithPreparedRegistry({
      provider: normalizedRef.provider,
      modelId: normalizedRef.model,
      modelRegistry,
      cfg,
      agentDir: resolvedAgentDir,
      ...(options?.agentRuntimeId ? { agentRuntimeId: options.agentRuntimeId } : {}),
      manifestAlias: normalizedRef.manifestAlias,
      workspaceDir,
      authProfileId: options?.authProfileId,
      authProfileMode: options?.authProfileMode,
      preferredProfile: options?.preferredProfile,
      runtimeHooks,
      ...(options?.allowBundledStaticCatalogFallback ? { skipConfiguredFallback: true } : {}),
    });
  };
  const providerRuntimeMetadataShouldWin = shouldCompareProviderRuntimeResolvedModel({
    provider: normalizedRef.provider,
    modelId: normalizedRef.model,
    cfg,
    agentDir: resolvedAgentDir,
    workspaceDir,
    runtimeHooks,
  });
  let model =
    explicitModel?.kind === "resolved" && !providerRuntimeMetadataShouldWin
      ? explicitModel.model
      : undefined;
  model ??= await resolveDynamicAttempt();
  if (!model && !explicitModel && options?.allowBundledStaticCatalogFallback) {
    model = await resolveStaticCatalogFallbackModel();
  }
  if (!model && !explicitModel && options?.allowBundledStaticCatalogFallback) {
    model = buildConfiguredFallbackModel({
      provider: normalizedRef.provider,
      modelId: normalizedRef.model,
      cfg,
      agentDir: resolvedAgentDir,
      manifestAlias: normalizedRef.manifestAlias,
      workspaceDir,
      runtimeHooks,
    });
  }
  if (model && options?.allowBundledStaticCatalogFallback) {
    const staticMediaInput = (await resolveStaticCatalogModel())?.mediaInput;
    const resolvedMediaInput = (model as ProviderRuntimeModel).mediaInput;
    const mediaInput = mergeModelMediaInput(staticMediaInput, resolvedMediaInput);
    if (mediaInput) {
      model = { ...(model as ProviderRuntimeModel), mediaInput } as typeof model;
    }
  }
  if (model) {
    return { model, authStorage, modelRegistry };
  }
  return {
    error: buildUnknownModelError({
      provider: normalizedRef.provider,
      modelId: normalizedRef.model,
      cfg,
      agentDir: resolvedAgentDir,
      workspaceDir,
      runtimeHooks,
    }),
    authStorage,
    modelRegistry,
  };
}

/**
 * Build a more helpful error when the model is not found.
 *
 * Some provider plugins only become available after setup/auth has registered
 * them. When users point `agents.defaults.model.primary` at one of those
 * providers before setup, the raw `Unknown model` error is too vague. Provider
 * plugins can append a targeted recovery hint here.
 *
 * See: https://github.com/openclaw/openclaw/issues/17328
 */
function buildUnknownModelError(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): string {
  const suppressed = buildSuppressedBuiltInModelError({
    provider: params.provider,
    id: params.modelId,
    ...(params.cfg ? { config: params.cfg } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  if (suppressed) {
    return suppressed;
  }
  const base = `Unknown model: ${params.provider}/${params.modelId}`;
  const registrationHint = buildMissingProviderModelRegistrationHint({
    provider: params.provider,
    modelId: params.modelId,
    cfg: params.cfg,
  });
  if (registrationHint) {
    return `${base}. ${registrationHint}`;
  }
  const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
  const hint = runtimeHooks.buildProviderUnknownModelHintWithPlugin({
    provider: params.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: process.env,
    context: {
      config: params.cfg,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      env: process.env,
      provider: params.provider,
      modelId: params.modelId,
    },
  });
  return hint ? `${base}. ${hint}` : base;
}

function buildMissingProviderModelRegistrationHint(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
}): string | undefined {
  // Legacy openai-codex refs can come from model selections, provider config,
  // or persisted routes. All of them should be repaired by doctor rather than
  // turned into a new models.providers[] registration.
  if (normalizeProviderId(params.provider) === "openai-codex") {
    return `"openai-codex" is a legacy provider ID. Run \`openclaw doctor --fix\` to migrate legacy model and provider config to the current OpenAI format. If the provider has no authenticated profile, run \`openclaw models status\` to check provider auth and re-authenticate if needed. See https://docs.openclaw.ai/concepts/model-providers.`;
  }
  const configuredModels = params.cfg?.agents?.defaults?.models;
  if (!configuredModels) {
    return undefined;
  }
  const agentModelKey = modelKey(params.provider, params.modelId);
  const configuredEntry =
    configuredModels[agentModelKey] ?? configuredModels[`${params.provider}/${params.modelId}`];
  if (!configuredEntry) {
    return undefined;
  }
  // Models bound to an agent runtime (e.g. "codex") draw their catalog from that
  // runtime and its linked account, not from models.providers[].models[].
  // Advising a models.providers[] registration here is actively misleading: it
  // makes resolution "succeed" only for the request to be rejected later by the
  // runtime/provider (e.g. OpenAI returns 400 "model is not supported when using
  // Codex with a ChatGPT account" once a deprecated model id is no longer
  // offered). Point the user at the runtime's live catalog instead.
  const agentRuntimeId = configuredEntry.agentRuntime?.id;
  if (agentRuntimeId) {
    return `Found agents.defaults.models["${agentModelKey}"] bound to the "${agentRuntimeId}" agent runtime. Models served by an agent runtime come from that runtime and its linked account, not from models.providers["${params.provider}"].models[] — registering it there will not make it usable. Confirm "${params.modelId}" is still offered by the "${agentRuntimeId}" runtime and switch agents.defaults.model.primary to a currently available model (run \`openclaw models list --provider ${params.provider}\` to list them). See https://docs.openclaw.ai/concepts/model-providers.`;
  }
  const providerConfig = findNormalizedProviderValue(
    params.cfg?.models?.providers,
    params.provider,
  ) as { models?: unknown } | undefined;
  const providerModels = Array.isArray(providerConfig?.models) ? providerConfig.models : [];
  const hasProviderModel = providerModels.some((entry) => {
    if (!entry || typeof entry !== "object" || !("id" in entry)) {
      return false;
    }
    const id = (entry as { id?: unknown }).id;
    return typeof id === "string" && id === params.modelId;
  });
  if (hasProviderModel) {
    return undefined;
  }
  return `Found agents.defaults.models["${agentModelKey}"], but no matching models.providers["${params.provider}"].models[] entry. Add { "id": "${params.modelId}", "name": "${params.modelId}" } to models.providers["${params.provider}"].models[] to register this provider model. For custom or proxy providers, also set api and baseUrl so requests route to the intended endpoint. See https://docs.openclaw.ai/concepts/model-providers.`;
}
