import { describe, expect, it } from "vitest";
import { decodePluginDiscoveryId, joinClawHubPluginCatalog } from "./catalog-discovery.js";

const remote = {
  packageName: "@alice/memory-plus",
  displayName: "Memory Plus",
  family: "code-plugin" as const,
  isOfficial: false,
  categories: ["memory"],
  runtimeId: "memory-plus",
};

describe("plugin discovery identity and local join", () => {
  it("round-trips a stable URL-safe opaque route identity", () => {
    const [plugin] = joinClawHubPluginCatalog({
      remote: [remote],
      local: { plugins: [], diagnostics: [], mutationAllowed: true },
    });
    const id = plugin?.id;
    if (!id) {
      throw new Error("Expected the joined catalog fixture to have an opaque id.");
    }

    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(id).not.toContain(remote.packageName);
    expect(decodePluginDiscoveryId(id)).toBe(remote.packageName);
    expect(decodePluginDiscoveryId("@alice/memory-plus")).toBeUndefined();
  });

  it("joins a package runtime alias to authoritative Gateway state", () => {
    const [plugin] = joinClawHubPluginCatalog({
      remote: [remote],
      local: {
        plugins: [
          {
            id: "memory-plus",
            name: "Memory Plus",
            installed: true,
            enabled: false,
            state: "needs-setup",
          },
        ],
        diagnostics: [],
        mutationAllowed: true,
      },
    });

    expect(plugin?.local).toEqual({
      present: true,
      installed: true,
      enabled: false,
      state: "needs-setup",
      pluginId: "memory-plus",
      action: "manage",
    });
  });

  it("does not claim install eligibility when Gateway mutation is disabled", () => {
    const [plugin] = joinClawHubPluginCatalog({
      remote: [remote],
      local: { plugins: [], diagnostics: [], mutationAllowed: false },
    });

    expect(plugin?.local).toEqual({
      present: false,
      installed: false,
      enabled: false,
      state: "not-installed",
      action: "unavailable",
    });
  });
});
