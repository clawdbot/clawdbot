/** Worker-thread entrypoint for complete model-catalog discovery. */
import { parentPort, workerData } from "node:worker_threads";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  copyConfigResolutionFacts,
  restoreConfigResolutionFacts,
} from "../config/resolution-facts.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { serveWorkerTasks } from "../infra/worker-task-pool.js";
import { listRuntimePluginIdsFromRegistry } from "../plugins/active-runtime-registry.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { isManifestPluginAvailableForControlPlane } from "../plugins/manifest-contract-eligibility.js";
import { restorePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { planRuntimePluginDiscovery } from "../plugins/provider-discovery.js";
import { restorePreparedSyntheticAuthFacts } from "../plugins/provider-synthetic-auth.js";
import { manifestPluginResolvesRuntimeModelCatalogAugment } from "../plugins/providers.js";
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
import { resolveImplicitProviderDiscoveryScope } from "./models-config.providers.discovery-scope.js";
import {
  fingerprintPreparedModelCatalogGeneration,
  fingerprintPreparedModelWorkerRequest,
  type PreparedModelCatalogWorkerInput,
  type PreparedModelWorkerRequest,
  type PreparedModelWorkerResult,
} from "./prepared-model-catalog-worker.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";
import { scopeSyntheticAuthProviderRefs } from "./prepared-model-runtime.synthetic-auth.js";
import { loadAgentRuntimePluginRegistryHandle } from "./runtime-plugins.js";
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
  // metadata generation. Its source/built artifact selection must survive reconstruction too.
  const metadata = restorePluginMetadataSnapshot(value.pluginMetadataSnapshot);
  // Runtime catalog and harness owners declare their role in the prepared manifest snapshot.
  // An empty eligible set stays empty instead of reopening unscoped plugin discovery.
  const normalizedConfig = normalizePluginsConfig(value.input.config.plugins);
  const basePluginIds = metadata.plugins
    .filter(
      (plugin) =>
        (manifestPluginResolvesRuntimeModelCatalogAugment(plugin) ||
          plugin.cliBackends.length > 0 ||
          Boolean(plugin.setup?.cliBackends?.length) ||
          Boolean(plugin.activation?.onAgentHarnesses?.length)) &&
        isManifestPluginAvailableForControlPlane({
          snapshot: metadata,
          plugin,
          config: value.input.config,
          normalizedConfig,
          ...(value.input.env ? { env: value.input.env } : {}),
        }),
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
  const prepared = await prepareWorkspaceBuildGroup(
    [value.input],
    "live",
    { preferBuiltPluginArtifacts: value.preferBuiltPluginArtifacts, basePluginIds },
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
    preferBuiltPluginArtifacts: prepared.pluginGeneration.preferBuiltPluginArtifacts,
    pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
  });
  return { agentFacts, pluginGeneration: prepared.pluginGeneration, reconstructedFingerprint };
}

