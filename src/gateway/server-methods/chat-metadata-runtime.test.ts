import fs from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  resolveUsableAgentCredentialModes,
  type AgentCredentialMap,
} from "../../agents/agent-auth-credentials.js";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { setPreparedModelRuntimeAuthStore } from "../../agents/prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createGatewayChatMetadataRuntime } from "./chat-metadata-runtime.js";
import type { GatewayRequestContext } from "./types.js";

function createOwner(
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

function createHarness(
  initialConfig: OpenClawConfig = { agents: { list: [{ id: "main", default: true }] } },
  runtimeOptions: {
    beforeRefresh?: () => Promise<void>;
    refreshOnRead?: boolean;
    useDefaultProjection?: boolean;
  } = {},
) {
  const { useDefaultProjection = false, ...gatewayRuntimeOptions } = runtimeOptions;
  let config = initialConfig;
  let owner = createOwner(config, "first");
  let skillsVersion = 1;
  let pluginRegistryVersion = 1;
  let authStore: AuthProfileStore | undefined = { version: 1, profiles: {} };
  let authStoreRevision = 1;
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
      facts: { authStore: AuthProfileStore; owner: PreparedModelRuntimeSnapshot };
    }) => ({
      modelCatalog: facts.owner.modelCatalog.entries,
      models: facts.owner.modelCatalog.entries,
    }),
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
      ...(useDefaultProjection ? {} : { buildProjection: buildProjection as never }),
    },
  });
  return {
    buildCommands,
    buildProjection,
    getPluginRegistryVersion,
    getAuthStoreRevision,
    getPreparedAuthStore,
    getPreparedOwner,
    getSkillsVersion,
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

describe("gateway chat metadata runtime", () => {
  test("refreshes lazily on the first read when configured", async () => {
    const beforeRefresh = vi.fn(async () => {});
    const harness = createHarness(undefined, { beforeRefresh, refreshOnRead: true });

    expect(harness.buildProjection).not.toHaveBeenCalled();
    await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "first" })],
    });

    expect(beforeRefresh).toHaveBeenCalledOnce();
    expect(harness.buildProjection).toHaveBeenCalledOnce();
  });

  test("single-flights equivalent refreshes and reads", async () => {
    const harness = createHarness();
    const releaseModels = createDeferred();
    harness.buildProjection.mockImplementationOnce(async ({ facts }) => {
      await releaseModels.promise;
      return {
        modelCatalog: facts.owner.modelCatalog.entries,
        models: facts.owner.modelCatalog.entries,
      };
    });

    const firstRefresh = harness.runtime.refresh();
    const secondRefresh = harness.runtime.refresh();
    await vi.waitFor(() => expect(harness.buildProjection).toHaveBeenCalledTimes(1));

    const firstRead = harness.runtime.read({ agentId: "main" });
    const secondRead = harness.runtime.read({ agentId: "main" });
    expect(harness.buildCommands).toHaveBeenCalledTimes(1);
    expect(harness.buildProjection).toHaveBeenCalledTimes(1);

    releaseModels.resolve();
    await Promise.all([firstRefresh, secondRefresh]);
    const [first, second] = await Promise.all([firstRead, secondRead]);
    expect(first).toBe(second);
    expect(harness.buildCommands).toHaveBeenCalledTimes(1);
    expect(harness.buildProjection).toHaveBeenCalledTimes(1);
  });

  test("serves published metadata without request-time generation reads", async () => {
    const harness = createHarness();
    await harness.runtime.refresh();
    harness.getPreparedOwner.mockClear();
    harness.getPreparedAuthStore.mockClear();
    harness.getAuthStoreRevision.mockClear();
    harness.getSkillsVersion.mockClear();
    harness.getPluginRegistryVersion.mockClear();

    const first = await harness.runtime.read({ agentId: "main" });
    const second = await harness.runtime.read({ agentId: "main" });

    expect(first).toBe(second);
    expect(harness.getPreparedOwner).not.toHaveBeenCalled();
    expect(harness.getPreparedAuthStore).not.toHaveBeenCalled();
    expect(harness.getAuthStoreRevision).not.toHaveBeenCalled();
    expect(harness.getSkillsVersion).not.toHaveBeenCalled();
    expect(harness.getPluginRegistryVersion).not.toHaveBeenCalled();
  });

  test("serves startup projections from the published generation", async () => {
    const harness = createHarness();
    await harness.runtime.refresh();
    harness.getPreparedOwner.mockClear();
    harness.getPreparedAuthStore.mockClear();
    harness.getAuthStoreRevision.mockClear();
    harness.getSkillsVersion.mockClear();
    harness.getPluginRegistryVersion.mockClear();

    const first = await harness.runtime.readStartup({
      agentId: "main",
      includeSystem: false,
    });
    const second = await harness.runtime.readStartup({
      agentId: "main",
      includeSystem: false,
    });

    expect(second.agentsList).toBe(first.agentsList);
    expect(first.sessionModelCatalog).toEqual([
      expect.objectContaining({ id: "first", provider: "test" }),
    ]);
    expect(first.defaultModelCatalog).toBe(first.sessionModelCatalog);
    expect(first.metadata.models).toEqual(first.sessionModelCatalog);
    expect(harness.buildProjection).toHaveBeenCalledTimes(1);
    expect(harness.getPreparedOwner).not.toHaveBeenCalled();
    expect(harness.getPreparedAuthStore).not.toHaveBeenCalled();
    expect(harness.getAuthStoreRevision).not.toHaveBeenCalled();
    expect(harness.getSkillsVersion).not.toHaveBeenCalled();
    expect(harness.getPluginRegistryVersion).not.toHaveBeenCalled();
  });

  test("keeps large-roster neutral projections prepared outside the session cache", async () => {
    const defaultAgentId = "agent-0";
    const agentIds = Array.from({ length: 65 }, (_, index) => `agent-${index}`);
    const harness = createHarness({
      agents: {
        list: agentIds.map((id) => ({
          id,
          ...(id === defaultAgentId ? { default: true } : {}),
        })),
      },
    });
    await harness.runtime.refresh();

    const readNeutralStartup = async () =>
      await harness.runtime.readStartup({
        agentId: defaultAgentId,
        includeSystem: false,
      });
    const first = await readNeutralStartup();
    const second = await readNeutralStartup();

    expect(first.agentsList.agents).toHaveLength(agentIds.length);
    expect(second.agentsList).toBe(first.agentsList);
    expect(harness.buildProjection).toHaveBeenCalledTimes(agentIds.length);

    await harness.runtime.readStartup({
      agentId: defaultAgentId,
      sessionEntry: {
        authProfileOverride: "test:session",
        authProfileOverrideSource: "user",
      },
      includeSystem: false,
    });
    await readNeutralStartup();

    expect(harness.buildProjection).toHaveBeenCalledTimes(agentIds.length + 1);
  });

  test("caches a session auth projection separately from the neutral roster", async () => {
    const harness = createHarness();
    await harness.runtime.refresh();

    const sessionEntry = {
      authProfileOverride: "test:session",
      authProfileOverrideSource: "user" as const,
    };
    const first = await harness.runtime.readStartup({
      agentId: "main",
      sessionEntry,
      includeSystem: false,
    });
    const second = await harness.runtime.readStartup({
      agentId: "main",
      sessionEntry,
      includeSystem: false,
    });

    expect(second).toEqual(first);
    expect(harness.buildProjection).toHaveBeenCalledTimes(2);
    expect(harness.buildProjection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        preferredProfileId: "test:session",
        lockedProfileId: "test:session",
      }),
    );
  });

  test.each([
    {
      name: "legacy source-less user",
      sessionEntry: { authProfileOverride: "test:legacy-user" },
      locked: true,
    },
    {
      name: "legacy source-less automatic",
      sessionEntry: {
        authProfileOverride: "test:legacy-auto",
        authProfileOverrideCompactionCount: 0,
      },
      locked: false,
    },
  ])("projects $name provenance", async ({ sessionEntry, locked }) => {
    const harness = createHarness();
    await harness.runtime.refresh();

    await harness.runtime.readStartup({
      agentId: "main",
      sessionEntry,
      includeSystem: false,
    });

    const projectionParams = harness.buildProjection.mock.calls.at(-1)?.[0];
    expect(projectionParams).toEqual(
      expect.objectContaining({
        preferredProfileId: sessionEntry.authProfileOverride,
      }),
    );
    if (locked) {
      expect(projectionParams).toEqual(
        expect.objectContaining({
          lockedProfileId: sessionEntry.authProfileOverride,
        }),
      );
    } else {
      expect(projectionParams).not.toHaveProperty("lockedProfileId");
    }
  });

  test("keeps disk-only roster rows without projecting them", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        scenario: "minimal",
        agentEnv: "main",
      },
      async (state) => {
        await fs.mkdir(state.statePath("agents", "dormant", "agent"), { recursive: true });
        const harness = createHarness({});

        await harness.runtime.refresh();
        harness.getPreparedOwner.mockClear();
        const startup = await harness.runtime.readStartup({
          agentId: "main",
          includeSystem: false,
        });

        expect(startup.agentsList.agents.map((agent) => agent.id)).toEqual(["main", "dormant"]);
        expect(harness.getPreparedOwner).not.toHaveBeenCalled();
        expect(harness.buildProjection).toHaveBeenCalledTimes(1);
      },
    );
  });

  test("reuses the prepared generation for an equivalent config replacement", async () => {
    const harness = createHarness();
    await harness.runtime.refresh();
    const first = await harness.runtime.read({ agentId: "main" });

    harness.setConfig({
      agents: { list: [{ id: "main", default: true }] },
    });
    await harness.runtime.refresh();
    const second = await harness.runtime.read({ agentId: "main" });

    expect(second).toBe(first);
    expect(harness.buildCommands).toHaveBeenCalledTimes(1);
    expect(harness.buildProjection).toHaveBeenCalledTimes(1);
  });

  test("rebuilds after an auth store publishes a newer revision", async () => {
    const harness = createHarness();
    harness.setAuthStore(undefined);
    harness.buildProjection.mockImplementation(async ({ facts }) => ({
      modelCatalog: facts.owner.modelCatalog.entries,
      models: facts.owner.modelCatalog.entries.map((model) => ({
        ...model,
        available: Object.keys(facts.authStore.profiles).length > 0,
      })),
    }));

    await harness.runtime.refresh();
    await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
      models: [expect.objectContaining({ available: false })],
    });

    harness.setAuthStore({
      version: 1,
      profiles: { "test:default": { type: "api_key", provider: "test" } },
    });
    harness.setAuthStoreRevision(2);
    await harness.runtime.refresh();

    await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
      models: [expect.objectContaining({ available: true })],
    });
    expect(harness.buildProjection).toHaveBeenCalledTimes(2);
  });

  test.each(["before", "after"] as const)(
    "converges to models.list availability when owner auth publishes %s attachment",
    async (publicationOrder) => {
      const harness = createHarness(undefined, { useDefaultProjection: true });
      harness.setAuthStore({ version: 1, profiles: {} });
      const preparedOwner = createOwner(
        harness.getPreparedOwner()!.config,
        "gpt-5.4",
        {
          openai: {
            type: "oauth",
            access: "prepared-access",
            refresh: "prepared-refresh",
            expires: Date.now() + 30 * 60_000,
          },
        },
        "openai",
        "openai-chatgpt-responses",
      );

      if (publicationOrder === "before") {
        harness.setOwner(preparedOwner);
      } else {
        await harness.runtime.refresh();
        await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
          models: [],
        });
        harness.setOwner(preparedOwner);
      }

      await harness.runtime.refresh();
      await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
        models: [expect.objectContaining({ id: "gpt-5.4", available: true })],
      });
    },
  );

  test("keeps live provider discovery off chat metadata projection", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: { "openai/gpt-5.6-sol": {} },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
    const harness = createHarness(config, { useDefaultProjection: true });
    const credentials: AgentCredentialMap = {
      openai: {
        type: "oauth",
        access: "rejected-access-token",
        refresh: "rejected-refresh-token",
        expires: Date.now() + 30 * 60_000,
      },
    };
    const owner = createOwner(
      config,
      "gpt-5.6-sol",
      credentials,
      "openai",
      "openai-chatgpt-responses",
    );
    const fullCatalog = {
      ...owner.modelCatalog,
      providerOutcomes: [{ provider: "openai", status: "auth-rejected" as const }],
    };
    const loadFullModelCatalog = vi.fn(async () => fullCatalog);
    harness.setOwner({
      ...owner,
      loadFullModelCatalog,
    });
    harness.setAuthStore({
      version: 1,
      profiles: {
        "openai:chatgpt": {
          type: "oauth",
          provider: "openai",
          access: "rejected-access-token",
          refresh: "rejected-refresh-token",
          expires: Date.now() + 30 * 60_000,
        },
      },
    });

    await harness.runtime.refresh();

    await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "gpt-5.6-sol", available: true })],
    });
    expect(loadFullModelCatalog).not.toHaveBeenCalled();
  });

  test("retains a generation while auth store revisions are unchanged", async () => {
    const harness = createHarness();
    harness.getPreparedAuthStore.mockImplementation(() => ({ version: 1, profiles: {} }));
    await harness.runtime.refresh();
    const first = await harness.runtime.read({ agentId: "main" });

    await harness.runtime.refresh();
    const second = await harness.runtime.read({ agentId: "main" });

    expect(second).toBe(first);
    expect(harness.buildProjection).toHaveBeenCalledTimes(1);
    expect(harness.getAuthStoreRevision).toHaveBeenCalledWith("/tmp/first/agent");
    expect(harness.getAuthStoreRevision).toHaveBeenCalledWith(undefined);
  });

  test("refreshes config, catalog-auth, skills, and plugin generations", async () => {
    const harness = createHarness();
    await harness.runtime.refresh();
    const first = await harness.runtime.read({ agentId: "main" });

    harness.setSkillsVersion(2);
    harness.runtime.invalidate();
    await harness.runtime.refresh();
    const skillsChanged = await harness.runtime.read({ agentId: "main" });

    harness.setPluginRegistryVersion(2);
    harness.runtime.invalidate();
    await harness.runtime.refresh();
    const pluginsChanged = await harness.runtime.read({ agentId: "main" });

    const nextConfig = {
      agents: { list: [{ id: "main", default: true }] },
      tools: { swarm: { enabled: true } },
    };
    harness.setConfig(nextConfig);
    harness.setOwner(createOwner(nextConfig, "second"));
    harness.runtime.invalidate();
    await harness.runtime.refresh();
    const configAndOwnerChanged = await harness.runtime.read({ agentId: "main" });

    expect(first.commands).toEqual([{ name: "command-1-1" }]);
    expect(skillsChanged.commands).toEqual([{ name: "command-2-1" }]);
    expect(pluginsChanged.commands).toEqual([{ name: "command-2-2" }]);
    expect(configAndOwnerChanged.models).toEqual([
      expect.objectContaining({ id: "second", provider: "test" }),
    ]);
    expect(harness.buildCommands).toHaveBeenCalledTimes(4);
    expect(harness.buildProjection).toHaveBeenCalledTimes(4);
  });

  test("waits for an invalidated generation to be replaced before serving reads", async () => {
    const harness = createHarness();
    await harness.runtime.refresh();

    harness.runtime.invalidate();
    const read = harness.runtime.read({ agentId: "main" });
    let settled = false;
    void read.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    const nextConfig = {
      agents: { list: [{ id: "main", default: true }] },
      tools: { swarm: { enabled: true } },
    };
    harness.setConfig(nextConfig);
    harness.setOwner(createOwner(nextConfig, "replacement"));
    await harness.runtime.refresh();

    await expect(read).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "replacement" })],
      swarmEnabled: true,
    });
  });

  test("retries a session projection invalidated while it is awaiting", async () => {
    const harness = createHarness();
    await harness.runtime.refresh();
    const releaseProjection = createDeferred();
    harness.buildProjection.mockImplementationOnce(async ({ facts }) => {
      await releaseProjection.promise;
      return {
        modelCatalog: facts.owner.modelCatalog.entries,
        models: facts.owner.modelCatalog.entries,
      };
    });

    const read = harness.runtime.read({
      agentId: "main",
      sessionEntry: {
        authProfileOverride: "test:session",
        authProfileOverrideSource: "user",
      },
    });
    await vi.waitFor(() => expect(harness.buildProjection).toHaveBeenCalledTimes(2));

    const nextConfig = {
      agents: { list: [{ id: "main", default: true }] },
      tools: { swarm: { enabled: true } },
    };
    harness.setConfig(nextConfig);
    harness.setOwner(createOwner(nextConfig, "replacement"));
    harness.runtime.invalidate();
    await harness.runtime.refresh();

    releaseProjection.resolve();
    await expect(read).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "replacement" })],
      swarmEnabled: true,
    });
  });

  test("discards a projection failure from an invalidated generation", async () => {
    const harness = createHarness();
    await harness.runtime.refresh();
    const releaseProjection = createDeferred();
    harness.buildProjection.mockImplementationOnce(async () => {
      await releaseProjection.promise;
      throw new Error("obsolete projection failed");
    });

    const read = harness.runtime.read({
      agentId: "main",
      sessionEntry: {
        authProfileOverride: "test:session",
        authProfileOverrideSource: "user",
      },
    });
    await vi.waitFor(() => expect(harness.buildProjection).toHaveBeenCalledTimes(2));

    const nextConfig = {
      agents: { list: [{ id: "main", default: true }] },
      tools: { swarm: { enabled: true } },
    };
    harness.setConfig(nextConfig);
    harness.setOwner(createOwner(nextConfig, "replacement"));
    harness.runtime.invalidate();
    await harness.runtime.refresh();

    releaseProjection.resolve();
    await expect(read).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "replacement" })],
      swarmEnabled: true,
    });
  });

  test("resolves the replacement gate after a coalesced second invalidation", async () => {
    const harness = createHarness();
    await harness.runtime.refresh();
    const releaseCommands = createDeferred();
    harness.buildCommands.mockImplementationOnce(async () => {
      await releaseCommands.promise;
      return { commands: [{ name: "replacement" }] };
    });

    harness.runtime.invalidate();
    const firstRefresh = harness.runtime.refresh();
    await vi.waitFor(() => expect(harness.buildCommands).toHaveBeenCalledTimes(2));

    harness.runtime.invalidate();
    const secondRefresh = harness.runtime.refresh();
    releaseCommands.resolve();
    await Promise.all([firstRefresh, secondRefresh]);

    const timedOut = Symbol("timed out");
    const result = await Promise.race([
      harness.runtime.read({ agentId: "main" }),
      new Promise<typeof timedOut>((resolve) => {
        setTimeout(() => resolve(timedOut), 100);
      }),
    ]);
    expect(result).not.toBe(timedOut);
  });

  test("retries an unavailable owner on the next read once it is published again", async () => {
    const harness = createHarness();
    await harness.runtime.refresh();

    harness.getPreparedOwner.mockReturnValue(undefined);
    await expect(harness.runtime.refresh()).rejects.toThrow(
      'prepared chat metadata owner is unavailable for agent "main"',
    );
    await expect(harness.runtime.read({ agentId: "main" })).rejects.toThrow(
      'prepared chat metadata owner is unavailable for agent "main"',
    );

    const recovered = createOwner(
      { agents: { list: [{ id: "main", default: true }] } },
      "recovered",
    );
    harness.setOwner(recovered);
    harness.getPreparedOwner.mockReturnValue(recovered);

    await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "recovered" })],
    });
  });

  test("rejects replacement waiters on failure and recovers on a later generation", async () => {
    const harness = createHarness();
    await harness.runtime.refresh();

    harness.runtime.invalidate();
    const failedRead = harness.runtime.read({ agentId: "main" });
    harness.runtime.fail(new Error("replacement failed"));
    await expect(failedRead).rejects.toThrow("replacement failed");
    await expect(harness.runtime.read({ agentId: "main" })).rejects.toThrow("replacement failed");

    const nextConfig = { agents: { list: [{ id: "main", default: true }] } };
    harness.setConfig(nextConfig);
    harness.setOwner(createOwner(nextConfig, "recovered"));
    harness.runtime.invalidate();
    await harness.runtime.refresh();

    await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "recovered" })],
    });
  });

  test("omits failed command preparation without losing models", async () => {
    const harness = createHarness();
    harness.buildCommands.mockRejectedValueOnce(new Error("skill scan failed"));

    await harness.runtime.refresh();
    const metadata = await harness.runtime.read({ agentId: "main" });

    expect(metadata.commands).toBeUndefined();
    expect(metadata.models).toEqual([expect.objectContaining({ id: "first" })]);
  });

  test("does not publish a generation whose neutral projection failed", async () => {
    const harness = createHarness();
    harness.buildProjection.mockRejectedValueOnce(new Error("startup projection failed"));

    await expect(harness.runtime.refresh()).rejects.toThrow("startup projection failed");
    await harness.runtime.refresh();
    await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "first" })],
    });
    expect(harness.buildProjection).toHaveBeenCalledTimes(2);
  });
});
