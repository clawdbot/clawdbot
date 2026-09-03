import { performance } from "node:perf_hooks";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import pLimit from "p-limit";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runAbortableTimeout } from "../node-host/with-timeout.js";
import { prepareModelCatalogThinkingPolicies } from "../plugins/provider-thinking.js";
import { getPreparedRuntimeAuthMaterializations } from "./auth-profiles/runtime-materializations.js";
import { collectConfiguredAgentHarnessRuntimes } from "./harness-runtimes.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  createPreparedModelCatalogWorker,
  createPreparedModelCatalogWorkerInput,
} from "./prepared-model-catalog-worker.js";
import {
  setPreparedModelRuntimeAuthMaterializations,
  setPreparedModelRuntimeAuthLoader,
  setPreparedModelRuntimeAuthStore,
  type PreparedModelRuntimeAuth,
  type PreparedModelRuntimeAuthScope,
} from "./prepared-model-runtime-auth.js";
import type {
  PreparedModelRuntimeAgentFacts,
  PreparedModelRuntimeCatalogFacts,
} from "./prepared-model-runtime.catalog-contract.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import {
  fingerprintPreparedRuntimeFacts,
  prepareConfiguredRuntimeFactsBatch,
  prepareWorkspaceBuildGroup,
} from "./prepared-model-runtime.facts.js";
import { materializePreparedModelCatalog } from "./prepared-model-runtime.full-catalog.js";
import {
  createPreparedInboundRegistryLoader,
  preparedModelRuntimeWorkspaceFactsKey,
} from "./prepared-model-runtime.inbound-registry.js";
import { resolvePreparedOAuthRefreshProviderIds } from "./prepared-model-runtime.oauth-refresh.js";
import { notifyPreparedModelRuntimePublication } from "./prepared-model-runtime.publication-events.js";
import type {
  PreparedModelRuntimeBuildStats,
  PreparedModelRuntimeInput,
  PreparedModelRuntimePluginGeneration,
  PreparedModelRuntimeSnapshot,
  PreparedModelRuntimeStores,
} from "./prepared-model-runtime.types.js";
import { AuthStorage } from "./sessions/auth-storage.js";

const MAX_CONCURRENT_FULL_MODEL_CATALOG_BUILDS = 1;
const limitFullModelCatalogBuild = pLimit(MAX_CONCURRENT_FULL_MODEL_CATALOG_BUILDS);

type PreparedModelRuntimeCatalogAccess = Readonly<{
  close: () => Promise<void>;
  readFullModelCatalog: () => ModelCatalogSnapshot | undefined;
  loadFullModelCatalog: (options?: { refresh?: boolean }) => Promise<ModelCatalogSnapshot>;
  loadAuth: (scope: PreparedModelRuntimeAuthScope) => Promise<PreparedModelRuntimeAuth>;
}>;
type PreparedModelRuntimeBuildCandidate = Readonly<{
  input: PreparedModelRuntimeInput;
  catalogOwner: PreparedModelRuntimeSnapshot["catalogOwner"];
  pluginGeneration?: PreparedModelRuntimePluginGeneration;
  prepareInboundPluginRegistry?: boolean;
  isGenerationCurrent?: () => boolean;
  isBuildCurrent?: () => boolean;
  /** Shared publication guards run before workspace preparation; registration guards do not. */
  isPreparationCurrent?: () => boolean;
}>;

export type PreparedModelRuntimeBuildResult = Readonly<{
  snapshot: PreparedModelRuntimeSnapshot;
  pluginGeneration: PreparedModelRuntimePluginGeneration;
  close: () => Promise<void>;
}>;

function assertPreparedModelRuntimeInputCurrent(
  input: PreparedModelRuntimeInput,
  isCurrent: (() => boolean) | undefined,
): void {
  if (isCurrent && !isCurrent()) {
    throw new PreparedModelRuntimePublicationSupersededError(
      `prepared model runtime publication was superseded for ${input.agentDir}`,
    );
  }
}

function assertPreparedModelRuntimeCandidatesCurrent(
  candidates: readonly PreparedModelRuntimeBuildCandidate[],
): void {
  for (const candidate of candidates) {
    assertPreparedModelRuntimeInputCurrent(candidate.input, candidate.isBuildCurrent);
  }
}

