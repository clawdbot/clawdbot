/**
 * Plugin node-capability route matching and surface listing tests.
 */
import { describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../../plugins/registry.js";
import { resolvePluginRoutePathContext } from "./path-context.js";
import {
  findMatchingPluginNodeCapabilityRoute,
  listPluginNodeCapabilities,
} from "./route-capability.js";

describe("plugin node capability route metadata", () => {
  it("lists one capability per surface with the shortest ttl", () => {
    const registry: PluginRegistry = {
      ...createEmptyPluginRegistry(),
      httpRoutes: [
        {
          pluginId: "one",
          path: "/one",
          auth: "plugin",
          match: "exact",
          handler: async () => false,
          nodeCapability: { surface: "canvas" },
        },
        {
          pluginId: "two",
          path: "/two",
          auth: "plugin",
          match: "exact",
          handler: async () => false,
          nodeCapability: { surface: "canvas", ttlMs: 100 },
        },
        {
          pluginId: "files",
          path: "/files",
          auth: "plugin",
          match: "exact",
          handler: async () => false,
          nodeCapability: { surface: "files", ttlMs: 200 },
        },
      ],
    };

    expect(listPluginNodeCapabilities(registry)).toEqual([
      { surface: "canvas", ttlMs: 100, scopeKey: "two:canvas" },
      { surface: "files", ttlMs: 200, scopeKey: "files:files" },
    ]);
  });

  it("adds plugin ownership to matched capability route metadata", () => {
    const registry: PluginRegistry = {
      ...createEmptyPluginRegistry(),
      httpRoutes: [
        {
          pluginId: "canvas-plugin",
          path: "/__openclaw__/canvas/ws",
          auth: "plugin",
          match: "exact",
          handler: async () => false,
          nodeCapability: { surface: "canvas" },
        },
      ],
    };

    expect(
      findMatchingPluginNodeCapabilityRoute(
        registry,
        resolvePluginRoutePathContext("/__openclaw__/canvas/ws"),
      )?.nodeCapability,
    ).toEqual({ surface: "canvas", scopeKey: "canvas-plugin:canvas" });
  });
});
