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
    expect(snapshot.installedApps).toEqual([
      { id: "app-1", runtimeName: "app-1", enabled: true, callable: true },
      { id: "app-2", runtimeName: "app-2", enabled: true, callable: true },
    ]);
    expect(request).toHaveBeenNthCalledWith(1, "app/installed", { forceRefresh: true });
    expect(request).toHaveBeenNthCalledWith(2, "app/read", {
      appIds: ["app-1", "app-2"],
      includeTools: true,
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
      includeTools: true,
    });
  });

  it("upgrades an in-flight targeted refresh before returning the complete account inventory", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const apps = [app("google-calendar-app"), app("unrelated-slack-app")];
    let resolveTargetedInstall: ((response: v2.AppsInstalledResponse) => void) | undefined;
    let installedCalls = 0;
    const request = vi.fn(async (method, params) => {
      if (method === "app/installed") {
        installedCalls += 1;
        if (installedCalls === 1) {
          expect(params).toEqual({ forceRefresh: true });
          return await new Promise<v2.AppsInstalledResponse>((resolve) => {
            resolveTargetedInstall = resolve;
          });
        }
        expect(params).toEqual({ forceRefresh: false });
      }
      return codexAppInventoryResponse(method, apps, params);
    });

    const targeted = cache.refreshNow({
      key: "runtime",
      request,
      targetAppIds: ["google-calendar-app"],
    });
    const complete = cache.refreshNow({ key: "runtime", request, targetAppIds: [] });
    expect(installedCalls).toBe(1);

    resolveTargetedInstall?.(codexAppInventoryResponse("app/installed", apps));
    const [targetedSnapshot, completeSnapshot] = await Promise.all([targeted, complete]);

    expect(targetedSnapshot.apps).toEqual([app("google-calendar-app")]);
    expect(completeSnapshot.apps).toEqual(apps);
    expect(cache.read({ key: "runtime", request }).snapshot?.apps).toEqual(apps);
    expect(request.mock.calls.filter(([method]) => method === "app/installed")).toEqual([
      ["app/installed", { forceRefresh: true }],
      ["app/installed", { forceRefresh: false }],
    ]);
    expect(request.mock.calls.filter(([method]) => method === "app/read")).toEqual([
      ["app/read", { appIds: ["google-calendar-app"], includeTools: true }],
      ["app/read", { appIds: ["google-calendar-app", "unrelated-slack-app"], includeTools: true }],
    ]);
  });

  it("joins a complete in-flight refresh for a narrower plugin request", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const apps = [app("google-calendar-app"), app("unrelated-slack-app")];
    let resolveInstall: ((response: v2.AppsInstalledResponse) => void) | undefined;
    const request = vi.fn(async (method, params) => {
      if (method === "app/installed") {
        return await new Promise<v2.AppsInstalledResponse>((resolve) => {
          resolveInstall = resolve;
        });
      }
      return codexAppInventoryResponse(method, apps, params);
    });

    const complete = cache.refreshNow({ key: "runtime", request, targetAppIds: [] });
    const targeted = cache.refreshNow({
      key: "runtime",
      request,
      targetAppIds: ["google-calendar-app"],
    });
    resolveInstall?.(codexAppInventoryResponse("app/installed", apps));

    const [completeSnapshot, targetedSnapshot] = await Promise.all([complete, targeted]);
    expect(completeSnapshot.apps).toEqual(apps);
    expect(targetedSnapshot.apps).toEqual(apps);
    expect(request).toHaveBeenCalledTimes(2);
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
      includeTools: true,
    });
    expect(request).toHaveBeenNthCalledWith(3, "app/read", {
      appIds: apps.slice(100, 200).map((entry) => entry.id),
      includeTools: true,
    });
    expect(request).toHaveBeenNthCalledWith(4, "app/read", {
      appIds: apps.slice(200).map((entry) => entry.id),
      includeTools: true,
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
      includeTools: true,
    });
  });

  it("keeps authorized disabled app metadata distinct from runtime callability", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const disabledApp = { ...app("disabled-app"), isEnabled: false };
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, [disabledApp], params),
    );

    const snapshot = await cache.refreshNow({ key: "runtime", request });

    expect(snapshot.apps).toEqual([disabledApp]);
    expect(snapshot.installedApps).toEqual([
      { id: "disabled-app", runtimeName: "disabled-app", enabled: false, callable: false },
    ]);
  });

  it("excludes installed apps whose account is not authorized to read their metadata", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const inaccessibleApp = { ...app("inaccessible-app"), isAccessible: false };
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, [inaccessibleApp], params),
    );

    const snapshot = await cache.refreshNow({ key: "runtime", request });

    expect(snapshot.apps).toEqual([]);
    expect(snapshot.installedApps).toEqual([
      {
        id: "inaccessible-app",
        runtimeName: "inaccessible-app",
        enabled: true,
        callable: false,
      },
    ]);
  });

  it("keeps authorized app metadata when enabled runtime tools are not callable", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const authorizedApp = app("tool-blocked-app");
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, [authorizedApp], params, {
        callableByAppId: { "tool-blocked-app": false },
      }),
    );

    const snapshot = await cache.refreshNow({ key: "runtime", request });

    expect(snapshot.apps).toEqual([authorizedApp]);
    expect(snapshot.installedApps).toEqual([
      {
        id: "tool-blocked-app",
        runtimeName: "tool-blocked-app",
        enabled: true,
        callable: false,
      },
    ]);
  });

  it("seeds the upstream runtime once and reuses its snapshot on later refreshes", async () => {
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
    expect(request).toHaveBeenNthCalledWith(3, "app/installed", { forceRefresh: false });
  });

  it("refreshes the upstream snapshot when a caller explicitly requests it", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, [app("refreshed-app")], params),
    );

    await cache.refreshNow({ key: "runtime", request, nowMs: 0 });
    await cache.refreshNow({
      key: "runtime",
      request,
      nowMs: 1,
      forceRefetch: true,
    });

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

  it("fails closed when the pinned server does not implement app/installed", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const request = vi.fn(async (method, params) => {
      if (method === "app/installed") {
        throw new CodexAppServerRpcError({ code: -32601, message: "Method not found" }, method);
      }
      return codexAppInventoryResponse(method, [app("current-app")], params);
    });

    await expect(cache.refreshNow({ key: "runtime", request })).rejects.toThrow("Method not found");
    expect(request).toHaveBeenCalledExactlyOnceWith("app/installed", { forceRefresh: true });
    expect(cache.read({ key: "runtime", request, suppressRefresh: true }).snapshot).toBeUndefined();
  });

  it("fails closed when installed app inventory is unauthorized", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const request = vi.fn(async (method) => {
      throw new CodexAppServerRpcError({ code: 403, message: "Forbidden" }, method);
    });

    await expect(cache.refreshNow({ key: "runtime", request })).rejects.toThrow("Forbidden");
    expect(request).toHaveBeenCalledExactlyOnceWith("app/installed", { forceRefresh: true });
  });

  it("fails closed when app metadata cannot be read", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const request = vi.fn(async (method, params) => {
      if (method === "app/read") {
        throw new CodexAppServerRpcError({ code: -32601, message: "Method not found" }, method);
      }
      return codexAppInventoryResponse(method, [app("current-app")], params);
    });

    await expect(cache.refreshNow({ key: "runtime", request })).rejects.toThrow("Method not found");
    expect(request).toHaveBeenNthCalledWith(1, "app/installed", { forceRefresh: true });
    expect(request).toHaveBeenNthCalledWith(2, "app/read", {
      appIds: ["current-app"],
      includeTools: true,
    });
    expect(cache.read({ key: "runtime", request, suppressRefresh: true }).snapshot).toBeUndefined();
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
      installedApps: [{ id: "fresh-app", runtimeName: "fresh-app", enabled: true, callable: true }],
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

  it("discards a pre-invalidation refresh instead of republishing it as fresh", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 1_000 });
    const key = "runtime";
    let resolveInstalled: ((response: v2.AppsInstalledResponse) => void) | undefined;
    const request = vi.fn(async (method, params) => {
      if (method === "app/installed") {
        return await new Promise<v2.AppsInstalledResponse>((resolve) => {
          resolveInstalled = resolve;
        });
      }
      return codexAppInventoryResponse(method, [app("stale-app")], params);
    });

    const read = cache.read({ key, request, nowMs: 0 });
    expect(read.state).toBe("missing");
    expect(read.refreshScheduled).toBe(true);

    cache.invalidate(key, "plugin installed", 1);
    resolveInstalled?.(codexAppInventoryResponse("app/installed", [app("stale-app")]));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    const after = cache.read({ key, request, nowMs: 2, suppressRefresh: true });
    expect(after.state).toBe("missing");
    expect(after.diagnostic?.message).toBe("plugin installed");
  });

  it("keeps the complete inventory when a targeted refresh lands on the same runtime", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 1_000 });
    const key = "runtime";
    const apps = [app("calendar-app"), app("drive-app")];
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, apps, params),
    );

    await cache.refreshNow({ key, request, nowMs: 0, targetAppIds: [] });
    const targeted = await cache.refreshNow({
      key,
      request,
      nowMs: 1,
      forceRefetch: true,
      targetAppIds: ["calendar-app"],
    });
    expect(targeted.apps).toEqual([app("calendar-app")]);
    expect(targeted.targetAppIds).toEqual(["calendar-app"]);

    const read = cache.read({ key, request, nowMs: 2, suppressRefresh: true });
    expect(read.state).toBe("fresh");
    expect(read.snapshot?.targetAppIds).toBeUndefined();
    expect(read.snapshot?.apps).toEqual(apps);
  });

  it("does not renew non-target row freshness during a targeted merge", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 1_000 });
    const key = "runtime";
    const apps = [app("calendar-app"), app("drive-app")];
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, apps, params),
    );

    await cache.refreshNow({ key, request, nowMs: 0, targetAppIds: [] });
    await cache.refreshNow({
      key,
      request,
      nowMs: 900,
      forceRefetch: true,
      targetAppIds: ["calendar-app"],
    });

    // Freshness still belongs to the complete fetch at t=0, not the merge at t=900.
    const read = cache.read({ key, request, nowMs: 1_100, suppressRefresh: true });
    expect(read.state).toBe("stale");
  });

  it("keeps a scoped invalidation until a covering targeted refresh", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 1_000 });
    const key = "runtime";
    const apps = [app("calendar-app"), app("drive-app")];
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, apps, params),
    );

    await cache.refreshNow({ key, request, nowMs: 0, targetAppIds: [] });
    cache.invalidate(key, "calendar plugin installed", 1, ["calendar-app"]);

    await cache.refreshNow({
      key,
      request,
      nowMs: 2,
      forceRefetch: true,
      targetAppIds: ["drive-app"],
    });
    expect(cache.read({ key, request, nowMs: 3, suppressRefresh: true }).state).toBe("stale");

    await cache.refreshNow({
      key,
      request,
      nowMs: 4,
      forceRefetch: true,
      targetAppIds: ["calendar-app"],
    });
    expect(cache.read({ key, request, nowMs: 5, suppressRefresh: true }).state).toBe("fresh");
  });

  it("replaces an expired union entry on the next single-target refresh", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 1_000 });
    const key = "runtime";
    const apps = [app("calendar-app"), app("drive-app")];
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, apps, params),
    );

    await cache.refreshNow({ key, request, nowMs: 0, targetAppIds: ["calendar-app"] });
    await cache.refreshNow({
      key,
      request,
      nowMs: 1,
      forceRefetch: true,
      targetAppIds: ["drive-app"],
    });
    expect(cache.read({ key, request, nowMs: 1_500, suppressRefresh: true }).state).toBe("stale");

    // Past TTL nothing is preserved; the single-target refresh replaces the
    // union entry and freshness recovers without a complete fetch.
    await cache.refreshNow({
      key,
      request,
      nowMs: 1_500,
      forceRefetch: true,
      targetAppIds: ["calendar-app"],
    });
    const read = cache.read({ key, request, nowMs: 1_600, suppressRefresh: true });
    expect(read.state).toBe("fresh");
    expect(read.snapshot?.targetAppIds).toEqual(["calendar-app"]);
    expect(read.snapshot?.apps).toEqual([app("calendar-app")]);
  });

  it("renews freshness when a targeted refresh re-covers the whole cached scope", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 1_000 });
    const key = "runtime";
    const apps = [app("calendar-app")];
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, apps, params),
    );

    await cache.refreshNow({ key, request, nowMs: 0, targetAppIds: ["calendar-app"] });
    expect(cache.read({ key, request, nowMs: 1_500, suppressRefresh: true }).state).toBe("stale");

    await cache.refreshNow({
      key,
      request,
      nowMs: 1_500,
      forceRefetch: true,
      targetAppIds: ["calendar-app"],
    });
    expect(cache.read({ key, request, nowMs: 1_600, suppressRefresh: true }).state).toBe("fresh");
  });

  it("retires stacked scoped invalidations across separate covering refreshes", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 1_000 });
    const key = "runtime";
    const apps = [app("calendar-app"), app("drive-app")];
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, apps, params),
    );

    await cache.refreshNow({ key, request, nowMs: 0, targetAppIds: [] });
    cache.invalidate(key, "calendar plugin installed", 1, ["calendar-app"]);
    cache.invalidate(key, "drive plugin installed", 2, ["drive-app"]);

    await cache.refreshNow({
      key,
      request,
      nowMs: 3,
      forceRefetch: true,
      targetAppIds: ["calendar-app"],
    });
    expect(cache.read({ key, request, nowMs: 4, suppressRefresh: true }).state).toBe("stale");

    await cache.refreshNow({
      key,
      request,
      nowMs: 5,
      forceRefetch: true,
      targetAppIds: ["drive-app"],
    });
    expect(cache.read({ key, request, nowMs: 6, suppressRefresh: true }).state).toBe("fresh");
  });

  it("keeps an unscoped invalidation until a complete refresh", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 1_000 });
    const key = "runtime";
    const apps = [app("calendar-app")];
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, apps, params),
    );

    await cache.refreshNow({ key, request, nowMs: 0, targetAppIds: [] });
    cache.invalidate(key, "runtime identity changed", 1);

    await cache.refreshNow({
      key,
      request,
      nowMs: 2,
      forceRefetch: true,
      targetAppIds: ["calendar-app"],
    });
    expect(cache.read({ key, request, nowMs: 3, suppressRefresh: true }).state).toBe("stale");

    await cache.refreshNow({ key, request, nowMs: 4, forceRefetch: true, targetAppIds: [] });
    expect(cache.read({ key, request, nowMs: 5, suppressRefresh: true }).state).toBe("fresh");
  });

  it("merges targeted refreshes for one runtime instead of alternating narrow snapshots", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 1_000 });
    const key = "runtime";
    const apps = [app("calendar-app"), app("drive-app")];
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, apps, params),
    );

    await cache.refreshNow({ key, request, nowMs: 0, targetAppIds: ["calendar-app"] });
    await cache.refreshNow({
      key,
      request,
      nowMs: 1,
      forceRefetch: true,
      targetAppIds: ["drive-app"],
    });

    const read = cache.read({ key, request, nowMs: 2, suppressRefresh: true });
    expect(read.state).toBe("fresh");
    expect(read.snapshot?.targetAppIds).toEqual(["calendar-app", "drive-app"]);
    expect(read.snapshot?.apps).toEqual(apps);
    expect(read.snapshot?.installedApps.map((entry) => entry.id)).toEqual([
      "calendar-app",
      "drive-app",
    ]);
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
