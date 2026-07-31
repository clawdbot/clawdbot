import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { ConfiguredModelRef } from "@openclaw/model-catalog-core/configured-model-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { PreparedMessageToolCatalog } from "../channels/plugins/message-action-discovery.js";
import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import { sha256Base64Url } from "../infra/crypto-digest.js";
import { prepareMediaCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  getPreparedMessageToolCatalog,
  getPreparedMessageToolCatalogForRegistry,
} from "../plugins/prepared-message-tool-catalog.js";
import type { PreparedProviderStaticCatalog } from "../plugins/provider-discovery.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { resolveRuntimeSyntheticAuthProviderRefs } from "../plugins/synthetic-auth.runtime.js";
import type { ProviderPlugin } from "../plugins/types.js";
import type { AgentCredentialMap } from "./agent-auth-credentials.js";
import { resolveAmbientAgentCredentialsForDiscovery } from "./agent-auth-discovery.js";
import {
  discoverAuthStorage,
  discoverModels,
  discoverModelsFromCapturedSources,
} from "./agent-model-discovery.js";
import {
  buildInlineProviderModels,
  type InlineModelEntry,
} from "./embedded-agent-runner/model.inline-provider.js";
import {
  createBundledStaticCatalogModelResolver,
  loadBundledProviderStaticCatalogContextModels,
} from "./embedded-agent-runner/model.static-catalog.js";
import { createStaticModelIdMatcher } from "./embedded-agent-runner/model.static-id.js";
import { buildPreparedModelCatalogSnapshot, type ModelCatalogEntry } from "./model-catalog.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";
import { ensureOpenClawModelsJson, planOpenClawModelsJsonSource } from "./models-config.js";
import { prepareImplicitProviderStaticCatalog } from "./models-config.providers.implicit.js";
import {
  loadPersistedPluginModelCatalogsReadOnly,
  resolvePluginModelCatalogOwnerPluginId,
  type PersistedPluginModelCatalog,
} from "./plugin-model-catalog.js";
import {
  collectPreparedModelRuntimeConfiguredRefs,
  collectConfiguredProviderIdsNeedingStaticCatalog,
  collectPreparedModelRuntimeProviderIds,
  prepareConfiguredRuntimeModels,
  toStaticCatalogEntry,
  type PreparedConfiguredRuntimeModel,
} from "./prepared-model-runtime.configured.js";
import type {
  PreparedModelRuntimeBuildStats,
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimeInput,
} from "./prepared-model-runtime.types.js";
import { ensureRuntimePluginsLoaded } from "./runtime-plugins.js";
import type { AuthStorage, AuthStorageData } from "./sessions/auth-storage.js";
import type { ModelRegistry } from "./sessions/model-registry.js";
import { stableStringify } from "./stable-stringify.js";

const MODEL_RUNTIME_PROVIDER_DISCOVERY_TIMEOUT_MS = 5_000;

type PreparedModelRuntimeAgentBaseFacts = {
  input: PreparedModelRuntimeInput;
  env: NodeJS.ProcessEnv;
  templateAuthStorage: AuthStorage;
  credentials: Readonly<AuthStorageData>;
  providerIds: string[];
  configuredModelRefs: readonly ConfiguredModelRef[];
};

export type PreparedModelRuntimeAgentFacts = PreparedModelRuntimeAgentBaseFacts & {
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
  configuredGeneratedCatalogPluginIds: readonly string[];
};

export type PreparedModelRuntimeWorkspaceFacts = {
  pluginMetadataSnapshot: PluginMetadataSnapshot;
  messageToolCatalog?: PreparedMessageToolCatalog;
  mediaCapabilityProviders?: ReturnType<typeof prepareMediaCapabilityProviders>;
  preparedStaticProviderCatalog?: PreparedProviderStaticCatalog;
  providerStaticModels?: readonly ProviderRuntimeModel[];
  providerStaticModelsComplete: boolean;
  inlineProviderModels: readonly InlineModelEntry[];
  configuredCatalogEntries: readonly ModelCatalogEntry[];
};