function groupBuildCandidates<K>(
  candidates: readonly PreparedModelRuntimeBuildCandidate[],
  keyOf: (candidate: PreparedModelRuntimeBuildCandidate) => K,
): Map<K, PreparedModelRuntimeBuildCandidate[]> {
  const groups = new Map<K, PreparedModelRuntimeBuildCandidate[]>();
  for (const candidate of candidates) {
    const key = keyOf(candidate);
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  return groups;
}

function createFullModelCatalogAccess(params: {
  agentFacts: PreparedModelRuntimeAgentFacts;
  pluginGeneration: PreparedModelRuntimePluginGeneration;
  isCurrent: () => boolean;
}): PreparedModelRuntimeCatalogAccess {
  const project = (catalog: ModelCatalogSnapshot) => {
    const projected = materializePreparedModelCatalog(
      catalog,
      params.agentFacts.runtimeCapabilityModels,
    );
    prepareModelCatalogThinkingPolicies({
      catalog: projected,
      metadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
      providers: params.pluginGeneration.pluginRegistry?.providers,
    });
    return projected;
  };
  const assertCurrent = () =>
    assertPreparedModelRuntimeInputCurrent(params.agentFacts.input, params.isCurrent);
  let fullCatalog: ModelCatalogSnapshot | undefined;
  let pending: Promise<ModelCatalogSnapshot> | undefined;
  let pendingAuth: { key: string; promise: Promise<PreparedModelRuntimeAuth> } | undefined;
  const workerInput = createPreparedModelCatalogWorkerInput({
    agentFacts: params.agentFacts,
    pluginMetadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
    preferBuiltPluginArtifacts: params.pluginGeneration.preferBuiltPluginArtifacts,
  });
  let worker: ReturnType<typeof createPreparedModelCatalogWorker> | undefined;
  let closed = false;
  const getWorker = () => {
    assertCurrent();
    if (closed) {
      throw new PreparedModelRuntimePublicationSupersededError(
        `prepared model runtime catalog generation was superseded for ${params.agentFacts.input.agentDir}`,
      );
    }
    return (worker ??= createPreparedModelCatalogWorker({
      input: workerInput,
      isCurrent: params.isCurrent,
    }));
  };
  return {
    close: async () => {
      closed = true;
      const activeWorker = worker;
      worker = undefined;
      await activeWorker?.close?.();
    },
    loadAuth: ({ providerIds, profileIds }) => {
      const cacheKey = [providerIds, profileIds ?? []]
        .map((ids) =>
          [...new Set(ids)].toSorted((left, right) => left.localeCompare(right)).join("\0"),
        )
        .join("\0\0");
      if (pendingAuth?.key === cacheKey) {
        return pendingAuth.promise;
      }
      const promise = getWorker()
        .loadAuth({ providerIds, ...(profileIds?.length ? { profileIds } : {}) })
        .then((refreshed) => {
          const providerAuth = {
            ...params.agentFacts.providerAuth,
          };
          for (const providerId of providerIds) {
            delete providerAuth[normalizeProviderId(providerId)];
          }
          Object.assign(providerAuth, refreshed.providerAuth);
          return { authStore: refreshed.authStore, providerAuth: Object.freeze(providerAuth) };
        })
        .finally(() => {
          if (pendingAuth?.promise === promise) {
            pendingAuth = undefined;
          }
        });
      pendingAuth = { key: cacheKey, promise };
      return promise;
    },
    readFullModelCatalog: () => {
      assertCurrent();
      return fullCatalog;
    },
    loadFullModelCatalog: async (options) => {
      assertCurrent();
      if (!options?.refresh && fullCatalog) {
        return fullCatalog;
      }
      if (!pending) {
        // Discovery never occupies the per-agent build slot: run admission and republication
        // must not wait behind a provider fetch. One worker at a time is enough ordering, and
        // getWorker() re-fences the generation right before the write-capable request.
        const build = limitFullModelCatalogBuild(async () => {
          assertCurrent();
          const catalog = await getWorker().loadCatalog();
          assertCurrent();
          return catalog;
        });
        pending = build
          .then((catalog) => {
            assertCurrent();
            fullCatalog = project(catalog);
            notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
            return fullCatalog;
          })
          .finally(() => {
            pending = undefined;
          });
      }
      return pending;
    },
  };
}

function createSnapshot(
  catalogOwner: PreparedModelRuntimeSnapshot["catalogOwner"],
  agentFacts: PreparedModelRuntimeAgentFacts,
  pluginGeneration: PreparedModelRuntimePluginGeneration,
  catalogFacts: PreparedModelRuntimeCatalogFacts,
  catalogAccess: PreparedModelRuntimeCatalogAccess,
): PreparedModelRuntimeSnapshot {
  const { credentials, input } = agentFacts;
  const { mediaCapabilityProviders, messageToolCatalog, pluginMetadataSnapshot, pluginRegistry } =
    pluginGeneration;
  const { configuredRuntimeModels, inlineProviderModels, templateModelRegistry } = catalogFacts;
  const modelCatalog = materializePreparedModelCatalog(
    catalogFacts.modelCatalog,
    agentFacts.runtimeCapabilityModels,
  );
  prepareModelCatalogThinkingPolicies({
    catalog: modelCatalog,
    metadataSnapshot: pluginMetadataSnapshot,
    providers: pluginRegistry?.providers,
  });
  const createStores = (): PreparedModelRuntimeStores => {
    // Runtime API keys and session extensions mutate these objects. Fork them per run while the
    // credential map and parsed catalog remain owned by the lifecycle snapshot.
    const authStorage = AuthStorage.inMemory(credentials);
    return { authStorage, modelRegistry: templateModelRegistry.fork(authStorage) };
  };
  const snapshot: PreparedModelRuntimeSnapshot = Object.freeze({
    catalogOwner,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    agentDir: input.agentDir,
    activeProjectKeys: [],
    ...(input.inheritedAuthDir ? { inheritedAuthDir: input.inheritedAuthDir } : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    config: input.config,
    providerAuth: Object.freeze({ ...agentFacts.providerAuth }),
    oauthRefreshProviderIds: resolvePreparedOAuthRefreshProviderIds({
      oauthProviders: agentFacts.templateAuthStorage.getOAuthProviders(),
      providerRegistrations: pluginRegistry?.providers ?? [],
    }),
    metadataSnapshot: pluginMetadataSnapshot,
    allowGatewaySubagentBinding: input.allowGatewaySubagentBinding === true,
    ...(pluginRegistry ? { pluginRegistry } : {}),
    ...(messageToolCatalog ? { messageToolCatalog } : {}),
    ...(mediaCapabilityProviders ? { mediaCapabilityProviders } : {}),
    modelCatalog,
    readFullModelCatalog: catalogAccess.readFullModelCatalog,
    loadFullModelCatalog: catalogAccess.loadFullModelCatalog,
    configuredRuntimeModels,
    inlineProviderModels,
    createStores,
  });
  setPreparedModelRuntimeAuthStore(snapshot, agentFacts.authStore);
  setPreparedModelRuntimeAuthLoader(snapshot, catalogAccess.loadAuth);
  setPreparedModelRuntimeAuthMaterializations(
    snapshot,
    Object.freeze([...getPreparedRuntimeAuthMaterializations(input.agentDir)]),
  );
  return snapshot;
}

async function buildSnapshotBatch(
  candidates: readonly PreparedModelRuntimeBuildCandidate[],
  pluginMetadataSnapshot?: PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"],
  onBuildStats?: (stats: PreparedModelRuntimeBuildStats) => void,
): Promise<PreparedModelRuntimeBuildResult[]> {
  const generations = groupBuildCandidates(candidates, (candidate) => candidate.pluginGeneration);
  const fresh = generations.get(undefined) ?? [];
  // Reusable generations precede fresh ones; preserve first-seen order within each group.
  generations.delete(undefined);
  generations.set(undefined, fresh);
  const groups = [...generations].flatMap(([pluginGeneration, generationCandidates]) =>
    [
      ...groupBuildCandidates(generationCandidates, (candidate) => {
        const workspace = preparedModelRuntimeWorkspaceFactsKey(candidate.input);
        const kind = candidate.prepareInboundPluginRegistry ? "configured" : "dynamic";
        return pluginGeneration ? workspace : `${kind}\0${workspace}`;
      }).values(),
    ].map((groupCandidates) => ({ groupCandidates, pluginGeneration })),
  );
  const preparedInputs = new Map<
    PreparedModelRuntimeInput,
    {
      agentFacts: PreparedModelRuntimeAgentFacts;
      pluginGeneration: PreparedModelRuntimePluginGeneration;
    }
  >();
  const requirePreparedInput = (input: PreparedModelRuntimeInput) => {
    const prepared = preparedInputs.get(input);
    if (!prepared) {
      throw new Error(`prepared model runtime facts missing for ${input.agentDir}`);
    }
    return prepared;
  };
  const loadInboundPluginRegistry = createPreparedInboundRegistryLoader();
  // Config objects can change between publications. Share this projection only
  // inside the current build batch so every later publication reads fresh config.
  const configuredHarnessRuntimesByConfig = new Map<OpenClawConfig, readonly string[]>();
  let runtimePluginMs = 0;
  let pluginMetadataMs = 0;
  let staticProviderCatalogMs = 0;
  let ambientCredentialsMs = 0;
  let agentFactsMs = 0;
  let configuredProjectionMs = 0;
  const workspaceFactsStartedAt = performance.now();
  // Workspace plugin loading and static hooks are intentionally sequential. Large parallel
  // workspace fanout recreates the CPU/RSS spike this generation boundary is meant to contain.
  for (const { groupCandidates, pluginGeneration } of groups) {
    for (const candidate of groupCandidates) {
      assertPreparedModelRuntimeInputCurrent(candidate.input, candidate.isPreparationCurrent);
    }
    const prepareInboundPluginRegistry = groupCandidates.some(
      (candidate) => candidate.prepareInboundPluginRegistry,
    );
    const preferBuiltPluginArtifacts =
      pluginGeneration?.preferBuiltPluginArtifacts ?? prepareInboundPluginRegistry;
    const getConfiguredHarnessRuntimes = () => {
      const config = groupCandidates[0]!.input.config;
      let runtimes = configuredHarnessRuntimesByConfig.get(config);
      if (!runtimes) {
        runtimes = collectConfiguredAgentHarnessRuntimes(config);
        configuredHarnessRuntimesByConfig.set(config, runtimes);
      }
      return runtimes;
    };
    // Owners publish the curated build; live discovery belongs to the catalog worker.
    const prepared = await prepareWorkspaceBuildGroup(
      groupCandidates.map(({ input }) => input),
      "static",
      {
        preferBuiltPluginArtifacts,
        getConfiguredHarnessRuntimes,
      },
      prepareInboundPluginRegistry ? loadInboundPluginRegistry : undefined,
      pluginGeneration,
      pluginMetadataSnapshot,
    );
    assertPreparedModelRuntimeCandidatesCurrent(groupCandidates);
    runtimePluginMs += prepared.buildStats.runtimePluginMs;
    pluginMetadataMs += prepared.buildStats.pluginMetadataMs;
    staticProviderCatalogMs += prepared.buildStats.staticProviderCatalogMs;
    ambientCredentialsMs += prepared.buildStats.ambientCredentialsMs;
    agentFactsMs += prepared.buildStats.agentFactsMs;
    configuredProjectionMs += prepared.buildStats.configuredProjectionMs;
    for (const agentFacts of prepared.agentFacts) {
      preparedInputs.set(agentFacts.input, {
        agentFacts,
        pluginGeneration: prepared.pluginGeneration,
      });
    }
  }
  const workspaceFactsMs = performance.now() - workspaceFactsStartedAt;
  const preparedCatalogs = new Map<PreparedModelRuntimeInput, PreparedModelRuntimeCatalogFacts>();
  let runtimeRegistryCount = 0;
  const registryStartedAt = performance.now();
  for (const { groupCandidates } of groups) {
    assertPreparedModelRuntimeCandidatesCurrent(groupCandidates);
    const { pluginGeneration } = requirePreparedInput(groupCandidates[0]!.input);
    const batch = prepareConfiguredRuntimeFactsBatch({
      agentFacts: groupCandidates.map(({ input }) => requirePreparedInput(input).agentFacts),
      pluginGeneration,
    });
    runtimeRegistryCount += batch.registryCount;
    for (const [input, catalogFacts] of batch.catalogs) {
      preparedCatalogs.set(input, catalogFacts);
    }
    assertPreparedModelRuntimeCandidatesCurrent(groupCandidates);
  }
  const registryMs = performance.now() - registryStartedAt;
  const preparedAgentFacts = [...preparedInputs.values()].map(({ agentFacts }) => agentFacts);
  const configuredRuntimeModelCount = [...preparedCatalogs.values()].reduce(
    (count, facts) => count + facts.configuredRuntimeModels.length,
    0,
  );
  const generatedCatalogPluginCount = new Set(
    preparedAgentFacts.flatMap((facts) => facts.configuredGeneratedCatalogPluginIds),
  ).size;
  const generatedCatalogReadCount = preparedAgentFacts.reduce(
    (count, facts) => count + facts.configuredGeneratedCatalogPluginIds.length,
    0,
  );
  onBuildStats?.({
    agentCount: candidates.length,
    workspaceGroupCount: groups.length,
    configuredFactsGroupCount: groups.length,
    credentialGroupCount: new Set(
      preparedAgentFacts.map(({ credentials }) => fingerprintPreparedRuntimeFacts(credentials)),
    ).size,
    runtimeRegistryCount,
    configuredRuntimeModelCount,
    generatedCatalogPluginCount,
    generatedCatalogReadCount,
    workspaceFactsMs,
    runtimePluginMs,
    pluginMetadataMs,
    staticProviderCatalogMs,
    ambientCredentialsMs,
    agentFactsMs,
    configuredProjectionMs,
    registryMs,
    fullCatalogConcurrencyLimit: MAX_CONCURRENT_FULL_MODEL_CATALOG_BUILDS,
  });
  assertPreparedModelRuntimeCandidatesCurrent(candidates);
  return candidates.map((candidate) => {
    const { input } = candidate;
    const { agentFacts, pluginGeneration } = requirePreparedInput(input);
    const catalogFacts = preparedCatalogs.get(input);
    if (!catalogFacts) {
      throw new Error(`prepared model runtime snapshot facts missing for ${input.agentDir}`);
    }
    const catalogAccess = createFullModelCatalogAccess({
      agentFacts,
      pluginGeneration,
      isCurrent: candidate.isGenerationCurrent ?? (() => false),
    });
    return {
      snapshot: createSnapshot(
        candidate.catalogOwner,
        agentFacts,
        pluginGeneration,
        catalogFacts,
        catalogAccess,
      ),
      pluginGeneration,
      close: catalogAccess.close,
    };
  });
}

export function startSerializedSnapshotBuildBatch(
  candidates: readonly PreparedModelRuntimeBuildCandidate[],
  agentBuildCompletions: Map<string, Promise<void>>,
  buildTimeoutMs: number,
  onBuildStats?: (stats: PreparedModelRuntimeBuildStats) => void,
  pluginMetadataSnapshot?: PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"],
): {
  pending: Promise<PreparedModelRuntimeBuildResult[]>;
  completion: Promise<void>;
} {
  const agentDirs = [...new Set(candidates.map(({ input }) => input.agentDir))];
  const previousBuildCompletions = agentDirs
    .map((agentDir) => agentBuildCompletions.get(agentDir))
    .filter((completion) => completion !== undefined);
  // Lifecycle events may overlap. The timeout covers queueing plus this build, while completion
  // follows the real work so a timed-out generation can never overlap a replacement.
  const startBuild = (async () => {
    if (previousBuildCompletions.length > 0) {
      await Promise.all(previousBuildCompletions);
    }
    return {
      actualBuild: buildSnapshotBatch(candidates, pluginMetadataSnapshot, onBuildStats),
    };
  })();
  const completion = startBuild
    .then(({ actualBuild }) => actualBuild)
    .then(
      () => undefined,
      () => undefined,
    );
  for (const agentDir of agentDirs) {
    agentBuildCompletions.set(agentDir, completion);
    void completion.then(() => {
      if (agentBuildCompletions.get(agentDir) === completion) {
        agentBuildCompletions.delete(agentDir);
      }
    });
  }
  return {
    pending: runAbortableTimeout(
      async () => (await startBuild).actualBuild,
      buildTimeoutMs,
      "prepared model runtime publication",
    ),
    completion,
  };
}
