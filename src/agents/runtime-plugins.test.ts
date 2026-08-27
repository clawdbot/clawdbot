// Verifies agent runtime plugin loads stay scoped to prepared-runtime handles.
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  loadPluginMetadataSnapshot: vi.fn(),
  getCurrentPluginMetadataSnapshot: vi.fn(),
  getActivePluginRegistry: vi.fn(),
  getActivePluginRegistryWorkspaceDir: vi.fn(),
  getActivePluginRuntimeSubagentMode: vi.fn(),
  loadPluginRegistryHandle: vi.fn(),
  adoptRuntimeContextEngineRegistrations: vi.fn((target: unknown) => target),
  adoptRuntimeWidgetPresenterRegistrations: vi.fn((target: unknown) => target),
  resolveAgentRuntimePluginLoadPlan: vi.fn(),
  resolveAgentRuntimePluginSelections: vi.fn(
    (_config: unknown, selections: readonly unknown[]) => selections,
  ),
}));

vi.mock("../context-engine/registry.js", () => ({
  adoptRuntimeContextEngineRegistrations: hoisted.adoptRuntimeContextEngineRegistrations,
}));

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRegistry: hoisted.getActivePluginRegistry,
  getActivePluginRegistryWorkspaceDir: hoisted.getActivePluginRegistryWorkspaceDir,
  getActivePluginRuntimeSubagentMode: hoisted.getActivePluginRuntimeSubagentMode,
}));

vi.mock("../plugins/widget-presenters.js", () => ({
  adoptRuntimeWidgetPresenterRegistrations: hoisted.adoptRuntimeWidgetPresenterRegistrations,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: hoisted.loadPluginMetadataSnapshot,
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: hoisted.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../plugins/loader.js", () => ({
  loadPluginRegistryHandle: hoisted.loadPluginRegistryHandle,
}));

vi.mock("./harness/runtime-plugin-load-plan.js", () => ({
  resolveAgentRuntimePluginLoadPlan: hoisted.resolveAgentRuntimePluginLoadPlan,
  resolveAgentRuntimePluginSelections: hoisted.resolveAgentRuntimePluginSelections,
}));

import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  createPreparedInboundRegistryLoader,
  prepareWorkspacePluginRegistries,
} from "./prepared-model-runtime.inbound-registry.js";
import {
  loadAgentRuntimePluginRegistryHandle,
  withAgentPluginRegistry,
} from "./runtime-plugins.js";

function createMetadataSnapshot(
  workspaceDir = "/tmp/gateway-workspace",
  pluginIds: string[] | undefined = ["telegram", "memory-core"],
) {
  return {
    workspaceDir,
    index: { installRecords: {}, plugins: [] },
    manifestRegistry: { diagnostics: [], plugins: [] },
    discovery: { candidates: [], diagnostics: [] },
    pluginIds,
  };
}

