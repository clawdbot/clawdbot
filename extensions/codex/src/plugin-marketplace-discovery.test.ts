import { describe, expect, it, vi } from "vitest";
import type { v2 } from "./app-server/protocol.js";
import {
  discoverCodexMarketplacePlugins,
  parseCodexPluginMarketplaceId,
} from "./plugin-marketplace-discovery.js";

function catalog(name: string, pluginName: string, path?: string): v2.PluginListResponse {
  return {
    marketplaces: [
      {
        name,
        ...(path ? { path } : {}),
        plugins: [
          {
            id: `${pluginName}@${name}`,
            name: pluginName,
            installed: false,
            enabled: false,
            installPolicy: "AVAILABLE",
            authPolicy: "ON_USE",
            interface: { shortDescription: "Summarize\nsource code" },
          },
        ],
      },
    ],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  };
}

describe("Codex marketplace plugin discovery", () => {
  it("merges repository/global and workspace/shared/personal marketplace requests", async () => {
    const request = vi.fn(async (params: v2.PluginListParams) =>
      params.marketplaceKinds
        ? catalog("workspace-directory", "workspace-review")
        : catalog("company-tools", "security-review", "/repo/.agents/plugins/marketplace.json"),
    );

    const result = await discoverCodexMarketplacePlugins({ request, workspaceDir: "/repo" });

    expect(request).toHaveBeenNthCalledWith(1, { cwds: ["/repo"] });
    expect(request).toHaveBeenNthCalledWith(2, {
      cwds: ["/repo"],
      marketplaceKinds: [
        "workspace-directory",
        "shared-with-me",
        "created-by-me-remote",
        "vertical",
      ],
    });
    expect(result.plugins.map((plugin) => plugin.id)).toEqual([
      "security-review@company-tools",
      "workspace-review@workspace-directory",
    ]);
    expect(result.plugins[0]?.description).toBe("Summarize source code");
  });

  it("preserves authorized workspace catalogs when another supplemental category fails", async () => {
    const request = vi.fn(async (params: v2.PluginListParams) => {
      if (!params.marketplaceKinds) {
        return catalog("openai-curated", "github", "/managed/catalog.json");
      }
      if (params.marketplaceKinds.length > 1) {
        throw new Error("personal catalog requires authentication");
      }
      if (params.marketplaceKinds[0] === "workspace-directory") {
        return catalog("workspace-directory", "security-review");
      }
      throw new Error("catalog not available for this account");
    });

    const result = await discoverCodexMarketplacePlugins({ request, workspaceDir: "/repo" });

    expect(result.plugins.map((plugin) => plugin.id)).toEqual([
      "github@openai-curated",
      "security-review@workspace-directory",
    ]);
    expect(result.warnings).toContain(
      "shared-with-me marketplace unavailable: catalog not available for this account",
    );
  });

  it("fails closed for marketplace and plugin names outside the upstream identifier contract", async () => {
    const request = vi.fn(async () => catalog("../company-tools", "security-review"));

    const result = await discoverCodexMarketplacePlugins({ request, workspaceDir: "/repo" });

    expect(result.plugins).toEqual([]);
    expect(parseCodexPluginMarketplaceId("review@company-tools")).toEqual({
      pluginName: "review",
      marketplaceName: "company-tools",
    });
    expect(parseCodexPluginMarketplaceId("../review@company-tools")).toBeUndefined();
    expect(parseCodexPluginMarketplaceId("review@../company-tools")).toBeUndefined();
    expect(parseCodexPluginMarketplaceId("review@company@tools")).toBeUndefined();
  });

  it("derives a stable slug from summary identities when a remote display name contains spaces", async () => {
    const listed = catalog("workspace-directory", "security-review");
    listed.marketplaces[0]!.plugins[0]!.name = "Security Review";
    const request = vi.fn(async () => listed);

    const result = await discoverCodexMarketplacePlugins({ request, workspaceDir: "/repo" });

    expect(result.plugins[0]?.id).toBe("security-review@workspace-directory");
  });

  it("refuses ambiguous equal identifiers from different marketplace paths", async () => {
    const request = vi.fn(async (params: v2.PluginListParams) =>
      params.marketplaceKinds
        ? catalog("company-tools", "security-review", "/different/marketplace.json")
        : catalog("company-tools", "security-review", "/repo/marketplace.json"),
    );

    const result = await discoverCodexMarketplacePlugins({ request, workspaceDir: "/repo" });

    expect(result.plugins).toEqual([]);
    expect(result.warnings[0]).toContain("requires a unique identity");
  });

  it("deduplicates qualified and unqualified summaries for the same trusted marketplace source", async () => {
    const request = vi.fn(async (params: v2.PluginListParams) => {
      const listed = catalog("company-tools", "security-review", "/repo/marketplace.json");
      if (!params.marketplaceKinds) {
        listed.marketplaces[0]!.plugins[0]!.id = "security-review";
      }
      return listed;
    });

    const result = await discoverCodexMarketplacePlugins({ request, workspaceDir: "/repo" });

    expect(result.plugins.map((plugin) => plugin.id)).toEqual(["security-review@company-tools"]);
    expect(result.warnings).toEqual([]);
  });

  it.each([
    { availability: "DISABLED_BY_ADMIN", installPolicy: "AVAILABLE" },
    { availability: "AVAILABLE", installPolicy: "NOT_AVAILABLE" },
  ] as const)(
    "retains the most restrictive policy across duplicate catalog snapshots",
    async (policy) => {
      const request = vi.fn(async (params: v2.PluginListParams) => {
        const listed = catalog("company-tools", "security-review", "/repo/marketplace.json");
        if (params.marketplaceKinds) {
          Object.assign(listed.marketplaces[0]!.plugins[0]!, policy);
        }
        return listed;
      });

      const result = await discoverCodexMarketplacePlugins({ request, workspaceDir: "/repo" });

      expect(result.plugins).toHaveLength(1);
      expect(result.plugins[0]?.available).toBe(false);
    },
  );

  it("retains Codex-approved local marketplaces regardless of their catalog name", async () => {
    const request = vi.fn(async () =>
      catalog("openai-curated", "github", "/repo/.agents/plugins/marketplace.json"),
    );

    const result = await discoverCodexMarketplacePlugins({
      request,
      workspaceDir: "/repo/subdirectory",
    });

    expect(result.plugins.map((plugin) => plugin.id)).toEqual(["github@openai-curated"]);
    expect(result.warnings).toEqual([]);
  });

  it.each([true, false, null] as const)(
    "preserves remote installation-interstitial policy %j",
    async (mustShowInstallationInterstitial) => {
      const listed = catalog("workspace-directory", "security-review");
      Object.assign(listed.marketplaces[0]!.plugins[0]!, {
        remotePluginId: "plugins~Plugin_remote_opaque",
        mustShowInstallationInterstitial,
      });

      const result = await discoverCodexMarketplacePlugins({
        request: vi.fn(async () => listed),
        workspaceDir: "/repo",
      });

      expect(result.plugins[0]?.mustShowInstallationInterstitial).toBe(
        mustShowInstallationInterstitial,
      );
    },
  );
});
