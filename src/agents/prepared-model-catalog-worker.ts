/** Runs complete model-catalog discovery outside the Gateway event loop. */
import {
  getConfigResolutionFacts,
  serializeConfigResolutionFacts,
} from "../config/resolution-facts.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PreparedAgentCredentialModes } from "./agent-auth-credential-modes.js";
import { cloneAuthProfileStore } from "./auth-profiles/clone.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  setPreparedModelFullCatalogAuth,
  type PreparedModelRuntimeAuth,
  type PreparedModelRuntimeAuthScope,
} from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeAgentFacts } from "./prepared-model-runtime.catalog-contract.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import { fingerprintPreparedRuntimeFacts } from "./prepared-model-runtime.facts.js";
import { markPreparedModelCatalogFull } from "./prepared-model-runtime.full-catalog.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

export type PreparedModelCatalogWorkerInput = Readonly<{
  kind: "catalog";
  generationFingerprint: string;
  input: PreparedModelRuntimeInput;
  sourceConfigForSecrets: PreparedModelRuntimeInput["config"];
  configResolutionFacts: ReturnType<typeof serializeConfigResolutionFacts>;
  sourceConfigResolutionFacts: ReturnType<typeof serializeConfigResolutionFacts>;
  authStore: AuthProfileStore;
  providerIds: readonly string[];
  preferBuiltPluginArtifacts: boolean;
  pluginMetadataSnapshot: Omit<PluginMetadataSnapshot, "normalizePluginId">;
}>;

export type PreparedModelWorkerRequest =
  | Readonly<{ kind: "catalog" }>
  | Readonly<{
      kind: "auth-refresh";
      profileIds?: readonly string[];
      providerIds: readonly string[];
    }>;

export type PreparedModelWorkerResult =
  | Readonly<{
      status: "ok";
      kind: "catalog";
      generationFingerprint: string;
      snapshot: ModelCatalogSnapshot;
      authStore: AuthProfileStore;
      authModes: PreparedAgentCredentialModes;
    }>
  | Readonly<{
      status: "ok";
      kind: "auth-refresh";
      generationFingerprint: string;
      authStore: AuthProfileStore;
      authModes: PreparedAgentCredentialModes;
    }>
  | Readonly<{
      status: "generation-mismatch";
      generationFingerprint: string;
      reconstructedFingerprint: string;
    }>
  | Readonly<{ status: "failed"; error: string }>;

// Cold source/plugin loading can take well over a minute. Three minutes preserves exact full-view
// discovery while bounding a wedged provider; expiry rejects and never returns partial results.
const PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS = 180_000;
const PREPARED_MODEL_CATALOG_WORKER_GENERATION_POLL_MS = 25;

class PreparedModelCatalogGenerationMismatchError extends Error {
  constructor(
    readonly agentDir: string,
    readonly generationFingerprint: string,
    readonly reconstructedFingerprint: string,
  ) {
    super(
      `prepared model catalog worker reconstructed a different runtime generation for ${agentDir} (owner=${generationFingerprint} worker=${reconstructedFingerprint})`,
    );
    this.name = "PreparedModelCatalogGenerationMismatchError";
  }
}

function fingerprintPreparedModelCatalogPlugins(snapshot: PluginMetadataSnapshot): string {
  return fingerprintPreparedRuntimeFacts({
    config: snapshot.configFingerprint ?? null,
    index: resolveInstalledManifestRegistryIndexFingerprint(snapshot.index),
    pluginIds: snapshot.pluginIds ?? null,
    policy: snapshot.policyHash,
    workspaceDir: snapshot.workspaceDir ?? null,
  });
}

export function fingerprintPreparedModelCatalogGeneration(params: {
  input: PreparedModelRuntimeInput;
  sourceConfigForSecrets: PreparedModelRuntimeInput["config"];
  configResolutionFacts: ReturnType<typeof serializeConfigResolutionFacts>;
  sourceConfigResolutionFacts: ReturnType<typeof serializeConfigResolutionFacts>;
  authStore: AuthProfileStore;
  providerIds: readonly string[];
  preferBuiltPluginArtifacts?: boolean;
  pluginMetadataSnapshot: PluginMetadataSnapshot;
}): string {
  return fingerprintPreparedRuntimeFacts({
    input: params.input,
    sourceConfigForSecrets: params.sourceConfigForSecrets,
    configResolutionFacts: params.configResolutionFacts,
    sourceConfigResolutionFacts: params.sourceConfigResolutionFacts,
    authStore: params.authStore,
    providerIds: params.providerIds,
    preferBuiltPluginArtifacts: params.preferBuiltPluginArtifacts === true,
    pluginFingerprint: fingerprintPreparedModelCatalogPlugins(params.pluginMetadataSnapshot),
  });
}

