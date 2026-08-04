import { performance } from "node:perf_hooks";
import pLimit from "p-limit";
import { withTimeout } from "../node-host/with-timeout.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  PreparedModelRuntimePublicationSupersededError,
  toPreparedModelRuntimeError,
} from "./prepared-model-runtime.errors.js";
import {
  fingerprintPreparedRuntimeFacts,
  prepareAgentCatalogSource,
  prepareConfiguredRuntimeFactsBatch,
  prepareFullCatalogFacts,
  preparedModelRuntimeWorkspaceFactsKey,
  prepareWorkspaceBuildGroup,
  type PreparedModelRuntimeAgentFacts,
  type PreparedModelRuntimeCatalogFacts,
  type PreparedModelRuntimeCatalogSource,
  type PreparedModelRuntimeWorkspaceFacts,
} from "./prepared-model-runtime.facts.js";
import type {
  PreparedModelRuntimeBuildStats,
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimeInput,
  PreparedModelRuntimeSnapshot,
  PreparedModelRuntimeStores,
} from "./prepared-model-runtime.types.js";
import { AuthStorage } from "./sessions/auth-storage.js";

const MAX_CONCURRENT_MODEL_RUNTIME_AGENT_SOURCE_BUILDS = 2;
const MAX_CONCURRENT_FULL_MODEL_CATALOG_BUILDS = 1;
const limitFullModelCatalogBuild = pLimit(MAX_CONCURRENT_FULL_MODEL_CATALOG_BUILDS);

type PreparedModelRuntimeCatalogAccess = Readonly<{
  loadFullModelCatalog: () => Promise<ModelCatalogSnapshot>;
}>;
type PreparedModelRuntimeBuildGuards =
  | ReadonlyMap<PreparedModelRuntimeInput, () => boolean>
  | (() => boolean);

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
  workspaceFacts: PreparedModelRuntimeWorkspaceFacts;
  agentBuildCompletions: Map<string, Promise<void>>;
  isCurrent: () => boolean;
  eagerCatalog?: ModelCatalogSnapshot;
}): PreparedModelRuntimeCatalogAccess {
  let fullCatalog = params.eagerCatalog;
  let pending: Promise<ModelCatalogSnapshot> | undefined;
  const assertCurrent = () => {
    if (!params.isCurrent()) {
      throw new PreparedModelRuntimePublicationSupersededError(
        `prepared model runtime catalog generation was superseded for ${params.agentFacts.input.agentDir}`,
      );
    }
  };
  return {
    loadFullModelCatalog: () => {
      if (fullCatalog) {
        return Promise.resolve(fullCatalog);
      }
      if (!pending) {
        pending = runSerializedPreparedModelRuntimeTask({
          agentDir: params.agentFacts.input.agentDir,
          agentBuildCompletions: params.agentBuildCompletions,
          isCurrent: params.isCurrent,
          task: async () =>
            await limitFullModelCatalogBuild(async () => {
              // Full inventory belongs to explicit control-plane reads. The generation queue
              // prevents a stale plan from overlapping or following a replacement build.
              assertCurrent();
              const fullCatalogMode: PreparedModelRuntimeCatalogMode = "live";
              const liveWorkspaceFacts = (
                await prepareWorkspaceBuildGroup([params.agentFacts.input], fullCatalogMode)
              ).workspaceFacts;
              assertCurrent();
              // Agent facts remain bound to the published turn generation. Auth mutations advance
              // that owner generation, so these guards reject rather than mixing credential facts.
              const catalogSource = await prepareAgentCatalogSource(
                params.agentFacts,
                liveWorkspaceFacts,
                fullCatalogMode,
                false,
              );
              assertCurrent();
              const facts = await prepareFullCatalogFacts(
                params.agentFacts,
                liveWorkspaceFacts,
                fullCatalogMode,
                catalogSource,
              );
              assertCurrent();
              fullCatalog = facts.modelCatalog;
              return fullCatalog;
            }),
        }).finally(() => {
          pending = undefined;
        });
      }
      return pending;
    },
  };
}

