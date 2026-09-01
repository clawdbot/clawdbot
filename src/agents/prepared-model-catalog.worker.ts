/** Worker-thread entrypoint for complete model-catalog discovery. */
import { parentPort, workerData } from "node:worker_threads";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  copyConfigResolutionFacts,
  restoreConfigResolutionFacts,
} from "../config/resolution-facts.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { restorePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { resolveRuntimeSyntheticAuthProviderRefs } from "../plugins/synthetic-auth.runtime.js";
import {
  resolveAgentCredentialMapFromStore,
  resolveUsableAgentCredentialModes,
} from "./agent-auth-credentials.js";
import { resolveAmbientAgentCredentialsForDiscovery } from "./agent-auth-discovery.js";
import { overlayExternalAuthProfiles } from "./auth-profiles/external-auth.js";
import { listExternalCliSyncProviderIds } from "./auth-profiles/external-cli-sync.js";
import { mergeRuntimeExternalProfileReferences } from "./auth-profiles/runtime-external-profile-references.js";
import { replaceRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  preserveResolvedSecretBackedCredentials,
} from "./auth-profiles/store.js";
import {
  fingerprintPreparedModelCatalogGeneration,
  type PreparedModelCatalogWorkerInput,
  type PreparedModelWorkerRequest,
  type PreparedModelWorkerResult,
} from "./prepared-model-catalog-worker.js";
import { scopeSyntheticAuthProviderRefs } from "./prepared-model-runtime.synthetic-auth.js";
import { AuthStorage } from "./sessions/auth-storage.js";

