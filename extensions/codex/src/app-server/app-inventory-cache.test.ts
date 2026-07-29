// Codex tests cover app inventory cache plugin behavior.
import { MAX_DATE_TIMESTAMP_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  CodexAppInventoryCache,
  buildCodexAppInventoryCacheKey,
  serializeCodexAppInventoryError,
} from "./app-inventory-cache.js";
import { codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import { CodexAppServerRpcError } from "./client.js";
import type { v2 } from "./protocol.js";

describe("Codex app inventory cache", () => {
  it("coalesces installed app and metadata requests into one inventory refresh", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const apps = [app("app-1"), app("app-2")];
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, apps, params),
    );

    const key = buildCodexAppInventoryCacheKey(
      { codexHome: "/codex", authProfileId: "work" },
      "2026.6.27",
      "2026.6.27",
    );
    const read = cache.read({ key, request, nowMs: 0 });
    expect(read.state).toBe("missing");
    expect(read.refreshScheduled).toBe(true);

    const snapshot = await cache.refreshNow({ key, request, nowMs: 0 });
    expect(snapshot.apps).toEqual(apps);
    expect(snapshot.source).toBe("installed");
    expect(request).toHaveBeenNthCalledWith(1, "app/installed", { forceRefresh: true });
    expect(request).toHaveBeenNthCalledWith(2, "app/read", {
      appIds: ["app-1", "app-2"],
    });

    const fresh = cache.read({ key, request, nowMs: 50 });
    expect(fresh.state).toBe("fresh");
    expect(fresh.refreshScheduled).toBe(false);
    expect(fresh.snapshot?.apps).toEqual(apps);
  });

  it("changes the cache key when either build version changes", () => {
    const input = { codexHome: "/codex", authProfileId: "work" };
    const baseline = buildCodexAppInventoryCacheKey(input, "2026.6.27", "2026.6.27");

    expect(buildCodexAppInventoryCacheKey(input, "2026.6.28", "2026.6.27")).not.toBe(baseline);
    expect(buildCodexAppInventoryCacheKey(input, "2026.6.27", "2026.6.28")).not.toBe(baseline);
  });

  it("reads missing inventory without scheduling app discovery when suppressed", () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, [app("app-1")], params),
    );

    const read = cache.read({ key: "runtime", request, suppressRefresh: true });

    expect(read.state).toBe("missing");
    expect(read.refreshScheduled).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("reads metadata only for targeted installed apps", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const apps = [app("app-1"), app("google-calendar-app")];
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, apps, params),
    );

    const snapshot = await cache.refreshNow({
      key: "runtime",
      request,
      targetAppIds: ["google-calendar-app"],
    });

    expect(snapshot.apps).toEqual([app("google-calendar-app")]);
    expect(request).toHaveBeenNthCalledWith(1, "app/installed", { forceRefresh: true });
    expect(request).toHaveBeenNthCalledWith(2, "app/read", {
      appIds: ["google-calendar-app"],
    });
  });

  it("does not request metadata when a targeted app is not installed", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, [app("app-1")], params),
    );

    const snapshot = await cache.refreshNow({
      key: "runtime",
      request,
      targetAppIds: ["missing-app"],
    });

    expect(snapshot.apps).toEqual([]);
    expect(request).toHaveBeenCalledExactlyOnceWith("app/installed", { forceRefresh: true });
  });

  it("limits each metadata request to the app/read 100-app contract", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const apps = Array.from({ length: 205 }, (_, index) => app(`app-${index}`));
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, apps, params),
    );

    const snapshot = await cache.refreshNow({ key: "runtime", request });

    expect(snapshot.apps).toEqual(apps);
    expect(request).toHaveBeenCalledTimes(4);
    expect(request).toHaveBeenNthCalledWith(2, "app/read", {
      appIds: apps.slice(0, 100).map((entry) => entry.id),
    });
    expect(request).toHaveBeenNthCalledWith(3, "app/read", {
      appIds: apps.slice(100, 200).map((entry) => entry.id),
    });
    expect(request).toHaveBeenNthCalledWith(4, "app/read", {
      appIds: apps.slice(200).map((entry) => entry.id),
    });
  });

  it("excludes installed apps whose metadata is missing", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const installedApps = [app("available-app"), app("missing-app")];
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(
        method,
        method === "app/read" ? [installedApps[0]!] : installedApps,
        params,
      ),
    );

    const snapshot = await cache.refreshNow({ key: "runtime", request });

    expect(snapshot.apps).toEqual([app("available-app")]);
  });

  it("excludes retained runtime rows when global or workspace policy denies app metadata", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const disabledApp = { ...app("policy-disabled-app"), isEnabled: false };
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, method === "app/read" ? [] : [disabledApp], params),
    );

    const snapshot = await cache.refreshNow({ key: "runtime", request });

    expect(snapshot.apps).toEqual([]);
    expect(request).toHaveBeenNthCalledWith(2, "app/read", {
      appIds: ["policy-disabled-app"],
    });
  });

  it("retains disabled app metadata without marking its runtime callable", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const disabledApp = { ...app("disabled-app"), isEnabled: false };
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, [disabledApp], params),
    );

    const snapshot = await cache.refreshNow({ key: "runtime", request });

    expect(snapshot.apps).toEqual([{ ...disabledApp, isAccessible: false }]);
  });

  it("does not expose enabled installed apps that are not callable", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const inaccessibleApp = { ...app("inaccessible-app"), isAccessible: false };
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, [inaccessibleApp], params),
    );

    const snapshot = await cache.refreshNow({ key: "runtime", request });

    expect(snapshot.apps).toEqual([inaccessibleApp]);
  });

  it("force-refreshes the upstream runtime snapshot on every cache refresh", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    let installedCalls = 0;
    const request = vi.fn(async (method, params) => {
      if (method === "app/installed") {
        installedCalls += 1;
      }
      return codexAppInventoryResponse(method, [app(`refreshed-app-${installedCalls}`)], params);
    });

    const first = await cache.refreshNow({ key: "runtime", request, nowMs: 0 });
    const second = await cache.refreshNow({ key: "runtime", request, nowMs: 101 });

    expect(first.apps).toEqual([app("refreshed-app-1")]);
    expect(second.apps).toEqual([app("refreshed-app-2")]);
    expect(request).toHaveBeenNthCalledWith(1, "app/installed", { forceRefresh: true });
    expect(request).toHaveBeenNthCalledWith(3, "app/installed", { forceRefresh: true });
  });

  it("uses stale inventory for the current read while refreshing asynchronously", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 10 });
    let installedCalls = 0;
    const request = vi.fn(async (method, params) => {
      if (method === "app/installed") {
        installedCalls += 1;
      }
      return codexAppInventoryResponse(method, [app(`app-${installedCalls}`)], params);
    });
    const key = "runtime";
    await cache.refreshNow({ key, request, nowMs: 0 });

    const stale = cache.read({ key, request, nowMs: 11, suppressRefresh: true });
    expect(stale.state).toBe("stale");
    expect(stale.snapshot?.apps).toEqual([app("app-1")]);
    expect(stale.refreshScheduled).toBe(true);

    const refreshed = await cache.refreshNow({ key, request, nowMs: 11 });
    expect(refreshed.apps).toEqual([app("app-2")]);
  });

  it("marks inventory stale when the expiry would exceed the Date range", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, [app("app-overflow")], params),
    );
    const key = "runtime";
    const snapshot = await cache.refreshNow({ key, request, nowMs: MAX_DATE_TIMESTAMP_MS });

    expect(snapshot.expiresAtMs).toBe(0);
    const read = cache.read({
      key,
      request,
      nowMs: Date.parse("2026-05-29T12:00:00.000Z"),
    });
    expect(read.state).toBe("stale");
    expect(read.snapshot?.apps).toEqual([app("app-overflow")]);
  });

  it("records refresh errors without discarding the last successful snapshot", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 1 });
    const key = "runtime";
    await cache.refreshNow({
      key,
      nowMs: 0,
      request: async (method, params) => codexAppInventoryResponse(method, [app("app-1")], params),
    });

    await expect(
      cache.refreshNow({
        key,
        nowMs: 2,
        request: async () => {
          throw new Error("app inventory failed");
        },
      }),
    ).rejects.toThrow("app inventory failed");

    const read = cache.read({
      key,
      nowMs: 2,
      request: async (method, params) => codexAppInventoryResponse(method, [app("app-2")], params),
    });
    expect(read.snapshot?.apps).toEqual([app("app-1")]);
    expect(read.diagnostic?.message).toBe("app inventory failed");
  });

  it("preserves supported older app servers when app/installed is unavailable", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const request = vi.fn(async (method, params) => {
      if (method === "app/installed") {
        throw new CodexAppServerRpcError({ code: -32601, message: "Method not found" }, method);
      }
      return codexAppInventoryResponse(method, [app("legacy-app")], params);
    });

    const snapshot = await cache.refreshNow({ key: "runtime", request });

    expect(snapshot.apps).toEqual([app("legacy-app")]);
    expect(snapshot.source).toBe("legacy");
    expect(request).toHaveBeenNthCalledWith(1, "app/installed", { forceRefresh: true });
    expect(request).toHaveBeenNthCalledWith(2, "app/list", {
      cursor: undefined,
      limit: 100,
      forceRefetch: false,
    });
  });

  it("does not expose disabled apps from supported older app servers", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const disabledApp = { ...app("legacy-disabled-app"), isEnabled: false };
    const request = vi.fn(async (method, params) => {
      if (method === "app/installed") {
        throw new CodexAppServerRpcError({ code: -32601, message: "Method not found" }, method);
      }
      return codexAppInventoryResponse(method, [disabledApp], params);
    });

    const snapshot = await cache.refreshNow({ key: "runtime", request });

    expect(snapshot.apps).toEqual([{ ...disabledApp, isAccessible: false }]);
    expect(request).toHaveBeenNthCalledWith(1, "app/installed", { forceRefresh: true });
    expect(request).toHaveBeenNthCalledWith(2, "app/list", {
      cursor: undefined,
      limit: 100,
      forceRefetch: false,
    });
  });

  it("does not fall back to the legacy directory for authorization failures", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const request = vi.fn(async (method) => {
      throw new CodexAppServerRpcError({ code: 403, message: "Forbidden" }, method);
    });

    await expect(cache.refreshNow({ key: "runtime", request })).rejects.toThrow("Forbidden");
    expect(request).toHaveBeenCalledExactlyOnceWith("app/installed", { forceRefresh: true });
  });

  it("omits challenge HTML when serializing app inventory errors", () => {
    const error = new Error(
      'failed to read apps: Request failed with status 403 Forbidden: <html><script src="/backend-api/connectors/directory/list?__cf_chl_tk=secret-token"></script></html>',
    );

    expect(serializeCodexAppInventoryError(error).message).toBe(
      "failed to read apps: Request failed with status 403 Forbidden: [HTML response body omitted]",
    );
  });

  it("keeps serialized app inventory error messages on a UTF-16 boundary", () => {
    const error = new Error(`${"x".repeat(499)}🚀tail`);

    expect(serializeCodexAppInventoryError(error).message).toBe(`${"x".repeat(499)}...`);
  });

  it("keeps serialized app inventory error data on a UTF-16 boundary", () => {
    const error = Object.assign(new Error("app inventory failed"), {
      data: { label: `${"x".repeat(499)}🚀tail` },
    });

    expect(serializeCodexAppInventoryError(error).data).toEqual({
      label: `${"x".repeat(499)}...`,
    });
  });

  it("forces a post-install refresh past an older in-flight runtime snapshot", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 1_000 });
    const key = "runtime";
    let resolveStale: ((response: v2.AppsInstalledResponse) => void) | undefined;
    let resolveFresh: ((response: v2.AppsInstalledResponse) => void) | undefined;
    let installedCalls = 0;
    const request = vi.fn(async (method, params) => {
      if (method === "app/installed") {
        installedCalls += 1;
        expect(params.forceRefresh).toBe(true);
        return await new Promise<v2.AppsInstalledResponse>((resolve) => {
          if (installedCalls === 1) {
            resolveStale = resolve;
          } else {
            resolveFresh = resolve;
          }
        });
      }
      return codexAppInventoryResponse(method, [app("fresh-app"), app("stale-app")], params);
    });

    const staleRead = cache.read({ key, request, nowMs: 0 });
    expect(staleRead.state).toBe("missing");
    expect(staleRead.refreshScheduled).toBe(true);

    cache.invalidate(key, "plugin installed", 1);
    const forcedRead = cache.read({ key, request, nowMs: 1, forceRefetch: true });
    expect(forcedRead.state).toBe("missing");
    expect(forcedRead.refreshScheduled).toBe(true);
    expect(installedCalls).toBe(2);

    const forced = cache.refreshNow({ key, request, nowMs: 1 });
    resolveFresh?.(codexAppInventoryResponse("app/installed", [app("fresh-app")]));
    await expect(forced).resolves.toStrictEqual({
      key,
      apps: [app("fresh-app")],
      source: "installed",
      fetchedAtMs: 1,
      expiresAtMs: 1_001,
      revision: 2,
    });

    resolveStale?.(codexAppInventoryResponse("app/installed", [app("stale-app")]));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));

    const freshRead = cache.read({ key, request, nowMs: 2 });
    expect(freshRead.state).toBe("fresh");
    expect(freshRead.snapshot?.apps).toEqual([app("fresh-app")]);
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
