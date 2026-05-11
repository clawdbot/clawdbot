import { describe, expect, it, vi } from "vitest";
import { CodexAppInventoryCache, buildCodexAppInventoryCacheKey } from "./app-inventory-cache.js";
import type { v2 } from "./protocol.js";

describe("Codex app inventory cache", () => {
  it("returns missing while scheduling one coalesced app/list refresh", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const request = vi.fn(async (_method: "app/list", params: v2.AppsListParams) => {
      return {
        data: [app(params.cursor ? "app-2" : "app-1")],
        nextCursor: params.cursor ? null : "next",
      } satisfies v2.AppsListResponse;
    });

    const key = buildCodexAppInventoryCacheKey({ codexHome: "/codex", authProfileId: "work" });
    const read = cache.read({ key, request, nowMs: 0 });
    expect(read.state).toBe("missing");
    expect(read.refreshScheduled).toBe(true);

    const snapshot = await cache.refreshNow({ key, request, nowMs: 0 });
    expect(snapshot.apps.map((item) => item.id)).toEqual(["app-1", "app-2"]);
    expect(request).toHaveBeenCalledTimes(2);

    const fresh = cache.read({ key, request, nowMs: 50 });
    expect(fresh.state).toBe("fresh");
    expect(fresh.refreshScheduled).toBe(false);
    expect(fresh.snapshot?.apps.map((item) => item.id)).toEqual(["app-1", "app-2"]);
  });

  it("uses stale inventory for the current read while refreshing asynchronously", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 10 });
    const request = vi.fn(async () => {
      return {
        data: [app(`app-${request.mock.calls.length}`)],
        nextCursor: null,
      } satisfies v2.AppsListResponse;
    });
    const key = "runtime";
    await cache.refreshNow({ key, request, nowMs: 0 });

    const stale = cache.read({ key, request, nowMs: 11 });
    expect(stale.state).toBe("stale");
    expect(stale.snapshot?.apps.map((item) => item.id)).toEqual(["app-1"]);
    expect(stale.refreshScheduled).toBe(true);

    const refreshed = await cache.refreshNow({ key, request, nowMs: 11 });
    expect(refreshed.apps.map((item) => item.id)).toEqual(["app-2"]);
  });

  it("records refresh errors without discarding the last successful snapshot", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 1 });
    const key = "runtime";
    await cache.refreshNow({
      key,
      nowMs: 0,
      request: async () => ({ data: [app("app-1")], nextCursor: null }),
    });

    await expect(
      cache.refreshNow({
        key,
        nowMs: 2,
        request: async () => {
          throw new Error("app list failed");
        },
      }),
    ).rejects.toThrow("app list failed");

    const read = cache.read({
      key,
      nowMs: 2,
      request: async () => ({ data: [app("app-2")], nextCursor: null }),
    });
    expect(read.snapshot?.apps.map((item) => item.id)).toEqual(["app-1"]);
    expect(read.diagnostic?.message).toBe("app list failed");
  });

  it("forces a post-install refresh past an older in-flight app/list", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 1_000 });
    const key = "runtime";
    let resolveStale: ((response: v2.AppsListResponse) => void) | undefined;
    let resolveFresh: ((response: v2.AppsListResponse) => void) | undefined;
    const request = vi.fn(
      async (_method: "app/list", params: v2.AppsListParams): Promise<v2.AppsListResponse> => {
        expect(params.forceRefetch).toBe(request.mock.calls.length === 2);
        return await new Promise((resolve) => {
          if (request.mock.calls.length === 1) {
            resolveStale = resolve;
          } else {
            resolveFresh = resolve;
          }
        });
      },
    );

    const staleRead = cache.read({ key, request, nowMs: 0 });
    expect(staleRead.state).toBe("missing");
    expect(staleRead.refreshScheduled).toBe(true);

    cache.invalidate(key, "plugin installed", 1);
    const forcedRead = cache.read({ key, request, nowMs: 1, forceRefetch: true });
    expect(forcedRead.state).toBe("missing");
    expect(forcedRead.refreshScheduled).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);

    const forced = cache.refreshNow({ key, request, nowMs: 1 });
    resolveFresh?.({ data: [app("fresh-app")], nextCursor: null });
    await expect(forced).resolves.toStrictEqual({
      key,
      apps: [app("fresh-app")],
      fetchedAtMs: 1,
      expiresAtMs: 1_001,
      revision: 2,
    });

    resolveStale?.({ data: [app("stale-app")], nextCursor: null });
    await Promise.resolve();

    const freshRead = cache.read({ key, request, nowMs: 2 });
    expect(freshRead.state).toBe("fresh");
    expect(freshRead.snapshot?.apps.map((item) => item.id)).toEqual(["fresh-app"]);
  });
});

function app(id: string): v2.AppInfo {
  return {
    id,
    name: id,
    description: null,
    logoUrl: null,
    logoUrlDark: null,
    distributionChannel: null,
    branding: null,
    appMetadata: null,
    labels: null,
    installUrl: null,
    isAccessible: true,
    isEnabled: true,
    pluginDisplayNames: [],
  };
}