export type PreparedModelRuntimeCatalogFacts = {
  templateModelRegistry: ModelRegistry;
  modelCatalog: ModelCatalogSnapshot;
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
  inlineProviderModels: readonly InlineModelEntry[];
};

export type PreparedModelRuntimeCatalogSource = Readonly<{
  modelsJsonContents: string | null;
  pluginCatalogs: readonly PersistedPluginModelCatalog[];
}>;

type PreparedConfiguredRegistryGroup = {
  agentFacts: PreparedModelRuntimeAgentFacts[];
  modelsJsonContents: string | null;
  oauthProviders: ReturnType<AuthStorage["getOAuthProviders"]>;
  pluginCatalogs: readonly PersistedPluginModelCatalog[];
};

function prepareAgentFacts(
  input: PreparedModelRuntimeInput,
  catalogMode: PreparedModelRuntimeCatalogMode,
  ambientCredentials: Readonly<AgentCredentialMap>,
): PreparedModelRuntimeAgentBaseFacts {
  const env = input.env ?? process.env;
  const templateAuthStorage = discoverAuthStorage(input.agentDir, {
    config: input.config,
    // Snapshot construction never initializes, migrates, or externally syncs auth. ModelRegistry
    // discovery only parses the credential generation captured here.
    readOnly: true,
    ambientCredentials,
    ...(input.skipCredentials ? { skipCredentials: true } : {}),
    ...(input.inheritedAuthDir ? { inheritedAuthDir: input.inheritedAuthDir } : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    ...(input.env ? { env } : {}),
  });
  const credentials = templateAuthStorage.getAll();
  const configuredModelRefs = collectPreparedModelRuntimeConfiguredRefs(
    input.config,
    input.agentId,
  );
  return {
    input,
    env,
    templateAuthStorage,
    credentials,
    configuredModelRefs,
    // Gateway startup prepares only providers named by config/model selection. An unrelated
    // stored credential must not pull that provider's complete catalog into the admission path.
    providerIds: collectPreparedModelRuntimeProviderIds(
      input.config,
      credentials,
      catalogMode === "live",
      configuredModelRefs,
    ),
  };
}

function listPreparedSyntheticAuthProviderRefs(providers: readonly ProviderPlugin[]): string[] {
  return [
    ...new Set(
      providers.flatMap((provider) =>
        typeof provider.resolveSyntheticAuth === "function"
          ? [provider.id, ...(provider.aliases ?? []), ...(provider.hookAliases ?? [])]
          : [],
      ),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

function resolvePreparedSyntheticAuth(params: {
  config: PreparedModelRuntimeInput["config"];
  provider: string;
  providers: readonly ProviderPlugin[];
}): { apiKey?: string } | undefined {
  const normalizedProvider = normalizeProviderId(params.provider);
  const providerPlugin = params.providers.find((candidate) =>
    [candidate.id, ...(candidate.aliases ?? []), ...(candidate.hookAliases ?? [])].some(
      (ref) => normalizeProviderId(ref) === normalizedProvider,
    ),
  );
  return (
    providerPlugin?.resolveSyntheticAuth?.({
      config: params.config,
      provider: params.provider,
      providerConfig: Object.entries(params.config.models?.providers ?? {}).find(
        ([providerId]) => normalizeProviderId(providerId) === normalizedProvider,
      )?.[1],
    }) ?? undefined
  );
}

export function preparedModelRuntimeWorkspaceFactsKey(input: PreparedModelRuntimeInput): string {
  return JSON.stringify({
    // Config is the process generation. Agent-specific configured refs are projected after these
    // workspace/plugin facts are shared.
    config: hashRuntimeConfigValue(input.config),
    env: hashRuntimeConfigValue(input.env ?? process.env),
    readOnly: input.readOnly === true,
    workspaceDir: input.workspaceDir,
  });
}

export async function prepareWorkspaceBuildGroup(
  inputs: readonly PreparedModelRuntimeInput[],
  catalogMode: PreparedModelRuntimeCatalogMode,
): Promise<{
  agentFacts: PreparedModelRuntimeAgentFacts[];
  workspaceFacts: PreparedModelRuntimeWorkspaceFacts;
  buildStats: Pick<
    PreparedModelRuntimeBuildStats,
    | "runtimePluginMs"
    | "pluginMetadataMs"
    | "staticProviderCatalogMs"
    | "ambientCredentialsMs"
    | "agentFactsMs"
    | "configuredProjectionMs"
  >;
}> {
  const input = inputs[0];
  if (!input) {
    throw new Error("prepared model runtime workspace group is empty");
  }
  const env = input.env ?? process.env;
  const runtimePluginStartedAt = performance.now();
  const runtimePluginRegistry =
    catalogMode === "live" && !input.readOnly
      ? ensureRuntimePluginsLoaded({
          config: input.config,
          ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
        })
      : undefined;
  const runtimePluginMs = performance.now() - runtimePluginStartedAt;
  const pluginMetadataStartedAt = performance.now();
  const pluginMetadataSnapshot = resolvePluginMetadataSnapshot({
    config: input.config,
    env,
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
  });
  const pluginMetadataMs = performance.now() - pluginMetadataStartedAt;
  const matchesStaticModelId = createStaticModelIdMatcher({
    manifestPlugins: pluginMetadataSnapshot.plugins,
  });
  const mediaCapabilityProviders =
    input.readOnly || !runtimePluginRegistry
      ? undefined
      : prepareMediaCapabilityProviders({
          cfg: input.config,
          pluginMetadataSnapshot,
          registry: runtimePluginRegistry,
        });
  const messageToolCatalog = runtimePluginRegistry
    ? getPreparedMessageToolCatalogForRegistry(runtimePluginRegistry)
    : catalogMode === "live"
      ? getPreparedMessageToolCatalog()
      : undefined;
  const resolveManifestStaticCatalogModel = createBundledStaticCatalogModelResolver({
    cfg: input.config,
    env,
    includeRuntimeDiscovery: true,
    metadataSnapshot: pluginMetadataSnapshot,
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
  });
  const configuredManifestModels = new Map<string, ProviderRuntimeModel | undefined>();
  const resolveConfiguredManifestModel = (lookup: { provider: string; modelId: string }) => {
    const key = `${normalizeProviderId(lookup.provider)}\0${lookup.modelId.trim().toLowerCase()}`;
    if (configuredManifestModels.has(key)) {
      return configuredManifestModels.get(key);
    }
    const model = resolveManifestStaticCatalogModel(lookup);
    configuredManifestModels.set(key, model);
    return model;
  };
  const configuredProviderIds = collectPreparedModelRuntimeProviderIds(input.config, {}, false);
  const staticCatalogProviderIds = collectConfiguredProviderIdsNeedingStaticCatalog({
    config: input.config,
    matchesStaticModelId,
    resolveStaticCatalogModel: resolveConfiguredManifestModel,
  });
  const staticProviderCatalogStartedAt = performance.now();
  const preparedStaticProviderCatalog =
    catalogMode === "static"
      ? await prepareImplicitProviderStaticCatalog({
          config: input.config,
          env,
          pluginMetadataSnapshot,
          providerDiscoveryProviderIds: configuredProviderIds,
          staticCatalogProviderIds,
          ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
        })
      : undefined;
  const staticProviderCatalogMs = performance.now() - staticProviderCatalogStartedAt;
  const preparedSyntheticAuthProviders = preparedStaticProviderCatalog?.providers ?? [];
  // Static Gateway publication consumes provider discovery entrypoints without activating plugin
  // runtimes. The run boundary already owns runtime activation for its exact workspace.
  const ambientCredentialsStartedAt = performance.now();
  const ambientCredentials = resolveAmbientAgentCredentialsForDiscovery({
    config: input.config,
    env,
    syntheticAuthProviderRefs:
      catalogMode === "static"
        ? listPreparedSyntheticAuthProviderRefs(preparedSyntheticAuthProviders)
        : resolveRuntimeSyntheticAuthProviderRefs({
            config: input.config,
            env,
            index: pluginMetadataSnapshot.index,
            registryDiagnostics: pluginMetadataSnapshot.registryDiagnostics,
            ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
          }),
    ...(catalogMode === "static"
      ? {
          resolveSyntheticAuth: (provider: string) =>
            resolvePreparedSyntheticAuth({
              config: input.config,
              provider,
              providers: preparedSyntheticAuthProviders,
            }),
        }
      : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
  });
  const ambientCredentialsMs = performance.now() - ambientCredentialsStartedAt;
  const agentFactsStartedAt = performance.now();
  const agentBaseFacts = inputs.map((candidate) =>
    prepareAgentFacts(candidate, catalogMode, ambientCredentials),
  );
  const agentFactsMs = performance.now() - agentFactsStartedAt;
  const configuredProjectionStartedAt = performance.now();
  const providerStaticModels =
    catalogMode === "static"
      ? []
      : await loadBundledProviderStaticCatalogContextModels({
          cfg: input.config,
          env,
          metadataSnapshot: pluginMetadataSnapshot,
          ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
        });
  // Provider definitions are process/config facts. Which refs are admitted remains agent-owned.
  const inlineProviderModels = buildInlineProviderModels(input.config.models?.providers ?? {}, {
    providerMetadataOwners: pluginMetadataSnapshot.owners,
  });
  const configuredCatalogEntries = buildConfiguredModelCatalog({
    cfg: input.config,
    manifestPlugins: pluginMetadataSnapshot.plugins,
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
  });
  const agentFacts: PreparedModelRuntimeAgentFacts[] = [];
  for (const facts of agentBaseFacts) {
    const configuredRuntimeModels = prepareConfiguredRuntimeModels({
      config: facts.input.config,
      configuredModelRefs: facts.configuredModelRefs,
      metadataSnapshot: pluginMetadataSnapshot,
      ...(preparedStaticProviderCatalog ? { preparedStaticProviderCatalog } : {}),
      providerStaticModels,
      matchesStaticModelId,
      resolveStaticCatalogModel: resolveConfiguredManifestModel,
    });
    const configuredEntryKeys = new Set(configuredCatalogEntries.map(modelCatalogEntryKey));
    for (const configured of configuredRuntimeModels) {
      configuredEntryKeys.add(
        modelCatalogEntryKey({ provider: configured.provider, id: configured.modelId }),
      );
    }
    const configuredGeneratedCatalogPluginIds = [
      ...new Set(
        facts.configuredModelRefs.flatMap(({ value }) => {
          const separator = value.indexOf("/");
          if (separator <= 0 || separator >= value.length - 1) {
            return [];
          }
          const provider = normalizeProviderId(value.slice(0, separator));
          const modelId = value.slice(separator + 1).trim();
          if (
            !provider ||
            !modelId ||
            configuredEntryKeys.has(modelCatalogEntryKey({ provider, id: modelId }))
          ) {
            return [];
          }
          const pluginId = resolvePluginModelCatalogOwnerPluginId({
            providerId: provider,
            pluginMetadataSnapshot,
          });
          return pluginId ? [pluginId] : [];
        }),
      ),
    ].toSorted((left, right) => left.localeCompare(right));
    agentFacts.push({
      ...facts,
      configuredRuntimeModels,
      configuredGeneratedCatalogPluginIds,
    });
  }
  const configuredProjectionMs = performance.now() - configuredProjectionStartedAt;
  return {
    agentFacts,
    buildStats: {
      runtimePluginMs,
      pluginMetadataMs,
      staticProviderCatalogMs,
      ambientCredentialsMs,
      agentFactsMs,
      configuredProjectionMs,
    },
    workspaceFacts: {
      pluginMetadataSnapshot,
      messageToolCatalog,
      providerStaticModelsComplete: catalogMode === "live",
      inlineProviderModels,
      configuredCatalogEntries,
      ...(mediaCapabilityProviders ? { mediaCapabilityProviders } : {}),
      ...(preparedStaticProviderCatalog ? { preparedStaticProviderCatalog } : {}),
      ...(providerStaticModels ? { providerStaticModels } : {}),
    },
  };
}

export async function prepareFullCatalogFacts(
  agentFacts: PreparedModelRuntimeAgentFacts,
  workspaceFacts: PreparedModelRuntimeWorkspaceFacts,
  catalogMode: PreparedModelRuntimeCatalogMode,
  catalogSource?: PreparedModelRuntimeCatalogSource,
): Promise<PreparedModelRuntimeCatalogFacts> {
  const { credentials, env, input, templateAuthStorage } = agentFacts;
  const { pluginMetadataSnapshot, preparedStaticProviderCatalog } = workspaceFacts;
  const templateModelRegistry = discoverModels(templateAuthStorage, input.agentDir, {
    config: input.config,
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    pluginMetadataSnapshot,
    ...(catalogMode === "static" ? { normalizeModels: false } : {}),
    ...(catalogSource
      ? {
          includePluginCatalogs: true,
          modelsJsonContents: catalogSource.modelsJsonContents,
          pluginCatalogs: catalogSource.pluginCatalogs,
        }
      : {}),
  });
  const modelCatalog = await buildPreparedModelCatalogSnapshot({
    agentDir: input.agentDir,
    authCredentials: credentials,
    config: input.config,
    modelRegistry: templateModelRegistry,
    metadataSnapshot: pluginMetadataSnapshot,
    includeProviderPluginAugmentation: catalogMode === "live",
    ...(input.env ? { env } : {}),
    ...(input.readOnly ? { readOnly: true } : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
  });
  const providerStaticModels =
    (workspaceFacts.providerStaticModelsComplete
      ? workspaceFacts.providerStaticModels
      : undefined) ??
    (await loadBundledProviderStaticCatalogContextModels({
      cfg: input.config,
      env,
      metadataSnapshot: pluginMetadataSnapshot,
      ...(preparedStaticProviderCatalog ? { preparedStaticProviderCatalog } : {}),
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    }));
  const configuredRuntimeModels = agentFacts.configuredRuntimeModels;
  const staticModels = new Map<string, ProviderRuntimeModel>();
  for (const model of [
    ...configuredRuntimeModels.map((configured) => configured.model),
    ...providerStaticModels,
  ]) {
    const modelKey = `${normalizeProviderId(model.provider)}\0${model.id.trim().toLowerCase()}`;
    if (!staticModels.has(modelKey)) {
      staticModels.set(modelKey, model);
    }
  }
  const staticEntries = [...staticModels.values()].map(toStaticCatalogEntry);
  return {
    templateModelRegistry,
    modelCatalog: { ...modelCatalog, staticEntries },
    configuredRuntimeModels,
    inlineProviderModels: workspaceFacts.inlineProviderModels,
  };
}

function modelCatalogEntryKey(entry: Pick<ModelCatalogEntry, "id" | "provider">): string {
  return `${normalizeProviderId(entry.provider)}\0${entry.id.trim().toLowerCase()}`;
}

function createConfiguredModelCatalogSnapshot(params: {
  agentFacts: PreparedModelRuntimeAgentFacts;
  workspaceFacts: PreparedModelRuntimeWorkspaceFacts;
  templateModelRegistry: ModelRegistry;
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
}): ModelCatalogSnapshot {
  const entries = new Map<string, ModelCatalogEntry>();
  const addEntry = (entry: ModelCatalogEntry) => {
    const key = modelCatalogEntryKey(entry);
    if (!entries.has(key)) {
      entries.set(key, entry);
    }
  };
  for (const entry of params.workspaceFacts.configuredCatalogEntries) {
    addEntry(entry);
  }
  for (const configured of params.configuredRuntimeModels) {
    addEntry(toStaticCatalogEntry(configured.model));
  }
  for (const { value } of params.agentFacts.configuredModelRefs) {
    const separator = value.indexOf("/");
    if (separator <= 0 || separator >= value.length - 1) {
      continue;
    }
    const provider = normalizeProviderId(value.slice(0, separator));
    const modelId = value.slice(separator + 1).trim();
    if (!provider || !modelId) {
      continue;
    }
    const model = params.templateModelRegistry.find(provider, modelId);
    if (model) {
      addEntry(toStaticCatalogEntry(model));
    }
  }
  const configuredEntries = [...entries.values()];
  const staticEntries = params.configuredRuntimeModels.map(({ model }) =>
    toStaticCatalogEntry(model),
  );
  return {
    entries: configuredEntries,
    routeVariants: configuredEntries,
    ...(staticEntries.length > 0 ? { staticEntries } : {}),
  };
}

function prepareConfiguredRuntimeFacts(
  agentFacts: PreparedModelRuntimeAgentFacts,
  workspaceFacts: PreparedModelRuntimeWorkspaceFacts,
  sharedTemplateModelRegistry: ModelRegistry,
): PreparedModelRuntimeCatalogFacts {
  const { configuredRuntimeModels } = agentFacts;
  const { inlineProviderModels } = workspaceFacts;
  const templateModelRegistry = sharedTemplateModelRegistry;
  return {
    templateModelRegistry,
    modelCatalog: createConfiguredModelCatalogSnapshot({
      agentFacts,
      workspaceFacts,
      templateModelRegistry,
      configuredRuntimeModels,
    }),
    configuredRuntimeModels,
    inlineProviderModels,
  };
}

function captureModelsJsonContents(agentDir: string): string | null {
  try {
    return fs.readFileSync(path.join(agentDir, "models.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function fingerprintPreparedRuntimeFacts(value: unknown): string {
  return sha256Base64Url(stableStringify(value));
}

function hasSameOAuthProviderGeneration(
  left: ReturnType<AuthStorage["getOAuthProviders"]>,
  right: ReturnType<AuthStorage["getOAuthProviders"]>,
): boolean {
  // OAuth descriptors carry executable hooks. Match those hooks by identity so equivalent
  // AuthStorage instances share built-ins without merging distinct closure generations.
  return (
    left.length === right.length &&
    left.every((provider, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        provider.id === candidate.id &&
        provider.name === candidate.name &&
        provider.usesCallbackServer === candidate.usesCallbackServer &&
        provider.login === candidate.login &&
        provider.refreshToken === candidate.refreshToken &&
        provider.getApiKey === candidate.getApiKey &&
        provider.modifyModels === candidate.modifyModels
      );
    })
  );
}

function groupConfiguredRegistrySources(
  agentFacts: readonly PreparedModelRuntimeAgentFacts[],
): PreparedConfiguredRegistryGroup[] {
  const groups = new Map<string, PreparedConfiguredRegistryGroup[]>();
  for (const facts of agentFacts) {
    const modelsJsonContents = captureModelsJsonContents(facts.input.agentDir);
    const oauthProviders = facts.templateAuthStorage.getOAuthProviders();
    // Generated catalogs are agent-owned. Capture only plugins needed by unresolved configured
    // refs, then group exact bytes and OAuth behavior so publication never mixes generations.
    const pluginCatalogs = loadPersistedPluginModelCatalogsReadOnly(
      facts.input.agentDir,
      facts.configuredGeneratedCatalogPluginIds,
    );
    const key = fingerprintPreparedRuntimeFacts({
      credentials: facts.credentials,
      modelsJsonContents,
      pluginCatalogs,
    });
    const candidates = groups.get(key) ?? [];
    const group = candidates.find((candidate) =>
      hasSameOAuthProviderGeneration(candidate.oauthProviders, oauthProviders),
    );
    if (group) {
      group.agentFacts.push(facts);
    } else {
      candidates.push({
        agentFacts: [facts],
        modelsJsonContents,
        oauthProviders,
        pluginCatalogs,
      });
      groups.set(key, candidates);
    }
  }
  return [...groups.values()].flat();
}

export function prepareConfiguredRuntimeFactsBatch(params: {
  agentFacts: readonly PreparedModelRuntimeAgentFacts[];
  workspaceFacts: PreparedModelRuntimeWorkspaceFacts;
}): {
  catalogs: Map<PreparedModelRuntimeInput, PreparedModelRuntimeCatalogFacts>;
  registryCount: number;
} {
  const catalogs = new Map<PreparedModelRuntimeInput, PreparedModelRuntimeCatalogFacts>();
  let registryCount = 0;
  for (const group of groupConfiguredRegistrySources(params.agentFacts)) {
    const representative = group.agentFacts[0];
    if (!representative) {
      continue;
    }
    // Catalog bytes, credentials, and OAuth provider behavior are identical inside this group.
    // Parse once, then fork request auth without reopening filesystem or SQLite catalog sources.
    const templateModelRegistry = discoverModelsFromCapturedSources(
      representative.templateAuthStorage,
      {
        config: representative.input.config,
        includePluginCatalogs: true,
        modelsJsonContents: group.modelsJsonContents,
        pluginCatalogs: group.pluginCatalogs,
        pluginMetadataSnapshot: params.workspaceFacts.pluginMetadataSnapshot,
        ...(representative.input.workspaceDir
          ? { workspaceDir: representative.input.workspaceDir }
          : {}),
      },
    );
    registryCount += 1;
    for (const facts of group.agentFacts) {
      catalogs.set(
        facts.input,
        prepareConfiguredRuntimeFacts(facts, params.workspaceFacts, templateModelRegistry),
      );
    }
  }
  return { catalogs, registryCount };
}

export async function prepareAgentCatalogSource(
  agentFacts: PreparedModelRuntimeAgentFacts,
  workspaceFacts: PreparedModelRuntimeWorkspaceFacts,
  catalogMode: PreparedModelRuntimeCatalogMode,
  persist = true,
): Promise<PreparedModelRuntimeCatalogSource> {
  const { env, input, providerIds } = agentFacts;
  const options = {
    pluginMetadataSnapshot: workspaceFacts.pluginMetadataSnapshot,
    ...(workspaceFacts.preparedStaticProviderCatalog
      ? { preparedStaticProviderCatalog: workspaceFacts.preparedStaticProviderCatalog }
      : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    ...(input.env ? { env } : {}),
    ...(catalogMode === "static"
      ? {
          providerDiscoveryEntriesOnly: true as const,
          providerDiscoveryProviderIds: providerIds,
        }
      : { providerDiscoveryTimeoutMs: MODEL_RUNTIME_PROVIDER_DISCOVERY_TIMEOUT_MS }),
  };
  if (!persist) {
    const source = await planOpenClawModelsJsonSource(input.config, input.agentDir, options);
    return {
      modelsJsonContents: source.modelsJsonContents,
      pluginCatalogs: source.pluginCatalogs,
    };
  }
  if (!input.readOnly) {
    await ensureOpenClawModelsJson(input.config, input.agentDir, options);
  }
  // Capture immediately after the serialized write. Another owner may share this directory and
  // publish a different workspace generation before full-catalog parsing begins.
  return {
    modelsJsonContents: captureModelsJsonContents(input.agentDir),
    pluginCatalogs: loadPersistedPluginModelCatalogsReadOnly(input.agentDir),
  };
}
