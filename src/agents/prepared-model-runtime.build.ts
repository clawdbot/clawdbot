import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import pLimit from "p-limit";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runAbortableTimeout } from "../node-host/with-timeout.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import { prepareModelCatalogThinkingPolicies } from "../plugins/provider-thinking.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { resolveUsableAgentCredentialModes } from "./agent-auth-credentials.js";
import { collectConfiguredAgentHarnessRuntimes } from "./harness-runtimes.js";
import { augmentPreparedModelCatalogWithAgentHarness } from "./harness/model-catalog.js";
import { createPreparedModelCatalogProviderNormalizer } from "./model-catalog-provider-normalizer.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { resolveModelCatalogIdentityKey } from "./openai-model-routes.js";
import { createPreparedModelCatalogWorker } from "./prepared-model-catalog-worker.js";
import {
  getPreparedModelFullCatalogAuth,
  setPreparedModelFullCatalogAuth,
  type PreparedModelRuntimeAuth,
} from "./prepared-model-runtime-auth.js";
import type {
  PreparedModelRuntimeAgentFacts,
  PreparedModelRuntimeCatalogFacts,
  PreparedModelRuntimeCatalogSource,
} from "./prepared-model-runtime.catalog-contract.js";
import { prepareConfiguredRuntimeFacts } from "./prepared-model-runtime.configured-catalog.js";
import {
  assertPreparedModelRuntimeInputCurrent,
  assertPreparedModelRuntimeCandidatesCurrent,
  PreparedModelRuntimePublicationSupersededError,
} from "./prepared-model-runtime.errors.js";
import {
  fingerprintPreparedRuntimeFacts,
  preparedModelInventoryKey,
  prepareConfiguredRuntimeFactsBatch,
  prepareWorkspaceBuildGroup,
} from "./prepared-model-runtime.facts.js";
import {
  createPreparedModelRuntimeSnapshot,
  type PreparedModelRuntimeCatalogAccess,
  isPreparedModelCatalogFull,
  markPreparedModelCatalogFull,
  materializePreparedModelCatalog,
  prepareFullCatalogFacts,
  prepareModelCatalogPublication,
} from "./prepared-model-runtime.full-catalog.js";
import {
  createPreparedInboundRegistryLoader,
  preparedModelRuntimeWorkspaceFactsKey,
} from "./prepared-model-runtime.inbound-registry.js";
import { createCatalogAttemptReporter } from "./prepared-model-runtime.publication-events.js";
import { prepareAgentCatalogSource } from "./prepared-model-runtime.scoped-catalog.js";
import type {
  PreparedModelRuntimeBuildStats,
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimeInput,
  PreparedModelRuntimeOwner,
  PreparedModelRuntimePluginGeneration,
  PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.types.js";

const MAX_CONCURRENT_MODEL_RUNTIME_AGENT_SOURCE_BUILDS = 2;
const MAX_CONCURRENT_FULL_MODEL_CATALOG_BUILDS = 1;
const limitFullModelCatalogBuild = pLimit(MAX_CONCURRENT_FULL_MODEL_CATALOG_BUILDS);

export type PreparedModelRuntimeBuildCandidate = Readonly<{
  input: PreparedModelRuntimeInput;
  catalogOwner: PreparedModelRuntimeSnapshot["catalogOwner"];
  inventoryOwner?: Pick<PreparedModelRuntimeOwner, "catalogInventory" | "catalogAttemptError">;
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
  catalogFacts: PreparedModelRuntimeCatalogFacts;
  pluginGeneration: PreparedModelRuntimePluginGeneration;
  agentBuildCompletions: Map<string, Promise<void>>;
  isCurrent: () => boolean;
  inventoryOwner: Pick<PreparedModelRuntimeOwner, "catalogInventory" | "catalogAttemptError">;
}): PreparedModelRuntimeCatalogAccess {
  // Retain discovery, not the retired worker or its runtime capability projection.
  const project = (
    catalog: ModelCatalogSnapshot,
    configuredRuntimeModels = params.catalogFacts.configuredRuntimeModels,
  ) => {
    const configured = prepareConfiguredRuntimeFacts({
      agentFacts: params.agentFacts,
      workspaceFacts: params.pluginGeneration,
      templateModelRegistry: params.catalogFacts.templateModelRegistry,
      configuredRuntimeModels,
    }).modelCatalog;
    const current = materializePreparedModelCatalog(
      configured,
      params.agentFacts.runtimeCapabilityModels,
      configuredRuntimeModels,
    );
    const projected = materializePreparedModelCatalog(
      catalog,
      params.agentFacts.runtimeCapabilityModels,
      configuredRuntimeModels,
    );
    projected.entries = dedupeByKey(
      [...projected.entries, ...current.entries],
      resolveModelCatalogIdentityKey,
    );
    projected.routeVariants = dedupeByKey(
      [...projected.routeVariants, ...current.routeVariants],
      (entry) =>
        JSON.stringify([
          resolveModelCatalogIdentityKey(entry),
          entry.api,
          entry.baseUrl,
          entry.nativeRuntime,
        ]),
    );
    prepareModelCatalogThinkingPolicies({
      catalog: projected,
      metadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
      providers: params.pluginGeneration.pluginRegistry?.providers,
    });
    return projected;
  };
  const inventoryKey = preparedModelInventoryKey(params.agentFacts.input);
  const normalizeProvider = createPreparedModelCatalogProviderNormalizer(
    params.pluginGeneration.pluginMetadataSnapshot,
    params.agentFacts.input.config,
    params.agentFacts.env,
  );
  const previousInventory = params.inventoryOwner.catalogInventory;
  const attempt = createCatalogAttemptReporter(params.inventoryOwner, params.isCurrent);
  const pluginFingerprint = resolveInstalledManifestRegistryIndexFingerprint(
    params.pluginGeneration.pluginMetadataSnapshot.index,
  );
  let inventory =
    previousInventory?.key === inventoryKey &&
    previousInventory.pluginFingerprint === pluginFingerprint &&
    isDeepStrictEqual(
      getPreparedModelFullCatalogAuth(previousInventory.catalog)?.credentials,
      params.agentFacts.credentials,
    )
      ? previousInventory
      : undefined;
  let fullCatalog = inventory ? project(inventory.catalog) : undefined;
  if (fullCatalog) {
    if (
      params.pluginGeneration.pluginRegistry?.agentHarnesses.some(
        ({ harness }) => typeof harness.loadModelCatalog === "function",
      )
    ) {
      fullCatalog.authoritative = false;
    } else {
      markPreparedModelCatalogFull(fullCatalog);
    }
  }
  let pending:
    | { source: "inventory" | "worker"; promise: Promise<ModelCatalogSnapshot> }
    | undefined;
  let pendingAuth:
    | {
        key: string;
        promise: Promise<PreparedModelRuntimeAuth>;
      }
    | undefined;
  const assertCurrent = () =>
    assertPreparedModelRuntimeInputCurrent(params.agentFacts.input, params.isCurrent);
  // Construction is lazy: automatic prepared reads do not start a thread. The first explicit
  // request initializes one registry and reuses that exact plugin generation until retirement.
  const worker = createPreparedModelCatalogWorker({
    pluginRegistry: params.pluginGeneration.pluginRegistry,
    agentFacts: params.agentFacts,
    pluginMetadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
    preferBuiltPluginArtifacts: params.pluginGeneration.preferBuiltPluginArtifacts,
    isCurrent: params.isCurrent,
  });
  return {
    isCurrent: params.isCurrent,
    loadAuth: ({ providerIds, profileIds }) => {
      const cacheKey = [providerIds, profileIds ?? []]
        .map((ids) =>
          [...new Set(ids)].toSorted((left, right) => left.localeCompare(right)).join("\0"),
        )
        .join("\0\0");
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
    loadFullModelCatalog: async function loadFullModelCatalog(
      options,
    ): Promise<ModelCatalogSnapshot> {
      assertCurrent();
      if (!options?.refresh && fullCatalog && isPreparedModelCatalogFull(fullCatalog)) {
        return fullCatalog;
      }
      if (options?.refresh && pending?.source === "inventory") {
        await pending.promise;
        return await loadFullModelCatalog(options);
      }
      if (!pending) {
        const retainedCatalog = !options?.refresh ? inventory?.catalog : undefined;
        const build = runSerializedPreparedModelRuntimeTask({
          agentDir: params.agentFacts.input.agentDir,
          agentBuildCompletions: params.agentBuildCompletions,
          isCurrent: params.isCurrent,
          task: async () =>
            await limitFullModelCatalogBuild(async () => {
              // Full inventory belongs to explicit control-plane reads. The generation queue
              // prevents a stale plan from overlapping or following a replacement build.
              assertCurrent();
              const { modelCatalog: workerCatalog, configuredRuntimeModels } = retainedCatalog
                ? {
                    modelCatalog: retainedCatalog,
                    configuredRuntimeModels: params.catalogFacts.configuredRuntimeModels,
                  }
                : await worker.loadCatalog();
              assertCurrent();
              const auth = getPreparedModelFullCatalogAuth(workerCatalog);
              if (!auth) {
                throw new Error("prepared model catalog worker omitted its auth generation");
              }
              const publication = prepareModelCatalogPublication(
                workerCatalog,
                inventory,
                auth,
                normalizeProvider,
              );
              // Provider inventory survives compatible reloads. Native rows and readiness
              // must come from this generation's parent registry before full publication.
              const catalog = markPreparedModelCatalogFull(
                await augmentPreparedModelCatalogWithAgentHarness({
                  input: params.agentFacts.input,
                  snapshot: project(publication.catalog, configuredRuntimeModels),
                  pluginRegistry: params.pluginGeneration.pluginRegistry,
                  isCurrent: params.isCurrent,
                }),
              );
              setPreparedModelFullCatalogAuth(catalog, auth);
              assertCurrent();
              return { catalog, publication };
            }),
        });
        const promise = build
          .then(({ catalog, publication }) => {
            assertCurrent();
            inventory = {
              ...publication,
              key: inventoryKey,
              pluginFingerprint,
            };
            params.inventoryOwner.catalogInventory = inventory;
            fullCatalog = catalog;
            attempt.published();
            return fullCatalog;
          })
          .catch(attempt.failed)
          .finally(() => {
            pending = undefined;
          });
        pending = { source: retainedCatalog ? "inventory" : "worker", promise };
      }
      return pending.promise;
    },
  };
}

async function buildSnapshotBatch(
  candidates: readonly PreparedModelRuntimeBuildCandidate[],
  catalogMode: PreparedModelRuntimeCatalogMode,
  agentBuildCompletions: Map<string, Promise<void>>,
  pluginMetadataSnapshot?: PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"],
  onBuildStats?: (stats: PreparedModelRuntimeBuildStats) => void,
  includeCredentialProviders = catalogMode === "live",
  onStage?: (stage: string) => void,
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
    const prepared = await prepareWorkspaceBuildGroup(
      groupCandidates.map(({ input }) => input),
      catalogMode,
      {
        preferBuiltPluginArtifacts,
        includeCredentialProviders,
        getConfiguredHarnessRuntimes,
        onStage,
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
  const catalogSourceStartedAt = performance.now();
  onStage?.("agent catalog sources");
  const catalogSources = new Map<PreparedModelRuntimeInput, PreparedModelRuntimeCatalogSource>();
  if (catalogMode === "live") {
    const sourceCandidatesByAgentDir = groupBuildCandidates(
      candidates,
      ({ input }) => input.agentDir,
    );
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
          const { agentFacts, pluginGeneration } = requirePreparedInput(input);
          // A replacement waits for this batch's completion. Stop the stale batch before another
          // same-directory write so a superseded generation cannot overwrite catalog state.
          assertPreparedModelRuntimeInputCurrent(input, candidate.isBuildCurrent);
          const catalogSource = await prepareAgentCatalogSource(
            agentFacts,
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
  onStage?.("model registries");
  if (catalogMode === "live") {
    // Explicit live owners still request the complete inventory. Keep those builds sequential
    // instead of multiplying heap and GC pressure when a command names several agents.
    for (const candidate of candidates) {
      const { input } = candidate;
      const { agentFacts, pluginGeneration } = requirePreparedInput(input);
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
    catalogSourceCount:
      catalogMode === "live" ? preparedAgentFacts.filter(({ input }) => !input.readOnly).length : 0,
    credentialGroupCount: new Set(
      preparedAgentFacts.map(({ credentials }) => fingerprintPreparedRuntimeFacts(credentials)),
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
    const { agentFacts, pluginGeneration } = requirePreparedInput(input);
    const catalogFacts = preparedCatalogs.get(input);
    if (!catalogFacts) {
      throw new Error(`prepared model runtime snapshot facts missing for ${input.agentDir}`);
    }
    return {
      snapshot: createPreparedModelRuntimeSnapshot(
        candidate.catalogOwner,
        agentFacts,
        pluginGeneration,
        catalogFacts,
        createFullModelCatalogAccess({
          agentFacts,
          catalogFacts,
          pluginGeneration,
          agentBuildCompletions,
          isCurrent: candidate.isGenerationCurrent ?? (() => false),
          inventoryOwner: candidate.inventoryOwner ?? {},
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
  includeCredentialProviders = catalogMode === "live",
): {
  pending: Promise<PreparedModelRuntimeBuildResult[]>;
  completion: Promise<void>;
} {
  const agentDirs = [...new Set(candidates.map(({ input }) => input.agentDir))];
  let stage = "previous generation completion";
  const previousBuildCompletions = agentDirs
    .map((agentDir) => agentBuildCompletions.get(agentDir))
    .filter((completion) => completion !== undefined);
  // Lifecycle events may overlap. The timeout covers queueing plus this build, while completion
  // follows the real work so a timed-out generation can never overlap a replacement.
  const startBuild = (async () => {
    if (previousBuildCompletions.length > 0) {
      await Promise.all(previousBuildCompletions);
      // Queued publications register while the prior build settles. Recheck them here so a
      // retired owner cannot start expensive workspace preparation ahead of its replacement.
      assertPreparedModelRuntimeCandidatesCurrent(candidates);
    }
    return await buildSnapshotBatch(
      candidates,
      catalogMode,
      agentBuildCompletions,
      pluginMetadataSnapshot,
      onBuildStats,
      includeCredentialProviders,
      (nextStage) => {
        stage = nextStage;
      },
    );
  })();
  const completion = startBuild.then(
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
      () => startBuild,
      buildTimeoutMs,
      () => `prepared model runtime publication (${stage})`,
    ),
    completion,
  };
}
