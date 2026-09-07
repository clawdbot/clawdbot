/** Runs complete model-catalog discovery outside the Gateway event loop. */
import {
  getConfigResolutionFacts,
  serializeConfigResolutionFacts,
} from "../config/resolution-facts.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { WorkerTaskError, WorkerTaskPool } from "../infra/worker-task-pool.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { captureProviderSyntheticAuthFacts } from "../plugins/provider-runtime.js";
import type { PreparedSyntheticAuthFacts } from "../plugins/provider-synthetic-auth.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { listManifestSyntheticAuthProviderRefs } from "../plugins/synthetic-auth.runtime.js";
import type { PreparedAgentCredentialModes } from "./agent-auth-credential-modes.js";
import { cloneAuthProfileStore } from "./auth-profiles/clone.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  setPreparedModelFullCatalogAuth,
  type PreparedModelRuntimeAuth,
  type PreparedModelRuntimeAuthScope,
} from "./prepared-model-runtime-auth.js";
import type {
  PreparedModelRuntimeAgentFacts,
  PreparedModelRuntimeCatalogFacts,
} from "./prepared-model-runtime.catalog-contract.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import { fingerprintPreparedRuntimeFacts } from "./prepared-model-runtime.facts.js";
import { markPreparedModelCatalogFull } from "./prepared-model-runtime.full-catalog.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";
import type { AuthStorageData } from "./sessions/auth-storage.js";

export type PreparedModelCatalogWorkerInput = Readonly<{
  kind: "catalog";
  generationFingerprint: string;
  input: PreparedModelRuntimeInput & { env: NodeJS.ProcessEnv };
  sourceConfigForSecrets: PreparedModelRuntimeInput["config"];
  configResolutionFacts: ReturnType<typeof serializeConfigResolutionFacts>;
  sourceConfigResolutionFacts: ReturnType<typeof serializeConfigResolutionFacts>;
  authStore: AuthProfileStore;
  providerIds: readonly string[];
  preferBuiltPluginArtifacts: boolean;
  pluginMetadataSnapshot: Omit<PluginMetadataSnapshot, "normalizePluginId">;
}>;

type PreparedModelWorkerCommand =
  | Readonly<{ kind: "catalog" }>
  | Readonly<{
      kind: "auth-refresh";
      profileIds?: readonly string[];
      providerIds: readonly string[];
    }>;

export type PreparedModelWorkerRequest = PreparedModelWorkerCommand &
  Readonly<{ syntheticAuth: PreparedSyntheticAuthFacts }>;

