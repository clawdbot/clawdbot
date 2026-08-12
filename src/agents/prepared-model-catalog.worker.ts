/** Worker-thread entrypoint for complete model-catalog discovery. */
import { parentPort, workerData } from "node:worker_threads";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  resolveAgentCredentialMapFromStore,
  resolveUsableAgentCredentialModes,
} from "./agent-auth-credentials.js";
import { resolveAmbientAgentCredentialsForDiscovery } from "./agent-auth-discovery.js";
import { overlayExternalAuthProfiles } from "./auth-profiles/external-auth.js";
import { listExternalCliSyncProviderIds } from "./auth-profiles/external-cli-sync.js";
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

function refreshAuthStore(params: {
  agentDir: string;
  inheritedAuthDir?: string;
  authStore: PreparedModelCatalogWorkerInput["authStore"];
  config: PreparedModelCatalogWorkerInput["input"]["config"];
  env: NodeJS.ProcessEnv;
  providerIds?: readonly string[];
}) {
  const durable = preserveResolvedSecretBackedCredentials({
    next: loadAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
      allowKeychainPrompt: false,
      ...(params.inheritedAuthDir ? { inheritedAuthDir: params.inheritedAuthDir } : {}),
    }),
    existing: params.authStore,
  });
  const persistedProfileIds = new Set(params.authStore.runtimePersistedProfileIds ?? []);
  const externalProfileIds = new Set(params.authStore.runtimeExternalProfileIds ?? []);
  for (const [profileId, credential] of Object.entries(params.authStore.profiles)) {
    if (
      !persistedProfileIds.has(profileId) &&
      !externalProfileIds.has(profileId) &&
      durable.profiles[profileId] === undefined
    ) {
      durable.profiles[profileId] = credential;
    }
  }
  return overlayExternalAuthProfiles(durable, {
    agentDir: params.agentDir,
    config: params.config,
    env: params.env,
    ...(params.providerIds ? { externalCliProviderIds: params.providerIds } : {}),
    allowKeychainPrompt: false,
  });
}

export async function runPreparedModelCatalogWorkerInput(
  value: PreparedModelCatalogWorkerInput | PreparedModelAuthRefreshWorkerInput,
): Promise<PreparedModelWorkerResult> {
  try {
    if (value.kind === "auth-refresh") {
      return {
        status: "ok",
        kind: "auth-refresh",
        generationFingerprint: value.generationFingerprint,
        authStore: refreshAuthStore({
          agentDir: value.agentDir,
          inheritedAuthDir: value.inheritedAuthDir,
          authStore: value.authStore,
          config: value.config,
          env: value.env,
          providerIds: value.providerIds,
        }),
      };
    }
    const { prepareAgentCatalogSource, prepareFullCatalogFacts, prepareWorkspaceBuildGroup } =
      await import("./prepared-model-runtime.facts.js");
    const prepared = await prepareWorkspaceBuildGroup([value.input], "live");
    const agentFacts = prepared.agentFacts[0];
    if (!agentFacts) {
      throw new Error("prepared model catalog worker produced no agent facts");
    }
    const reconstructedFingerprint = fingerprintPreparedModelCatalogGeneration({
      input: value.input,
      authStore: value.authStore,
      providerIds: value.providerIds,
      pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
    });
    if (reconstructedFingerprint !== value.generationFingerprint) {
      throw new Error("prepared model catalog worker reconstructed a different runtime generation");
    }
    // Full discovery is one point-in-time operation: refresh first, then let every provider hook
    // and the returned availability projection consume the same exact store.
    const authStore = refreshAuthStore({
      agentDir: value.input.agentDir,
      inheritedAuthDir: value.input.inheritedAuthDir,
      authStore: value.authStore,
      config: value.input.config,
      env: value.input.env ?? process.env,
      providerIds: listExternalCliSyncProviderIds(),
    });
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir: value.input.agentDir, store: authStore }]);
    const ambientCredentials = withPluginRuntimeRegistryScope(
      prepared.pluginGeneration.pluginRegistry,
      () =>
        resolveAmbientAgentCredentialsForDiscovery({
          config: value.input.config,
          env: value.input.env,
          ...(value.input.workspaceDir ? { workspaceDir: value.input.workspaceDir } : {}),
        }),
    );
    const credentials = {
      ...ambientCredentials,
      ...resolveAgentCredentialMapFromStore(authStore, { config: value.input.config }),
    };
    const exactAgentFacts = {
      ...agentFacts,
      authStore,
      templateAuthStorage: AuthStorage.inMemory(credentials),
      credentials,
      providerIds: [...new Set([...value.providerIds, ...Object.keys(credentials)])].toSorted(
        (left, right) => left.localeCompare(right),
      ),
    };
    const source = await prepareAgentCatalogSource(
      exactAgentFacts,
      prepared.pluginGeneration,
      "live",
      false,
      { authStore },
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
      authStore,
      authModes: resolveUsableAgentCredentialModes(credentials),
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
