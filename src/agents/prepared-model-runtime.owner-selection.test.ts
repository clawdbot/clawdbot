// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeMocks,
  getPreparedModelRuntimeTestApi,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  acquireAgentRunPreparedModelRuntime,
  getPreparedModelRuntimeSnapshot,
  loadPublishedGatewayReplyDispatchRuntime,
  loadPreparedModelRuntimeSnapshot,
  prepareModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();

describe("prepared model runtime owner selection", () => {
  beforeEach(() => {
    resetPreparedModelRuntimeHarness();
  });

  it("serializes live catalog sources for owners sharing one agent directory", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shared-catalog-source-"));
    try {
      const agentDir = path.join(rootDir, "agent");
      fs.mkdirSync(agentDir);
      mocks.configuredAgentIds = ["agent-a", "agent-b"];
      mocks.configuredAgentDirs.set("agent-a", agentDir);
      mocks.configuredAgentDirs.set("agent-b", agentDir);
      mocks.configuredWorkspaces.set("agent-a", "/tmp/source-workspace-a");
      mocks.configuredWorkspaces.set("agent-b", "/tmp/source-workspace-b");
      let activeWrites = 0;
      let peakActiveWrites = 0;
      mocks.ensureOpenClawModelsJson.mockImplementation(async (_config, targetDir, options) => {
        activeWrites += 1;
        peakActiveWrites = Math.max(peakActiveWrites, activeWrites);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        const workspaceDir = (options as { workspaceDir?: string }).workspaceDir ?? "unknown";
        fs.writeFileSync(
          path.join(String(targetDir), "models.json"),
          JSON.stringify({
            providers: {
              custom: {
                api: "openai-completions",
                baseUrl: "https://models.example/v1",
                models: [{ id: path.basename(workspaceDir) }],
              },
            },
          }),
        );
        activeWrites -= 1;
        return { agentDir: String(targetDir), wrote: true };
      });

      await refreshPreparedModelRuntimeSnapshots({});

      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
      expect(peakActiveWrites).toBe(1);
      expect(
        mocks.discoverModels.mock.calls.map((call) => {
          const contents = (call[2] as { modelsJsonContents: string }).modelsJsonContents;
          const parsed = JSON.parse(contents) as {
            providers: { custom: { models: Array<{ id: string }> } };
          };
          return parsed.providers.custom.models[0]?.id;
        }),
      ).toEqual(["source-workspace-a", "source-workspace-b"]);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("finds the configured gateway owner when request config omits its launch workspace", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = retainLegacyDefaultAgentId({ agents: { entries: { default: {} } } }, "default");

    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      defaultWorkspaceDir: "/tmp/gateway-launch-workspace",
    });
    const snapshot = await prepareModelRuntimeSnapshot({
      config,
      agentDir: "/tmp/unused-agent",
    });

    expect(snapshot.workspaceDir).toBe("/tmp/gateway-launch-workspace");
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
  });

  it("resolves a gateway-published owner for readers that omit the binding flag", async () => {
    // Gateway startup publishes configured owners with allowGatewaySubagentBinding,
    // a publication-time build capability. Readers (models.list, catalog loads)
    // cannot know it, so an absent flag is a wildcard in fallback resolution;
    // requiring equality made every flagless read miss the configured owner and
    // rebuild a live ephemeral catalog per request. A reader that explicitly
    // demands binding still never receives a non-binding owner.
    mocks.configuredAgentIds = ["default"];
    const config = retainLegacyDefaultAgentId(
      { agents: { defaults: { model: "openai/gpt-5.5" }, entries: { default: {} } } },
      "default",
    );
    await refreshPreparedModelRuntimeSnapshots(config, {
      allowGatewaySubagentBinding: true,
      catalogMode: "static",
      gatewayLifecycle: true,
      defaultWorkspaceDir: "/tmp/gateway-launch-workspace",
    });
    const request = {
      config,
      agentId: "default",
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/gateway-launch-workspace",
    };

    await expect(
      loadPreparedModelRuntimeSnapshot({ ...request, allowGatewaySubagentBinding: true }),
    ).resolves.toMatchObject({ config });
    await expect(loadPreparedModelRuntimeSnapshot(request)).resolves.toMatchObject({ config });
  });

  it("does not resolve a binding-demanding reader against a non-binding owner", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = retainLegacyDefaultAgentId(
      { agents: { defaults: { model: "openai/gpt-5.5" }, entries: { default: {} } } },
      "default",
    );
    await refreshPreparedModelRuntimeSnapshots(config, {
      catalogMode: "static",
      gatewayLifecycle: true,
      defaultWorkspaceDir: "/tmp/gateway-launch-workspace",
    });

    await expect(
      prepareModelRuntimeSnapshot({
        config,
        agentId: "default",
        agentDir: "/tmp/unused-agent",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/gateway-launch-workspace",
        allowGatewaySubagentBinding: true,
      }),
    ).rejects.toThrow("prepared model runtime owner was not published");
  });

  it("publishes provider selections kept on the core runtime by request parameters", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {
      agents: {
        defaults: {
          model: "openai/gpt-5",
          models: {
            "openai/gpt-5": { params: { transport: "sse", openaiWsWarmup: false } },
          },
        },
      },
    };

    await refreshPreparedModelRuntimeSnapshots(config, {
      catalogMode: "static",
      gatewayLifecycle: true,
    });

    expect(
      mocks.loadAgentRuntimePluginRegistryHandle.mock.calls.map((call) => call[0].selections),
    ).toContainEqual([{ provider: "openai", modelId: "gpt-5", runtime: "openclaw" }]);
  });

  it("reuses the configured owner for its prepared plugin harness selections", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() =>
      createEmptyPluginRegistry(),
    );
    await refreshPreparedModelRuntimeSnapshots(config, {
      allowGatewaySubagentBinding: true,
      catalogMode: "static",
      gatewayLifecycle: true,
    });
    const configured = getPreparedModelRuntimeSnapshot({
      agentId: "default",
      agentDir: "/tmp/unused-agent",
      allowGatewaySubagentBinding: true,
      config,
      workspaceDir: "/tmp/unused-workspace",
    });

    const runInput = {
      agentId: "default",
      agentDir: "/tmp/unused-agent",
      allowGatewaySubagentBinding: true,
      config,
      runtimePluginSelections: [{ provider: "openai", modelId: "gpt-5.5", runtime: "codex" }],
      workspaceDir: "/tmp/unused-workspace",
    };
    const first = await acquireAgentRunPreparedModelRuntime(runInput);
    first.release();
    const second = await acquireAgentRunPreparedModelRuntime(runInput);
    second.release();

    expect(first.snapshot).toBe(configured);
    expect(second.snapshot).toBe(first.snapshot);
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(2);
    expect(mocks.loadAgentRuntimePluginRegistryHandle.mock.calls[0]?.[0]).not.toHaveProperty(
      "selections",
    );
    expect(mocks.loadAgentRuntimePluginRegistryHandle.mock.calls[1]?.[0]).toMatchObject({
      selections: [{ provider: "openai", modelId: "gpt-5.5", runtime: "codex" }],
    });
    const dispatchRuntime = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
    expect(dispatchRuntime?.inboundPluginRegistry).toBeDefined();
    expect(configured?.pluginRegistry).not.toBe(dispatchRuntime?.inboundPluginRegistry);
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledOnce();
    expect(mocks.discoverModels).toHaveBeenCalledOnce();
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
  });

  it("sequences pending owners by their explicit plugin generation", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const generationA = (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }))
      ?.pluginGeneration;
    expect(generationA).toBeDefined();
    const generationB = {
      ...generationA!,
      pluginMetadataSnapshot: { ...generationA!.pluginMetadataSnapshot },
    };
    let finishGenerationA!: () => void;
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(
      async () =>
        await new Promise<{ agentDir: string; wrote: false }>((resolve) => {
          finishGenerationA = () =>
            resolve({ agentDir: "/tmp/dynamic-generation-agent", wrote: false });
        }),
    );
    const input = {
      config,
      agentId: "default",
      agentDir: "/tmp/dynamic-generation-agent",
      workspaceDir: "/tmp/dynamic-generation-workspace",
    };

    const pendingA = acquireAgentRunPreparedModelRuntime(input, {
      pluginGeneration: generationA!,
    });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    const matchingPendingA = acquireAgentRunPreparedModelRuntime(input, {
      pluginGeneration: generationA!,
    });
    const pendingB = acquireAgentRunPreparedModelRuntime(input, {
      pluginGeneration: generationB,
    });
    await Promise.resolve();
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    finishGenerationA();
    const [leaseA, matchingLeaseA, leaseB] = await Promise.all([
      pendingA,
      matchingPendingA,
      pendingB,
    ]);

    expect(matchingLeaseA.snapshot).toBe(leaseA.snapshot);
    expect(leaseB.snapshot).not.toBe(leaseA.snapshot);
    expect(leaseA.snapshot.metadataSnapshot).toBe(generationA!.pluginMetadataSnapshot);
    expect(leaseB.snapshot.metadataSnapshot).toBe(generationB.pluginMetadataSnapshot);
    leaseA.release();
    matchingLeaseA.release();
    await expect(prepareModelRuntimeSnapshot(input)).resolves.toBe(leaseB.snapshot);
    leaseB.release();
  });

  it("bounds retained gateway run owners while reusing recent selections", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(config, {
      catalogMode: "static",
      gatewayLifecycle: true,
    });
    const acquire = async (modelId: string) => {
      const lease = await acquireAgentRunPreparedModelRuntime({
        agentId: "default",
        agentDir: "/tmp/unused-agent",
        config,
        runtimePluginSelections: [{ provider: "openai", modelId, runtime: "codex" }],
        workspaceDir: "/tmp/unused-workspace",
      });
      lease.release();
      return lease.snapshot;
    };

    const first = await acquire("run-model-0");
    for (let index = 1; index < 9; index += 1) {
      await acquire(`run-model-${index}`);
    }
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(11);

    const rebuilt = await acquire("run-model-0");
    expect(rebuilt).not.toBe(first);
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(12);
  });

  it("never evicts a configured owner acquired through the gateway run path", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(config, {
      catalogMode: "static",
      gatewayLifecycle: true,
    });
    const configuredInput = {
      agentId: "default",
      agentDir: "/tmp/unused-agent",
      config,
      runtimePluginSelections: [{ provider: "openai", modelId: "gpt-5.5", runtime: "codex" }],
      workspaceDir: "/tmp/unused-workspace",
    };
    const configured = getPreparedModelRuntimeSnapshot(configuredInput);
    const configuredLease = await acquireAgentRunPreparedModelRuntime(configuredInput);
    expect(configuredLease.snapshot).toBe(configured);
    configuredLease.release();

    for (let index = 0; index < 9; index += 1) {
      const lease = await acquireAgentRunPreparedModelRuntime({
        ...configuredInput,
        runtimePluginSelections: [
          { provider: "openai", modelId: `run-model-${index}`, runtime: "codex" },
        ],
      });
      lease.release();
    }

    expect(getPreparedModelRuntimeSnapshot(configuredInput)).toBe(configured);
  });

  it("retires released retained run owners when gateway refresh clears the lifecycle", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(config, {
      catalogMode: "static",
      gatewayLifecycle: true,
    });
    for (let index = 0; index < 3; index += 1) {
      const lease = await acquireAgentRunPreparedModelRuntime({
        agentId: "default",
        agentDir: "/tmp/unused-agent",
        config,
        runtimePluginSelections: [
          { provider: "openai", modelId: `retained-model-${index}`, runtime: "codex" },
        ],
        workspaceDir: "/tmp/unused-workspace",
      });
      lease.release();
    }
    expect(getPreparedModelRuntimeTestApi().getPreparedModelRuntimeOwnerCountForTest()).toBe(4);

    const refreshError = new Error("configured owner discovery failed");
    mocks.configuredAgentIdsError = refreshError;
    await expect(refreshPreparedModelRuntimeSnapshots(config)).rejects.toBe(refreshError);

    expect(getPreparedModelRuntimeTestApi().getPreparedModelRuntimeOwnerCountForTest()).toBe(1);
  });

  it("does not substitute a configured owner captured from another environment", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      defaultWorkspaceDir: "/tmp/gateway-launch-workspace",
    });

    await expect(
      prepareModelRuntimeSnapshot({
        config,
        agentDir: "/tmp/unused-agent",
        env: { ...process.env, OPENCLAW_PREPARED_RUNTIME_TEST_SCOPE: "different" },
      }),
    ).rejects.toThrow("prepared model runtime owner was not published");
  });

  it("does not substitute a configured owner for an explicit workspace", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};

    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      defaultWorkspaceDir: "/tmp/gateway-launch-workspace",
    });

    await expect(
      prepareModelRuntimeSnapshot({
        config,
        agentDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/other-explicit-workspace",
      }),
    ).rejects.toThrow("prepared model runtime owner was not published");
  });

  it("does not choose between configured owners sharing one agent directory", async () => {
    const config = {};
    const agentDir = "/tmp/shared-configured-agent";
    await publishPreparedModelRuntimeSnapshot(
      { config, agentDir, workspaceDir: "/tmp/shared-workspace-a" },
      { provenance: "configured" },
    );
    await publishPreparedModelRuntimeSnapshot(
      { config, agentDir, workspaceDir: "/tmp/shared-workspace-b" },
      { provenance: "configured" },
    );

    await expect(prepareModelRuntimeSnapshot({ config, agentDir })).rejects.toThrow(
      "prepared model runtime owner was not published",
    );
  });

  it("selects a configured owner by agent id when directories are shared", async () => {
    const config = {};
    const agentDir = "/tmp/shared-agent-id-directory";
    await publishPreparedModelRuntimeSnapshot(
      { agentId: "agent-a", config, agentDir, workspaceDir: "/tmp/shared-agent-id-workspace" },
      { provenance: "configured" },
    );
    const selected = await publishPreparedModelRuntimeSnapshot(
      { agentId: "agent-b", config, agentDir, workspaceDir: "/tmp/shared-agent-id-workspace" },
      { provenance: "configured" },
    );

    await expect(
      prepareModelRuntimeSnapshot({ agentId: "agent-b", config, agentDir }),
    ).resolves.toBe(selected);
  });

  it("retires configured owners removed by config reload", async () => {
    mocks.configuredAgentIds = ["default", "removed"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config);
    mocks.configuredAgentIds = ["default"];

    await refreshPreparedModelRuntimeSnapshots(config);

    await expect(
      prepareModelRuntimeSnapshot({
        config,
        agentDir: "/tmp/configured-removed",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/workspace-removed",
      }),
    ).rejects.toThrow("prepared model runtime owner was not published");
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3);
  });

  it("shares static workspace facts without eager per-agent catalog work", async () => {
    mocks.configuredAgentIds = ["agent-a", "agent-b", "agent-c", "agent-d"];
    for (const agentId of ["agent-a", "agent-b", "agent-c"]) {
      mocks.configuredWorkspaces.set(agentId, "/tmp/shared-prepared-runtime-workspace");
    }
    mocks.configuredWorkspaces.set("agent-d", "/tmp/distinct-prepared-runtime-workspace");
    const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    let stats:
      | {
          agentCount: number;
          workspaceGroupCount: number;
          configuredFactsGroupCount: number;
          catalogSourceCount: number;
          catalogGroupCount: number;
          runtimeRegistryCount: number;
          fullCatalogConcurrencyLimit: number;
        }
      | undefined;

    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      onBuildStats: (value) => {
        stats = value;
      },
    });

    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(4);
    expect(mocks.resolveAmbientCredentials).toHaveBeenCalledTimes(2);
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(2);
    expect(mocks.resolveStaticCatalogModel).toHaveBeenCalledTimes(2);
    expect(mocks.buildPreparedModelCatalogSnapshot).not.toHaveBeenCalled();
    expect(mocks.discoverModels).toHaveBeenCalledTimes(2);
    expect(stats).toMatchObject({
      agentCount: 4,
      workspaceGroupCount: 2,
      configuredFactsGroupCount: 2,
      catalogSourceCount: 0,
      catalogGroupCount: 0,
      runtimeRegistryCount: 2,
      fullCatalogConcurrencyLimit: 1,
    });

    const snapshot = getPreparedModelRuntimeSnapshot({
      agentId: "agent-a",
      config,
      agentDir: "/tmp/configured-agent-a",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/shared-prepared-runtime-workspace",
    });
    await snapshot?.loadFullModelCatalog?.();
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce();
  });

  it("shares workspace facts while isolating each agent's configured model projection", async () => {
    mocks.configuredAgentIds = ["agent-a", "agent-b"];
    for (const agentId of mocks.configuredAgentIds) {
      mocks.configuredWorkspaces.set(agentId, "/tmp/shared-agent-model-workspace");
    }
    mocks.resolveStaticCatalogModel.mockImplementation(
      ({ provider, modelId }: { provider: string; modelId: string }) => ({
        id: modelId,
        name: modelId,
        provider,
        api: "openai-completions",
        baseUrl: "https://models.example/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      }),
    );
    const config = {
      agents: {
        defaults: { model: "custom/shared-model" },
        list: [
          { id: "agent-a", model: "custom/model-a" },
          { id: "agent-b", model: "custom/model-b" },
        ],
      },
    };

    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });

    for (const agentId of mocks.configuredAgentIds) {
      const snapshot = getPreparedModelRuntimeSnapshot({
        agentId,
        config,
        agentDir: `/tmp/configured-${agentId}`,
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/shared-agent-model-workspace",
      });
      expect(snapshot?.configuredRuntimeModels.map(({ modelId }) => modelId)).toEqual([
        "shared-model",
        agentId === "agent-a" ? "model-a" : "model-b",
      ]);
      expect(snapshot?.modelCatalog.entries.map(({ id }) => id)).not.toContain(
        agentId === "agent-a" ? "model-b" : "model-a",
      );
    }
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledOnce();
  });

  it("parses one static registry per exact agent catalog and credential generation", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-prepared-registry-groups-"));
    try {
      mocks.configuredAgentIds = ["agent-a", "agent-b", "agent-c"];
      for (const agentId of mocks.configuredAgentIds) {
        const agentDir = path.join(rootDir, agentId);
        fs.mkdirSync(agentDir, { recursive: true });
        mocks.configuredAgentDirs.set(agentId, agentDir);
        mocks.configuredWorkspaces.set(agentId, "/tmp/shared-prepared-runtime-workspace");
      }
      const sharedCatalog = JSON.stringify({
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: "https://models.example/v1",
            models: [{ id: "shared-model" }],
          },
        },
      });
      fs.writeFileSync(path.join(rootDir, "agent-a", "models.json"), sharedCatalog);
      fs.writeFileSync(path.join(rootDir, "agent-b", "models.json"), sharedCatalog);
      fs.writeFileSync(
        path.join(rootDir, "agent-c", "models.json"),
        JSON.stringify({
          providers: {
            custom: {
              api: "openai-completions",
              baseUrl: "https://models.example/v1",
              models: [{ id: "distinct-model" }],
            },
          },
        }),
      );
      let runtimeRegistryCount = 0;

      await refreshPreparedModelRuntimeSnapshots(
        { agents: { defaults: { model: "openai/gpt-5.5" } } },
        {
          gatewayLifecycle: true,
          catalogMode: "static",
          onBuildStats: (stats) => {
            runtimeRegistryCount = stats.runtimeRegistryCount;
          },
        },
      );

      expect(mocks.discoverModels).toHaveBeenCalledTimes(2);
      expect(runtimeRegistryCount).toBe(2);
      expect(
        mocks.discoverModels.mock.calls.map((call) => {
          const options = call.length === 2 ? call[1] : call[2];
          return (options as { modelsJsonContents?: string }).modelsJsonContents;
        }),
      ).toEqual(expect.arrayContaining([sharedCatalog, expect.stringContaining("distinct-model")]));
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("keeps registry parsing isolated across OAuth provider generations", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-prepared-oauth-groups-"));
    try {
      mocks.configuredAgentIds = ["agent-a", "agent-b", "agent-c"];
      const sharedCatalog = JSON.stringify({
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: "https://models.example/v1",
            models: [{ id: "shared-model" }],
          },
        },
      });
      const sharedProvider = {
        id: "custom",
        name: "OAuth A",
        login: vi.fn(),
        refreshToken: vi.fn(),
        getApiKey: vi.fn(),
      };
      const oauthProviders = {
        "agent-a": sharedProvider,
        "agent-b": { ...sharedProvider },
        "agent-c": { ...sharedProvider, name: "OAuth B", modifyModels: vi.fn() },
      };
      for (const agentId of mocks.configuredAgentIds) {
        const agentDir = path.join(rootDir, agentId);
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(path.join(agentDir, "models.json"), sharedCatalog);
        mocks.configuredAgentDirs.set(agentId, agentDir);
        mocks.configuredWorkspaces.set(agentId, "/tmp/shared-prepared-runtime-workspace");
      }
      mocks.discoverAuthStorage.mockImplementation((agentDir: unknown) => {
        const agentId = path.basename(String(agentDir)) as keyof typeof oauthProviders;
        return {
          getAll: () => ({ custom: { type: "api_key" as const, key: "shared-key" } }),
          getOAuthProviders: () => [oauthProviders[agentId]],
        };
      });
      let runtimeRegistryCount = 0;

      await refreshPreparedModelRuntimeSnapshots(
        { agents: { defaults: { model: "openai/gpt-5.5" } } },
        {
          gatewayLifecycle: true,
          catalogMode: "static",
          onBuildStats: (stats) => {
            runtimeRegistryCount = stats.runtimeRegistryCount;
          },
        },
      );

      expect(mocks.discoverModels).toHaveBeenCalledTimes(2);
      expect(runtimeRegistryCount).toBe(2);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("serializes on-demand full catalogs across prepared owners", async () => {
    mocks.configuredAgentIds = ["agent-a", "agent-b"];
    mocks.configuredWorkspaces.set("agent-a", "/tmp/shared-prepared-runtime-workspace");
    mocks.configuredWorkspaces.set("agent-b", "/tmp/shared-prepared-runtime-workspace");
    mocks.discoverAuthStorage.mockImplementation((agentDir: unknown) => ({
      getAll: () => ({
        custom: { type: "api_key" as const, key: `test-key:${String(agentDir)}` },
      }),
      getOAuthProviders: () => [],
    }));
    let activePlans = 0;
    let peakActivePlans = 0;
    mocks.runPreparedModelCatalogWorker.mockImplementation(async () => {
      activePlans += 1;
      peakActivePlans = Math.max(peakActivePlans, activePlans);
      await Promise.resolve();
      activePlans -= 1;
      return { entries: [], routeVariants: [] };
    });
    const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };

    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });

    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(2);
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledOnce();
    expect(mocks.discoverModels).toHaveBeenCalledTimes(2);
    const loadAgentCatalog = (agentId: string) =>
      getPreparedModelRuntimeSnapshot({
        agentId,
        config,
        agentDir: `/tmp/configured-${agentId}`,
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/shared-prepared-runtime-workspace",
      })?.loadFullModelCatalog?.();
    await Promise.all([loadAgentCatalog("agent-a"), loadAgentCatalog("agent-b")]);

    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(2);
    expect(peakActivePlans).toBe(1);
  });

  it("serializes a lazy catalog plan before a superseding generation", async () => {
    mocks.configuredAgentIds = ["agent-a"];
    mocks.configuredWorkspaces.set("agent-a", "/tmp/shared-prepared-runtime-workspace");
    const initialConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const snapshot = getPreparedModelRuntimeSnapshot({
      agentId: "agent-a",
      config: initialConfig,
      agentDir: "/tmp/configured-agent-a",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/shared-prepared-runtime-workspace",
    });
    let releaseLazyPlan: (() => void) | undefined;
    mocks.runPreparedModelCatalogWorker.mockImplementation(async () => {
      if (!releaseLazyPlan) {
        await new Promise<void>((resolve) => {
          releaseLazyPlan = resolve;
        });
      }
      return { entries: [], routeVariants: [] };
    });

    const staleCatalogLoad = snapshot?.loadFullModelCatalog?.();
    await vi.waitFor(() => expect(releaseLazyPlan).toBeTypeOf("function"));
    const replacement = refreshPreparedModelRuntimeSnapshots(
      { agents: { defaults: { model: "openai/gpt-5.6" } } },
      { gatewayLifecycle: true, catalogMode: "live" },
    );
    await Promise.resolve();
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce();
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();

    releaseLazyPlan?.();
    await expect(staleCatalogLoad).rejects.toThrow("superseded");
    await replacement;
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce();
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
  });

  it("stops a superseded same-directory batch before another catalog write", async () => {
    mocks.configuredAgentIds = ["agent-a", "agent-b"];
    for (const agentId of mocks.configuredAgentIds) {
      mocks.configuredAgentDirs.set(agentId, "/tmp/shared-catalog-agent-dir");
      mocks.configuredWorkspaces.set(agentId, `/tmp/catalog-workspace-${agentId}`);
    }
    const staleConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    const latestConfig = { agents: { defaults: { model: "openai/gpt-5.6" } } };
    let releaseStaleWrite: (() => void) | undefined;
    mocks.ensureOpenClawModelsJson.mockImplementation(async (config) => {
      if (config === staleConfig && !releaseStaleWrite) {
        await new Promise<void>((resolve) => {
          releaseStaleWrite = resolve;
        });
      }
      return { agentDir: "/tmp/shared-catalog-agent-dir", wrote: false };
    });

    const stale = refreshPreparedModelRuntimeSnapshots(staleConfig);
    await vi.waitFor(() => expect(releaseStaleWrite).toBeTypeOf("function"));
    const latest = refreshPreparedModelRuntimeSnapshots(latestConfig);
    releaseStaleWrite?.();

    await expect(stale).rejects.toThrow("superseded");
    await latest;
    expect(
      mocks.ensureOpenClawModelsJson.mock.calls.filter(([config]) => config === staleConfig),
    ).toHaveLength(1);
    expect(
      mocks.ensureOpenClawModelsJson.mock.calls.filter(([config]) => config === latestConfig),
    ).toHaveLength(2);
  });

  it("publishes a current sibling when another auth owner is superseded", async () => {
    const config = {};
    const supersededDir = "/tmp/prepared-model-runtime-auth-retry-superseded";
    const siblingDir = "/tmp/prepared-model-runtime-auth-retry-sibling";
    await publishPreparedModelRuntimeSnapshot({ config, agentDir: supersededDir });
    const firstSibling = await publishPreparedModelRuntimeSnapshot({
      config,
      agentDir: siblingDir,
    });
    let releaseSupersededRefresh: (() => void) | undefined;
    let blockedSupersededRefresh = true;
    mocks.ensureOpenClawModelsJson.mockImplementation(async (_config, agentDir) => {
      if (agentDir === supersededDir && blockedSupersededRefresh) {
        blockedSupersededRefresh = false;
        await new Promise<void>((resolve) => {
          releaseSupersededRefresh = resolve;
        });
      }
      return { agentDir: String(agentDir), wrote: false };
    });

    mocks.mutationListener?.({ affectsInheritedStores: true });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(4));
    const siblingPending = publishPreparedModelRuntimeSnapshot({
      config,
      agentDir: siblingDir,
    });
    mocks.mutationListener?.({ agentDir: supersededDir, affectsInheritedStores: false });
    releaseSupersededRefresh?.();

    await expect(siblingPending).resolves.not.toBe(firstSibling);
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(6));
    await expect(
      prepareModelRuntimeSnapshot({ config, agentDir: supersededDir }),
    ).resolves.toMatchObject({ agentDir: supersededDir });
  });
});
