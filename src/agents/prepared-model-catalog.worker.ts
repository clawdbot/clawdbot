/** Worker-thread entrypoint for complete model-catalog discovery. */
import { parentPort, workerData } from "node:worker_threads";
import { overlayExternalAuthProfiles } from "./auth-profiles/external-auth.js";
import { replaceRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  preserveResolvedSecretBackedCredentials,
} from "./auth-profiles/store.js";
import {
  fingerprintPreparedModelCatalogGeneration,
  type PreparedModelAuthRefreshWorkerInput,
  type PreparedModelCatalogWorkerInput,
  type PreparedModelWorkerResult,
} from "./prepared-model-catalog-worker.js";
import { AuthStorage } from "./sessions/auth-storage.js";

export async function runPreparedModelCatalogWorkerInput(
  value: PreparedModelCatalogWorkerInput | PreparedModelAuthRefreshWorkerInput,
): Promise<PreparedModelWorkerResult> {
  try {
    if (value.kind === "auth-refresh") {
      // Durable profiles may be changed by another CLI process after this generation was built.
      // Reload them before adding current external overlays, while retaining only literals whose
      // unchanged SecretRefs were materialized by the owning generation.
      const authStore = preserveResolvedSecretBackedCredentials({
        next: loadAuthProfileStoreWithoutExternalProfiles(value.agentDir, {
          allowKeychainPrompt: false,
          ...(value.inheritedAuthDir ? { inheritedAuthDir: value.inheritedAuthDir } : {}),
        }),
        existing: value.authStore,
      });
      return {
        status: "ok",
        kind: "auth-refresh",
        generationFingerprint: value.generationFingerprint,
        authStore: overlayExternalAuthProfiles(authStore, {
          config: value.config,
          env: value.env,
          externalCliProviderIds: value.providerIds,
          allowKeychainPrompt: false,
        }),
      };
    }
    const { prepareAgentCatalogSource, prepareFullCatalogFacts, prepareWorkspaceBuildGroup } =
      await import("./prepared-model-runtime.facts.js");
    replaceRuntimeAuthProfileStoreSnapshots([
      { agentDir: value.input.agentDir, store: value.authStore },
    ]);
    const prepared = await prepareWorkspaceBuildGroup([value.input], "live");
    const agentFacts = prepared.agentFacts[0];
    if (!agentFacts) {
      throw new Error("prepared model catalog worker produced no agent facts");
    }
    const exactAgentFacts = {
      ...agentFacts,
      authStore: value.authStore,
      templateAuthStorage: AuthStorage.inMemory({ ...value.credentials }),
      credentials: value.credentials,
      providerIds: [...value.providerIds],
    };
    const reconstructedFingerprint = fingerprintPreparedModelCatalogGeneration({
      input: value.input,
      authStore: value.authStore,
      credentials: value.credentials,
      providerIds: value.providerIds,
      pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
    });
    if (reconstructedFingerprint !== value.generationFingerprint) {
      throw new Error("prepared model catalog worker reconstructed a different runtime generation");
    }
    const source = await prepareAgentCatalogSource(
      exactAgentFacts,
      prepared.pluginGeneration,
      "live",
      false,
      { authStore: value.authStore },
    );
    const facts = await prepareFullCatalogFacts(
      exactAgentFacts,
      prepared.pluginGeneration,
      "live",
      source,
    );
    return {
      status: "ok",
      kind: "catalog",
      generationFingerprint: value.generationFingerprint,
      snapshot: facts.modelCatalog,
    };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

if (parentPort) {
  const send: (message: PreparedModelWorkerResult) => void =
    parentPort.postMessage.bind(parentPort);
  send(
    await runPreparedModelCatalogWorkerInput(
      workerData as PreparedModelCatalogWorkerInput | PreparedModelAuthRefreshWorkerInput,
    ),
  );
}
