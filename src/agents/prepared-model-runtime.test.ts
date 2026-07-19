import { beforeEach, describe, expect, it, vi } from "vitest";

type LoadStaticCatalog =
  typeof import("./embedded-agent-runner/model.static-catalog.js").loadBundledProviderStaticCatalogContextModels;

const mocks = vi.hoisted(() => ({
  authStorage: { getAll: vi.fn(() => ({ custom: { type: "api_key", key: "test-key" } })) },
  modelRegistry: {
    fork: vi.fn((authStorage: unknown) => ({ authStorage })),
    getAll: vi.fn(() => []),
  },
  discoverAuthStorage: vi.fn(),
  discoverModels: vi.fn(),
  ensureOpenClawModelsJson: vi.fn(async (..._args: unknown[]) => ({
    agentDir: "/tmp/agent",
    wrote: false,
  })),
  buildPreparedModelCatalogSnapshot: vi.fn(async (..._args: unknown[]) => ({
    entries: [],
    routeVariants: [],
  })),
  ensureRuntimePluginsLoaded: vi.fn(),
  loadStaticCatalog: vi.fn<LoadStaticCatalog>(async () => []),
  configuredAgentIds: [] as string[],
  mutationListener: undefined as
    | ((event: { agentDir?: string; affectsInheritedStores: boolean }) => void)
    | undefined,
}));

vi.mock("./model-catalog.js", () => ({
  buildPreparedModelCatalogSnapshot: (...args: unknown[]) =>
    mocks.buildPreparedModelCatalogSnapshot(...args),
}));

vi.mock("./agent-model-discovery.js", () => ({
  discoverAuthStorage: (...args: unknown[]) => {
    mocks.discoverAuthStorage(...args);
    return mocks.authStorage;
  },
  discoverModels: (...args: unknown[]) => {
    mocks.discoverModels(...args);
    return mocks.modelRegistry;
  },
}));

vi.mock("./agent-scope.js", () => ({
  listAgentIds: () => mocks.configuredAgentIds,
  resolveAgentDir: (_config: unknown, agentId: string) =>
    agentId === "default" ? "/tmp/unused-agent" : `/tmp/configured-${agentId}`,
  resolveAgentWorkspaceDir: (_config: unknown, agentId: string) =>
    agentId === "default" ? "/tmp/unused-workspace" : `/tmp/workspace-${agentId}`,
  resolveDefaultAgentDir: () => "/tmp/unused-agent",
  resolveDefaultAgentId: () => "default",
}));

vi.mock("./auth-profiles/runtime-snapshots.js", () => ({
  registerRuntimeAuthProfileStoreMutationListener: (
    listener: (event: { agentDir?: string; affectsInheritedStores: boolean }) => void,
  ) => {
    mocks.mutationListener = listener;
    return () => {};
  },
}));

vi.mock("./model-discovery-context.js", () => ({
  resolveModelPluginMetadataSnapshot: () => undefined,
}));

vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: (...args: unknown[]) => mocks.ensureOpenClawModelsJson(...args),
}));

vi.mock("./runtime-plugins.js", () => ({
  ensureRuntimePluginsLoaded: (...args: unknown[]) => mocks.ensureRuntimePluginsLoaded(...args),
}));

vi.mock("./embedded-agent-runner/model.static-catalog.js", () => ({
  loadBundledProviderStaticCatalogContextModels: (...args: Parameters<LoadStaticCatalog>) =>
    mocks.loadStaticCatalog(...args),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: vi.fn() }),
}));

