// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { requireActivePluginRegistry } from "../plugins/runtime.js";
import { getPreparedModelRuntimeAuthStore } from "./prepared-model-runtime-auth.js";
import { startSerializedSnapshotBuild } from "./prepared-model-runtime.build.js";
import { prepareWorkspacePluginRegistries } from "./prepared-model-runtime.inbound-registry.js";
import {
  acquireAgentRunPreparedModelRuntime,
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
import { getPreparedPluginRuntimeLoadContext } from "./prepared-model-runtime.plugin-context.js";

const mocks = getPreparedModelRuntimeMocks();

describe("prepared model runtime snapshots", () => {
  beforeEach(() => {
    resetPreparedModelRuntimeHarness();
  });

  it("allows a direct serialized build without a lifecycle generation guard", async () => {
    const input = {
      config: {},
      agentDir: "/tmp/direct-prepared-model-runtime-build",
      readOnly: true,
    };
    const build = startSerializedSnapshotBuild(input, new Map(), 1_000, "static");

    await expect(build.pending).resolves.toMatchObject({
      snapshot: {
        agentDir: input.agentDir,
        config: input.config,
      },
      pluginGeneration: expect.any(Object),
    });
    await expect(build.completion).resolves.toBeUndefined();
  });

  it("materializes Claude CLI thinking capabilities on the prepared logical row", async () => {
    const modelIds = ["claude-opus-5", "claude-sonnet-5"];
    mocks.resolveStaticCatalogModel.mockImplementation(({ modelId, provider }) =>
      provider === "claude-cli"
        ? {
            provider,
            id: modelId,
            name: `${modelId} (Claude CLI)`,
            api: "anthropic-messages",
            baseUrl: "https://api.anthropic.com",
            reasoning: true,
            input: ["text" as const],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1_000_000,
            maxTokens: 128_000,
          }
        : undefined,
    );
    mocks.buildPreparedModelCatalogSnapshot.mockResolvedValue({
      entries: modelIds.map((id) => ({ provider: "anthropic", id, name: id, reasoning: false })),
      routeVariants: modelIds.map((id) => ({
        provider: "anthropic",
        id,
        name: id,
        reasoning: false,
      })),
    });
    // Raw user config permits sparse provider model overrides. This omission is
    // the contract under test: it must not become an explicit reasoning opt-out.
    const config = {
      agents: {
        defaults: {
          model: { primary: `anthropic/${modelIds[0]}` },
          models: Object.fromEntries(
            modelIds.map((modelId) => [
              `anthropic/${modelId}`,
              {
                agentRuntime: { id: "claude-cli" },
                params: { thinking: "medium" },
              },
            ]),
          ),
        },
      },
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            models: modelIds.map((id) => ({ id, name: id })),
          },
        },
      },
    } as unknown as OpenClawConfig;
    const snapshot = await publishPreparedModelRuntimeSnapshot({
      agentId: "main",
      config,
      agentDir: "/tmp/prepared-model-runtime-claude-cli-capabilities",
    });
    for (const modelId of modelIds) {
      expect(
        snapshot.modelCatalog.entries.find(
          (entry) => entry.provider === "anthropic" && entry.id === modelId,
        ),
      ).toMatchObject({ reasoning: true });
      expect(snapshot.modelCatalog.entries).not.toContainEqual(
        expect.objectContaining({ provider: "claude-cli", id: modelId }),
      );
    }
  });

  it("publishes a run owner from the caller-selected metadata generation", async () => {
    const lease = await acquireAgentRunPreparedModelRuntime(
      {
        config: {},
        agentId: "main",
        agentDir: "/tmp/selected-metadata-agent",
        workspaceDir: "/tmp/selected-metadata-workspace",
        loadRuntimePlugins: true,
        runtimePluginSelections: [{ provider: "selected", modelId: "model" }],
      },
      {
        catalogMode: "static",
        pluginMetadataSnapshot: mocks.pluginMetadataSnapshot as never,
      },
    );

    expect(lease.snapshot.metadataSnapshot).toBe(mocks.pluginMetadataSnapshot);
    lease.release();
  });

  it("keeps an isolated setup probe exact after a gateway replacement", async () => {
    mocks.configuredAgentIds = ["default"];
    const stagedConfig = { agents: { defaults: { model: "openai/gpt-5.6" } } };
    const selectedPluginRegistry = createEmptyPluginRegistry();
    selectedPluginRegistry.agentHarnesses.push({
      pluginId: "codex",
      source: "test",
      harness: {
        id: "codex",
        label: "Codex",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("unused");
        },
      },
    });
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation((params) =>
      (params as { selections?: unknown }).selections
        ? selectedPluginRegistry
        : createEmptyPluginRegistry(),
    );
    await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
    markPreparedModelRuntimeSnapshotsStale("test isolated probe replacement", {
      waitForReplacement: true,
    });
    const leasePending = acquireReadOnlyPreparedModelRuntime({
      agentId: "openclaw",
      config: stagedConfig,
      agentDir: "/tmp/setup-probe-agent",
      inheritedAuthDir: "/tmp/setup-probe-agent",
      workspaceDir: "/tmp/setup-probe-workspace",
      runtimePluginSelections: [{ provider: "openai", modelId: "gpt-5.6", runtime: "codex" }],
    });
    await Promise.resolve();
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(1);

    await refreshPreparedModelRuntimeSnapshots({
      agents: { defaults: { model: "openai/gpt-5.5" } },
    });
    const lease = await leasePending;
    expect(lease.snapshot).toMatchObject({
      agentId: "openclaw",
      config: stagedConfig,
      agentDir: "/tmp/setup-probe-agent",
      workspaceDir: "/tmp/setup-probe-workspace",
      pluginRegistry: expect.any(Object),
    });
    expect(lease.snapshot.pluginRegistry?.agentHarnesses.map((entry) => entry.harness.id)).toEqual([
      "codex",
    ]);
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledWith(
      expect.objectContaining({
        selections: [{ provider: "openai", modelId: "gpt-5.6", runtime: "codex" }],
      }),
    );
    lease.release();
  });

  it("loads provider runtime for an isolated native-harness probe", () => {
    const pluginRegistry = createEmptyPluginRegistry();
    mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(pluginRegistry);

    expect(
      prepareWorkspacePluginRegistries(
        {
          config: {},
          agentDir: "/tmp/native-provider-probe",
          readOnly: true,
          loadRuntimePlugins: true,
        },
        mocks.pluginMetadataSnapshot as never,
      ).runtimePluginRegistry,
    ).toBe(pluginRegistry);
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledWith(
      expect.objectContaining({ selections: undefined }),
    );
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
    const pluginRegistry = createEmptyPluginRegistry();
    mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValueOnce(pluginRegistry);
    mocks.discoverAuthStorage.mockImplementationOnce(() => {
      expect(requireActivePluginRegistry()).toBe(pluginRegistry);
    });
    const snapshot = await publishPreparedModelRuntimeSnapshot({
      config: {},
      agentDir: "/tmp/prepared-model-runtime-plugin-order",
      workspaceDir: "/tmp/prepared-model-runtime-plugin-workspace",
    });

    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledWith({
      config: {},
      env: process.env,
      metadataSnapshot: mocks.pluginMetadataSnapshot,
      workspaceDir: "/tmp/prepared-model-runtime-plugin-workspace",
      selections: undefined,
    });
    expect(snapshot.pluginRegistry).toBe(pluginRegistry);
    expect(mocks.loadAgentRuntimePluginRegistryHandle.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.discoverAuthStorage.mock.invocationCallOrder[0]!,
    );
  });

  it("uses an explicit lifecycle environment for catalog and auth discovery", async () => {
    const env = { NVIDIA_API_KEY: "test-nvidia-api-key" };
    const config = {};
    const snapshot = await publishPreparedModelRuntimeSnapshot({
      config,
      agentDir: "/tmp/prepared-model-runtime-explicit-env",
      env,
    });

    expect(getPreparedPluginRuntimeLoadContext(snapshot.pluginRegistry)).toMatchObject({
      rawConfig: config,
      env,
    });

    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledWith(
      config,
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

  it("keeps provider catalog outcomes on the published live snapshot", async () => {
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[2] as {
        onProviderCatalogOutcome?: (outcome: {
          provider: string;
          status: "ready" | "auth-rejected" | "unavailable";
        }) => void;
      };
      options.onProviderCatalogOutcome?.({ provider: "openai", status: "auth-rejected" });
      return { agentDir: "/tmp/provider-outcome-agent", wrote: false };
    });

    const snapshot = await publishPreparedModelRuntimeSnapshot({
      config: {},
      agentDir: "/tmp/provider-outcome-agent",
    });

    expect(snapshot.modelCatalog.providerOutcomes).toEqual([
      { provider: "openai", status: "auth-rejected" },
    ]);
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

    expect(mocks.loadStaticCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {},
        env: process.env,
        metadataSnapshot: snapshot.metadataSnapshot,
        workspaceDir: "/tmp/prepared-model-runtime-static-workspace",
      }),
    );
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

  it("publishes configured manifest model capabilities without a provider discovery entry", async () => {
    const runtimeModel = {
      provider: "openai",
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text" as const, "image" as const],
      cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    };
    mocks.resolveStaticCatalogModel.mockReturnValueOnce(runtimeModel);
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: { "openai/gpt-5.4": {} },
        },
        entries: {
          qa: { default: true, model: { primary: "openai/gpt-5.4" } },
        },
      },
    };

    const snapshot = await publishPreparedModelRuntimeSnapshot({
      agentId: "qa",
      config,
      agentDir: "/tmp/prepared-model-runtime-manifest-qa",
      workspaceDir: "/tmp/prepared-model-runtime-manifest-workspace",
    });

    expect(mocks.loadStaticCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: config,
        env: process.env,
        metadataSnapshot: snapshot.metadataSnapshot,
        workspaceDir: "/tmp/prepared-model-runtime-manifest-workspace",
      }),
    );
    expect(mocks.createStaticCatalogResolver).toHaveBeenCalledOnce();
    expect(mocks.createStaticCatalogResolver).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: config,
        env: process.env,
        includeRuntimeDiscovery: true,
        metadataSnapshot: snapshot.metadataSnapshot,
        workspaceDir: "/tmp/prepared-model-runtime-manifest-workspace",
      }),
    );
    expect(mocks.resolveStaticCatalogModel).toHaveBeenCalledTimes(2);
    expect(snapshot.agentId).toBe("qa");
    expect(snapshot.configuredRuntimeModels).toEqual([
      { provider: "openai", modelId: "gpt-5.4", model: runtimeModel },
    ]);
    expect(snapshot.modelCatalog.entries).toEqual([]);
    expect(snapshot.modelCatalog.staticEntries).toEqual([
      {
        provider: "openai",
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 1_050_000,
        reasoning: true,
        input: ["text", "image"],
      },
    ]);
  });

  it("retains full configured static models with request-time catalog precedence", async () => {
    const runtimeModel = {
      provider: "nvidia",
      id: "nemotron-static",
      name: "Nemotron Static",
      api: "openai-completions" as const,
      baseUrl: "https://integrate.api.nvidia.com/v1",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    };
    mocks.loadStaticCatalog.mockResolvedValueOnce([
      {
        ...runtimeModel,
        baseUrl: "https://provider-static.example.test/v1",
      },
    ]);
    mocks.resolveStaticCatalogModel.mockReturnValueOnce(runtimeModel);

    const snapshot = await publishPreparedModelRuntimeSnapshot({
      config: { agents: { defaults: { model: { primary: "nvidia/nemotron-static" } } } },
      agentDir: "/tmp/prepared-model-runtime-configured-static",
      workspaceDir: "/tmp/prepared-model-runtime-configured-static-workspace",
    });

    expect(snapshot.configuredRuntimeModels).toEqual([
      { provider: "nvidia", modelId: "nemotron-static", model: runtimeModel },
    ]);
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

  it("prepares inline provider models once at the snapshot boundary", async () => {
    const snapshot = await publishPreparedModelRuntimeSnapshot({
      config: {
        models: {
          providers: {
            custom: {
              baseUrl: "https://custom.example.test/v1",
              api: "openai-responses",
              models: [
                {
                  id: "custom-model",
                  name: "Custom Model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 8_192,
                },
              ],
            },
          },
        },
      },
      agentDir: "/tmp/prepared-model-runtime-inline",
    });

    expect(snapshot.inlineProviderModels).toMatchObject([
      {
        provider: "custom",
        id: "custom-model",
        baseUrl: "https://custom.example.test/v1",
        api: "openai-responses",
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
    expect(mocks.planOpenClawModelsJsonSource).not.toHaveBeenCalled();
    expect(mocks.loadAgentRuntimePluginRegistryHandle).not.toHaveBeenCalled();
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
    expect(mocks.discoverAuthStorage).toHaveBeenCalledOnce();
    expect(getPreparedModelRuntimeAuthStore(credentialFree)).toEqual({ version: 1, profiles: {} });
  });

  it("reuses one lifecycle-owned snapshot without rediscovering files", async () => {
    const config = {};
    const input = { config, agentDir: "/tmp/prepared-model-runtime-reuse" };

    const first = await publishPreparedModelRuntimeSnapshot(input);
    const second = await prepareModelRuntimeSnapshot(input);

    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.authModes).toEqual({ custom: "api_key" });
    expect(Object.isFrozen(first.authModes)).toBe(true);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(1);
    expect(mocks.discoverAuthStorage).toHaveBeenCalledTimes(1);
    expect(mocks.resolveAmbientCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.discoverModels).toHaveBeenCalledTimes(1);
    expect(mocks.buildPreparedModelCatalogSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ authCredentials: mocks.authStorage.getAll() }),
    );
    const firstStores = first.createStores();
    const secondStores = first.createStores();
    expect(secondStores.authStorage).not.toBe(firstStores.authStorage);
    expect(secondStores.modelRegistry).not.toBe(firstStores.modelRegistry);
  });

  it.each([
    {
      label: "usable",
      credential: { type: "oauth", access: "a", refresh: "r", expires: 1 },
      expected: "oauth",
    },
    {
      label: "unusable",
      credential: { type: "oauth", access: "", refresh: "", expires: 0 },
      expected: undefined,
    },
  ] as const)(
    "consumes $label startup CLI hydration without rediscovery",
    async ({ credential, expected }) => {
      const config = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
            models: { "openai/gpt-5.4": {} },
          },
        },
      };
      mocks.authStorage.getAll.mockReturnValue({ openai: credential });

      const snapshot = await publishPreparedModelRuntimeSnapshot({
        config,
        agentDir: "/tmp/prepared-model-runtime-cli-startup",
      });

      const discoveryOptions = mocks.discoverAuthStorage.mock.calls[0]?.[1] as {
        externalCli?: unknown;
      };
      expect(discoveryOptions.externalCli).toBeUndefined();
      expect(snapshot.authModes.openai).toBe(expected);
    },
  );

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
    let finishLatestBuild: (() => void) | undefined;
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
    await vi.waitFor(() => expect(finishLatestBuild).toEqual(expect.any(Function)));
    finishLatestBuild?.();
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
