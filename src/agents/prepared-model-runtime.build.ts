import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import pLimit from "p-limit";
import { runAbortableTimeout } from "../node-host/with-timeout.js";
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
type PreparedModelRuntimeBuildGuards =
  | ReadonlyMap<PreparedModelRuntimeInput, () => boolean>
  | (() => boolean);

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
  guards: PreparedModelRuntimeBuildGuards,
): void {
  const isCurrent = typeof guards === "function" ? guards : guards.get(input);
  if (isCurrent && !isCurrent()) {
    throw new PreparedModelRuntimePublicationSupersededError(
      `prepared model runtime publication was superseded for ${input.agentDir}`,
    );
  }
}

function assertPreparedModelRuntimeInputsCurrent(
  inputs: readonly PreparedModelRuntimeInput[],
  guards: PreparedModelRuntimeBuildGuards,
): void {
  for (const input of inputs) {
    assertPreparedModelRuntimeInputCurrent(input, guards);
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
            fullCatalog = catalog;
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
  const createStores = (): PreparedModelRuntimeStores => {
    // Runtime API keys and session extensions mutate these objects. Fork them per run while the
    // credential map and parsed catalog remain owned by the lifecycle snapshot.
    const authStorage = AuthStorage.inMemory(credentials);
    return { authStorage, modelRegistry: templateModelRegistry.fork(authStorage) };
  };
  const snapshot: PreparedModelRuntimeSnapshot = Object.freeze({
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
  inputs: readonly PreparedModelRuntimeInput[],
  catalogMode: PreparedModelRuntimeCatalogMode,
  agentBuildCompletions: Map<string, Promise<void>>,
  generationGuards: ReadonlyMap<PreparedModelRuntimeInput, () => boolean>,
  buildGuards: PreparedModelRuntimeBuildGuards,
  inboundPluginRegistryInputs: ReadonlySet<PreparedModelRuntimeInput>,
  reusablePluginGenerations: ReadonlyMap<
    PreparedModelRuntimeInput,
    PreparedModelRuntimePluginGeneration
  >,
  pluginMetadataSnapshot?: PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"],
  onBuildStats?: (stats: PreparedModelRuntimeBuildStats) => void,
): Promise<PreparedModelRuntimeBuildResult[]> {
  const freshGroups = new Map<string, PreparedModelRuntimeInput[]>();
  const reusableGroups = new Map<
    PreparedModelRuntimePluginGeneration,
    PreparedModelRuntimeInput[]
  >();
  for (const input of inputs) {
    const reusablePluginGeneration = reusablePluginGenerations.get(input);
    if (reusablePluginGeneration) {
      const group = reusableGroups.get(reusablePluginGeneration);
      if (group) {
        group.push(input);
      } else {
        reusableGroups.set(reusablePluginGeneration, [input]);
      }
      continue;
    }
    const ownerKind = inboundPluginRegistryInputs.has(input) ? "configured" : "dynamic";
    const key = `${ownerKind}\0${preparedModelRuntimeWorkspaceFactsKey(input)}`;
    const group = freshGroups.get(key);
    if (group) {
      group.push(input);
    } else {
      freshGroups.set(key, [input]);
    }
  }
  const groups: Array<{
    groupInputs: PreparedModelRuntimeInput[];
    pluginGeneration?: PreparedModelRuntimePluginGeneration;
  }> = [
    ...[...reusableGroups].map(([pluginGeneration, groupInputs]) => ({
      groupInputs,
      pluginGeneration,
    })),
    ...[...freshGroups.values()].map((groupInputs) => ({ groupInputs })),
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
  for (const { groupInputs, pluginGeneration } of groups) {
    if (typeof buildGuards === "function") {
      assertPreparedModelRuntimeInputsCurrent(groupInputs, buildGuards);
    }
    const prepareInboundPluginRegistry = groupInputs.some((input) =>
      inboundPluginRegistryInputs.has(input),
    );
    const preferBuiltPluginArtifacts =
      pluginGeneration?.preferBuiltPluginArtifacts ?? prepareInboundPluginRegistry;
    const prepared = await prepareWorkspaceBuildGroup(
      groupInputs,
      catalogMode,
      { preferBuiltPluginArtifacts },
      prepareInboundPluginRegistry ? loadInboundPluginRegistry : undefined,
      pluginGeneration,
      pluginMetadataSnapshot,
    );
    assertPreparedModelRuntimeInputsCurrent(groupInputs, buildGuards);
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
    const sourceInputsByAgentDir = new Map<string, PreparedModelRuntimeInput[]>();
    for (const input of inputs) {
      const group = sourceInputsByAgentDir.get(input.agentDir);
      if (group) {
        group.push(input);
      } else {
        sourceInputsByAgentDir.set(input.agentDir, [input]);
      }
    }
    const sourceErrors: unknown[] = [];
    const sourceBuild = await runTasksWithConcurrency({
      limit: MAX_CONCURRENT_MODEL_RUNTIME_AGENT_SOURCE_BUILDS,
      errorMode: "stop",
      onTaskError: (error) => {
        sourceErrors.push(error);
      },
      tasks: [...sourceInputsByAgentDir.values()].map((sourceInputs) => async () => {
        // Generated catalogs are agent-directory owned. Preserve write serialization within one
        // directory while allowing bounded progress across distinct agents.
        for (const input of sourceInputs) {
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
          assertPreparedModelRuntimeInputCurrent(input, buildGuards);
          const catalogSource = await prepareAgentCatalogSource(
            prepared,
            pluginGeneration,
            catalogMode,
          );
          assertPreparedModelRuntimeInputCurrent(input, buildGuards);
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
    for (const input of inputs) {
      const agentFacts = preparedInputs.get(input);
      const pluginGeneration = pluginGenerations.get(input);
      if (!agentFacts || !pluginGeneration) {
        throw new Error(`prepared model runtime facts missing for ${input.agentDir}`);
      }
      const catalogSource = catalogSources.get(input);
      if (!catalogSource) {
        throw new Error(`prepared model runtime catalog source missing for ${input.agentDir}`);
      }
      assertPreparedModelRuntimeInputCurrent(input, buildGuards);
      preparedCatalogs.set(
        input,
        await prepareFullCatalogFacts(agentFacts, pluginGeneration, catalogMode, catalogSource),
      );
      assertPreparedModelRuntimeInputCurrent(input, buildGuards);
      runtimeRegistryCount += 1;
    }
  } else {
    for (const { groupInputs } of groups) {
      assertPreparedModelRuntimeInputsCurrent(groupInputs, buildGuards);
      const pluginGeneration = pluginGenerations.get(groupInputs[0]!);
      if (!pluginGeneration) {
        throw new Error("prepared model runtime plugin generation is missing");
      }
      const batch = prepareConfiguredRuntimeFactsBatch({
        agentFacts: groupInputs.map((input) => {
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
      assertPreparedModelRuntimeInputsCurrent(groupInputs, buildGuards);
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
    agentCount: inputs.length,
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
    catalogGroupCount: catalogMode === "live" ? inputs.length : 0,
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
  assertPreparedModelRuntimeInputsCurrent(inputs, buildGuards);
  return inputs.map((input) => {
    const agentFacts = preparedInputs.get(input);
    const pluginGeneration = pluginGenerations.get(input);
    const catalogFacts = preparedCatalogs.get(input);
    if (!agentFacts || !pluginGeneration || !catalogFacts) {
      throw new Error(`prepared model runtime snapshot facts missing for ${input.agentDir}`);
    }
    return {
      snapshot: createSnapshot(
        agentFacts,
        pluginGeneration,
        catalogFacts,
        createFullModelCatalogAccess({
          agentFacts,
          pluginGeneration,
          agentBuildCompletions,
          isCurrent: generationGuards.get(input) ?? (() => false),
        }),
      ),
      pluginGeneration,
    };
  });
}

export function startSerializedSnapshotBuildBatch(
  inputs: readonly PreparedModelRuntimeInput[],
  agentBuildCompletions: Map<string, Promise<void>>,
  buildTimeoutMs: number,
  catalogMode: PreparedModelRuntimeCatalogMode = "live",
  onBuildStats?: (stats: PreparedModelRuntimeBuildStats) => void,
  generationGuards: ReadonlyMap<PreparedModelRuntimeInput, () => boolean> = new Map(),
  buildGuards: PreparedModelRuntimeBuildGuards = generationGuards,
  inboundPluginRegistryInputs: ReadonlySet<PreparedModelRuntimeInput> = new Set(),
  reusablePluginGenerations: ReadonlyMap<
    PreparedModelRuntimeInput,
    PreparedModelRuntimePluginGeneration
  > = new Map(),
  pluginMetadataSnapshot?: PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"],
): {
  pending: Promise<PreparedModelRuntimeBuildResult[]>;
  completion: Promise<void>;
} {
  const agentDirs = [...new Set(inputs.map((input) => input.agentDir))];
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
        inputs,
        catalogMode,
        agentBuildCompletions,
        generationGuards,
        buildGuards,
        inboundPluginRegistryInputs,
        reusablePluginGenerations,
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
  input: PreparedModelRuntimeInput,
  agentBuildCompletions: Map<string, Promise<void>>,
  buildTimeoutMs: number,
  catalogMode: PreparedModelRuntimeCatalogMode = "live",
  generationGuard: () => boolean = () => true,
  prepareInboundPluginRegistry = false,
  reusablePluginGeneration?: PreparedModelRuntimePluginGeneration,
  pluginMetadataSnapshot?: PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"],
): {
  pending: Promise<PreparedModelRuntimeBuildResult>;
  completion: Promise<void>;
} {
  const build = startSerializedSnapshotBuildBatch(
    [input],
    agentBuildCompletions,
    buildTimeoutMs,
    catalogMode,
    undefined,
    new Map([[input, generationGuard]]),
    undefined,
    prepareInboundPluginRegistry ? new Set([input]) : undefined,
    reusablePluginGeneration ? new Map([[input, reusablePluginGeneration]]) : undefined,
    pluginMetadataSnapshot,
  );
  return {
    pending: build.pending.then((results) => results[0]!),
    completion: build.completion,
  };
}
