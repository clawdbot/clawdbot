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

  it("keeps query kinds and runtime identities separate", async () => {
    const cache = new CodexPluginMetadataCache();
    const request = vi.fn(async (_method: string, params: v2.PluginListParams) =>
      pluginList(params.marketplaceKinds ? "workspace-directory" : "openai-curated-remote"),
    );

    await cache.load({
      appCacheKey: "runtime-a",
      queryKind: "curated-global",
      requestParams: {},
      request,
    });
    await cache.load({
      appCacheKey: "runtime-a",
      queryKind: "workspace-directory",
      requestParams: { cwds: [], marketplaceKinds: ["workspace-directory"] },
      request,
    });
    await cache.load({
      appCacheKey: "runtime-b",
      queryKind: "curated-global",
      requestParams: {},
      request,
    });

    expect(request).toHaveBeenCalledTimes(3);
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
    incomplete.marketplaceLoadErrors = [{ message: "catalog unavailable" }];
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

  it("reuses a successful workspace snapshot for the process lifetime", async () => {
    const cache = new CodexPluginMetadataCache();
    const request = vi.fn(async () => pluginList("workspace-directory"));
    const params = {
      appCacheKey: "runtime-a",
      queryKind: "workspace-directory" as const,
      requestParams: {
        cwds: [],
        marketplaceKinds: ["workspace-directory"],
      } satisfies v2.PluginListParams,
      request,
    };

    const first = await cache.load(params);
    await expect(cache.load(params)).resolves.toBe(first);
    expect(request).toHaveBeenCalledTimes(1);
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
