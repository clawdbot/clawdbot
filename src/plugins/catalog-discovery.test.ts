import { describe, expect, it } from "vitest";
import { joinClawHubPluginCatalog, resolvePluginDiscoveryIdentity } from "./catalog-discovery.js";

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
    expect(resolvePluginDiscoveryIdentity(id)).toEqual({
      origin: "clawhub",
      identity: remote.packageName,
    });
    expect(resolvePluginDiscoveryIdentity("@alice/memory-plus")).toBeUndefined();
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

  it("deduplicates canonical and aliased local entries while preserving local state", () => {
    const items = joinClawHubPluginCatalog({
      remote: [remote],
      local: {
        plugins: [
          {
            id: "memory-plus",
            packageName: "@alice/memory-plus",
            name: "Local presentation",
            installed: true,
            enabled: true,
            state: "enabled",
          },
        ],
        diagnostics: [],
        mutationAllowed: true,
      },
      published: [],
      includeBundledOnly: true,
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.catalog.name).toBe("Memory Plus");
    expect(items[0]?.local.state).toBe("enabled");
  });

  it("places unpublished bundled entries before ClawHub results only when requested", () => {
    const bundledOnly = {
      id: "calendar-local",
      name: "Calendar Local",
      description: "Coordinate a local calendar.",
      packageName: "@openclaw/calendar-local",
      origin: "bundled",
      installed: false,
      enabled: false,
      state: "not-installed" as const,
      category: "tool",
      install: { source: "official" as const, pluginId: "calendar-local" },
    };
    const local = { plugins: [bundledOnly], diagnostics: [], mutationAllowed: true };

    const all = joinClawHubPluginCatalog({
      remote: [remote],
      local,
      intent: "all",
    });
    const tools = joinClawHubPluginCatalog({
      remote: [],
      local,
      includeBundledOnly: true,
      published: [remote],
      intent: "bundled",
      category: "tools",
    });

    expect(all.map((item) => item.catalog.name)).toEqual(["Memory Plus"]);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      catalog: { categories: ["tools"], official: false },
      local: {
        present: true,
        action: "install",
        install: { source: "official", pluginId: "calendar-local" },
      },
    });
    expect(resolvePluginDiscoveryIdentity(tools[0]?.id ?? "")).toEqual({
      origin: "local",
      identity: "@openclaw/calendar-local",
    });
  });

  it("uses the complete publication set so a later ClawHub page cannot become a bundled result", () => {
    const expedia = {
      ...remote,
      packageName: "@expediagroup/expedia-openclaw",
      displayName: "Expedia Travel",
      runtimeId: "expedia-travel",
    };
    const local = {
      plugins: [
        {
          id: "expedia-travel",
          packageName: expedia.packageName,
          name: "Expedia Travel",
          origin: "official",
          installed: false,
          enabled: false,
          state: "not-installed" as const,
        },
        {
          id: "private-bundle",
          packageName: "@openclaw/private-bundle",
          name: "Private Bundle",
          origin: "bundled",
          installed: false,
          enabled: false,
          state: "not-installed" as const,
        },
      ],
      diagnostics: [],
      mutationAllowed: true,
    };

    const items = joinClawHubPluginCatalog({
      remote: [],
      published: [expedia],
      local,
      includeBundledOnly: true,
      intent: "bundled",
    });

    expect(items.map((item) => item.catalog.name)).toEqual(["Private Bundle"]);
  });

  it("filters bundled entries for unified search and keeps them ahead of ClawHub results", () => {
    const local = {
      plugins: [
        {
          id: "calendar-local",
          name: "Memory Calendar",
          description: "Coordinate a local calendar.",
          installed: false,
          enabled: false,
          state: "not-installed" as const,
          category: "tool",
          origin: "bundled",
          install: { source: "official" as const, pluginId: "calendar-local" },
        },
      ],
      diagnostics: [],
      mutationAllowed: true,
    };
    const common = {
      remote: [remote],
      published: [remote],
      local,
      includeBundledOnly: true,
    } as const;

    expect(
      joinClawHubPluginCatalog({ ...common, query: "memory" }).map((item) => item.catalog.name),
    ).toEqual(["Memory Calendar", "Memory Plus"]);
    expect(joinClawHubPluginCatalog({ ...common, remote: [], query: "unrelated" })).toHaveLength(0);
  });
});