export function createPreparedModelCatalogWorkerInput(params: {
  agentFacts: PreparedModelRuntimeAgentFacts;
  pluginMetadataSnapshot: PluginMetadataSnapshot;
  preferBuiltPluginArtifacts?: boolean;
}): PreparedModelCatalogWorkerInput {
  const source = params.agentFacts.input;
  // Registries and closures stay process-local. The worker reconstructs them from this exact
  // lifecycle plan and receives only already-materialized auth facts.
  const input: PreparedModelRuntimeInput = {
    ...(source.agentId ? { agentId: source.agentId } : {}),
    agentDir: source.agentDir,
    ...(source.inheritedAuthDir ? { inheritedAuthDir: source.inheritedAuthDir } : {}),
    ...(source.workspaceDir ? { workspaceDir: source.workspaceDir } : {}),
    ...(source.readOnly ? { readOnly: true } : {}),
    skipCredentials: true,
    env: { ...params.agentFacts.env },
    ...(source.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
    ...(source.runtimePluginSelections
      ? { runtimePluginSelections: source.runtimePluginSelections }
      : {}),
    config: source.config,
  };
  // Capture the authored pair now; structured cloning cannot carry process-local Ref provenance.
  const sourceConfigForSecrets = projectConfigOntoRuntimeSourceSnapshot(source.config);
  const configResolutionFacts = serializeConfigResolutionFacts(source.config);
  const sourceConfigResolutionFacts =
    getConfigResolutionFacts(source.config) === getConfigResolutionFacts(sourceConfigForSecrets)
      ? configResolutionFacts
      : serializeConfigResolutionFacts(sourceConfigForSecrets);
  const authStore = cloneAuthProfileStore(params.agentFacts.authStore);
  const providerIds = [...params.agentFacts.providerIds];
  const { normalizePluginId: _normalizePluginId, ...pluginMetadataSnapshot } =
    params.pluginMetadataSnapshot;
  return {
    kind: "catalog",
    generationFingerprint: fingerprintPreparedModelCatalogGeneration({
      input,
      sourceConfigForSecrets,
      configResolutionFacts,
      sourceConfigResolutionFacts,
      authStore,
      providerIds,
      preferBuiltPluginArtifacts: params.preferBuiltPluginArtifacts,
      pluginMetadataSnapshot: params.pluginMetadataSnapshot,
    }),
    input,
    sourceConfigForSecrets,
    configResolutionFacts,
    sourceConfigResolutionFacts,
    authStore,
    providerIds,
    preferBuiltPluginArtifacts: params.preferBuiltPluginArtifacts === true,
    pluginMetadataSnapshot,
  };
}

type PreparedModelCatalogWorker = Readonly<{
  loadAuth: (scope: PreparedModelRuntimeAuthScope) => Promise<PreparedModelRuntimeAuth>;
  loadCatalog: () => Promise<ModelCatalogSnapshot>;
}>;

export function createPreparedModelCatalogWorker(params: {
  input: PreparedModelCatalogWorkerInput;
  isCurrent: () => boolean;
}): PreparedModelCatalogWorker {
  const superseded = () =>
    new PreparedModelRuntimePublicationSupersededError(
      `prepared model runtime catalog generation was superseded for ${params.input.input.agentDir}`,
    );
  let generationPoll: NodeJS.Timeout | undefined;
  const assertCurrent = () => {
    if (!params.isCurrent()) {
      throw superseded();
    }
  };
  let pool: WorkerTaskPool<PreparedModelWorkerRequest, PreparedModelWorkerResult> | undefined;
  const mismatch = (
    message: Extract<PreparedModelWorkerResult, { status: "generation-mismatch" }>,
  ) =>
    new PreparedModelCatalogGenerationMismatchError(
      params.input.input.agentDir,
      message.generationFingerprint,
      message.reconstructedFingerprint,
    );
  const createPool = () =>
    new WorkerTaskPool<PreparedModelWorkerRequest, PreparedModelWorkerResult>({
      workerUrl: resolveRuntimeWorkerUrl({
        currentModuleUrl: import.meta.url,
        sourceWorkerName: "prepared-model-catalog.worker",
        distWorkerPath: "agents/prepared-model-catalog.worker.js",
      }),
      maxWorkers: 1,
      // Recreating this worker would import changed plugin code under the old generation.
      // Only the lifecycle owner may retire it; crashes close the generation permanently.
      idleTimeoutMs: 0,
      restartOnError: false,
      workerOptions: {
        workerData: params.input,
        // Establish state/config environment before worker module initialization reads process.env.
        env: { ...process.env, ...params.input.input.env },
      },
      validateResult: (message) => {
        assertCurrent();
        if (message.status === "generation-mismatch") {
          // Fence before any successor dispatches: rejecting here closes the pool, so a queued
          // auth or catalog request never runs on the retired worker and rejects with this
          // same typed outcome instead of a generic failure.
          throw mismatch(message);
        }
        if (
          message.status === "ok" &&
          message.generationFingerprint !== params.input.generationFingerprint
        ) {
          throw new Error("prepared model catalog worker returned a stale generation");
        }
      },
    });
  const retire = (error: Error) => {
    const closing = pool;
    pool = undefined;
    return closing?.close(error) ?? Promise.resolve();
  };
  const stop = (error: Error) => {
    clearInterval(generationPoll);
    generationPoll = undefined;
    return pool?.close(error) ?? Promise.resolve();
  };
  const request = async (
    value: PreparedModelWorkerRequest,
  ): Promise<Extract<PreparedModelWorkerResult, { status: "ok" }>> => {
    let message: PreparedModelWorkerResult;
    try {
      assertCurrent();
      generationPoll ??= setInterval(() => {
        if (!params.isCurrent()) {
          void stop(superseded());
        }
      }, PREPARED_MODEL_CATALOG_WORKER_GENERATION_POLL_MS);
      generationPoll.unref();
      message = await (pool ??= createPool()).run(
        () => {
          assertCurrent();
          return value;
        },
        { timeoutMs: PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS },
      );
      assertCurrent();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (failure instanceof PreparedModelCatalogGenerationMismatchError) {
        // Facts from another generation are never published as this one, but the generation
        // itself stays open: drop the fenced pool so the next request rebuilds a worker from
        // the same lifecycle plan instead of replaying a cached terminal error.
        await retire(failure);
        throw failure;
      }
      await stop(failure);
      throw error;
    }
    if (message.status === "failed") {
      throw new Error(message.error);
    }
    if (message.status === "generation-mismatch") {
      // validateResult fences this reply before the pool can resolve it.
      throw mismatch(message);
    }
    return message;
  };

  return {
    loadCatalog: async () => {
      const message = await request({ kind: "catalog" });
      if (message.kind !== "catalog") {
        throw new Error("prepared model catalog worker returned an auth refresh result");
      }
      const modelCatalog = markPreparedModelCatalogFull(message.snapshot);
      setPreparedModelFullCatalogAuth(modelCatalog, {
        authStore: message.authStore,
        authModes: message.authModes,
      });
      return modelCatalog;
    },
    loadAuth: async ({ providerIds, profileIds }) => {
      const normalizedProviderIds = [...new Set(providerIds)].toSorted((left, right) =>
        left.localeCompare(right),
      );
      const normalizedProfileIds = profileIds
        ? [...new Set(profileIds)].toSorted((left, right) => left.localeCompare(right))
        : undefined;
      const message = await request({
        kind: "auth-refresh",
        providerIds: normalizedProviderIds,
        ...(normalizedProfileIds ? { profileIds: normalizedProfileIds } : {}),
      });
      if (message.kind !== "auth-refresh") {
        throw new Error("prepared model auth refresh worker returned a catalog result");
      }
      return { authStore: message.authStore, authModes: message.authModes };
    },
  };
}
