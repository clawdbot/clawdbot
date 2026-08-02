// Verifies scoped registry handles cannot install process-wide runtime state.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import {
  getActivePluginChannelRegistry,
  getActivePluginRegistry,
  pinActivePluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../runtime.js";

const loaderMocks = vi.hoisted(() => ({
  loadAndActivateRootPluginRegistry: vi.fn(),
  loadPluginRegistryHandle: vi.fn(),
}));

vi.mock("../loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../loader.js")>();
  return {
    ...actual,
    loadAndActivateRootPluginRegistry: loaderMocks.loadAndActivateRootPluginRegistry,
    loadPluginRegistryHandle: loaderMocks.loadPluginRegistryHandle,
  };
});

import {
  installRuntimePluginRegistryAtProcessRoot,
  loadRuntimePluginRegistryHandle,
} from "./standalone-runtime-registry-loader.js";

beforeEach(() => {
  loaderMocks.loadAndActivateRootPluginRegistry.mockReset();
  loaderMocks.loadPluginRegistryHandle.mockReset();
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("standalone runtime registry ownership", () => {
  it("returns a scoped handle without replacing active or pinned registries", () => {
    const activeRegistry = createEmptyPluginRegistry();
    const channelRegistry = createEmptyPluginRegistry();
    const scopedRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(activeRegistry, "active-key", "default", "/tmp/ws");
    pinActivePluginChannelRegistry(channelRegistry);
    loaderMocks.loadPluginRegistryHandle.mockReturnValue(scopedRegistry);

    expect(
      loadRuntimePluginRegistryHandle({
        forceLoad: true,
        surface: "channel",
        loadOptions: { onlyPluginIds: ["tool-plugin"], workspaceDir: "/tmp/ws" },
      }),
    ).toBe(scopedRegistry);

    expect(loaderMocks.loadPluginRegistryHandle).toHaveBeenCalledWith({
      activate: false,
      cache: false,
      onlyPluginIds: ["tool-plugin"],
      workspaceDir: "/tmp/ws",
    });
    expect(getActivePluginRegistry()).toBe(activeRegistry);
    expect(getActivePluginChannelRegistry()).toBe(channelRegistry);
  });

  it("builds an explicit empty scope instead of reusing the active registry", () => {
    const activeRegistry = createEmptyPluginRegistry();
    const emptyScopedRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(activeRegistry, "active-key", "default", "/tmp/ws");
    loaderMocks.loadPluginRegistryHandle.mockReturnValue(emptyScopedRegistry);

    expect(
      loadRuntimePluginRegistryHandle({
        requiredPluginIds: [],
        loadOptions: { onlyPluginIds: [], workspaceDir: "/tmp/ws" },
      }),
    ).toBe(emptyScopedRegistry);

    expect(loaderMocks.loadPluginRegistryHandle).toHaveBeenCalledWith({
      activate: false,
      onlyPluginIds: [],
      workspaceDir: "/tmp/ws",
    });
    expect(getActivePluginRegistry()).toBe(activeRegistry);
  });

  it("uses the activating loader only at the process-root entry point", () => {
    const rootRegistry = createEmptyPluginRegistry();
    loaderMocks.loadAndActivateRootPluginRegistry.mockReturnValue(rootRegistry);

    expect(
      installRuntimePluginRegistryAtProcessRoot({
        forceLoad: true,
        loadOptions: {
          onlyPluginIds: ["gateway-plugin"],
          workspaceDir: "/tmp/ws",
          runtimeOptions: { allowGatewaySubagentBinding: true },
        },
      }),
    ).toBe(rootRegistry);

    expect(loaderMocks.loadAndActivateRootPluginRegistry).toHaveBeenCalledWith({
      activate: true,
      cache: false,
      onlyPluginIds: ["gateway-plugin"],
      workspaceDir: "/tmp/ws",
      runtimeOptions: { allowGatewaySubagentBinding: true },
    });
    expect(loaderMocks.loadPluginRegistryHandle).not.toHaveBeenCalled();
  });

  it("pins an explicitly installed channel surface", () => {
    const rootRegistry = createEmptyPluginRegistry();
    loaderMocks.loadAndActivateRootPluginRegistry.mockReturnValue(rootRegistry);

    installRuntimePluginRegistryAtProcessRoot({
      forceLoad: true,
      surface: "channel",
      loadOptions: { workspaceDir: "/tmp/ws" },
    });

    expect(getActivePluginRegistry()).toBe(rootRegistry);
    expect(getActivePluginChannelRegistry()).toBe(rootRegistry);
  });
});
