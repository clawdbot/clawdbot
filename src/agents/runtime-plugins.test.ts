import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  getCurrentPluginMetadataSnapshot: vi.fn(),
  ensureStandaloneRuntimePluginRegistryLoaded: vi.fn(),
  getActivePluginRuntimeSubagentMode: vi.fn<() => "default" | "explicit" | "gateway-bindable">(
    () => "default",
  ),
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: hoisted.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../plugins/runtime/standalone-runtime-registry-loader.js", () => ({
  ensureStandaloneRuntimePluginRegistryLoaded: hoisted.ensureStandaloneRuntimePluginRegistryLoaded,
}));

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRuntimeSubagentMode: hoisted.getActivePluginRuntimeSubagentMode,
}));

describe("ensureRuntimePluginsLoaded", () => {
  let ensureRuntimePluginsLoaded: typeof import("./runtime-plugins.js").ensureRuntimePluginsLoaded;

  beforeEach(async () => {
    hoisted.getCurrentPluginMetadataSnapshot.mockReset();
    hoisted.getCurrentPluginMetadataSnapshot.mockReturnValue(undefined);
    hoisted.ensureStandaloneRuntimePluginRegistryLoaded.mockReset();
    hoisted.ensureStandaloneRuntimePluginRegistryLoaded.mockReturnValue(undefined);
    hoisted.getActivePluginRuntimeSubagentMode.mockReset();
    hoisted.getActivePluginRuntimeSubagentMode.mockReturnValue("default");
    vi.resetModules();
    ({ ensureRuntimePluginsLoaded } = await import("./runtime-plugins.js"));
  });

  it("does not reactivate plugins when a process already has an active registry", async () => {
    hoisted.ensureStandaloneRuntimePluginRegistryLoaded.mockReturnValue({});

    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.ensureStandaloneRuntimePluginRegistryLoaded).toHaveBeenCalledTimes(1);
  });

  it("resolves runtime plugins through the shared runtime helper", async () => {
    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.ensureStandaloneRuntimePluginRegistryLoaded).toHaveBeenCalledWith({
      requiredPluginIds: undefined,
      loadOptions: {
        config: {} as never,
        workspaceDir: "/tmp/workspace",
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      },
    });
  });

  it("scopes runtime plugin loading to the current gateway startup plan", async () => {
    const config = {} as never;
    hoisted.getCurrentPluginMetadataSnapshot.mockReturnValue({
      startup: {
        pluginIds: ["telegram", "memory-core"],
      },
    });

    ensureRuntimePluginsLoaded({
      config,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.getCurrentPluginMetadataSnapshot).toHaveBeenCalledWith({
      config,
      workspaceDir: "/tmp/workspace",
    });
    expect(hoisted.ensureStandaloneRuntimePluginRegistryLoaded).toHaveBeenCalledWith({
      requiredPluginIds: ["telegram", "memory-core"],
      loadOptions: {
        config,
        workspaceDir: "/tmp/workspace",
        onlyPluginIds: ["telegram", "memory-core"],
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      },
    });
  });

  it("delegates startup-scope registry reuse to loader cache compatibility", async () => {
    hoisted.getCurrentPluginMetadataSnapshot.mockReturnValue({
      startup: {
        pluginIds: ["telegram"],
      },
    });
    hoisted.getActivePluginRuntimeSubagentMode.mockReturnValue("gateway-bindable");

    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.ensureStandaloneRuntimePluginRegistryLoaded).toHaveBeenCalledWith({
      requiredPluginIds: ["telegram"],
      loadOptions: {
        config: {} as never,
        onlyPluginIds: ["telegram"],
        workspaceDir: "/tmp/workspace",
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      },
    });
  });

  it("lets the loader decide when startup ids match but config changes", async () => {
    const config = {
      plugins: {
        config: {
          telegram: {
            replyMode: "changed",
          },
        },
      },
    } as never;
    hoisted.getCurrentPluginMetadataSnapshot.mockReturnValue({
      startup: {
        pluginIds: ["telegram"],
      },
    });
    hoisted.getActivePluginRuntimeSubagentMode.mockReturnValue("gateway-bindable");

    ensureRuntimePluginsLoaded({
      config,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.ensureStandaloneRuntimePluginRegistryLoaded).toHaveBeenCalledWith({
      requiredPluginIds: ["telegram"],
      loadOptions: {
        config,
        onlyPluginIds: ["telegram"],
        workspaceDir: "/tmp/workspace",
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      },
    });
  });

  it("does not enable gateway subagent binding for normal runtime loads", async () => {
    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
    });

    expect(hoisted.ensureStandaloneRuntimePluginRegistryLoaded).toHaveBeenCalledWith({
      requiredPluginIds: undefined,
      loadOptions: {
        config: {} as never,
        workspaceDir: "/tmp/workspace",
        runtimeOptions: undefined,
      },
    });
  });

  it("inherits gateway-bindable mode from an active gateway registry", async () => {
    hoisted.getActivePluginRuntimeSubagentMode.mockReturnValue("gateway-bindable");

    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
    });

    expect(hoisted.ensureStandaloneRuntimePluginRegistryLoaded).toHaveBeenCalledWith({
      requiredPluginIds: undefined,
      loadOptions: {
        config: {} as never,
        workspaceDir: "/tmp/workspace",
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      },
    });
  });
});
