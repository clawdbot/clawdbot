/** Runs complete model-catalog discovery outside the Gateway event loop. */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
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
import {
  PreparedModelCatalogGenerationInvalidError,
  PreparedModelRuntimePublicationSupersededError,
} from "./prepared-model-runtime.errors.js";
import { fingerprintPreparedRuntimeFacts } from "./prepared-model-runtime.facts.js";
import { markPreparedModelCatalogFull } from "./prepared-model-runtime.full-catalog.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

export type PreparedModelCatalogWorkerInput = Readonly<{
  kind: "catalog";
  generationFingerprint: string;
  input: PreparedModelRuntimeInput;
  authStore: AuthProfileStore;
  providerIds: readonly string[];
  pluginMetadataSnapshot: Omit<PluginMetadataSnapshot, "normalizePluginId">;
}>;

export type PreparedModelWorkerRequest =
  | Readonly<{ requestId: number; kind: "catalog" }>
  | Readonly<{
      requestId: number;
      kind: "auth-refresh";
      profileIds?: readonly string[];
      providerIds: readonly string[];
    }>;
type PreparedModelWorkerRequestInput =
  | Readonly<{ kind: "catalog" }>
  | Readonly<{
      kind: "auth-refresh";
      profileIds?: readonly string[];
      providerIds: readonly string[];
    }>;

export type PreparedModelWorkerResult =
  | Readonly<{
      status: "ok";
      requestId: number;
      kind: "catalog";
      generationFingerprint: string;
      snapshot: ModelCatalogSnapshot;
      authStore: AuthProfileStore;
      authModes: PreparedAgentCredentialModes;
    }>
  | Readonly<{
      status: "ok";
      requestId: number;
      kind: "auth-refresh";
      generationFingerprint: string;
      authStore: AuthProfileStore;
      authModes: PreparedAgentCredentialModes;
    }>
  | Readonly<{ status: "generation-invalid"; requestId: number; error: string }>
  | Readonly<{ status: "failed"; requestId: number; error: string }>;

// Cold source/plugin loading can take well over a minute. Three minutes preserves exact full-view
// discovery while bounding a wedged provider; expiry rejects and never returns partial results.
const PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS = 180_000;
const PREPARED_MODEL_CATALOG_WORKER_GENERATION_POLL_MS = 25;

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
  authStore: AuthProfileStore;
  providerIds: readonly string[];
  pluginMetadataSnapshot: PluginMetadataSnapshot;
}): string {
  return fingerprintPreparedRuntimeFacts({
    input: params.input,
    authStore: params.authStore,
    providerIds: params.providerIds,
    pluginFingerprint: fingerprintPreparedModelCatalogPlugins(params.pluginMetadataSnapshot),
  });
}

