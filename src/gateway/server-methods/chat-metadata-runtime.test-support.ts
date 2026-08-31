import { vi } from "vitest";
import {
  resolveUsableAgentCredentialModes,
  type AgentCredentialMap,
} from "../../agents/agent-auth-credentials.js";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { setPreparedModelRuntimeAuthStore } from "../../agents/prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createGatewayChatMetadataRuntime } from "./chat-metadata-runtime.js";
import type { GatewayRequestContext } from "./types.js";

export function createChatMetadataOwner(
  config: OpenClawConfig,
  id: string,
  credentials: AgentCredentialMap = {},
  provider = "test",
  api?: ModelCatalogEntry["api"],
): PreparedModelRuntimeSnapshot {
  const model = { id, name: id, provider, ...(api ? { api } : {}) };
  const authStore: AuthProfileStore = {
    version: 1,
    profiles: Object.fromEntries(
      Object.entries(credentials).map(([credentialProvider, credential]) => [
        `${credentialProvider}:prepared`,
        { ...credential, provider: credentialProvider },
      ]),
    ),
  };
  const owner: PreparedModelRuntimeSnapshot = {
    catalogOwner: { agentId: "main", workspaceDir: `/tmp/${id}/workspace` },
    agentId: "main",
    agentDir: `/tmp/${id}/agent`,
    workspaceDir: `/tmp/${id}/workspace`,
    activeProjectKeys: [],
    config,
    authModes: resolveUsableAgentCredentialModes(credentials),
    metadataSnapshot: { index: { plugins: [] }, plugins: [] } as never,
    allowGatewaySubagentBinding: false,
    modelCatalog: {
      entries: [model],
      routeVariants: api ? [model] : [],
    },
    configuredRuntimeModels: [],
    inlineProviderModels: [],
    createStores: () => ({
      authStorage: { getAll: () => credentials } as never,
      modelRegistry: {} as never,
    }),
  };
  setPreparedModelRuntimeAuthStore(owner, authStore);
  return owner;
}

export function createChatMetadataHarness(
  initialConfig: OpenClawConfig = { agents: { list: [{ id: "main", default: true }] } },
  runtimeOptions: {
    beforeRefresh?: () => Promise<void>;
    refreshOnRead?: boolean;
    useDefaultProjection?: boolean;
    onChanged?: () => void;
  } = {},
) {
  const { useDefaultProjection = false, ...gatewayRuntimeOptions } = runtimeOptions;
  let config = initialConfig;
  let owner = createChatMetadataOwner(config, "first");
  let skillsVersion = 1;
  let pluginRegistryVersion = 1;
  let authStore: AuthProfileStore | undefined = { version: 1, profiles: {} };
  let authStoreRevision = 1;
  const invalidProjections = new WeakSet<object>();
  const getPreparedOwner = vi.fn((): PreparedModelRuntimeSnapshot | undefined => owner);
  const getPreparedAuthStore = vi.fn(() => authStore);
  const getAuthStoreRevision = vi.fn(() => authStoreRevision);
  const getSkillsVersion = vi.fn(() => skillsVersion);
  const getPluginRegistryVersion = vi.fn(() => pluginRegistryVersion);
  const buildCommands = vi.fn(async () => ({
    commands: [{ name: `command-${skillsVersion}-${pluginRegistryVersion}` }],
  }));
  const buildProjection = vi.fn(
    async ({
      facts,
    }: {
      facts: {
        authStore: AuthProfileStore;
        modelCatalog: ModelCatalogSnapshot;
        owner: PreparedModelRuntimeSnapshot;
      };
    }) => {
      const modelCatalog = facts.modelCatalog;
      return {
        modelCatalog: modelCatalog.entries,
        models: modelCatalog.entries,
      };
    },
  );
  const readProjection = vi.fn(
    (projection: { modelCatalog: ModelCatalogEntry[]; models?: unknown[] }) => projection,
  );
  const context = {
    getRuntimeConfig: () => config,
    loadGatewayModelCatalogSnapshot: async (params?: { readOnly?: boolean }) => {
      const modelCatalog =
        params?.readOnly === false && owner.loadFullModelCatalog
          ? await owner.loadFullModelCatalog()
          : owner.modelCatalog;
      return {
        ...modelCatalog,
        agentId: owner.agentId,
        agentDir: owner.agentDir,
        workspaceDir: owner.workspaceDir,
        config: owner.config,
      };
    },
    logGateway: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as GatewayRequestContext;
  const runtime = createGatewayChatMetadataRuntime({
    getConfig: () => config,
    getContext: () => context,
    log: context.logGateway,
    ...gatewayRuntimeOptions,
    deps: {
      getPreparedOwner,
      getPreparedAuthStore,
      getAuthStoreRevision,
      getSkillsVersion,
      getPluginRegistryVersion,
      buildCommands,
      ...(useDefaultProjection
        ? {}
        : {
            buildProjection: async (params) => {
              const projection = await buildProjection(params);
              return {
                modelCatalog: projection.modelCatalog,
                read: () => ({ models: readProjection(projection).models }),
                isCurrent: () => !invalidProjections.has(projection),
              };
            },
          }),
    },
  });
  return {
    buildCommands,
    buildProjection,
    readProjection,
    getPluginRegistryVersion,
    getAuthStoreRevision,
    getPreparedAuthStore,
    getPreparedOwner,
    getSkillsVersion,
    invalidProjections,
    runtime,
    setConfig(next: OpenClawConfig) {
      config = next;
    },
    setAuthStore(next: AuthProfileStore | undefined) {
      authStore = next;
    },
    setAuthStoreRevision(next: number) {
      authStoreRevision = next;
    },
    setOwner(next: PreparedModelRuntimeSnapshot) {
      owner = next;
    },
    setPluginRegistryVersion(next: number) {
      pluginRegistryVersion = next;
    },
    setSkillsVersion(next: number) {
      skillsVersion = next;
    },
  };
}