import {
  acquireReadOnlyPreparedModelRuntime,
  activateStandalonePreparedModelRuntime,
  getPreparedModelRuntimeSnapshot,
  loadPreparedModelRuntimeSnapshot,
  markPreparedModelRuntimeSnapshotsStale,
  prepareModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
  rejectPendingPreparedModelRuntimeReplacement,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

describe("prepared model runtime snapshots", () => {
  const getTesting = () =>
    (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.preparedModelRuntimeTestApi")
    ] as {
      resetPreparedModelRuntimeSnapshotsForTest: () => void;
      setModelRuntimeBuildTimeoutMsForTest: (timeoutMs: number) => void;
    };

  beforeEach(() => {
    getTesting().resetPreparedModelRuntimeSnapshotsForTest();
    mocks.discoverAuthStorage.mockClear();
    mocks.discoverModels.mockClear();
    mocks.ensureOpenClawModelsJson.mockClear();
    mocks.buildPreparedModelCatalogSnapshot.mockClear();
    mocks.ensureRuntimePluginsLoaded.mockClear();
    mocks.loadStaticCatalog.mockClear();
    mocks.modelRegistry.fork.mockClear();
    mocks.configuredAgentIds = [];
  });

  it("reactivates a standalone read-only owner after a publication boundary", async () => {
    const input = {
      agentDir: "/tmp/prepared-model-runtime-read-only-reactivation",
      config: {},
      readOnly: true,
    };
    await activateStandalonePreparedModelRuntime(input);

    markPreparedModelRuntimeSnapshotsStale("test config publication");

    expect(getPreparedModelRuntimeSnapshot(input)).toBeUndefined();
    await expect(loadPreparedModelRuntimeSnapshot(input)).resolves.toMatchObject({
      config: input.config,
    });
    expect(mocks.discoverAuthStorage).toHaveBeenCalledTimes(2);
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
  });

  it("never returns a standalone generation invalidated while it is building", async () => {
    const input = {
      agentDir: "/tmp/prepared-model-runtime-standalone-build-race",
      config: {},
    };
    let finishFirstBuild!: () => void;
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(
      async () =>
        await new Promise<{ agentDir: string; wrote: boolean }>((resolve) => {
          finishFirstBuild = () => resolve({ agentDir: input.agentDir, wrote: false });
        }),
    );

    const activation = activateStandalonePreparedModelRuntime(input);
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce());
    markPreparedModelRuntimeSnapshotsStale("test in-flight standalone publication");
    finishFirstBuild();

    const published = await activation;
    expect(published).toBeDefined();
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    await expect(prepareModelRuntimeSnapshot(input)).resolves.toBe(published);
  });

  it("loads runtime plugins before discovering an immutable generation", async () => {
    await publishPreparedModelRuntimeSnapshot({
      config: {},
      agentDir: "/tmp/prepared-model-runtime-plugin-order",
      workspaceDir: "/tmp/prepared-model-runtime-plugin-workspace",
    });

    expect(mocks.ensureRuntimePluginsLoaded).toHaveBeenCalledWith({
      config: {},
      workspaceDir: "/tmp/prepared-model-runtime-plugin-workspace",
    });
    expect(mocks.ensureRuntimePluginsLoaded.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.discoverAuthStorage.mock.invocationCallOrder[0]!,
    );
  });

  it("uses an explicit lifecycle environment for catalog and auth discovery", async () => {
    const env = { NVIDIA_API_KEY: "test-nvidia-api-key" };
    await publishPreparedModelRuntimeSnapshot({
      config: {},
      agentDir: "/tmp/prepared-model-runtime-explicit-env",
      env,
    });

    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledWith(
      {},
      "/tmp/prepared-model-runtime-explicit-env",
      expect.objectContaining({ env }),
    );
    expect(mocks.discoverAuthStorage).toHaveBeenCalledWith(
      "/tmp/prepared-model-runtime-explicit-env",
      expect.objectContaining({ env }),
    );
    expect(mocks.buildPreparedModelCatalogSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ env }),
    );
  });

  it("captures static provider-hook rows in the same lifecycle generation", async () => {
    mocks.loadStaticCatalog.mockResolvedValueOnce([
      {
        provider: "nvidia",
        id: "nemotron-static",
        name: "Nemotron Static",
        api: "openai-completions",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ]);

    const snapshot = await publishPreparedModelRuntimeSnapshot({
      config: {},
      agentDir: "/tmp/prepared-model-runtime-static-catalog",
      workspaceDir: "/tmp/prepared-model-runtime-static-workspace",
    });

    expect(mocks.loadStaticCatalog).toHaveBeenCalledWith({
      cfg: {},
      env: process.env,
      workspaceDir: "/tmp/prepared-model-runtime-static-workspace",
    });
    expect(snapshot.modelCatalog.staticEntries).toEqual([
      {
        provider: "nvidia",
        id: "nemotron-static",
        name: "Nemotron Static",
        api: "openai-completions",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        contextWindow: 128_000,
        reasoning: false,
        input: ["text"],
      },
    ]);
  });

  it("omits provider runtime APIs outside the catalog contract", async () => {
    mocks.loadStaticCatalog.mockResolvedValueOnce([
      {
        provider: "custom",
        id: "custom-static",
        name: "Custom Static",
        api: "mistral-conversations",
        baseUrl: "https://example.test/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_000,
        maxTokens: 8_192,
      },
    ]);

    const snapshot = await publishPreparedModelRuntimeSnapshot({
      config: {},
      agentDir: "/tmp/prepared-model-runtime-unsupported-api",
    });

    expect(snapshot.modelCatalog.staticEntries).toEqual([
      {
        provider: "custom",
        id: "custom-static",
        name: "Custom Static",
        baseUrl: "https://example.test/v1",
        contextWindow: 32_000,
        reasoning: false,
        input: ["text"],
      },
    ]);
  });

  it("stales a published owner synchronously before replacement", async () => {
    const input = { config: {}, agentDir: "/tmp/prepared-model-runtime-stale" };
    await publishPreparedModelRuntimeSnapshot(input);

    markPreparedModelRuntimeSnapshotsStale("test publication boundary");

    expect(getPreparedModelRuntimeSnapshot(input)).toBeUndefined();
    await expect(prepareModelRuntimeSnapshot(input)).rejects.toThrow("test publication boundary");
  });

  it("holds stale reads until the committed replacement is published", async () => {
    mocks.configuredAgentIds = ["default"];
    const firstConfig = {};
    const secondConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    const input = {
      agentId: "default",
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/unused-workspace",
    };
    await refreshPreparedModelRuntimeSnapshots(firstConfig);

    markPreparedModelRuntimeSnapshotsStale("test config commit", { waitForReplacement: true });
    const read = prepareModelRuntimeSnapshot({ ...input, config: secondConfig });
    await expect(
      Promise.race([
        read.then(
          () => "settled",
          () => "settled",
        ),
        Promise.resolve("pending"),
      ]),
    ).resolves.toBe("pending");

    const refresh = refreshPreparedModelRuntimeSnapshots(secondConfig);
    await expect(read).resolves.toMatchObject({ config: secondConfig });
    await refresh;
  });

  it("rebinds unpublished read-only activation to the committed replacement config", async () => {
    mocks.configuredAgentIds = ["default"];
    const initialConfig = {};
    const latestConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });

    markPreparedModelRuntimeSnapshotsStale("test read-only replacement", {
      waitForReplacement: true,
    });
    const read = loadPreparedModelRuntimeSnapshot({
      agentId: "default",
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/dynamic-read-only-workspace",
      config: initialConfig,
      readOnly: true,
    });
    markPreparedModelRuntimeSnapshotsStale("test superseding read-only replacement", {
      waitForReplacement: true,
    });
    expect(
      getPreparedModelRuntimeSnapshot({
        agentId: "default",
        agentDir: "/tmp/unused-agent",
        inheritedAuthDir: "/tmp/unused-agent",
        config: latestConfig,
      }),
    ).toBeUndefined();
    const refresh = refreshPreparedModelRuntimeSnapshots(latestConfig);

    await expect(read).resolves.toMatchObject({
      config: latestConfig,
      workspaceDir: "/tmp/dynamic-read-only-workspace",
    });
    await refresh;
  });

  it("does not let a superseded reload reject the current replacement gate", async () => {
    mocks.configuredAgentIds = ["default"];
    const initialConfig = {};
    const latestConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(initialConfig);

    const supersededGate = markPreparedModelRuntimeSnapshotsStale("test superseded reload", {
      waitForReplacement: true,
    });
    markPreparedModelRuntimeSnapshotsStale("test current reload", { waitForReplacement: true });
    rejectPendingPreparedModelRuntimeReplacement(
      supersededGate,
      new Error("superseded reload cancelled"),
    );
    const read = prepareModelRuntimeSnapshot({
      agentId: "default",
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/unused-workspace",
      config: latestConfig,
    });
    const refresh = refreshPreparedModelRuntimeSnapshots(latestConfig);

    await expect(read).resolves.toMatchObject({ config: latestConfig });
    await refresh;
  });

  it("allows a read-only draft owner while the gateway lifecycle is active", async () => {
    await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
    const draftConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };

    await expect(
      activateStandalonePreparedModelRuntime({
        agentDir: "/tmp/prepared-model-runtime-read-only-draft",
        config: draftConfig,
        readOnly: true,
      }),
    ).resolves.toMatchObject({ config: draftConfig });
    expect(mocks.discoverAuthStorage).toHaveBeenCalledWith(
      "/tmp/prepared-model-runtime-read-only-draft",
      expect.objectContaining({ readOnly: true }),
    );
    expect(mocks.discoverModels).toHaveBeenCalledOnce();
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
    expect(mocks.ensureRuntimePluginsLoaded).not.toHaveBeenCalled();
  });

  it("builds credential-free command owners separately from runtime owners", async () => {
    const config = {};
    const agentDir = "/tmp/prepared-model-runtime-credential-free";
    await publishPreparedModelRuntimeSnapshot({ config, agentDir });

    const credentialFree = await publishPreparedModelRuntimeSnapshot({
      config,
      agentDir,
      readOnly: true,
      skipCredentials: true,
    });

    expect(credentialFree).not.toBe(await prepareModelRuntimeSnapshot({ config, agentDir }));
    expect(mocks.discoverAuthStorage).toHaveBeenNthCalledWith(
      2,
      agentDir,
      expect.objectContaining({ readOnly: true, skipCredentials: true }),
    );
  });

  it("reuses one lifecycle-owned snapshot without rediscovering files", async () => {
    const config = {};
    const input = { config, agentDir: "/tmp/prepared-model-runtime-reuse" };

    const first = await publishPreparedModelRuntimeSnapshot(input);
    const second = await prepareModelRuntimeSnapshot(input);

    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(1);
    expect(mocks.discoverAuthStorage).toHaveBeenCalledTimes(1);
    expect(mocks.discoverModels).toHaveBeenCalledTimes(1);
    expect(mocks.buildPreparedModelCatalogSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ authCredentials: mocks.authStorage.getAll() }),
    );
    const firstStores = first.createStores();
    const secondStores = first.createStores();
    expect(secondStores.authStorage).not.toBe(firstStores.authStorage);
    expect(secondStores.modelRegistry).not.toBe(firstStores.modelRegistry);
  });

  it("ignores request config identity until lifecycle publication", async () => {
    const agentDir = "/tmp/prepared-model-runtime-request-config";
    const initialConfig = {};
    const first = await publishPreparedModelRuntimeSnapshot({ config: initialConfig, agentDir });

    const fromEquivalentClone = await prepareModelRuntimeSnapshot({ config: {}, agentDir });

    expect(fromEquivalentClone).toBe(first);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(1);
  });

  it("reuses read-only owners for equivalent config clones but rejects projections", async () => {
    const agentDir = "/tmp/prepared-model-runtime-read-only-config";
    const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    const first = await publishPreparedModelRuntimeSnapshot({ config, agentDir, readOnly: true });

    await expect(
      prepareModelRuntimeSnapshot({
        config: { agents: { defaults: { model: "openai/gpt-5.5" } } },
        agentDir,
        readOnly: true,
      }),
    ).resolves.toBe(first);
    await expect(
      prepareModelRuntimeSnapshot({
        config: { agents: { defaults: { model: "anthropic/claude-opus-4-6" } } },
        agentDir,
        readOnly: true,
      }),
    ).rejects.toThrow("not published");
    const secondLease = await acquireReadOnlyPreparedModelRuntime({
      config: { agents: { defaults: { model: "anthropic/claude-opus-4-6" } } },
      agentDir,
    });
    expect(secondLease.snapshot).not.toBe(first);
    expect(mocks.discoverModels).toHaveBeenCalledTimes(2);
    secondLease.release();
  });

  it("keeps synchronous read-only snapshots isolated by config", async () => {
    const agentDir = "/tmp/prepared-model-runtime-sync-read-only-config";
    const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    const snapshot = await publishPreparedModelRuntimeSnapshot({
      config,
      agentDir,
      readOnly: true,
    });

    expect(
      getPreparedModelRuntimeSnapshot({
        config: { agents: { defaults: { model: "openai/gpt-5.5" } } },
        agentDir,
        readOnly: true,
      }),
    ).toBe(snapshot);
    expect(
      getPreparedModelRuntimeSnapshot({
        config: { agents: { defaults: { model: "anthropic/claude-opus-4-6" } } },
        agentDir,
        readOnly: true,
      }),
    ).toBeUndefined();
  });

  it("canonicalizes explicit false owner flags", async () => {
    const input = {
      agentId: "worker",
      config: {},
      agentDir: "/tmp/configured-worker",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/workspace-worker",
    };
    await publishPreparedModelRuntimeSnapshot(input, { provenance: "configured" });

    await expect(
      prepareModelRuntimeSnapshot({
        ...input,
        readOnly: false,
        skipCredentials: false,
        workspaceDir: undefined,
      }),
    ).resolves.toMatchObject({ agentId: "worker", workspaceDir: "/tmp/workspace-worker" });
  });

  it("uses the explicit lifecycle config when adding an owner after a gateway refresh", async () => {
    const explicitConfig = {};
    const publishedConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(publishedConfig);

    const snapshot = await publishPreparedModelRuntimeSnapshot({
      config: explicitConfig,
      agentDir: "/tmp/prepared-model-runtime-late-owner",
    });

    expect(snapshot.config).toBe(explicitConfig);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledWith(
      explicitConfig,
      expect.any(String),
      expect.any(Object),
    );
  });

  it("rebuilds a standalone owner when its explicit config changes", async () => {
    const agentDir = "/tmp/prepared-model-runtime-standalone-config";
    const firstConfig = {};
    const secondConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };

    await activateStandalonePreparedModelRuntime({ config: firstConfig, agentDir });
    await activateStandalonePreparedModelRuntime({ config: secondConfig, agentDir });
    const snapshot = await prepareModelRuntimeSnapshot({ config: secondConfig, agentDir });

    expect(snapshot.config).toBe(secondConfig);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenLastCalledWith(
      secondConfig,
      agentDir,
      expect.any(Object),
    );
  });

  it("keeps each standalone activation bound to its published generation", async () => {
    const agentDir = "/tmp/prepared-model-runtime-overlapping-standalone";
    const firstConfig = {};
    const secondConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };

    const first = await activateStandalonePreparedModelRuntime({ config: firstConfig, agentDir });
    const second = await activateStandalonePreparedModelRuntime({ config: secondConfig, agentDir });

    expect(first?.config).toBe(firstConfig);
    expect(second?.config).toBe(secondConfig);
    expect(first).not.toBe(second);
  });

  it("serializes conflicting standalone activations for one owner", async () => {
    const agentDir = "/tmp/prepared-model-runtime-concurrent-standalone";
    const firstConfig = {};
    const secondConfig = {};
    let finishFirstBuild!: () => void;
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(
      async () =>
        await new Promise<{ agentDir: string; wrote: boolean }>((resolve) => {
          finishFirstBuild = () => resolve({ agentDir, wrote: false });
        }),
    );

    const firstActivation = activateStandalonePreparedModelRuntime({
      config: firstConfig,
      agentDir,
    });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce());
    const secondActivation = activateStandalonePreparedModelRuntime({
      config: secondConfig,
      agentDir,
    });

    await Promise.resolve();
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
    finishFirstBuild();

    const [first, second] = await Promise.all([firstActivation, secondActivation]);
    expect(first?.config).toBe(firstConfig);
    expect(second?.config).toBe(secondConfig);
    expect(first).not.toBe(second);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
  });

  it("does not discover a missing owner from a request lookup", async () => {
    await expect(
      prepareModelRuntimeSnapshot({
        config: {},
        agentDir: "/tmp/prepared-model-runtime-missing-owner",
      }),
    ).rejects.toThrow("prepared model runtime owner was not published");
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
  });

  it("deduplicates standalone activation while publishing later owners", async () => {
    const input = {
      config: {},
      agentDir: "/tmp/prepared-model-runtime-standalone",
      workspaceDir: "/tmp/prepared-model-runtime-standalone-workspace",
    };

    await activateStandalonePreparedModelRuntime(input);
    await activateStandalonePreparedModelRuntime(input);
    await activateStandalonePreparedModelRuntime({
      ...input,
      agentDir: "/tmp/prepared-model-runtime-standalone-second",
    });
    const replacementInput = { ...input, workspaceDir: "/tmp/standalone-replacement-workspace" };
    await activateStandalonePreparedModelRuntime(replacementInput);
    await expect(prepareModelRuntimeSnapshot(replacementInput)).resolves.toMatchObject({
      agentDir: input.agentDir,
      workspaceDir: replacementInput.workspaceDir,
    });
    await expect(prepareModelRuntimeSnapshot(input)).resolves.toMatchObject({
      workspaceDir: input.workspaceDir,
    });
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3);
  });

  it("skips a queued config generation superseded before its build starts", async () => {
    mocks.configuredAgentIds = ["default"];
    const firstConfig = { agents: { defaults: { model: "openai/gpt-5.4" } } };
    const latestConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };

    const first = refreshPreparedModelRuntimeSnapshots(firstConfig);
    const latest = refreshPreparedModelRuntimeSnapshots(latestConfig);
    await Promise.all([first, latest]);

    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
    await expect(
      prepareModelRuntimeSnapshot({
        agentDir: "/tmp/unused-agent",
        config: latestConfig,
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/unused-workspace",
      }),
    ).resolves.toMatchObject({ config: latestConfig });
  });

  it("keeps replacement readers blocked when an earlier refresh is superseded", async () => {
    mocks.configuredAgentIds = ["default"];
    const initialConfig = {};
    const skippedConfig = { agents: { defaults: { model: "openai/gpt-5.4" } } };
    const latestConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(initialConfig);
    let finishLatestBuild!: () => void;
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(
      async () =>
        await new Promise<{ agentDir: string; wrote: boolean }>((resolve) => {
          finishLatestBuild = () => resolve({ agentDir: "/tmp/unused-agent", wrote: false });
        }),
    );

    markPreparedModelRuntimeSnapshotsStale("test overlapping config commit", {
      waitForReplacement: true,
    });
    const skipped = refreshPreparedModelRuntimeSnapshots(skippedConfig);
    const latest = refreshPreparedModelRuntimeSnapshots(latestConfig);
    const read = prepareModelRuntimeSnapshot({
      agentId: "default",
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/unused-workspace",
      config: latestConfig,
    });

    await skipped;
    await expect(
      Promise.race([
        read.then(
          () => "settled",
          () => "settled",
        ),
        Promise.resolve("pending"),
      ]),
    ).resolves.toBe("pending");
    finishLatestBuild();
    await latest;
    await expect(read).resolves.toMatchObject({ config: latestConfig });
  });

  it("cancels a queued generation at an external publication boundary", async () => {
    mocks.configuredAgentIds = ["default"];

    const queued = refreshPreparedModelRuntimeSnapshots({});
    markPreparedModelRuntimeSnapshotsStale("plugin publication boundary");
    await queued;

    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
  });
});