export async function runPreparedModelCatalogWorkerRequest(
  value: PreparedModelCatalogWorkerInput,
  request: PreparedModelWorkerRequest,
  prepareGeneration = () => prepareWorkerGeneration(value),
): Promise<PreparedModelWorkerResult> {
  try {
    restorePreparedSyntheticAuthFacts(value.input.config, request.syntheticAuth, {
      env: value.input.env,
      workspaceDir: value.input.workspaceDir,
    });
    restorePreparedSyntheticAuthFacts(value.input.config, request.syntheticAuth, {
      workspaceDir: value.input.workspaceDir,
    });
    const generationFingerprint = fingerprintPreparedModelWorkerRequest(value, request);
    const prepared = await prepareGeneration();
    // Every ok reply is cached under the owner's generation. Facts rebuilt under another
    // fingerprint leave only as this typed outcome, so the owner retires the worker instead.
    if (prepared.reconstructedFingerprint !== value.generationFingerprint) {
      return {
        status: "generation-mismatch",
        generationFingerprint: value.generationFingerprint,
        reconstructedFingerprint: prepared.reconstructedFingerprint,
      };
    }
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
        kind: "auth-refresh",
        generationFingerprint,
        authStore,
        authModes: resolveUsableAgentCredentialModes({
          ...resolveSyntheticCredentials(request.providerIds),
          ...resolveAgentCredentialMapFromStore(authStore, { config: value.input.config }),
        }),
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
    const { pluginMetadataSnapshot, pluginRegistry } = prepared.pluginGeneration;
    const discoveryScope = resolveImplicitProviderDiscoveryScope({
      config: value.input.config,
      env: value.input.env,
      workspaceDir: value.input.workspaceDir,
      pluginMetadataSnapshot,
      providerDiscoveryProviderIds: exactAgentFacts.providerIds,
    });
    const discoveryPluginIds = [...(discoveryScope?.keys() ?? [])];
    const discoveryPlan = await withPluginRuntimeGenerationScope(pluginGenerationScope, () =>
      planRuntimePluginDiscovery({
        config: value.input.config,
        env: value.input.env,
        workspaceDir: value.input.workspaceDir,
        pluginMetadataSnapshot,
        onlyPluginIds: discoveryPluginIds,
      }),
    );
    let catalogGeneration = prepared.pluginGeneration;
    if (discoveryPlan.kind === "runtime") {
      // Refresh can reveal credential-only providers absent at startup. Materialize their
      // catalog owners from the captured metadata before binding the authoritative registry.
      const catalogRegistry = loadAgentRuntimePluginRegistryHandle({
        ...value.input,
        metadataSnapshot: pluginMetadataSnapshot,
        preferBuiltPluginArtifacts: value.preferBuiltPluginArtifacts,
        reusableRegistry: pluginRegistry,
        basePluginIds: [
          ...(pluginRegistry ? listRuntimePluginIdsFromRegistry(pluginRegistry) : []),
          ...(discoveryPlan.pluginIds ?? discoveryPluginIds),
        ],
      });
      prepareOwnedPluginLoadContext(
        value.input,
        value.input.env ?? process.env,
        catalogRegistry,
        pluginMetadataSnapshot,
        value.preferBuiltPluginArtifacts,
      );
      pluginGenerationScope.pluginRegistry = catalogRegistry;
      catalogGeneration = Object.freeze({ ...catalogGeneration, pluginRegistry: catalogRegistry });
    }
    const source = await prepareAgentCatalogSource(
      exactAgentFacts,
      catalogGeneration,
      "live",
      false,
      { authStore },
    );
    const facts = await prepareFullCatalogFacts(exactAgentFacts, catalogGeneration, "live", source);
    // Full discovery can publish routes absent from startup config. Pair those exact rows with
    // provider-owned synthetic auth before the catalog and auth modes cross the worker boundary.
    const catalogCredentials = resolveSyntheticCredentials(
      [...facts.modelCatalog.entries, ...facts.modelCatalog.routeVariants]
        .map((entry) => entry.provider)
        .filter((provider) => !startupProviderIds.has(normalizeProviderId(provider))),
    );
    return {
      status: "ok",
      kind: "catalog",
      generationFingerprint,
      snapshot: facts.modelCatalog,
      authStore,
      authModes: resolveUsableAgentCredentialModes({ ...catalogCredentials, ...credentials }),
    };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isWorkerRequest(value: unknown): value is PreparedModelWorkerRequest {
  return (
    isRecord(value) &&
    Array.isArray(value.syntheticAuth) &&
    (value.kind === "catalog" ||
      (value.kind === "auth-refresh" &&
        Array.isArray(value.providerIds) &&
        value.providerIds.every((providerId) => typeof providerId === "string") &&
        (value.profileIds === undefined ||
          (Array.isArray(value.profileIds) &&
            value.profileIds.every((profileId) => typeof profileId === "string")))))
  );
}

if (parentPort) {
  const value = workerData as PreparedModelCatalogWorkerInput;
  let preparedGeneration: ReturnType<typeof prepareWorkerGeneration> | undefined;
  serveWorkerTasks((request) => {
    if (!isWorkerRequest(request)) {
      throw new Error("invalid prepared model catalog worker request");
    }
    return runPreparedModelCatalogWorkerRequest(
      value,
      request,
      () => (preparedGeneration ??= prepareWorkerGeneration(value)),
    );
  });
}