export type PreparedModelWorkerResult =
  | Readonly<{
      status: "ok";
      kind: "catalog";
      generationFingerprint: string;
      snapshot: ModelCatalogSnapshot;
      configuredRuntimeModels: PreparedModelRuntimeCatalogFacts["configuredRuntimeModels"];
      credentials: Readonly<AuthStorageData>;
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

export function fingerprintPreparedModelWorkerRequest(
  input: PreparedModelCatalogWorkerInput,
  request: PreparedModelWorkerRequest,
): string {
  return fingerprintPreparedRuntimeFacts([input.generationFingerprint, request]);
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
  const input: PreparedModelCatalogWorkerInput["input"] = {
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
  loadCatalog: () => Promise<
    Pick<PreparedModelRuntimeCatalogFacts, "modelCatalog" | "configuredRuntimeModels">
  >;
}>;

export function createPreparedModelCatalogWorker(
  params: Parameters<typeof createPreparedModelCatalogWorkerInput>[0] & {
    isCurrent: () => boolean;
    pluginRegistry?: PluginRegistry;
  },
): PreparedModelCatalogWorker {
  const workerInput = createPreparedModelCatalogWorkerInput(params);
  // Parent probes retain the canonical generation; only the worker restores a cloned payload.
  const metadataSnapshot = params.pluginMetadataSnapshot;
  const superseded = () =>
    new PreparedModelRuntimePublicationSupersededError(
      `prepared model runtime catalog generation was superseded for ${workerInput.input.agentDir}`,
    );
  let generationPoll: NodeJS.Timeout | undefined;
  let stoppedError: Error | undefined;
  let expectedFingerprint: string | undefined;
  const captures = new Map<AbortController, Promise<PreparedSyntheticAuthFacts>>();
  const assertCurrent = () => {
    if (stoppedError) {
      throw stoppedError;
    }
    if (!params.isCurrent()) {
      throw superseded();
    }
  };
  let pool: WorkerTaskPool<PreparedModelWorkerRequest, PreparedModelWorkerResult> | undefined;
  const mismatch = (
    message: Extract<PreparedModelWorkerResult, { status: "generation-mismatch" }>,
  ) =>
    new PreparedModelCatalogGenerationMismatchError(
      workerInput.input.agentDir,
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
        workerData: workerInput,
        // Establish state/config environment before worker module initialization reads process.env.
        env: workerInput.input.env,
      },
      validateResult: (message) => {
        assertCurrent();
        if (message.status === "generation-mismatch") {
          // Fence before any successor dispatches: rejecting here closes the pool, so a queued
          // auth or catalog request never runs on the retired worker and rejects with this
          // same typed outcome instead of a generic failure.
          throw mismatch(message);
        }
        if (message.status === "ok" && message.generationFingerprint !== expectedFingerprint) {
          throw new Error("prepared model catalog worker returned a stale generation");
        }
      },
    });
  const stop = async (error: Error) => {
    stoppedError ??= error;
    clearInterval(generationPoll);
    generationPoll = undefined;
    for (const controller of captures.keys()) {
      controller.abort(stoppedError);
    }
    // Native probes live in the parent; drain them before retiring the compute worker.
    await Promise.allSettled(captures.values());
    await pool?.close(stoppedError);
  };
  const request = async (
    command: PreparedModelWorkerCommand,
  ): Promise<Extract<PreparedModelWorkerResult, { status: "ok" }>> => {
    let message: PreparedModelWorkerResult;
    let requestPool: typeof pool;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new WorkerTaskError("worker task timed out", "timeout")),
      PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS,
    );
    try {
      assertCurrent();
      generationPoll ??= setInterval(() => {
        if (!params.isCurrent()) {
          void stop(superseded());
        }
      }, PREPARED_MODEL_CATALOG_WORKER_GENERATION_POLL_MS);
      generationPoll.unref();
      const { input } = workerInput;
      const capture = withPluginRuntimeGenerationScope(
        { metadataSnapshot, pluginRegistry: params.pluginRegistry },
        () =>
          captureProviderSyntheticAuthFacts({
            config: input.config,
            env: input.env,
            workspaceDir: input.workspaceDir,
            providerRefs:
              command.kind === "catalog"
                ? [
                    ...listManifestSyntheticAuthProviderRefs(metadataSnapshot.index),
                    ...workerInput.providerIds,
                  ]
                : [...workerInput.providerIds, ...command.providerIds],
            signal: controller.signal,
          }),
      );
      captures.set(controller, capture);
      let syntheticAuth: PreparedSyntheticAuthFacts;
      try {
        syntheticAuth = await capture;
      } finally {
        captures.delete(controller);
      }
      controller.signal.throwIfAborted();
      const value = { ...command, syntheticAuth };
      requestPool = pool ??= createPool();
      message = await requestPool.run(
        () => {
          assertCurrent();
          expectedFingerprint = fingerprintPreparedModelWorkerRequest(workerInput, value);
          return value;
        },
        { timeoutMs: PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS, signal: controller.signal },
      );
      assertCurrent();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (failure instanceof PreparedModelCatalogGenerationMismatchError) {
        // Keep the generation open, but retire only this request's pool: a delayed rejection
        // from it must not close a replacement already serving the same lifecycle plan.
        if (pool === requestPool) {
          pool = undefined;
        }
        await requestPool?.close(failure);
        throw failure;
      }
      controller.abort(error);
      await stop(failure);
      throw error;
    } finally {
      clearTimeout(timeout);
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
        credentials: message.credentials,
      });
      return { modelCatalog, configuredRuntimeModels: message.configuredRuntimeModels };
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
