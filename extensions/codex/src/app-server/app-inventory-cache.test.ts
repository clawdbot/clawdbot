// Codex tests cover app inventory cache plugin behavior.
import { MAX_DATE_TIMESTAMP_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  CodexAppInventoryCache,
  buildCodexAppInventoryCacheKey,
  serializeCodexAppInventoryError,
} from "./app-inventory-cache.js";
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

    const key = buildCodexAppInventoryCacheKey(
      { codexHome: "/codex", authProfileId: "work" },
      "2026.6.27",
      "2026.6.27",
    );
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

  it("changes the cache key when either build version changes", () => {
    const input = { codexHome: "/codex", authProfileId: "work" };
    const baseline = buildCodexAppInventoryCacheKey(input, "2026.6.27", "2026.6.27");

    expect(buildCodexAppInventoryCacheKey(input, "2026.6.28", "2026.6.27")).not.toBe(baseline);
    expect(buildCodexAppInventoryCacheKey(input, "2026.6.27", "2026.6.28")).not.toBe(baseline);
  });

  it("can read missing inventory without scheduling app/list", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const request = vi.fn(async () => {
      return {
        data: [app("app-1")],
        nextCursor: null,
      } satisfies v2.AppsListResponse;
    });

    const read = cache.read({
      key: "runtime",
      request,
      suppressRefresh: true,
    });

    expect(read.state).toBe("missing");
    expect(read.refreshScheduled).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("finds a targeted app on a later large page", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const request = vi.fn(async (_method: "app/list", params: v2.AppsListParams) => {
      return {
        data: [app(params.cursor ? "google-calendar-app" : "app-1")],
        nextCursor: params.cursor ? "page-3" : "page-2",
      } satisfies v2.AppsListResponse;
    });

    const snapshot = await cache.refreshNow({
      key: "runtime",
      request,
      targetAppIds: ["google-calendar-app"],
    });

    expect(snapshot.apps.map((item) => item.id)).toEqual(["app-1", "google-calendar-app"]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, "app/list", {
      cursor: undefined,
      limit: 1_000,
      forceRefetch: false,
    });
    expect(request).toHaveBeenNthCalledWith(2, "app/list", {
      cursor: "page-2",
      limit: 1_000,
      forceRefetch: false,
    });
  });

  it("exhausts targeted refresh pages when a target app is absent", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const request = vi.fn(async (_method: "app/list", params: v2.AppsListParams) => {
      return {
        data: [app(params.cursor ? "app-2" : "app-1")],
        nextCursor: params.cursor ? null : "page-2",
      } satisfies v2.AppsListResponse;
    });

    const snapshot = await cache.refreshNow({
      key: "runtime",
      request,
      targetAppIds: ["missing-app"],
    });

    expect(snapshot.apps.map((item) => item.id)).toEqual(["app-1", "app-2"]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects a repeated app/list cursor instead of caching a partial snapshot", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const request = vi.fn(async () => ({
      data: [app(`app-${request.mock.calls.length}`)],
      nextCursor: "page-2",
    }));

    await expect(
      cache.refreshNow({
        key: "runtime",
        request,
        targetAppIds: ["missing-app"],
      }),
    ).rejects.toThrow("app/list returned repeated cursor page-2");

    const read = cache.read({ key: "runtime", request, suppressRefresh: true });
    expect(read.state).toBe("missing");
    expect(read.snapshot).toBeUndefined();
  });

  it("uses stale inventory for the current read while still refreshing asynchronously", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 10 });
    const request = vi.fn(async () => {
      return {
        data: [app(`app-${request.mock.calls.length}`)],
        nextCursor: null,
      } satisfies v2.AppsListResponse;
    });
    const key = "runtime";
    await cache.refreshNow({ key, request, nowMs: 0 });

    const stale = cache.read({ key, request, nowMs: 11, suppressRefresh: true });
    expect(stale.state).toBe("stale");
    expect(stale.snapshot?.apps.map((item) => item.id)).toEqual(["app-1"]);
    expect(stale.refreshScheduled).toBe(true);

    const refreshed = await cache.refreshNow({ key, request, nowMs: 11 });
    expect(refreshed.apps.map((item) => item.id)).toEqual(["app-2"]);
  });

  it("marks inventory stale when the expiry would exceed the Date range", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const request = vi.fn(async () => {
      return {
        data: [app("app-overflow")],
        nextCursor: null,
      } satisfies v2.AppsListResponse;
    });
    const key = "runtime";
    const snapshot = await cache.refreshNow({
      key,
      request,
      nowMs: MAX_DATE_TIMESTAMP_MS,
    });

    expect(snapshot.expiresAtMs).toBe(0);
    const read = cache.read({
      key,
      request,
      nowMs: Date.parse("2026-05-29T12:00:00.000Z"),
    });
    expect(read.state).toBe("stale");
    expect(read.snapshot?.apps.map((item) => item.id)).toEqual(["app-overflow"]);
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

  it("omits challenge HTML when serializing app/list errors", () => {
    const error = new Error(
      'failed to list apps: Request failed with status 403 Forbidden: <html><script src="/backend-api/connectors/directory/list?__cf_chl_tk=secret-token"></script></html>',
    );
    const serialized = serializeCodexAppInventoryError(error);

    expect(serialized.message).toBe(
      "failed to list apps: Request failed with status 403 Forbidden: [HTML response body omitted]",
    );
  });

  it("keeps serialized app/list error messages on a UTF-16 boundary", () => {
    const error = new Error(`${"x".repeat(499)}🚀tail`);

    expect(serializeCodexAppInventoryError(error).message).toBe(`${"x".repeat(499)}...`);
  });

  it("keeps serialized app/list error data on a UTF-16 boundary", () => {
    const error = Object.assign(new Error("app list failed"), {
      data: { label: `${"x".repeat(499)}🚀tail` },
    });

    expect(serializeCodexAppInventoryError(error).data).toEqual({
      label: `${"x".repeat(499)}...`,
    });
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
