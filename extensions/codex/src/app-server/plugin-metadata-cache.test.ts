// Codex tests cover plugin metadata cache behavior.
import { describe, expect, it, vi } from "vitest";
import { CodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import type { v2 } from "./protocol.js";

describe("Codex plugin metadata cache", () => {
  it("coalesces and reuses the full successful snapshot", async () => {
    const cache = new CodexPluginMetadataCache();
    let release: ((response: v2.PluginListResponse) => void) | undefined;
    const request = vi.fn(
      async () =>
        await new Promise<v2.PluginListResponse>((resolve) => {
          release = resolve;
        }),
    );
    const params = {
      appCacheKey: "runtime-a",
      queryKind: "curated-global" as const,
      requestParams: {},
      request,
    };

    const first = cache.load(params);
    const second = cache.load(params);
    const response = pluginList("openai-curated-remote", "calendar");
    release?.(response);

    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(firstSnapshot).toBe(secondSnapshot);
    expect(firstSnapshot.response).toBe(response);
    await expect(cache.load(params)).resolves.toBe(firstSnapshot);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("coalesces installed plugins through the exact Codex 0.146 endpoint", async () => {
    const cache = new CodexPluginMetadataCache();
    let release: ((response: v2.PluginInstalledResponse) => void) | undefined;
    const request = vi.fn(
      async () =>
        await new Promise<v2.PluginInstalledResponse>((resolve) => {
          release = resolve;
        }),
    );
    const requestParams = { cwds: ["/workspace/a"] } satisfies v2.PluginInstalledParams;
    const params = {
      appCacheKey: "runtime-a",
      queryKind: "installed" as const,
      requestParams,
      request,
    };

    const first = cache.load(params);
    const second = cache.load(params);
    expect(request).toHaveBeenCalledExactlyOnceWith("plugin/installed", requestParams);
    const response = installedPlugins("workspace-directory", "calendar");
    release?.(response);

    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
    expect(firstSnapshot).toBe(secondSnapshot);
    expect(firstSnapshot.response).toBe(response);
    expect(cache.read("runtime-a", "installed", requestParams)).toBe(firstSnapshot);
    expect(cache.read("runtime-a", "installed")).toBeUndefined();
    await expect(cache.load(params)).resolves.toBe(firstSnapshot);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps installed workspaces, catalog queries, and runtime identities separate", async () => {
    const cache = new CodexPluginMetadataCache();
    const request = vi.fn(
      async (
        method: "plugin/list" | "plugin/installed",
        params: v2.PluginListParams | v2.PluginInstalledParams,
      ) =>
        method === "plugin/installed"
          ? installedPlugins("workspace-directory", params.cwds?.[0] ?? "home")
          : pluginList("openai-curated-remote", "calendar"),
    );
    const installedRequest = async (
      method: "plugin/installed",
      params: v2.PluginInstalledParams,
    ): Promise<v2.PluginInstalledResponse> =>
      (await request(method, params)) as v2.PluginInstalledResponse;
    const catalogRequest = async (
      method: "plugin/list",
      params: v2.PluginListParams,
    ): Promise<v2.PluginListResponse> => (await request(method, params)) as v2.PluginListResponse;

    const workspaceA = await cache.load({
      appCacheKey: "runtime-a",
      queryKind: "installed",
      requestParams: { cwds: ["/workspace/a"] },
      request: installedRequest,
    });
    const workspaceB = await cache.load({
      appCacheKey: "runtime-a",
      queryKind: "installed",
      requestParams: { cwds: ["/workspace/b"] },
      request: installedRequest,
    });
    const curated = await cache.load({
      appCacheKey: "runtime-a",
      queryKind: "curated-global",
      requestParams: {},
      request: catalogRequest,
    });
    const otherRuntime = await cache.load({
      appCacheKey: "runtime-b",
      queryKind: "installed",
      requestParams: { cwds: ["/workspace/a"] },
      request: installedRequest,
    });

    expect(request).toHaveBeenCalledTimes(4);
    expect(request).toHaveBeenNthCalledWith(1, "plugin/installed", {
      cwds: ["/workspace/a"],
    });
    expect(request).toHaveBeenNthCalledWith(2, "plugin/installed", {
      cwds: ["/workspace/b"],
    });
    expect(request).toHaveBeenNthCalledWith(3, "plugin/list", {});
    expect(request).toHaveBeenNthCalledWith(4, "plugin/installed", {
      cwds: ["/workspace/a"],
    });
    expect(cache.read("runtime-a", "installed", { cwds: ["/workspace/a"] })).toBe(workspaceA);
    expect(cache.read("runtime-a", "installed", { cwds: ["/workspace/b"] })).toBe(workspaceB);
    expect(cache.read("runtime-a", "curated-global")).toBe(curated);
    expect(cache.read("runtime-b", "installed", { cwds: ["/workspace/a"] })).toBe(otherRuntime);
  });

  it("coalesces omitted and null installed-plugin scope as the same upstream query", async () => {
    const cache = new CodexPluginMetadataCache();
    const request = vi.fn(async () => installedPlugins("openai-curated-remote", "calendar"));

    const omitted = await cache.load({
      appCacheKey: "runtime-a",
      queryKind: "installed",
      requestParams: {},
      request,
    });
    const explicitNull = await cache.load({
      appCacheKey: "runtime-a",
      queryKind: "installed",
      requestParams: { cwds: null, installSuggestionPluginNames: null },
      request,
    });

    expect(explicitNull).toBe(omitted);
    expect(cache.read("runtime-a", "installed")).toBe(omitted);
    expect(request).toHaveBeenCalledExactlyOnceWith("plugin/installed", {});
  });

  it("keys installed suggestion sets using Codex's actual order-independent contract", async () => {
    const cache = new CodexPluginMetadataCache();
    const request = vi.fn(async () => installedPlugins("workspace-directory", "calendar"));
    const load = (installSuggestionPluginNames: string[]) =>
      cache.load({
        appCacheKey: "runtime-a",
        queryKind: "installed",
        requestParams: {
          cwds: ["/workspace/a"],
          installSuggestionPluginNames,
        },
        request,
      });

    const first = await load(["calendar", "drive", "calendar"]);
    await expect(load(["drive", "calendar"])).resolves.toBe(first);
    await load(["calendar"]);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, "plugin/installed", {
      cwds: ["/workspace/a"],
      installSuggestionPluginNames: ["calendar", "drive", "calendar"],
    });
    expect(request).toHaveBeenNthCalledWith(2, "plugin/installed", {
      cwds: ["/workspace/a"],
      installSuggestionPluginNames: ["calendar"],
    });
  });

  it("does not cache a failed installed-plugin request", async () => {
    const cache = new CodexPluginMetadataCache();
    const response = installedPlugins("workspace-directory", "calendar");
    const request = vi
      .fn<() => Promise<v2.PluginInstalledResponse>>()
      .mockRejectedValueOnce(new Error("installed plugins unavailable"))
      .mockResolvedValueOnce(response);
    const requestParams = { cwds: ["/workspace/a"] } satisfies v2.PluginInstalledParams;
    const params = {
      appCacheKey: "runtime-a",
      queryKind: "installed" as const,
      requestParams,
      request,
    };

    await expect(cache.load(params)).rejects.toThrow("installed plugins unavailable");
    expect(cache.read("runtime-a", "installed", requestParams)).toBeUndefined();
    await expect(cache.load(params)).resolves.toMatchObject({ response });
    expect(cache.read("runtime-a", "installed", requestParams)?.response).toBe(response);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not cache installed marketplaces that Codex reports as incomplete", async () => {
    const cache = new CodexPluginMetadataCache();
    const incomplete = installedPlugins("workspace-directory", "calendar");
    incomplete.marketplaceLoadErrors.push({
      marketplacePath: "/workspace/a/.codex/plugins",
      message: "workspace marketplace unavailable",
    });
    const healthy = installedPlugins("workspace-directory", "calendar");
    const request = vi
      .fn<() => Promise<v2.PluginInstalledResponse>>()
      .mockResolvedValueOnce(incomplete)
      .mockResolvedValueOnce(healthy);
    const requestParams = { cwds: ["/workspace/a"] } satisfies v2.PluginInstalledParams;
    const params = {
      appCacheKey: "runtime-a",
      queryKind: "installed" as const,
      requestParams,
      request,
    };

    await expect(cache.load(params)).resolves.toMatchObject({ response: incomplete });
    expect(cache.read("runtime-a", "installed", requestParams)).toBeUndefined();
    await expect(cache.load(params)).resolves.toMatchObject({ response: healthy });
    expect(cache.read("runtime-a", "installed", requestParams)?.response).toBe(healthy);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("invalidates every installed workspace snapshot for the changed runtime only", async () => {
    const cache = new CodexPluginMetadataCache();
    const request = vi.fn(async () => installedPlugins("workspace-directory", "calendar"));
    const load = (appCacheKey: string, cwd: string) =>
      cache.load({
        appCacheKey,
        queryKind: "installed",
        requestParams: { cwds: [cwd] },
        request,
      });

    await load("runtime-a", "/workspace/a");
    await load("runtime-a", "/workspace/b");
    const unrelated = await load("runtime-b", "/workspace/a");

    cache.invalidate("runtime-a");

    expect(cache.read("runtime-a", "installed", { cwds: ["/workspace/a"] })).toBeUndefined();
    expect(cache.read("runtime-a", "installed", { cwds: ["/workspace/b"] })).toBeUndefined();
    expect(cache.read("runtime-b", "installed", { cwds: ["/workspace/a"] })).toBe(unrelated);

    await load("runtime-a", "/workspace/a");
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("does not settle snapshots the caller marks uncacheable", async () => {
    // Upstream plugin/list fails open for remote catalogs (local-only response,
    // empty marketplaceLoadErrors); such a snapshot must not settle negatives.
    const cache = new CodexPluginMetadataCache();
    const failOpen = pluginList("local-only");
    const healthy = pluginList("openai-curated-remote", "calendar");
    const request = vi.fn(async () => (request.mock.calls.length > 1 ? healthy : failOpen));
    const params = {
      appCacheKey: "runtime-a",
      queryKind: "curated-global" as const,
      requestParams: {},
      request,
      cacheable: (response: v2.PluginListResponse) =>
        response.marketplaces.some((entry) => entry.name === "openai-curated-remote"),
    };

    await expect(cache.load(params)).resolves.toMatchObject({ response: failOpen });
    expect(cache.read("runtime-a", "curated-global")).toBeUndefined();
    await expect(cache.load(params)).resolves.toMatchObject({ response: healthy });
    expect(cache.read("runtime-a", "curated-global")?.response).toBe(healthy);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("expires settled snapshots after the freshness window", async () => {
    // Upstream refreshes its remote catalog in the background; a settled
    // negative must not deny a configured plugin for the process lifetime.
    let now = 0;
    const cache = new CodexPluginMetadataCache(() => now);
    const request = vi.fn(async () => pluginList("openai-curated-remote", "calendar"));
    const params = {
      appCacheKey: "runtime-a",
      queryKind: "curated-global" as const,
      requestParams: {},
      request,
    };

    await cache.load(params);
    await cache.load(params);
    expect(request).toHaveBeenCalledTimes(1);
    now = 60 * 60 * 1_000 + 1;
    expect(cache.read("runtime-a", "curated-global")).toBeUndefined();
    await cache.load(params);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps curated catalog runtime identities separate", async () => {
    const cache = new CodexPluginMetadataCache();
    const request = vi.fn(async () => pluginList("openai-curated-remote"));

    await cache.load({
      appCacheKey: "runtime-a",
      queryKind: "curated-global",
      requestParams: {},
      request,
    });
    await cache.load({
      appCacheKey: "runtime-b",
      queryKind: "curated-global",
      requestParams: {},
      request,
    });

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not cache failed requests", async () => {
    const cache = new CodexPluginMetadataCache();
    const request = vi
      .fn<() => Promise<v2.PluginListResponse>>()
      .mockRejectedValueOnce(new Error("catalog unavailable"))
      .mockResolvedValueOnce(pluginList("openai-curated-remote"));
    const params = {
      appCacheKey: "runtime-a",
      queryKind: "curated-global" as const,
      requestParams: {},
      request,
    };

    await expect(cache.load(params)).rejects.toThrow("catalog unavailable");
    await expect(cache.load(params)).resolves.toMatchObject({
      response: { marketplaces: [{ name: "openai-curated-remote" }] },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not cache responses with marketplace load errors", async () => {
    const cache = new CodexPluginMetadataCache();
    const incomplete = pluginList("openai-curated-remote");
    incomplete.marketplaceLoadErrors = [
      { marketplacePath: "/marketplaces/openai-curated", message: "catalog unavailable" },
    ];
    const request = vi
      .fn<() => Promise<v2.PluginListResponse>>()
      .mockResolvedValueOnce(incomplete)
      .mockResolvedValueOnce(pluginList("openai-curated-remote", "calendar"));
    const params = {
      appCacheKey: "runtime-a",
      queryKind: "curated-global" as const,
      requestParams: {},
      request,
    };

    await expect(cache.load(params)).resolves.toMatchObject({ response: incomplete });
    expect(cache.read("runtime-a", "curated-global")).toBeUndefined();
    await expect(cache.load(params)).resolves.toMatchObject({
      response: { marketplaces: [{ plugins: [{ id: "calendar" }] }] },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh load after invalidation while an older load is pending", async () => {
    const cache = new CodexPluginMetadataCache();
    const releases: Array<(response: v2.PluginListResponse) => void> = [];
    const request = vi.fn(
      async () =>
        await new Promise<v2.PluginListResponse>((resolve) => {
          releases.push(resolve);
        }),
    );
    const params = {
      appCacheKey: "runtime-a",
      queryKind: "curated-global" as const,
      requestParams: {},
      request,
    };

    const beforeInstall = cache.load(params);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    cache.invalidate("runtime-a");
    const afterInstall = cache.load(params);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    const current = pluginList("openai-curated-remote", "calendar");
    releases[1]?.(current);
    await expect(afterInstall).resolves.toMatchObject({ response: current });
    releases[0]?.(pluginList("openai-curated-remote"));
    await expect(beforeInstall).resolves.toBeDefined();
    expect(cache.read("runtime-a", "curated-global")?.response).toBe(current);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("retries a joined load with the caller's request after the owner fails", async () => {
    const cache = new CodexPluginMetadataCache();
    let rejectOwner: ((error: Error) => void) | undefined;
    const ownerRequest = vi.fn(
      async () =>
        await new Promise<v2.PluginListResponse>((_resolve, reject) => {
          rejectOwner = reject;
        }),
    );
    const params = {
      appCacheKey: "runtime-a",
      queryKind: "curated-global" as const,
      requestParams: {},
    };
    const owner = cache.load({ ...params, request: ownerRequest });
    const ownerResult = owner.catch((error: unknown) => error);
    await vi.waitFor(() => expect(rejectOwner).toBeTypeOf("function"));
    const joiningRequest = vi.fn(async () => pluginList("openai-curated-remote", "calendar"));
    const joining = cache.load({ ...params, request: joiningRequest });

    rejectOwner?.(new Error("owner cancelled"));
    await expect(ownerResult).resolves.toBeInstanceOf(Error);
    await expect(joining).resolves.toMatchObject({
      response: { marketplaces: [{ plugins: [{ id: "calendar" }] }] },
    });
    expect(ownerRequest).toHaveBeenCalledTimes(1);
    expect(joiningRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps an unrelated runtime load cacheable across invalidation", async () => {
    const cache = new CodexPluginMetadataCache();
    let release: ((response: v2.PluginListResponse) => void) | undefined;
    const request = vi.fn(
      async () =>
        await new Promise<v2.PluginListResponse>((resolve) => {
          release = resolve;
        }),
    );
    const params = {
      appCacheKey: "runtime-b",
      queryKind: "curated-global" as const,
      requestParams: {},
      request,
    };
    const pending = cache.load(params);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));

    cache.invalidate("runtime-a");
    const response = pluginList("openai-curated-remote", "calendar");
    release?.(response);
    await pending;

    await expect(cache.load(params)).resolves.toMatchObject({ response });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("invalidates one runtime and clear resets all snapshots", async () => {
    const cache = new CodexPluginMetadataCache();
    const request = vi.fn(async () => pluginList("openai-curated-remote"));
    const load = (appCacheKey: string) =>
      cache.load({
        appCacheKey,
        queryKind: "curated-global",
        requestParams: {},
        request,
      });

    await load("runtime-a");
    await load("runtime-b");
    cache.invalidate("runtime-a");
    await load("runtime-a");
    await load("runtime-b");
    expect(request).toHaveBeenCalledTimes(3);

    cache.clear();
    expect(cache.read("runtime-a", "curated-global")).toBeUndefined();
    expect(cache.read("runtime-b", "curated-global")).toBeUndefined();
  });
});

function pluginList(marketplaceName: string, pluginId?: string): v2.PluginListResponse {
  return {
    marketplaces: [
      {
        name: marketplaceName,
        path: null,
        interface: null,
        plugins: pluginId
          ? [
              {
                id: pluginId,
                name: pluginId,
                source: { type: "remote" },
                installed: false,
                enabled: false,
                installPolicy: "AVAILABLE",
                authPolicy: "ON_USE",
                availability: "AVAILABLE",
                interface: null,
              },
            ]
          : [],
      },
    ],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  };
}

function installedPlugins(marketplaceName: string, pluginId?: string): v2.PluginInstalledResponse {
  const { marketplaces } = pluginList(marketplaceName, pluginId);
  for (const marketplace of marketplaces) {
    for (const plugin of marketplace.plugins) {
      plugin.installed = true;
      plugin.enabled = true;
    }
  }
  return {
    marketplaces,
    marketplaceLoadErrors: [],
  };
}