export function createPreparedModelCatalogWorkerInput(params: {
  agentFacts: PreparedModelRuntimeAgentFacts;
  pluginMetadataSnapshot: PluginMetadataSnapshot;
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
  const authStore = cloneAuthProfileStore(params.agentFacts.authStore);
  const providerIds = [...params.agentFacts.providerIds];
  const { normalizePluginId: _normalizePluginId, ...pluginMetadataSnapshot } =
    params.pluginMetadataSnapshot;
  return {
    kind: "catalog",
    generationFingerprint: fingerprintPreparedModelCatalogGeneration({
      input,
      authStore,
      providerIds,
      pluginMetadataSnapshot: params.pluginMetadataSnapshot,
    }),
    input,
    authStore,
    providerIds,
    pluginMetadataSnapshot,
  };
}

function resolvePreparedModelCatalogWorkerUrl(currentModuleUrl = import.meta.url): URL {
  const currentPath = fileURLToPath(currentModuleUrl);
  const normalized = currentPath.replaceAll(path.sep, "/");
  const distMarker = "/dist/";
  const distIndex = normalized.lastIndexOf(distMarker);
  if (distIndex >= 0) {
    const distRoot = currentPath.slice(0, distIndex + distMarker.length);
    return pathToFileURL(path.join(distRoot, "agents", "prepared-model-catalog.worker.js"));
  }
  const extension = path.extname(currentPath) || ".js";
  return new URL(`./prepared-model-catalog.worker${extension}`, currentModuleUrl);
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
  let worker: Worker | undefined;
  let generationPoll: NodeJS.Timeout | undefined;
  let terminalError: Error | undefined;
  let nextRequestId = 1;
  const pending = new Map<
    number,
    {
      timeout: NodeJS.Timeout;
      resolve: (message: Extract<PreparedModelWorkerResult, { status: "ok" }>) => void;
      reject: (error: Error) => void;
    }
  >();

  const rejectPending = (error: Error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  };
  const stop = (error: Error) => {
    terminalError ??= error;
    if (generationPoll) {
      clearInterval(generationPoll);
      generationPoll = undefined;
    }
    const active = worker;
    worker = undefined;
    active?.removeAllListeners();
    rejectPending(error);
    if (active) {
      void active.terminate();
    }
  };
  const ensureWorker = (): Worker => {
    if (terminalError) {
      throw terminalError;
    }
    if (!params.isCurrent()) {
      const error = superseded();
      stop(error);
      throw error;
    }
    if (worker) {
      return worker;
    }
    const workerUrl = resolvePreparedModelCatalogWorkerUrl();
    const active = new Worker(workerUrl, {
      workerData: params.input,
      ...(workerUrl.pathname.endsWith(".ts") ? { execArgv: ["--import", "tsx"] } : {}),
      // Establish state/config environment before worker module initialization reads process.env.
      env: { ...process.env, ...params.input.input.env },
    });
    active.unref();
    active.on("message", (message: PreparedModelWorkerResult) => {
      const request = pending.get(message.requestId);
      if (!request) {
        return;
      }
      pending.delete(message.requestId);
      clearTimeout(request.timeout);
      if (!params.isCurrent()) {
        const error = superseded();
        request.reject(error);
        stop(error);
      } else if (message.status === "generation-invalid") {
        const error = new PreparedModelCatalogGenerationInvalidError(
          `prepared model catalog generation was invalid for ${params.input.input.agentDir}`,
        );
        request.reject(error);
        stop(error);
      } else if (message.status === "failed") {
        request.reject(new Error(message.error));
      } else if (message.generationFingerprint !== params.input.generationFingerprint) {
        const error = new Error("prepared model catalog worker returned a stale generation");
        request.reject(error);
        stop(error);
      } else {
        request.resolve(message);
      }
    });
    active.once("error", (error) =>
      stop(error instanceof Error ? error : new Error(String(error))),
    );
    active.once("exit", (code) => {
      if (worker === active) {
        stop(
          new Error(
            `prepared model catalog worker exited with code ${code} before its generation retired`,
          ),
        );
      }
    });
    worker = active;
    generationPoll = setInterval(() => {
      if (!params.isCurrent()) {
        stop(superseded());
      }
    }, PREPARED_MODEL_CATALOG_WORKER_GENERATION_POLL_MS);
    generationPoll.unref();
    return active;
  };
  const request = (
    value: PreparedModelWorkerRequestInput,
  ): Promise<Extract<PreparedModelWorkerResult, { status: "ok" }>> => {
    let active: Worker;
    try {
      active = ensureWorker();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const requestId = nextRequestId++;
    return new Promise<Extract<PreparedModelWorkerResult, { status: "ok" }>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        stop(new Error("prepared model catalog worker timed out"));
      }, PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS);
      timeout.unref();
      pending.set(requestId, { timeout, resolve, reject });
      active.postMessage({ ...value, requestId } satisfies PreparedModelWorkerRequest, []);
    }).then((message) => {
      if (!params.isCurrent()) {
        throw superseded();
      }
      return message;
    });
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