function refreshAuthStore(params: {
  agentDir: string;
  inheritedAuthDir?: string;
  authStore: PreparedModelCatalogWorkerInput["authStore"];
  config: PreparedModelCatalogWorkerInput["input"]["config"];
  env: NodeJS.ProcessEnv;
  profileIds?: readonly string[];
  providerIds?: readonly string[];
  pluginGeneration: Awaited<
    ReturnType<(typeof import("./prepared-model-runtime.facts.js"))["prepareWorkspaceBuildGroup"]>
  >["pluginGeneration"];
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
  const prepared = mergeRuntimeExternalProfileReferences({
    next: durable,
    existing: params.authStore,
  });
  return withPluginRuntimeGenerationScope(
    {
      metadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
      pluginRegistry: params.pluginGeneration.pluginRegistry,
    },
    () =>
      overlayExternalAuthProfiles(prepared, {
        config: params.config,
        env: params.env,
        ...(params.providerIds ? { externalCliProviderIds: params.providerIds } : {}),
        ...(params.profileIds ? { externalCliProfileIds: params.profileIds } : {}),
        allowKeychainPrompt: false,
      }),
  );
}

async function prepareWorkerGeneration(value: PreparedModelCatalogWorkerInput) {
  // Restore the captured pair before discovery, including known-empty facts and shared identity.
  // Without loader facts, decoded literal strings can be reparsed as references.
  restoreConfigResolutionFacts(value.input.config, value.configResolutionFacts);
  if (value.sourceConfigResolutionFacts === value.configResolutionFacts) {
    copyConfigResolutionFacts(value.input.config, value.sourceConfigForSecrets);
  } else {
    restoreConfigResolutionFacts(value.sourceConfigForSecrets, value.sourceConfigResolutionFacts);
  }
  setRuntimeConfigSnapshot(value.input.config, value.sourceConfigForSecrets);
  const { prepareWorkspaceBuildGroup } = await import("./prepared-model-runtime.facts.js");
  // Rediscovery under agent workspaces or runtime activation overlays loses the owner's
  // metadata generation. Transfer its facts and restore only process-local behavior.
  const metadata = restorePluginMetadataSnapshot(value.pluginMetadataSnapshot);
  const prepared = await prepareWorkspaceBuildGroup(
    [value.input],
    "live",
    {},
    undefined,
    undefined,
    metadata,
  );
  const agentFacts = prepared.agentFacts[0];
  if (!agentFacts) {
    throw new Error("prepared model catalog worker produced no agent facts");
  }
  const reconstructedFingerprint = fingerprintPreparedModelCatalogGeneration({
    input: value.input,
    sourceConfigForSecrets: value.sourceConfigForSecrets,
    configResolutionFacts: value.configResolutionFacts,
    sourceConfigResolutionFacts: value.sourceConfigResolutionFacts,
    authStore: value.authStore,
    providerIds: value.providerIds,
    pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
  });
  if (reconstructedFingerprint !== value.generationFingerprint) {
    throw new Error("prepared model catalog worker reconstructed a different runtime generation");
  }
  return { agentFacts, pluginGeneration: prepared.pluginGeneration };
}

export async function runPreparedModelCatalogWorkerRequest(
  value: PreparedModelCatalogWorkerInput,
  request: PreparedModelWorkerRequest,
  preparedGeneration = prepareWorkerGeneration(value),
): Promise<PreparedModelWorkerResult> {
  try {
    const prepared = await preparedGeneration;
    if (request.kind === "auth-refresh") {
      const authStore = refreshAuthStore({
        agentDir: value.input.agentDir,
        inheritedAuthDir: value.input.inheritedAuthDir,
        authStore: value.authStore,
        config: value.input.config,
        env: value.input.env ?? process.env,
        ...(request.profileIds ? { profileIds: request.profileIds } : {}),
        providerIds: request.providerIds,
        pluginGeneration: prepared.pluginGeneration,
      });
      return {
        status: "ok",
        requestId: request.requestId,
        kind: "auth-refresh",
        generationFingerprint: value.generationFingerprint,
        authStore,
        authModes: resolveUsableAgentCredentialModes(
          resolveAgentCredentialMapFromStore(authStore, { config: value.input.config }),
        ),
      };
    }
    const { prepareAgentCatalogSource } = await import("./prepared-model-runtime.facts.js");
    const { prepareFullCatalogFacts } = await import("./prepared-model-runtime.full-catalog.js");
    // Full discovery is one point-in-time operation: refresh first, then let every provider hook
    // and the returned availability projection consume the same exact store.
    const authStore = refreshAuthStore({
      agentDir: value.input.agentDir,
      inheritedAuthDir: value.input.inheritedAuthDir,
      authStore: value.authStore,
      config: value.input.config,
      env: value.input.env ?? process.env,
      providerIds: listExternalCliSyncProviderIds(),
      pluginGeneration: prepared.pluginGeneration,
    });
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir: value.input.agentDir, store: authStore }]);
    const pluginGenerationScope = {
      metadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
      pluginRegistry: prepared.pluginGeneration.pluginRegistry,
    };
    const resolveSyntheticCredentials = (providerIds: readonly string[]) =>
      withPluginRuntimeGenerationScope(pluginGenerationScope, () =>
        resolveAmbientAgentCredentialsForDiscovery({
          config: value.input.config,
          env: value.input.env,
          authoritativeSyntheticAuthProviderRefs:
            prepared.pluginGeneration.pluginMetadataSnapshot.owners.cliBackends.keys(),
          syntheticAuthProviderRefs: scopeSyntheticAuthProviderRefs(
            resolveRuntimeSyntheticAuthProviderRefs(),
            providerIds,
          ),
          ...(value.input.workspaceDir ? { workspaceDir: value.input.workspaceDir } : {}),
        }),
      );
    const ambientCredentials = resolveSyntheticCredentials(value.providerIds);
    const startupProviderIds = new Set(value.providerIds.map(normalizeProviderId));
    const credentials = {
      ...ambientCredentials,
      ...resolveAgentCredentialMapFromStore(authStore, { config: value.input.config }),
    };
    const exactAgentFacts = {
      ...prepared.agentFacts,
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
    // Full discovery can publish routes absent from startup config. Pair those exact rows with
    // provider-owned synthetic auth before the catalog and auth modes cross the worker boundary.
    const catalogCredentials = resolveSyntheticCredentials(
      [...facts.modelCatalog.entries, ...facts.modelCatalog.routeVariants]
        .map((entry) => entry.provider)
        .filter((provider) => !startupProviderIds.has(normalizeProviderId(provider))),
    );
    return {
      status: "ok",
      requestId: request.requestId,
      kind: "catalog",
      generationFingerprint: value.generationFingerprint,
      snapshot: facts.modelCatalog,
      authStore,
      authModes: resolveUsableAgentCredentialModes({ ...catalogCredentials, ...credentials }),
    };
  } catch (error) {
    return {
      status: "failed",
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

if (parentPort) {
  const send: (message: PreparedModelWorkerResult) => void =
    parentPort.postMessage.bind(parentPort);
  const value = workerData as PreparedModelCatalogWorkerInput;
  const preparedGeneration = prepareWorkerGeneration(value);
  let queue = Promise.resolve();
  parentPort.on("message", (request: PreparedModelWorkerRequest) => {
    queue = queue.then(async () => {
      send(await runPreparedModelCatalogWorkerRequest(value, request, preparedGeneration));
    });
  });
}
