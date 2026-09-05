import { randomUUID } from "node:crypto";
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
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { connectUserModelAccount } from "../../state/user-model-accounts.js";
import { ensureProfileForEmail, setDisplayName } from "../../state/user-profiles.js";
import { ModelAccountConnectAuthorityError } from "../model-account-connect.js";
import { createGatewayChatMetadataRuntime } from "./chat-metadata-runtime.js";
import type { GatewayRequestContext } from "./types.js";

export function connectChatMetadataAccount(profileId: string): string {
  return connectUserModelAccount({
    ownerProfileId: profileId,
    credential: {
      type: "oauth",
      provider: "openai",
      displayName: "Private provider account",
      access: "synthetic-personal-access",
      refresh: "synthetic-personal-refresh",
      expires: Date.now() + 600_000,
    },
    assertCurrent() {},
  }).authProfileId;
}

export async function createPersonalChatMetadataFixture() {
  const config = {
    agents: {
      defaults: { model: { primary: "openai/gpt-5.6-luna" } },
      list: [{ id: "main", default: true }],
    },
  } satisfies OpenClawConfig;
  const harness = createChatMetadataHarness(config, { useDefaultProjection: true });
  const owner = createChatMetadataOwner(
    config,
    "gpt-5.6-luna",
    {},
    "openai",
    "openai-chatgpt-responses",
  );
  harness.setOwner(owner);
  await harness.runtime.refresh();
  const alice = ensureProfileForEmail("alice@example.test");
  const bob = ensureProfileForEmail("bob@example.test");
  setDisplayName(alice.id, "Alice");
  return {
    harness,
    owner,
    alice,
    bob,
    aliceScope: { agentId: "main", requesterProfileId: alice.id },
    bobScope: { agentId: "main", requesterProfileId: bob.id },
  };
}

export function createDraftChatMetadataScope(
  owner: string = randomUUID(),
  authProfileId = `personal:${owner}:${randomUUID()}`,
) {
  const error = new ModelAccountConnectAuthorityError();
  let current = true;
  return {
    params: {
      agentId: "main",
      requesterProfileId: owner,
      draftAccountSelection: {
        owner,
        authProfileId,
        assertCurrent() {
          if (!current) {
            throw error;
          }
        },
      },
    },
    close() {
      current = false;
    },
    error,
  };
}

export function createOpenAIChatMetadataConfig(modelIds = ["gpt-5.6-sol"]): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.6-sol" },
        models: Object.fromEntries(modelIds.map((id) => [`openai/${id}`, {}])),
      },
      list: [{ id: "main", default: true }],
    },
  };
}

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
    observationConfig: config,
    isCurrent: () => true,
    authModes: resolveUsableAgentCredentialModes(credentials),
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
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
