// Covers runtime-visible channel plugin reads: process-root passthrough,
// registry-in-scope additions, and root-wins dedupe on id collisions.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  getRuntimeVisibleChannelPlugin,
  listRuntimeVisibleChannelPlugins,
} from "./runtime-visible-channels.js";

const mocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn(),
  getLoadedChannelPlugin: vi.fn(),
  listChannelPlugins: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => mocks.getChannelPlugin(...args),
  getLoadedChannelPlugin: (...args: unknown[]) => mocks.getLoadedChannelPlugin(...args),
  listChannelPlugins: (...args: unknown[]) => mocks.listChannelPlugins(...args),
}));

function scopedRegistryWith(plugins: Array<Record<string, unknown>>): PluginRegistry {
  return { channels: plugins.map((plugin) => ({ plugin })) } as unknown as PluginRegistry;
}

beforeEach(() => {
  mocks.getChannelPlugin.mockReset();
  mocks.getChannelPlugin.mockReturnValue(undefined);
  mocks.getLoadedChannelPlugin.mockReset();
  mocks.getLoadedChannelPlugin.mockReturnValue(undefined);
  mocks.listChannelPlugins.mockReset();
  mocks.listChannelPlugins.mockReturnValue([]);
});

describe("listRuntimeVisibleChannelPlugins", () => {
  it("returns the process-root list when no registry scope is active", () => {
    const rootPlugin = { id: "alpha" };
    mocks.listChannelPlugins.mockReturnValue([rootPlugin]);

    expect(listRuntimeVisibleChannelPlugins()).toEqual([rootPlugin]);
  });

  it("appends registry-scoped channel plugins the process root does not know", () => {
    const rootPlugin = { id: "alpha" };
    const scopedPlugin = { id: "zephyrchat" };
    mocks.listChannelPlugins.mockReturnValue([rootPlugin]);

    const visible = withPluginRuntimeRegistryScope(scopedRegistryWith([scopedPlugin]), () =>
      listRuntimeVisibleChannelPlugins(),
    );
    expect(visible).toEqual([rootPlugin, scopedPlugin]);
  });

  it("keeps the process-root implementation when a scoped plugin collides on id", () => {
    const rootPlugin = { id: "alpha", meta: { label: "Root Alpha" } };
    const scopedPlugin = { id: "alpha", meta: { label: "Scoped Alpha" } };
    mocks.listChannelPlugins.mockReturnValue([rootPlugin]);

    const visible = withPluginRuntimeRegistryScope(scopedRegistryWith([scopedPlugin]), () =>
      listRuntimeVisibleChannelPlugins(),
    );
    expect(visible).toEqual([rootPlugin]);
  });
});

describe("getRuntimeVisibleChannelPlugin", () => {
  it("resolves a channel plugin that exists only in the registry scope", () => {
    const scopedPlugin = { id: "zephyrchat" };

    const resolved = withPluginRuntimeRegistryScope(scopedRegistryWith([scopedPlugin]), () =>
      getRuntimeVisibleChannelPlugin("zephyrchat"),
    );
    expect(resolved).toBe(scopedPlugin);
    expect(getRuntimeVisibleChannelPlugin("zephyrchat")).toBeUndefined();
  });

  it("prefers the loaded plugin and keeps the bundled fallback last", () => {
    const loadedPlugin = { id: "alpha", meta: { label: "Loaded" } };
    const scopedPlugin = { id: "alpha", meta: { label: "Scoped" } };
    const bundledPlugin = { id: "beta", meta: { label: "Bundled" } };
    mocks.getLoadedChannelPlugin.mockImplementation((id: string) =>
      id === "alpha" ? loadedPlugin : undefined,
    );
    mocks.getChannelPlugin.mockImplementation((id: string) =>
      id === "beta" ? bundledPlugin : undefined,
    );

    const resolved = withPluginRuntimeRegistryScope(scopedRegistryWith([scopedPlugin]), () => ({
      alpha: getRuntimeVisibleChannelPlugin("alpha"),
      beta: getRuntimeVisibleChannelPlugin("beta"),
    }));
    expect(resolved.alpha).toBe(loadedPlugin);
    expect(resolved.beta).toBe(bundledPlugin);
  });
});
