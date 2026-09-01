import { describe, expect, it, vi } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import { refreshCodexPluginAppRuntimeState } from "./plugin-activation.js";
import type { v2 } from "./protocol.js";

const connectedApp: v2.AppInfo = {
  id: "fixture-app",
  name: "Fixture app",
  isAccessible: true,
  isEnabled: true,
  pluginDisplayNames: ["Fixture plugin"],
};

describe("explicit Codex plugin app refresh", () => {
  it("refreshes hosted tools and only the selected app metadata without reloading threads", async () => {
    const appCache = new CodexAppInventoryCache();
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(
        method,
        [connectedApp, { ...connectedApp, id: "other-app" }],
        params,
      ),
    );

    await refreshCodexPluginAppRuntimeState({
      request,
      appCache,
      appCacheKey: "selected-runtime",
      targetAppIds: [connectedApp.id],
    });

    expect(request.mock.calls).toEqual([
      ["app/installed", { forceRefresh: true }],
      ["app/read", { appIds: [connectedApp.id] }],
    ]);
    expect(appCache.read({ key: "selected-runtime", request }).snapshot?.apps).toEqual([
      expect.objectContaining({ id: connectedApp.id, isAccessible: true }),
    ]);
    expect(appCache.read({ key: "other-runtime", request, suppressRefresh: true }).state).toBe(
      "missing",
    );
  });

  it("leaves prior readiness stale and reports a failed recheck instead of returning success", async () => {
    const appCache = new CodexAppInventoryCache();
    const key = "selected-runtime";
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, [connectedApp], params),
    );
    await appCache.refreshNow({ key, request });
    const failure = new Error("Hosted connector refresh unavailable");

    await expect(
      refreshCodexPluginAppRuntimeState({
        request: async () => {
          throw failure;
        },
        appCache,
        appCacheKey: key,
        targetAppIds: [connectedApp.id],
      }),
    ).rejects.toBe(failure);

    const cached = appCache.read({ key, request });
    expect(cached.state).toBe("stale");
    expect(cached.diagnostic?.message).toBe(failure.message);
  });

  it("does not publish a pre-recheck refresh after the completed recheck removed access", async () => {
    const appCache = new CodexAppInventoryCache();
    const key = "selected-runtime";
    let finishOldRefresh: () => void = () => {};
    const oldRefresh = appCache.refreshNow({
      key,
      request: async (method, params) => {
        if (method === "app/installed") {
          await new Promise<void>((resolve) => {
            finishOldRefresh = resolve;
          });
        }
        return codexAppInventoryResponse(method, [connectedApp], params);
      },
    });
    const request = vi.fn(async (method, params) => codexAppInventoryResponse(method, [], params));

    await refreshCodexPluginAppRuntimeState({ request, appCache, appCacheKey: key });
    finishOldRefresh();
    await oldRefresh;

    const cached = appCache.read({ key, request });
    expect(cached.state).toBe("fresh");
    expect(cached.snapshot?.apps).toEqual([]);
  });
});
