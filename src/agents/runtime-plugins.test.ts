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
  resolveAgentHarnessOwnerPluginIds: vi.fn(() => ["codex"]),
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
  resolveAgentHarnessOwnerPluginIds: hoisted.resolveAgentHarnessOwnerPluginIds,
  resolveAgentRuntimePluginLoadPlan: hoisted.resolveAgentRuntimePluginLoadPlan,
  resolveAgentRuntimePluginSelections: hoisted.resolveAgentRuntimePluginSelections,
}));

import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { ensureSelectedAgentHarnessPlugin } from "./harness/runtime-plugin.js";
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

  it("uses harness runtimes prepared by the lifecycle batch", () => {
    const configuredHarnessRuntimes = ["codex"];

    loadAgentRuntimePluginRegistryHandle({
      config: {},
      configuredHarnessRuntimes,
      workspaceDir: "/tmp/workspace",
    });

    expect(hoisted.resolveAgentRuntimePluginSelections).toHaveBeenCalledWith(
      {},
      [],
      configuredHarnessRuntimes,
    );
  });

  it.each([true, false])("reuses only an imported selected owner (imported=%s)", (imported) => {
    const base = createEmptyPluginRegistry();
    base.plugins.push(
      createPluginRecord({ id: "memory-core" }),
      createPluginRecord({ id: "codex", format: "openclaw", imported }),
    );
    const selected = loadAgentRuntimePluginRegistryHandle({
      config: {},
      metadataSnapshot: createPluginMetadataSnapshot({
        manifestRegistry: { plugins: [], diagnostics: [] },
        workspaceDir: "/tmp/gateway-workspace",
      }),
      basePluginIds: ["memory-core"],
      reusableRegistry: base,
      selections: [{ provider: "openai", modelId: "gpt-5.5", runtime: "codex" }],
    });
    expect(selected === base).toBe(imported);
    expect(hoisted.loadPluginRegistryHandle).toHaveBeenCalledTimes(imported ? 0 : 1);
    expect(hoisted.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
    if (!imported) {
      expect(hoisted.loadPluginRegistryHandle).toHaveBeenCalledWith(
        expect.objectContaining({
          activate: false,
          onlyPluginIds: ["codex", "memory-core"],
        }),
      );
    }
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

  it("does not reuse a batch registry across metadata generations with identical config", () => {
    const input = { config: {}, workspaceDir: "/tmp/workspace" };
    const firstMetadata = createMetadataSnapshot(input.workspaceDir);
    const replacementMetadata = createMetadataSnapshot(input.workspaceDir);
    hoisted.loadPluginRegistryHandle.mockImplementation(() => createEmptyPluginRegistry());
    const load = createPreparedInboundRegistryLoader();

    const first = load(input, firstMetadata as never);
    expect(load(input, firstMetadata as never)).toBe(first);
    const replacement = load(input, replacementMetadata as never);
    expect(replacement).not.toBe(first);
    expect(load(input, replacementMetadata as never)).toBe(replacement);
    expect(hoisted.loadPluginRegistryHandle).toHaveBeenCalledTimes(2);
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

  it("carries low-level reply policy without rebinding the loader's cached registry", async () => {
    const config = { plugins: { enabled: false } } satisfies OpenClawConfig;
    const cachedRegistry = createEmptyPluginRegistry();
    hoisted.loadPluginRegistryHandle.mockReturnValue(cachedRegistry);
    const pluginRegistry = loadAgentRuntimePluginRegistryHandle({
      config,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });
    const error = await ensureSelectedAgentHarnessPlugin({
      config,
      provider: "openai",
      modelId: "gpt-5.5",
      agentHarnessRuntimeOverride: "codex",
      workspaceDir: "/tmp/workspace",
      pluginRegistry,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("plugins disabled");
    expect(pluginRegistry).toBe(cachedRegistry);
    expect(getPluginRuntimeLoadContext(cachedRegistry)).toBeUndefined();
    expect(hoisted.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
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
    const pluginRegistry = createEmptyPluginRegistry();
    hoisted.loadPluginRegistryHandle.mockReturnValue(pluginRegistry);

    await expect(
      withAgentPluginRegistry({
        config,
        workspaceDir: "/tmp/workspace",
        run: async () => getPluginRuntimeGatewayRequestScope()?.pluginRegistry,
      }),
    ).resolves.toBe(pluginRegistry);

    expect(getPluginRuntimeGatewayRequestScope()).toBeUndefined();
    expect(getPluginRuntimeLoadContext(pluginRegistry)).toMatchObject({
      activationSourceConfig: config,
      metadataSnapshot: expect.any(Object),
    });
    expect(hoisted.resolveAgentRuntimePluginLoadPlan).toHaveBeenCalledWith({
      config,
      workspaceDir: "/tmp/workspace",
      basePluginIds: undefined,
      selections: [],
      metadataSnapshot: expect.any(Object),
    });
  });

  it("inherits active runtime ids for direct hosts without a request registry", async () => {
    const config = {} as never;
    hoisted.getActivePluginRegistry.mockReturnValue({
      plugins: [
        createPluginRecord({ id: "startup-channel", status: "loaded" }),
        createPluginRecord({ id: "startup-provider", status: "loaded" }),
      ],
    });
    const pluginRegistry = createEmptyPluginRegistry();
    hoisted.loadPluginRegistryHandle.mockReturnValue(pluginRegistry);

    await withAgentPluginRegistry({
      config,
      workspaceDir: "/tmp/workspace",
      run: async () => {},
    });

    expect(hoisted.resolveAgentRuntimePluginLoadPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        basePluginIds: ["startup-channel", "startup-provider"],
      }),
    );
    expect(hoisted.loadPluginRegistryHandle).toHaveBeenCalledWith(
      expect.objectContaining({ onlyPluginIds: ["codex", "memory-core"] }),
    );
  });

  it.each([
    {
      name: "globally disabled plugins",
      config: { plugins: { enabled: false } } satisfies OpenClawConfig,
      runtime: "codex",
      expectedOwner: 'Owner plugin "codex" is not activatable',
      expectedReason: "plugins disabled",
      expectedMetadataLoads: 0,
    },
    {
      name: "globally disabled plugins with an unknown owner",
      config: { plugins: { enabled: false } } satisfies OpenClawConfig,
      runtime: "custom-harness",
      expectedOwner: "no plugin can register agent harness",
      expectedReason: "Plugins are disabled",
      expectedMetadataLoads: 0,
    },
    {
      name: "a restrictive allowlist",
      config: {
        plugins: { allow: ["openai", "memory-core"] },
      } satisfies OpenClawConfig,
      runtime: "codex",
      expectedOwner: 'Owner plugin "codex" is not activatable',
      expectedReason: "not in allowlist",
      expectedMetadataLoads: 1,
    },
  ])(
    "reports exact policy facts for direct hosts with $name",
    async ({ config, runtime, expectedOwner, expectedReason, expectedMetadataLoads }) => {
      const pluginRegistry = createEmptyPluginRegistry();
      hoisted.loadPluginRegistryHandle.mockReturnValue(pluginRegistry);
      if (config.plugins.enabled !== false) {
        hoisted.loadPluginMetadataSnapshot.mockReturnValue(
          createPluginMetadataSnapshot({
            config,
            workspaceDir: "/tmp/workspace",
            manifestRegistry: makeRegistry([
              {
                id: "codex",
                channels: [],
                activation: { onAgentHarnesses: ["codex"] },
                origin: "bundled",
              },
            ]),
          }),
        );
      }

      const error = await withAgentPluginRegistry({
        config,
        workspaceDir: "/tmp/workspace",
        run: async () => {
          await ensureSelectedAgentHarnessPlugin({
            provider: "openai",
            modelId: "gpt-5.5",
            config,
            agentHarnessRuntimeOverride: runtime,
            workspaceDir: "/tmp/workspace",
            pluginRegistry: getPluginRuntimeGatewayRequestScope()?.pluginRegistry,
          });
        },
      }).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(expectedOwner);
      expect((error as Error).message).toContain(expectedReason);
      expect((error as Error).message).toContain("reason=owner-plugin-not-activatable");
      expect((error as Error).message).not.toContain("absent from this prepared plugin generation");
      expect(hoisted.loadPluginMetadataSnapshot).toHaveBeenCalledTimes(expectedMetadataLoads);
    },
  );

  it("retains loaded request plugins when preparing a selected usage harness", async () => {
    const gatewayRegistry = createEmptyPluginRegistry();
    gatewayRegistry.plugins.push(
      createPluginRecord({ id: "request-provider" }),
      createPluginRecord({ id: "deferred", format: "openclaw", imported: false }),
    );
    hoisted.resolveAgentRuntimePluginLoadPlan.mockImplementation(({ config, basePluginIds }) => ({
      config,
      pluginIds: [...(basePluginIds ?? []), "selected-harness"],
    }));
    hoisted.loadPluginRegistryHandle.mockImplementation(({ onlyPluginIds }) => ({
      ...createEmptyPluginRegistry(),
      plugins: onlyPluginIds.map((id: string) => createPluginRecord({ id })),
    }));

    const loaded = await withPluginRuntimeRegistryScope(gatewayRegistry, () =>
      withAgentPluginRegistry({
        config: {},
        workspaceDir: "/tmp/workspace",
        selections: [{ provider: "selected-provider", modelId: "", runtime: "selected-harness" }],
        run: async () => getPluginRuntimeGatewayRequestScope()?.pluginRegistry,
      }),
    );

    expect(loaded?.plugins.map((plugin) => plugin.id)).toEqual([
      "request-provider",
      "selected-harness",
    ]);
    expect(gatewayRegistry.plugins.map((plugin) => plugin.id)).toEqual([
      "request-provider",
      "deferred",
    ]);
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
