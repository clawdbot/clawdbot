/** Request-isolated registry views forked from lifecycle-owned model generations. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import { normalizeDiscoveredAgentModel } from "./agent-model-discovery.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentDir,
  resolveDefaultAgentId,
} from "./agent-scope.js";
import {
  acquireReadOnlyPreparedModelRuntime,
  prepareModelRuntimeSnapshot,
  PreparedModelRuntimeOwnerNotPublishedError,
  type PreparedModelRuntimeInput,
  type PreparedModelRuntimeLease,
} from "./prepared-model-runtime.js";
import { AuthStorage, type ModelRegistry } from "./sessions/index.js";

type LoadPreparedAgentModelRegistryOptions = {
  agentId?: string;
  agentDir?: string;
  loadAvailability?: boolean;
  providerFilter?: string;
  normalizeModels?: boolean;
  skipCredentials?: boolean;
  workspaceDir?: string;
};

function usesCredentialFreeRegistry(options: LoadPreparedAgentModelRegistryOptions): boolean {
  return options.skipCredentials === true || options.loadAvailability === false;
}

function createRegistryView(params: {
  registry: ModelRegistry;
  agentDir: string;
  config: OpenClawConfig;
  providerFilter?: string;
  normalizeModels?: boolean;
  workspaceDir?: string;
}): ModelRegistry {
  const { registry } = params;
  const getAll = registry.getAll.bind(registry);
  const getAvailable = registry.getAvailable.bind(registry);
  const find = registry.find.bind(registry);
  const providerFilter = params.providerFilter ? normalizeProviderId(params.providerFilter) : "";
  const matchesProviderFilter = (entry: Model) =>
    !providerFilter || normalizeProviderId(entry.provider) === providerFilter;
  const shouldNormalize = params.normalizeModels !== false;
  const normalizeEntry = (entry: Model) =>
    shouldNormalize
      ? normalizeDiscoveredAgentModel(entry, params.agentDir, {
          config: params.config,
          ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
        })
      : entry;
  let normalizedAll: Model[] | undefined;
  let normalizedAvailable: Model[] | undefined;
  const loadNormalizedAll = () => (normalizedAll ??= getAll().map(normalizeEntry));
  const loadNormalizedAvailable = () =>
    (normalizedAvailable ??= getAvailable().map(normalizeEntry));
  const findCache = new Map<string, Model | undefined>();

  registry.getAll = () => loadNormalizedAll().filter(matchesProviderFilter);
  registry.getAvailable = () => loadNormalizedAvailable().filter(matchesProviderFilter);
  // Provider filters constrain list enumeration only. Direct configured-row lookups historically
  // remain available so model-list fallback construction can resolve an explicit entry.
  registry.find = (provider: string, modelId: string) => {
    const key = `${normalizeProviderId(provider)}\0${modelId}`;
    if (findCache.has(key)) {
      return findCache.get(key);
    }
    const entry = find(provider, modelId);
    const resolved = entry
      ? normalizeEntry(entry)
      : loadNormalizedAll().find(
          (candidate) =>
            normalizeProviderId(candidate.provider) === normalizeProviderId(provider) &&
            candidate.id === modelId,
        );
    findCache.set(key, resolved);
    return resolved;
  };
  return registry;
}

function registryOwnerCandidates(
  input: PreparedModelRuntimeInput,
  allowConfiguredWorkspaceFallback: boolean,
): PreparedModelRuntimeInput[] {
  if (!allowConfiguredWorkspaceFallback || !input.workspaceDir) {
    return [input];
  }
  const { workspaceDir: _workspaceDir, ...workspaceFree } = input;
  return [workspaceFree, input];
}

async function loadReadSnapshot(
  input: PreparedModelRuntimeInput,
  allowConfiguredWorkspaceFallback: boolean,
): Promise<PreparedModelRuntimeLease> {
  for (const candidate of registryOwnerCandidates(input, allowConfiguredWorkspaceFallback)) {
    try {
      const prepared = await prepareModelRuntimeSnapshot(candidate);
      // The lifecycle owner is authoritative when this read overlaps a config replacement.
      return { snapshot: prepared, release: () => {} };
    } catch (error) {
      if (!(error instanceof PreparedModelRuntimeOwnerNotPublishedError)) {
        throw error;
      }
    }
  }
  return await acquireReadOnlyPreparedModelRuntime(input);
}

function resolveInput(
  config: OpenClawConfig,
  options: LoadPreparedAgentModelRegistryOptions = {},
): PreparedModelRuntimeInput {
  const agentId = options.agentId ?? resolveDefaultAgentId(config);
  const agentDir = options.agentDir ?? resolveAgentDir(config, agentId);
  const workspaceDir = options.workspaceDir ?? resolveAgentWorkspaceDir(config, agentId);
  return {
    agentId,
    agentDir,
    config,
    inheritedAuthDir: resolveDefaultAgentDir(config),
    ...(usesCredentialFreeRegistry(options) ? { skipCredentials: true } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
  };
}

/** Loads and forks one registry from the owning command lifecycle generation. */
export async function loadPreparedAgentModelRegistry(
  config: OpenClawConfig,
  options: LoadPreparedAgentModelRegistryOptions = {},
): Promise<{ agentDir: string; config: OpenClawConfig; registry: ModelRegistry }> {
  const input = resolveInput(config, options);
  const lease = await loadReadSnapshot(input, options.workspaceDir === undefined);
  try {
    const snapshot = lease.snapshot;
    const stores = snapshot.createStores();
    // ModelRegistry.fork() restores the lifecycle template's raw base catalog before this view
    // applies normalization. Credential-free owners therefore preserve configured IDs as well as
    // preventing credential-dependent discovery during generation construction.
    const modelRegistry = usesCredentialFreeRegistry(options)
      ? stores.modelRegistry.fork(AuthStorage.inMemory({}))
      : stores.modelRegistry;
    return {
      agentDir: snapshot.agentDir,
      config: snapshot.config,
      registry: createRegistryView({
        registry: modelRegistry,
        agentDir: snapshot.agentDir,
        config: snapshot.config,
        providerFilter: options.providerFilter,
        normalizeModels: options.normalizeModels,
        workspaceDir: snapshot.workspaceDir ?? input.workspaceDir,
      }),
    };
  } finally {
    lease.release();
  }
}
