import { describe, expect, it } from "vitest";
import type { PluginRegistry } from "../../../plugins/registry.js";
import { resolvePluginRoutePathContext } from "./path-context.js";
import {
  findMatchingPluginNodeCapabilityRoute,
  listPluginNodeCapabilities,
} from "./route-capability.js";

describe("plugin node capability route metadata", () => {
  it("lists one capability per surface with the shortest ttl", () => {
    const registry = {
      httpRoutes: [
        { pluginId: "one", path: "/one", nodeCapability: { surface: "canvas" } },
        { pluginId: "two", path: "/two", nodeCapability: { surface: "canvas", ttlMs: 100 } },
        { pluginId: "files", path: "/files", nodeCapability: { surface: "files", ttlMs: 200 } },
      ],
    } as unknown as PluginRegistry;

    expect(listPluginNodeCapabilities(registry)).toEqual([
      { surface: "canvas", ttlMs: 100, scopeKey: "two:canvas" },
      { surface: "files", ttlMs: 200, scopeKey: "files:files" },
    ]);
  });

  it("adds plugin ownership to matched capability route metadata", () => {
    const registry = {
      httpRoutes: [
        {
          pluginId: "canvas-plugin",
          path: "/__openclaw__/canvas/ws",
          nodeCapability: { surface: "canvas" },
        },
      ],
    } as unknown as PluginRegistry;

    expect(
      findMatchingPluginNodeCapabilityRoute(
        registry,
        resolvePluginRoutePathContext("/__openclaw__/canvas/ws"),
      )?.nodeCapability,
    ).toEqual({ surface: "canvas", scopeKey: "canvas-plugin:canvas" });
  });
});
