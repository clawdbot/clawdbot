// Verifies agent runtime plugin loads stay scoped to prepared-runtime handles.
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  loadPluginMetadataSnapshot: vi.fn(),
  getActivePluginRegistry: vi.fn(),
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
}));

vi.mock("../plugins/widget-presenters.js", () => ({
  adoptRuntimeWidgetPresenterRegistrations: hoisted.adoptRuntimeWidgetPresenterRegistrations,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: hoisted.loadPluginMetadataSnapshot,
}));

vi.mock("../plugins/loader.js", () => ({
  loadPluginRegistryHandle: hoisted.loadPluginRegistryHandle,
}));

vi.mock("./harness/runtime-plugin-load-plan.js", () => ({
  resolveAgentRuntimePluginLoadPlan: hoisted.resolveAgentRuntimePluginLoadPlan,
  resolveAgentRuntimePluginSelections: hoisted.resolveAgentRuntimePluginSelections,
}));

import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
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
    hoisted.getActivePluginRegistry.mockReset().mockReturnValue(undefined);
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
    const activeRegistry = { active: true };
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

  it("preserves the gateway startup scope and ordering", () => {
    const config = {} as never;
    const metadataSnapshot = createMetadataSnapshot();

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