function createSnapshot(
  agentFacts: PreparedModelRuntimeAgentFacts,
  workspaceFacts: PreparedModelRuntimeWorkspaceFacts,
  catalogFacts: PreparedModelRuntimeCatalogFacts,
  catalogAccess: PreparedModelRuntimeCatalogAccess,
): PreparedModelRuntimeSnapshot {
  const { credentials, input } = agentFacts;
  const { mediaCapabilityProviders, messageToolCatalog, pluginMetadataSnapshot, pluginRegistry } =
    workspaceFacts;
  const { configuredRuntimeModels, inlineProviderModels, modelCatalog, templateModelRegistry } =
    catalogFacts;
  const createStores = (): PreparedModelRuntimeStores => {
    // Runtime API keys and session extensions mutate these objects. Fork them per run while the
    // credential map and parsed catalog remain owned by the lifecycle snapshot.
    const authStorage = AuthStorage.inMemory(credentials);
    return { authStorage, modelRegistry: templateModelRegistry.fork(authStorage) };
  };
  return Object.freeze({
    ...(input.agentId ? { agentId: input.agentId } : {}),
    agentDir: input.agentDir,
    activeProjectKeys: [],
    ...(input.inheritedAuthDir ? { inheritedAuthDir: input.inheritedAuthDir } : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    config: input.config,
    metadataSnapshot: pluginMetadataSnapshot,
    allowGatewaySubagentBinding: input.allowGatewaySubagentBinding === true,
    ...(pluginRegistry ? { pluginRegistry } : {}),
    ...(messageToolCatalog ? { messageToolCatalog } : {}),
    ...(mediaCapabilityProviders ? { mediaCapabilityProviders } : {}),
    modelCatalog,
    loadFullModelCatalog: catalogAccess.loadFullModelCatalog,
    configuredRuntimeModels,
    inlineProviderModels,
    createStores,
  });
}

async function buildSnapshotBatch(
  inputs: readonly PreparedModelRuntimeInput[],
  catalogMode: PreparedModelRuntimeCatalogMode,
  agentBuildCompletions: Map<string, Promise<void>>,
  generationGuards: ReadonlyMap<PreparedModelRuntimeInput, () => boolean>,
  buildGuards: PreparedModelRuntimeBuildGuards,
  onBuildStats?: (stats: PreparedModelRuntimeBuildStats) => void,
): Promise<PreparedModelRuntimeSnapshot[]> {
  const groups = new Map<string, PreparedModelRuntimeInput[]>();
  for (const input of inputs) {
    const key = preparedModelRuntimeWorkspaceFactsKey(input);
    const group = groups.get(key);
    if (group) {
      group.push(input);
    } else {
      groups.set(key, [input]);
    }
  }
  const preparedInputs = new Map<PreparedModelRuntimeInput, PreparedModelRuntimeAgentFacts>();
  const workspaceFacts = new Map<string, PreparedModelRuntimeWorkspaceFacts>();
  const workspaceKeys = new Map<PreparedModelRuntimeInput, string>();
  let runtimePluginMs = 0;
  let pluginMetadataMs = 0;
  let staticProviderCatalogMs = 0;
  let ambientCredentialsMs = 0;
  let agentFactsMs = 0;
  let configuredProjectionMs = 0;
  const workspaceFactsStartedAt = performance.now();
  // Workspace plugin loading and static hooks are intentionally sequential. Large parallel
  // workspace fanout recreates the CPU/RSS spike this generation boundary is meant to contain.
  for (const [key, group] of groups) {
    if (typeof buildGuards === "function") {
      assertPreparedModelRuntimeInputsCurrent(group, buildGuards);
    }
    const prepared = await prepareWorkspaceBuildGroup(group, catalogMode);
    assertPreparedModelRuntimeInputsCurrent(group, buildGuards);
    workspaceFacts.set(key, prepared.workspaceFacts);
    runtimePluginMs += prepared.buildStats.runtimePluginMs;
    pluginMetadataMs += prepared.buildStats.pluginMetadataMs;
    staticProviderCatalogMs += prepared.buildStats.staticProviderCatalogMs;
    ambientCredentialsMs += prepared.buildStats.ambientCredentialsMs;
    agentFactsMs += prepared.buildStats.agentFactsMs;
    configuredProjectionMs += prepared.buildStats.configuredProjectionMs;
    for (const agentFacts of prepared.agentFacts) {
      preparedInputs.set(agentFacts.input, agentFacts);
      workspaceKeys.set(agentFacts.input, key);
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
          const workspaceKey = workspaceKeys.get(input);
          const facts = workspaceKey ? workspaceFacts.get(workspaceKey) : undefined;
          if (!prepared) {
            throw new Error(`prepared model runtime agent facts missing for ${input.agentDir}`);
          }
          if (!facts) {
            throw new Error(`prepared model runtime workspace facts missing for ${input.agentDir}`);
          }
          // A replacement waits for this batch's completion. Stop the stale batch before another
          // same-directory write so a superseded generation cannot overwrite catalog state.
          assertPreparedModelRuntimeInputCurrent(input, buildGuards);
          const catalogSource = await prepareAgentCatalogSource(prepared, facts, catalogMode);
          assertPreparedModelRuntimeInputCurrent(input, buildGuards);
          catalogSources.set(input, catalogSource);
        }
      }),
    });
    if (sourceBuild.hasError) {
      // A superseded owner is lifecycle control flow. Preserve any genuine in-flight sibling
      // failure so auth refresh diagnostics do not disappear behind that expected cancellation.
      throw toPreparedModelRuntimeError(
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
      const workspaceKey = workspaceKeys.get(input);
      const facts = workspaceKey ? workspaceFacts.get(workspaceKey) : undefined;
      if (!agentFacts || !facts) {
        throw new Error(`prepared model runtime facts missing for ${input.agentDir}`);
      }
      const catalogSource = catalogSources.get(input);
      if (!catalogSource) {
        throw new Error(`prepared model runtime catalog source missing for ${input.agentDir}`);
      }
      assertPreparedModelRuntimeInputCurrent(input, buildGuards);
      preparedCatalogs.set(
        input,
        await prepareFullCatalogFacts(agentFacts, facts, catalogMode, catalogSource),
      );
      assertPreparedModelRuntimeInputCurrent(input, buildGuards);
      runtimeRegistryCount += 1;
    }
  } else {
    for (const [workspaceKey, group] of groups) {
      assertPreparedModelRuntimeInputsCurrent(group, buildGuards);
      const facts = workspaceFacts.get(workspaceKey);
      if (!facts) {
        throw new Error(`prepared model runtime workspace facts missing for ${workspaceKey}`);
      }
      const batch = prepareConfiguredRuntimeFactsBatch({
        agentFacts: group.map((input) => {
          const agentFacts = preparedInputs.get(input);
          if (!agentFacts) {
            throw new Error(`prepared model runtime facts missing for ${input.agentDir}`);
          }
          return agentFacts;
        }),
        workspaceFacts: facts,
      });
      runtimeRegistryCount += batch.registryCount;
      for (const [input, catalogFacts] of batch.catalogs) {
        preparedCatalogs.set(input, catalogFacts);
      }
      assertPreparedModelRuntimeInputsCurrent(group, buildGuards);
    }
  }
  const registryMs = performance.now() - registryStartedAt;
  const preparedAgentFacts = [...preparedInputs.values()];
  const configuredRuntimeModelCount = preparedAgentFacts.reduce(
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
    workspaceGroupCount: groups.size,
    configuredFactsGroupCount: groups.size,
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
    const workspaceKey = workspaceKeys.get(input);
    const facts = workspaceKey ? workspaceFacts.get(workspaceKey) : undefined;
    const catalogFacts = preparedCatalogs.get(input);
    if (!agentFacts || !facts || !catalogFacts) {
      throw new Error(`prepared model runtime snapshot facts missing for ${input.agentDir}`);
    }
    return createSnapshot(
      agentFacts,
      facts,
      catalogFacts,
      createFullModelCatalogAccess({
        agentFacts,
        workspaceFacts: facts,
        agentBuildCompletions,
        isCurrent: generationGuards.get(input) ?? (() => false),
        ...(catalogMode === "live" ? { eagerCatalog: catalogFacts.modelCatalog } : {}),
      }),
    );
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
): {
  pending: Promise<PreparedModelRuntimeSnapshot[]>;
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
    pending: withTimeout(
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
): {
  pending: Promise<PreparedModelRuntimeSnapshot>;
  completion: Promise<void>;
} {
  const build = startSerializedSnapshotBuildBatch(
    [input],
    agentBuildCompletions,
    buildTimeoutMs,
    catalogMode,
    undefined,
    new Map([[input, generationGuard]]),
  );
  return {
    pending: build.pending.then((snapshots) => snapshots[0]!),
    completion: build.completion,
  };
}
