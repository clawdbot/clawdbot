// Verifies prepared-runtime handles and process-root runtime installation remain distinct.
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  getCurrentPluginMetadataSnapshot: vi.fn(),
  getActivePluginRuntimeSubagentMode: vi.fn<() => "default" | "explicit" | "gateway-bindable">(),
  installRuntimePluginRegistryAtProcessRoot: vi.fn(),
  loadRuntimePluginRegistryHandle: vi.fn(),
  resolveAgentRuntimePluginLoadPlan: vi.fn(),
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: hoisted.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../plugins/runtime/standalone-runtime-registry-loader.js", () => ({
  installRuntimePluginRegistryAtProcessRoot: hoisted.installRuntimePluginRegistryAtProcessRoot,
  loadRuntimePluginRegistryHandle: hoisted.loadRuntimePluginRegistryHandle,
}));

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRuntimeSubagentMode: hoisted.getActivePluginRuntimeSubagentMode,
}));

vi.mock("./harness/runtime-plugin-load-plan.js", () => ({
  resolveAgentRuntimePluginLoadPlan: hoisted.resolveAgentRuntimePluginLoadPlan,
}));

import {
  installAgentRuntimePluginRegistryAtProcessRoot,
  loadAgentRuntimePluginRegistryHandle,
} from "./runtime-plugins.js";

describe("agent runtime plugin registries", () => {
  beforeEach(() => {
    hoisted.getCurrentPluginMetadataSnapshot.mockReset().mockReturnValue(undefined);
    hoisted.getActivePluginRuntimeSubagentMode.mockReset().mockReturnValue("default");
    hoisted.installRuntimePluginRegistryAtProcessRoot.mockReset().mockReturnValue({ root: true });
    hoisted.loadRuntimePluginRegistryHandle.mockReset().mockReturnValue({ handle: true });
    hoisted.resolveAgentRuntimePluginLoadPlan.mockReset().mockImplementation(({ config }) => ({
      config,
      pluginIds: ["codex", "memory-core"],
    }));
  });

  it("returns a non-activating handle for a prepared runtime", () => {
    const config = {} as never;
    const selections = [{ provider: "openai", modelId: "gpt-5.5", runtime: "codex" }];

    expect(
      loadAgentRuntimePluginRegistryHandle({
        config,
        workspaceDir: "/tmp/workspace",
        allowGatewaySubagentBinding: true,
        selections,
      }),
    ).toEqual({ handle: true });
    expect(hoisted.resolveAgentRuntimePluginLoadPlan).toHaveBeenCalledWith({
      config,
      workspaceDir: "/tmp/workspace",
      selections,
    });
    expect(hoisted.loadRuntimePluginRegistryHandle).toHaveBeenCalledWith({
      requiredPluginIds: ["codex", "memory-core"],
      loadOptions: {
        config,
        activationSourceConfig: config,
        workspaceDir: "/tmp/workspace",
        runtimeOptions: { allowGatewaySubagentBinding: true },
      },
    });
    expect(hoisted.installRuntimePluginRegistryAtProcessRoot).not.toHaveBeenCalled();
  });

  it("installs only through the explicit process-root entry point", () => {
    const config = {} as never;
    hoisted.getActivePluginRuntimeSubagentMode.mockReturnValue("gateway-bindable");

    expect(
      installAgentRuntimePluginRegistryAtProcessRoot({ config, workspaceDir: "/tmp/workspace" }),
    ).toEqual({ root: true });
    expect(hoisted.installRuntimePluginRegistryAtProcessRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        loadOptions: expect.objectContaining({
          runtimeOptions: { allowGatewaySubagentBinding: true },
        }),
      }),
    );
    expect(hoisted.loadRuntimePluginRegistryHandle).not.toHaveBeenCalled();
  });

  it("installs an explicit empty registry when plugins are globally disabled", () => {
    const params = {
      config: { plugins: { enabled: false } } as never,
      workspaceDir: "/tmp/workspace",
    };
    expect(loadAgentRuntimePluginRegistryHandle(params)).toEqual({ handle: true });
    expect(installAgentRuntimePluginRegistryAtProcessRoot(params)).toEqual({ root: true });
    expect(hoisted.resolveAgentRuntimePluginLoadPlan).not.toHaveBeenCalled();
    expect(hoisted.loadRuntimePluginRegistryHandle).toHaveBeenCalledWith({
      requiredPluginIds: [],
      loadOptions: {
        activationSourceConfig: params.config,
        config: params.config,
        onlyPluginIds: [],
        runtimeOptions: undefined,
        workspaceDir: "/tmp/workspace",
      },
    });
    expect(hoisted.installRuntimePluginRegistryAtProcessRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredPluginIds: [],
        loadOptions: expect.objectContaining({ onlyPluginIds: [] }),
      }),
    );
  });

  it("preserves the gateway startup scope and ordering", () => {
    const config = {} as never;
    hoisted.getCurrentPluginMetadataSnapshot.mockReturnValue({
      startup: { pluginIds: ["telegram", "memory-core"] },
    });

    loadAgentRuntimePluginRegistryHandle({ config, workspaceDir: "/tmp/workspace" });

    expect(hoisted.resolveAgentRuntimePluginLoadPlan).toHaveBeenCalledWith({
      config,
      workspaceDir: "/tmp/workspace",
      basePluginIds: ["telegram", "memory-core"],
      selections: [],
    });
    expect(hoisted.loadRuntimePluginRegistryHandle).toHaveBeenCalledWith(
      expect.objectContaining({
        loadOptions: expect.objectContaining({ forceFullRuntimeForChannelPlugins: true }),
      }),
    );
  });
});
