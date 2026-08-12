/** Runs complete model-catalog discovery outside the Gateway event loop. */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { AuthProfileCredential, AuthProfileStore } from "./auth-profiles/types.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import {
  fingerprintPreparedRuntimeFacts,
  markPreparedModelCatalogFull,
  type PreparedModelRuntimeAgentFacts,
} from "./prepared-model-runtime.facts.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";
import type { AuthStorageData } from "./sessions/auth-storage.js";

export type PreparedModelCatalogWorkerInput = Readonly<{
  generationFingerprint: string;
  input: PreparedModelRuntimeInput;
  authStore: AuthProfileStore;
  credentials: Readonly<AuthStorageData>;
  providerIds: readonly string[];
}>;

export type PreparedModelCatalogWorkerResult =
  | Readonly<{
      status: "ok";
      generationFingerprint: string;
      snapshot: ModelCatalogSnapshot;
    }>
  | Readonly<{ status: "failed"; error: string }>;

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
  credentials: Readonly<AuthStorageData>;
  providerIds: readonly string[];
  pluginMetadataSnapshot: PluginMetadataSnapshot;
}): string {
  return fingerprintPreparedRuntimeFacts({
    input: params.input,
    authStore: params.authStore,
    credentials: params.credentials,
    providerIds: params.providerIds,
    pluginFingerprint: fingerprintPreparedModelCatalogPlugins(params.pluginMetadataSnapshot),
  });
}

function projectWorkerAuthStore(store: AuthProfileStore): AuthProfileStore {
  return {
    ...store,
    profiles: Object.fromEntries(
      Object.entries(store.profiles).map(([profileId, credential]) => {
        // Ref-only profiles still need their descriptor for discovery. Once a matching literal
        // exists, omit the descriptor so the worker receives only the materialized credential.
        const projected = { ...credential } as AuthProfileCredential & Record<string, unknown>;
        if (projected.type === "api_key" && projected.key?.trim()) {
          delete projected.keyRef;
        } else if (projected.type === "token" && projected.token?.trim()) {
          delete projected.tokenRef;
        }
        return [profileId, projected];
      }),
    ),
  };
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
    inheritedAuthDir: source.agentDir,
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
  const authStore = projectWorkerAuthStore(params.agentFacts.authStore);
  const credentials = { ...params.agentFacts.credentials };
  const providerIds = [...params.agentFacts.providerIds];
  return {
    generationFingerprint: fingerprintPreparedModelCatalogGeneration({
      input,
      authStore,
      credentials,
      providerIds,
      pluginMetadataSnapshot: params.pluginMetadataSnapshot,
    }),
    input,
    authStore,
    credentials,
    providerIds,
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

export function runPreparedModelCatalogWorker(params: {
  input: PreparedModelCatalogWorkerInput;
  isCurrent: () => boolean;
}): Promise<ModelCatalogSnapshot> {
  const superseded = () =>
    new PreparedModelRuntimePublicationSupersededError(
      `prepared model runtime catalog generation was superseded for ${params.input.input.agentDir}`,
    );
  if (!params.isCurrent()) {
    return Promise.reject(superseded());
  }

  const workerUrl = resolvePreparedModelCatalogWorkerUrl();
  let worker: Worker;
  try {
    worker = new Worker(workerUrl, {
      workerData: params.input,
      ...(workerUrl.pathname.endsWith(".ts") ? { execArgv: ["--import", "tsx"] } : {}),
      // Establish state/config environment before worker module initialization reads process.env.
      env: { ...process.env, ...params.input.input.env },
    });
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  worker.unref();

  return new Promise<ModelCatalogSnapshot>((resolve, reject) => {
    let settled = false;
    type Outcome =
      | { status: "resolved"; snapshot: ModelCatalogSnapshot }
      | { status: "rejected"; error: Error };
    const settle = (outcome: Outcome, terminate = true) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearInterval(generationPoll);
      worker.removeAllListeners();
      const finish = () => {
        if (outcome.status === "resolved") {
          resolve(markPreparedModelCatalogFull(outcome.snapshot));
        } else {
          reject(outcome.error);
        }
      };
      if (!terminate) {
        finish();
        return;
      }
      void worker.terminate().then(finish, (terminationError: unknown) => {
        const error =
          terminationError instanceof Error
            ? terminationError
            : new Error(String(terminationError));
        reject(
          outcome.status === "rejected"
            ? new AggregateError([outcome.error, error], outcome.error.message)
            : new Error("prepared model catalog worker termination failed", { cause: error }),
        );
      });
    };
    const fail = (error: Error, terminate = true) =>
      settle({ status: "rejected", error }, terminate);
    const timeout = setTimeout(
      () => fail(new Error("prepared model catalog worker timed out")),
      PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS,
    );
    timeout.unref();
    const generationPoll = setInterval(() => {
      if (!params.isCurrent()) {
        fail(superseded());
      }
    }, PREPARED_MODEL_CATALOG_WORKER_GENERATION_POLL_MS);
    generationPoll.unref();

    worker.once("message", (message: PreparedModelCatalogWorkerResult) => {
      if (!params.isCurrent()) {
        fail(superseded());
      } else if (message.status === "failed") {
        fail(new Error(message.error));
      } else if (message.generationFingerprint !== params.input.generationFingerprint) {
        fail(new Error("prepared model catalog worker returned a stale generation"));
      } else {
        settle({ status: "resolved", snapshot: message.snapshot });
      }
    });
    worker.once("error", (error) =>
      fail(error instanceof Error ? error : new Error(String(error))),
    );
    worker.once("exit", (code) =>
      fail(
        new Error(
          `prepared model catalog worker exited with code ${code} before returning a result`,
        ),
        false,
      ),
    );
  });
}
