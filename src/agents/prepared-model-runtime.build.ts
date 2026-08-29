import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import pLimit from "p-limit";
import { runAbortableTimeout } from "../node-host/with-timeout.js";
import { prepareModelCatalogThinkingPolicies } from "../plugins/provider-thinking.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { resolveUsableAgentCredentialModes } from "./agent-auth-credentials.js";
import { getPreparedRuntimeAuthMaterializations } from "./auth-profiles/runtime-materializations.js";
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
  PreparedModelRuntimeCatalogSource,
} from "./prepared-model-runtime.catalog-contract.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import {
  fingerprintPreparedRuntimeFacts,
  prepareAgentCatalogSource,
  prepareConfiguredRuntimeFactsBatch,
  prepareWorkspaceBuildGroup,
} from "./prepared-model-runtime.facts.js";
import { prepareFullCatalogFacts } from "./prepared-model-runtime.full-catalog.js";
import {
  createPreparedInboundRegistryLoader,
  preparedModelRuntimeWorkspaceFactsKey,
} from "./prepared-model-runtime.inbound-registry.js";
import { notifyPreparedModelRuntimePublication } from "./prepared-model-runtime.publication-events.js";
import type {
  PreparedModelRuntimeBuildStats,
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimeInput,
  PreparedModelRuntimePluginGeneration,
  PreparedModelRuntimeSnapshot,
  PreparedModelRuntimeStores,
} from "./prepared-model-runtime.types.js";
import { AuthStorage } from "./sessions/auth-storage.js";

const MAX_CONCURRENT_MODEL_RUNTIME_AGENT_SOURCE_BUILDS = 2;
const MAX_CONCURRENT_FULL_MODEL_CATALOG_BUILDS = 1;
const limitFullModelCatalogBuild = pLimit(MAX_CONCURRENT_FULL_MODEL_CATALOG_BUILDS);

type PreparedModelRuntimeCatalogAccess = Readonly<{
  readFullModelCatalog: () => ModelCatalogSnapshot | undefined;
  loadFullModelCatalog: (options?: { refresh?: boolean }) => Promise<ModelCatalogSnapshot>;
  loadAuth: (scope: PreparedModelRuntimeAuthScope) => Promise<PreparedModelRuntimeAuth>;
}>;
export type PreparedModelRuntimeBuildCandidate = Readonly<{
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
}>;

function runSerializedPreparedModelRuntimeTask<T>(params: {
  agentDir: string;
  agentBuildCompletions: Map<string, Promise<void>>;
  isCurrent: () => boolean;
  task: () => Promise<T>;
}): Promise<T> {
  const previous = params.agentBuildCompletions.get(params.agentDir);
  const pending = (async () => {
    if (previous) {
      await previous;
    }
    // Workspace generations serialize to bound heap growth. Yield before the first and between
    // later builds so queued Gateway accepts and health probes always get an admission turn.
    await yieldToEventLoop();
    if (!params.isCurrent()) {
      throw new PreparedModelRuntimePublicationSupersededError(
        `prepared model runtime catalog generation was superseded for ${params.agentDir}`,
      );
    }
    return await params.task();
  })();
  const completion = pending.then(
    () => undefined,
    () => undefined,
  );
  params.agentBuildCompletions.set(params.agentDir, completion);
  void completion.then(() => {
    if (params.agentBuildCompletions.get(params.agentDir) === completion) {
      params.agentBuildCompletions.delete(params.agentDir);
    }
  });
  return pending;
}

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