describe("agent runtime plugin registries", () => {
  beforeEach(() => {
    hoisted.loadPluginMetadataSnapshot
      .mockReset()
      .mockImplementation((params: { workspaceDir?: string }) => ({
        ...createMetadataSnapshot(params.workspaceDir),
        pluginIds: undefined,
      }));
    hoisted.getCurrentPluginMetadataSnapshot.mockReset().mockReturnValue(undefined);
    hoisted.getActivePluginRegistry.mockReset().mockReturnValue(undefined);
    hoisted.getActivePluginRegistryWorkspaceDir.mockReset().mockReturnValue(undefined);
    hoisted.getActivePluginRuntimeSubagentMode.mockReset().mockReturnValue("default");
    hoisted.loadPluginRegistryHandle.mockReset().mockReturnValue({ handle: true });
    hoisted.adoptRuntimeContextEngineRegistrations
      .mockReset()
      .mockImplementation((target) => target);
    hoisted.adoptRuntimeWidgetPresenterRegistrations
      .mockReset()
      .mockImplementation((target) => target);
    hoisted.resolveAgentRuntimePluginLoadPlan.mockReset().mockImplementation(({ config }) => ({
      config,
      pluginIds: ["codex", "memory-core"],
    }));
    hoisted.resolveAgentRuntimePluginSelections
      .mockReset()
      .mockImplementation((_config, selections) => selections);
  });

  it("adopts full-only runtime capabilities from the active composition-root registry", () => {
    const activeRegistry = createEmptyPluginRegistry();
    const contextEnginesAdopted = { handle: "context-engines" };
    const presentersAdopted = { handle: "presenters" };
    hoisted.getActivePluginRegistry.mockReturnValue(activeRegistry);
    hoisted.adoptRuntimeContextEngineRegistrations.mockReturnValue(contextEnginesAdopted);
    hoisted.adoptRuntimeWidgetPresenterRegistrations.mockReturnValue(presentersAdopted);

    expect(
      loadAgentRuntimePluginRegistryHandle({ config: {} as never, workspaceDir: "/tmp/workspace" }),
    ).toBe(presentersAdopted);
    expect(hoisted.adoptRuntimeContextEngineRegistrations).toHaveBeenCalledWith(
      { handle: true },
      activeRegistry,
    );
    expect(hoisted.adoptRuntimeWidgetPresenterRegistrations).toHaveBeenCalledWith(
      contextEnginesAdopted,
      activeRegistry,
    );
    expect(hoisted.loadPluginRegistryHandle).toHaveBeenCalledWith(
      expect.not.objectContaining({ onlyPluginIds: expect.anything() }),
    );
  });

  it("bounds unscoped agent loads to active runtime plugins and selected owners", async () => {
    const runtime =
      await vi.importActual<typeof import("../plugins/runtime.js")>("../plugins/runtime.js");
    const previousRegistry = runtime.captureActivePluginRegistrySnapshot();
    const activeRegistry = createEmptyPluginRegistry();
    activeRegistry.plugins.push(
      createPluginRecord({ id: "startup-channel" }),
      createPluginRecord({ id: "startup-provider" }),
      createPluginRecord({ id: "deferred-plugin", format: "openclaw", imported: false }),
    );
    hoisted.resolveAgentRuntimePluginLoadPlan.mockImplementation(({ config, basePluginIds }) => ({
      config,
      pluginIds: [...(basePluginIds ?? []), "selected-provider"],
    }));

    try {
      runtime.setActivePluginRegistry(activeRegistry);
      hoisted.getActivePluginRegistry.mockImplementation(runtime.getActivePluginRegistry);

      loadAgentRuntimePluginRegistryHandle({
        config: {} as never,
        workspaceDir: "/tmp/workspace",
        selections: [{ provider: "selected", modelId: "model" }],
      });

      expect(hoisted.resolveAgentRuntimePluginLoadPlan).toHaveBeenCalledWith(
        expect.objectContaining({ basePluginIds: ["startup-channel", "startup-provider"] }),
      );
      expect(hoisted.loadPluginRegistryHandle).toHaveBeenCalledWith(
        expect.objectContaining({
          onlyPluginIds: ["startup-channel", "startup-provider", "selected-provider"],
        }),
      );
    } finally {
      activeRegistry.plugins.length = 0;
      runtime.restoreActivePluginRegistrySnapshot(previousRegistry);
      hoisted.getActivePluginRegistry.mockReset().mockReturnValue(undefined);
    }
  });

  it("reuses the current Gateway generation and loads only the imported-plugin delta", () => {
    const config = {} as never;
    const workspaceDir = "/tmp/default-workspace";
    const activeRegistry = {
      plugins: [
        { id: "gateway-owned", origin: "bundled", status: "loaded" },
        {
          id: "deferred",
          origin: "bundled",
          status: "loaded",
          format: "openclaw",
          imported: false,
        },
      ],
    };
    const metadataSnapshot = {
      ...createMetadataSnapshot(workspaceDir, undefined),
      manifestRegistry: {
        diagnostics: [],
        plugins: [
          { id: "gateway-owned", origin: "bundled" },
          { id: "deferred", origin: "bundled" },
        ],
      },
    };
    const selectedRegistry = { plugins: [...activeRegistry.plugins, { id: "selected-provider" }] };
    hoisted.getActivePluginRegistry.mockReturnValue(activeRegistry);
    hoisted.getActivePluginRegistryWorkspaceDir.mockReturnValue(workspaceDir);
    hoisted.getActivePluginRuntimeSubagentMode.mockReturnValue("gateway-bindable");
    hoisted.getCurrentPluginMetadataSnapshot.mockReturnValue(metadataSnapshot);
    hoisted.loadPluginRegistryHandle.mockReturnValue(selectedRegistry);
    hoisted.resolveAgentRuntimePluginLoadPlan.mockImplementation(({ basePluginIds }) => ({
      config,
      pluginIds: [...(basePluginIds ?? []), "selected-provider"],
    }));

    const prepared = prepareWorkspacePluginRegistries(
      {
        agentDir: "/tmp/agent",
        allowGatewaySubagentBinding: true,
        config,
        runtimePluginSelections: [{ provider: "selected", modelId: "model" }],
        workspaceDir,
      },
      metadataSnapshot as never,
      createPreparedInboundRegistryLoader(),
      true,
    );

    expect(prepared.inboundPluginRegistry).toBe(activeRegistry);
    expect(prepared.runtimePluginRegistry).toBe(selectedRegistry);
    expect(hoisted.resolveAgentRuntimePluginLoadPlan).toHaveBeenCalledWith(
      expect.objectContaining({ basePluginIds: ["gateway-owned"] }),
    );
    expect(hoisted.loadPluginRegistryHandle).toHaveBeenCalledOnce();
    expect(hoisted.loadPluginRegistryHandle).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["gateway-owned", "selected-provider"],
        preferBuiltPluginArtifacts: true,
      }),
    );
  });

  it.each([
    {
      name: "custom environment",
      input: { env: { OPENCLAW_STATE_DIR: "/tmp/custom-state" } },
    },
    {
      name: "non-bindable mode",
      setup: () => hoisted.getActivePluginRuntimeSubagentMode.mockReturnValue("default"),
    },
    {
      name: "different workspace",
      setup: () => hoisted.getActivePluginRegistryWorkspaceDir.mockReturnValue("/tmp/other"),
    },
    {
      name: "stale metadata generation",
      setup: () => hoisted.getCurrentPluginMetadataSnapshot.mockReturnValue({}),
    },
    {
      name: "manifest mismatch",
      setup: (activeRegistry: { plugins: Array<{ origin: string }> }) => {
        activeRegistry.plugins[0]!.origin = "external";
      },
    },
  ])("refuses Gateway registry reuse for $name", ({ input, setup }) => {
    const config = {} as never;
    const workspaceDir = "/tmp/default-workspace";
    const activeRegistry = {
      plugins: [{ id: "gateway-owned", origin: "bundled", status: "loaded" }],
    };
    const metadataSnapshot = {
      ...createMetadataSnapshot(workspaceDir, undefined),
      manifestRegistry: {
        diagnostics: [],
        plugins: [{ id: "gateway-owned", origin: "bundled" }],
      },
    };
    hoisted.getActivePluginRegistry.mockReturnValue(activeRegistry);
    hoisted.getActivePluginRegistryWorkspaceDir.mockReturnValue(workspaceDir);
    hoisted.getActivePluginRuntimeSubagentMode.mockReturnValue("gateway-bindable");
    hoisted.getCurrentPluginMetadataSnapshot.mockReturnValue(metadataSnapshot);
    setup?.(activeRegistry);

    const inbound = createPreparedInboundRegistryLoader()(
      {
        agentDir: "/tmp/agent",
        allowGatewaySubagentBinding: true,
        config,
        workspaceDir,
        ...input,
      },
      metadataSnapshot as never,
    );

    expect(inbound).not.toBe(activeRegistry);
    expect(hoisted.loadPluginRegistryHandle).toHaveBeenCalledOnce();
  });

  it("keeps direct no-current loads on the requested workspace", () => {
    const config = {} as never;
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" };
    const selections = [{ provider: "openai", modelId: "gpt-5.5", runtime: "codex" }];

    expect(
      loadAgentRuntimePluginRegistryHandle({
        config,
        env,
        workspaceDir: "/tmp/workspace",
        allowGatewaySubagentBinding: true,
        selections,
      }),
    ).toEqual({ handle: true });
    const metadataSnapshot = hoisted.loadPluginMetadataSnapshot.mock.results[0]?.value;
    expect(hoisted.loadPluginMetadataSnapshot).toHaveBeenCalledWith({
      config,
      env,
      workspaceDir: "/tmp/workspace",
    });
    expect(hoisted.resolveAgentRuntimePluginLoadPlan).toHaveBeenCalledWith({
      config,
      workspaceDir: "/tmp/workspace",
      selections,
      metadataSnapshot,
    });
    expect(hoisted.loadPluginRegistryHandle).toHaveBeenCalledWith({
      activate: false,
      config,
      activationSourceConfig: config,
      env,
      discovery: metadataSnapshot.discovery,
      installRecords: {},
      manifestRegistry: metadataSnapshot.manifestRegistry,
      workspaceDir: "/tmp/workspace",
      runtimeOptions: { allowGatewaySubagentBinding: true },
    });
  });

  it("loads an explicit empty handle when plugins are globally disabled", () => {
    const params = {
      config: { plugins: { enabled: false } } as never,
      workspaceDir: "/tmp/workspace",
    };
    expect(loadAgentRuntimePluginRegistryHandle(params)).toEqual({ handle: true });
    expect(hoisted.resolveAgentRuntimePluginLoadPlan).not.toHaveBeenCalled();
    expect(hoisted.loadPluginRegistryHandle).toHaveBeenCalledWith({
      activate: false,
      activationSourceConfig: params.config,
      config: params.config,
      onlyPluginIds: [],
      runtimeOptions: undefined,
      workspaceDir: "/tmp/workspace",
    });
  });

  it("keeps an explicit metadata generation source-default without Gateway selection", () => {
    const config = {} as never;
    const metadataSnapshot = createMetadataSnapshot();
    hoisted.getActivePluginRegistry.mockReturnValue({
      plugins: [{ id: "broader-process-owner", status: "loaded" }],
    });

    loadAgentRuntimePluginRegistryHandle({
      config,
      workspaceDir: "/tmp/workspace",
      metadataSnapshot: metadataSnapshot as never,
    });

    expect(hoisted.resolveAgentRuntimePluginLoadPlan).toHaveBeenCalledWith({
      config,
      workspaceDir: "/tmp/gateway-workspace",
      basePluginIds: ["telegram", "memory-core"],
      selections: [],
      metadataSnapshot,
    });
    expect(hoisted.loadPluginRegistryHandle).toHaveBeenCalledWith(
      expect.objectContaining({
        channelPluginLoadIntent: "full",
      }),
    );
    expect(hoisted.loadPluginRegistryHandle).toHaveBeenCalledWith(
      expect.not.objectContaining({ preferBuiltPluginArtifacts: true }),
    );
  });

  it("inherits the current request registry before process-wide startup metadata", () => {
    const config = {} as never;
    const metadataSnapshot = createMetadataSnapshot();
    const requestRegistry = {
      plugins: [
        { id: "memory-core", status: "loaded" },
        { id: "deferred", status: "loaded", format: "openclaw", imported: false },
      ],
    } as never;

    withPluginRuntimeRegistryScope(requestRegistry, () =>
      loadAgentRuntimePluginRegistryHandle({
        config,
        workspaceDir: "/tmp/workspace",
        metadataSnapshot: metadataSnapshot as never,
      }),
    );

    expect(hoisted.resolveAgentRuntimePluginLoadPlan).toHaveBeenCalledWith({
      config,
      workspaceDir: "/tmp/gateway-workspace",
      basePluginIds: ["memory-core"],
      selections: [],
      metadataSnapshot,
    });
  });

  it("lets direct local hosts bound the registry to configured runtime owners", () => {
    const config = {} as never;

    loadAgentRuntimePluginRegistryHandle({
      basePluginIds: [],
      config,
      workspaceDir: "/tmp/workspace",
    });

    const metadataSnapshot = hoisted.loadPluginMetadataSnapshot.mock.results[0]?.value;
    expect(hoisted.resolveAgentRuntimePluginLoadPlan).toHaveBeenCalledWith({
      config,
      workspaceDir: "/tmp/workspace",
      basePluginIds: [],
      selections: [],
      metadataSnapshot,
    });
  });

  it("loads selected runtimes from the Gateway metadata workspace", () => {
    const config = {} as never;
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" };
    const snapshot = createMetadataSnapshot();

    loadAgentRuntimePluginRegistryHandle({
      config,
      env,
      workspaceDir: "/tmp/agent-workspace",
      metadataSnapshot: snapshot as never,
      preferBuiltPluginArtifacts: true,
    });

    expect(hoisted.resolveAgentRuntimePluginLoadPlan).toHaveBeenCalledWith({
      config,
      workspaceDir: snapshot.workspaceDir,
      basePluginIds: ["telegram", "memory-core"],
      selections: [],
      metadataSnapshot: snapshot,
    });
    expect(hoisted.loadPluginRegistryHandle).toHaveBeenCalledWith({
      activate: false,
      activationSourceConfig: config,
      channelPluginLoadIntent: "full",
      config,
      discovery: snapshot.discovery,
      env,
      installRecords: {},
      manifestRegistry: snapshot.manifestRegistry,
      onlyPluginIds: ["codex", "memory-core"],
      preferBuiltPluginArtifacts: true,
      runtimeOptions: undefined,
      workspaceDir: snapshot.workspaceDir,
    });
  });

  it("owns a scoped registry for direct hosts", async () => {
    const config = {} as never;
    const pluginRegistry = { handle: true } as never;
    hoisted.loadPluginRegistryHandle.mockReturnValue(pluginRegistry);

    await expect(
      withAgentPluginRegistry({
        config,
        workspaceDir: "/tmp/workspace",
        run: async () => getPluginRuntimeGatewayRequestScope()?.pluginRegistry,
      }),
    ).resolves.toBe(pluginRegistry);

    expect(getPluginRuntimeGatewayRequestScope()).toBeUndefined();
    expect(hoisted.resolveAgentRuntimePluginLoadPlan).toHaveBeenCalledWith({
      config,
      workspaceDir: "/tmp/workspace",
      basePluginIds: [],
      selections: [],
      metadataSnapshot: expect.any(Object),
    });
  });

  it("reuses an existing gateway registry owner", async () => {
    const gatewayRegistry = { gateway: true } as never;

    await expect(
      withPluginRuntimeRegistryScope(gatewayRegistry, () =>
        withAgentPluginRegistry({
          config: {} as never,
          workspaceDir: "/tmp/workspace",
          run: async () => getPluginRuntimeGatewayRequestScope()?.pluginRegistry,
        }),
      ),
    ).resolves.toBe(gatewayRegistry);

    expect(hoisted.loadPluginRegistryHandle).not.toHaveBeenCalled();
  });
});