function createFullModelCatalogAccess(params: {
  agentFacts: PreparedModelRuntimeAgentFacts;
  pluginGeneration: PreparedModelRuntimePluginGeneration;
  agentBuildCompletions: Map<string, Promise<void>>;
  isCurrent: () => boolean;
}): PreparedModelRuntimeCatalogAccess {
  // The completed catalog is generation-owned. Explicit refresh replaces it only after a
  // successful build, so failed refreshes cannot discard the last verified inventory.
  let fullCatalog: ModelCatalogSnapshot | undefined;
  let pending: Promise<ModelCatalogSnapshot> | undefined;
  let pendingAuth:
    | {
        key: string;
        promise: Promise<PreparedModelRuntimeAuth>;
      }
    | undefined;
  const assertCurrent = () => {
    if (!params.isCurrent()) {
      throw new PreparedModelRuntimePublicationSupersededError(
        `prepared model runtime catalog generation was superseded for ${params.agentFacts.input.agentDir}`,
      );
    }
  };
  // Construction is lazy: automatic prepared reads do not start a thread. The first explicit
  // request initializes one registry and reuses that exact plugin generation until retirement.
  const worker = createPreparedModelCatalogWorker({
    input: createPreparedModelCatalogWorkerInput({
      agentFacts: params.agentFacts,
      pluginMetadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
    }),
    isCurrent: params.isCurrent,
  });
  return {
    loadAuth: ({ providerIds, profileIds }) => {
      const key = [...new Set(providerIds)]
        .toSorted((left, right) => left.localeCompare(right))
        .join("\0");
      const profileKey = [...new Set(profileIds ?? [])]
        .toSorted((left, right) => left.localeCompare(right))
        .join("\0");
      const cacheKey = `${key}\0\0${profileKey}`;
      if (pendingAuth?.key === cacheKey) {
        return pendingAuth.promise;
      }
      const promise = worker
        .loadAuth({ providerIds, ...(profileIds?.length ? { profileIds } : {}) })
        .then((refreshed) => {
          const authModes = {
            ...resolveUsableAgentCredentialModes(params.agentFacts.credentials),
          };
          for (const providerId of providerIds) {
            delete authModes[normalizeProviderId(providerId)];
          }
          Object.assign(authModes, refreshed.authModes);
          return { authStore: refreshed.authStore, authModes: Object.freeze(authModes) };
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
    loadFullModelCatalog: (options) => {
      try {
        assertCurrent();
      } catch (error) {
        return Promise.reject(toStringifiedError(error));
      }
      if (!options?.refresh && fullCatalog) {
        return Promise.resolve(fullCatalog);
      }
      if (!pending) {
        const build = runSerializedPreparedModelRuntimeTask({
          agentDir: params.agentFacts.input.agentDir,
          agentBuildCompletions: params.agentBuildCompletions,
          isCurrent: params.isCurrent,
          task: async () =>
            await limitFullModelCatalogBuild(async () => {
              // Full inventory belongs to explicit control-plane reads. The generation queue
              // prevents a stale plan from overlapping or following a replacement build.
              assertCurrent();
              const catalog = await worker.loadCatalog();
              assertCurrent();
              return catalog;
            }),
        });
        pending = build
          .then((catalog) => {
            prepareModelCatalogThinkingPolicies({
              catalog,
              metadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
              providers: params.pluginGeneration.pluginRegistry?.providers,
            });
            fullCatalog = catalog;
            notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
            return catalog;
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
  const { configuredRuntimeModels, inlineProviderModels, modelCatalog, templateModelRegistry } =
    catalogFacts;
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
    authModes: resolveUsableAgentCredentialModes(credentials),
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
  catalogMode: PreparedModelRuntimeCatalogMode,
  agentBuildCompletions: Map<string, Promise<void>>,
  pluginMetadataSnapshot?: PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"],
  onBuildStats?: (stats: PreparedModelRuntimeBuildStats) => void,
): Promise<PreparedModelRuntimeBuildResult[]> {
  const freshGroups = new Map<string, PreparedModelRuntimeBuildCandidate[]>();
  const reusableGroups = new Map<
    PreparedModelRuntimePluginGeneration,
    PreparedModelRuntimeBuildCandidate[]
  >();
  for (const candidate of candidates) {
    const { input, pluginGeneration: reusablePluginGeneration } = candidate;
    if (reusablePluginGeneration) {
      const group = reusableGroups.get(reusablePluginGeneration);
      if (group) {
        group.push(candidate);
      } else {
        reusableGroups.set(reusablePluginGeneration, [candidate]);
      }
      continue;
    }
    const ownerKind = candidate.prepareInboundPluginRegistry ? "configured" : "dynamic";
    const key = `${ownerKind}\0${preparedModelRuntimeWorkspaceFactsKey(input)}`;
    const group = freshGroups.get(key);
    if (group) {
      group.push(candidate);
    } else {
      freshGroups.set(key, [candidate]);
    }
  }
  const groups: Array<{
    groupCandidates: PreparedModelRuntimeBuildCandidate[];
    pluginGeneration?: PreparedModelRuntimePluginGeneration;
  }> = [
    ...[...reusableGroups].map(([pluginGeneration, groupCandidates]) => ({
      groupCandidates,
      pluginGeneration,
    })),
    ...[...freshGroups.values()].map((groupCandidates) => ({ groupCandidates })),
  ];
  const preparedInputs = new Map<PreparedModelRuntimeInput, PreparedModelRuntimeAgentFacts>();
  const pluginGenerations = new Map<
    PreparedModelRuntimeInput,
    PreparedModelRuntimePluginGeneration
  >();
  const loadInboundPluginRegistry = createPreparedInboundRegistryLoader();
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
    const prepared = await prepareWorkspaceBuildGroup(
      groupCandidates.map(({ input }) => input),
      catalogMode,
      { preferBuiltPluginArtifacts },
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
      preparedInputs.set(agentFacts.input, agentFacts);
      pluginGenerations.set(agentFacts.input, prepared.pluginGeneration);
    }
  }
  const workspaceFactsMs = performance.now() - workspaceFactsStartedAt;
  const catalogSourceStartedAt = performance.now();
  const catalogSources = new Map<PreparedModelRuntimeInput, PreparedModelRuntimeCatalogSource>();
  if (catalogMode === "live") {
    const sourceCandidatesByAgentDir = new Map<string, PreparedModelRuntimeBuildCandidate[]>();
    for (const candidate of candidates) {
      const { input } = candidate;
      const group = sourceCandidatesByAgentDir.get(input.agentDir);
      if (group) {
        group.push(candidate);
      } else {
        sourceCandidatesByAgentDir.set(input.agentDir, [candidate]);
      }
    }
    const sourceErrors: unknown[] = [];
    const sourceBuild = await runTasksWithConcurrency({
      limit: MAX_CONCURRENT_MODEL_RUNTIME_AGENT_SOURCE_BUILDS,
      errorMode: "stop",
      onTaskError: (error) => {
        sourceErrors.push(error);
      },
      tasks: [...sourceCandidatesByAgentDir.values()].map((sourceCandidates) => async () => {
        // Generated catalogs are agent-directory owned. Preserve write serialization within one
        // directory while allowing bounded progress across distinct agents.
        for (const candidate of sourceCandidates) {
          const { input } = candidate;
          const prepared = preparedInputs.get(input);
          const pluginGeneration = pluginGenerations.get(input);
          if (!prepared) {
            throw new Error(`prepared model runtime agent facts missing for ${input.agentDir}`);
          }
          if (!pluginGeneration) {
            throw new Error(
              `prepared model runtime plugin generation missing for ${input.agentDir}`,
            );
          }
          // A replacement waits for this batch's completion. Stop the stale batch before another
          // same-directory write so a superseded generation cannot overwrite catalog state.
          assertPreparedModelRuntimeInputCurrent(input, candidate.isBuildCurrent);
          const catalogSource = await prepareAgentCatalogSource(
            prepared,
            pluginGeneration,
            catalogMode,
          );
          assertPreparedModelRuntimeInputCurrent(input, candidate.isBuildCurrent);
          catalogSources.set(input, catalogSource);
        }
      }),
    });
    if (sourceBuild.hasError) {
      // A superseded owner is lifecycle control flow. Preserve any genuine in-flight sibling
      // failure so auth refresh diagnostics do not disappear behind that expected cancellation.
      throw toStringifiedError(
        sourceErrors.find(
          (error) => !(error instanceof PreparedModelRuntimePublicationSupersededError),
        ) ?? sourceBuild.firstError,
      );
    }
  }
  const catalogSourceMs = performance.now() - catalogSourceStartedAt;
  const preparedCatalogs = new Map<PreparedModelRuntimeInput, PreparedModelRuntimeCatalogFacts>();
  let runtimeRegistryCount = 0;
  const registryStartedAt = performance.now();
  if (catalogMode === "live") {
    // Explicit live owners still request the complete inventory. Keep those builds sequential
    // instead of multiplying heap and GC pressure when a command names several agents.
    for (const candidate of candidates) {
      const { input } = candidate;
      const agentFacts = preparedInputs.get(input);
      const pluginGeneration = pluginGenerations.get(input);
      if (!agentFacts || !pluginGeneration) {
        throw new Error(`prepared model runtime facts missing for ${input.agentDir}`);
      }
      const catalogSource = catalogSources.get(input);
      if (!catalogSource) {
        throw new Error(`prepared model runtime catalog source missing for ${input.agentDir}`);
      }
      assertPreparedModelRuntimeInputCurrent(input, candidate.isBuildCurrent);
      preparedCatalogs.set(
        input,
        await prepareFullCatalogFacts(agentFacts, pluginGeneration, catalogMode, catalogSource),
      );
      assertPreparedModelRuntimeInputCurrent(input, candidate.isBuildCurrent);
      runtimeRegistryCount += 1;
    }
  } else {
    for (const { groupCandidates } of groups) {
      assertPreparedModelRuntimeCandidatesCurrent(groupCandidates);
      const pluginGeneration = pluginGenerations.get(groupCandidates[0]!.input);
      if (!pluginGeneration) {
        throw new Error("prepared model runtime plugin generation is missing");
      }
      const batch = prepareConfiguredRuntimeFactsBatch({
        agentFacts: groupCandidates.map(({ input }) => {
          const agentFacts = preparedInputs.get(input);
          if (!agentFacts) {
            throw new Error(`prepared model runtime facts missing for ${input.agentDir}`);
          }
          return agentFacts;
        }),
        pluginGeneration,
      });
      runtimeRegistryCount += batch.registryCount;
      for (const [input, catalogFacts] of batch.catalogs) {
        preparedCatalogs.set(input, catalogFacts);
      }
      assertPreparedModelRuntimeCandidatesCurrent(groupCandidates);
    }
  }
  const registryMs = performance.now() - registryStartedAt;
  const preparedAgentFacts = [...preparedInputs.values()];
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
    catalogSourceCount:
      catalogMode === "live"
        ? [...preparedInputs.values()].filter(({ input }) => !input.readOnly).length
        : 0,
    credentialGroupCount: new Set(
      [...preparedInputs.values()].map((agentFacts) =>
        fingerprintPreparedRuntimeFacts(agentFacts.credentials),
      ),
    ).size,
    catalogGroupCount: catalogMode === "live" ? candidates.length : 0,
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
    catalogSourceMs,
    registryMs,
    sourceConcurrencyLimit: MAX_CONCURRENT_MODEL_RUNTIME_AGENT_SOURCE_BUILDS,
    fullCatalogConcurrencyLimit: MAX_CONCURRENT_FULL_MODEL_CATALOG_BUILDS,
  });
  assertPreparedModelRuntimeCandidatesCurrent(candidates);
  return candidates.map((candidate) => {
    const { input } = candidate;
    const agentFacts = preparedInputs.get(input);
    const pluginGeneration = pluginGenerations.get(input);
    const catalogFacts = preparedCatalogs.get(input);
    if (!agentFacts || !pluginGeneration || !catalogFacts) {
      throw new Error(`prepared model runtime snapshot facts missing for ${input.agentDir}`);
    }
    return {
      snapshot: createSnapshot(
        candidate.catalogOwner,
        agentFacts,
        pluginGeneration,
        catalogFacts,
        createFullModelCatalogAccess({
          agentFacts,
          pluginGeneration,
          agentBuildCompletions,
          isCurrent: candidate.isGenerationCurrent ?? (() => false),
        }),
      ),
      pluginGeneration,
    };
  });
}

export function startSerializedSnapshotBuildBatch(
  candidates: readonly PreparedModelRuntimeBuildCandidate[],
  agentBuildCompletions: Map<string, Promise<void>>,
  buildTimeoutMs: number,
  catalogMode: PreparedModelRuntimeCatalogMode = "live",
  onBuildStats?: (stats: PreparedModelRuntimeBuildStats) => void,
  pluginMetadataSnapshot?: PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"],
): {
  pending: Promise<PreparedModelRuntimeBuildResult[]>;
  completion: Promise<void>;
} {
  const agentDirs = [...new Set(candidates.map(({ input }) => input.agentDir))];
  const previousBuildCompletions = [
    ...new Set(
      agentDirs
        .map((agentDir) => agentBuildCompletions.get(agentDir))
        .filter((completion): completion is Promise<void> => completion !== undefined),
    ),
  ];
  // Lifecycle events may overlap. The timeout covers queueing plus this build, while completion
  // follows the real work so a timed-out generation can never overlap a replacement.
  const startBuild = (async () => {
    if (previousBuildCompletions.length > 0) {
      await Promise.all(previousBuildCompletions);
    }
    return {
      actualBuild: buildSnapshotBatch(
        candidates,
        catalogMode,
        agentBuildCompletions,
        pluginMetadataSnapshot,
        onBuildStats,
      ),
    };
  })();
  const completion = startBuild
    .then(async ({ actualBuild }) => await actualBuild)
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
      async () => {
        const { actualBuild } = await startBuild;
        return await actualBuild;
      },
      buildTimeoutMs,
      "prepared model runtime publication",
    ),
    completion,
  };
}

export function startSerializedSnapshotBuild(
  candidate: PreparedModelRuntimeBuildCandidate,
  agentBuildCompletions: Map<string, Promise<void>>,
  buildTimeoutMs: number,
  catalogMode: PreparedModelRuntimeCatalogMode = "live",
  pluginMetadataSnapshot?: PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"],
): {
  pending: Promise<PreparedModelRuntimeBuildResult>;
  completion: Promise<void>;
} {
  // Direct builds are current by default; batch callbacks require explicit generation authority.
  const isGenerationCurrent = candidate.isGenerationCurrent ?? (() => true);
  const build = startSerializedSnapshotBuildBatch(
    [
      {
        ...candidate,
        isGenerationCurrent,
        isBuildCurrent: candidate.isBuildCurrent ?? isGenerationCurrent,
      },
    ],
    agentBuildCompletions,
    buildTimeoutMs,
    catalogMode,
    undefined,
    pluginMetadataSnapshot,
  );
  return {
    pending: build.pending.then((results) => results[0]!),
    completion: build.completion,
  };
}
