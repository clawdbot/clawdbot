/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { EMPTY_MODEL_PROVIDERS_DATA } from "./load.ts";
import {
  appendPage,
  createHarness,
  deferred,
  requestCount,
} from "./model-providers-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ModelProvidersPage profile order", () => {
  it("keeps a queued profile order until configuration work completes", async () => {
    const { context, notifyRuntimeConfig, request, runtimeConfig } = createHarness("main");
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    const originalRequest = request.getMockImplementation()!;
    const firstSave = deferred<unknown>();
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "models.authOrderSet" && requestCount(request, method) === 1) {
        return firstSave.promise;
      }
      void params;
      return originalRequest(method);
    });

    page.setProfileOrder("openai", "openai", ["openai:two", "openai:one"]);
    await vi.waitFor(() => expect(requestCount(request, "models.authOrderSet")).toBe(1));
    page.setProfileOrder("openai", "openai", ["openai:one", "openai:two"]);
    runtimeConfig.state.configSaving = true;
    notifyRuntimeConfig();
    firstSave.resolve({});
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(requestCount(request, "models.authOrderSet")).toBe(1);
    expect(page.profileOrders.openai).toEqual(["openai:one", "openai:two"]);

    runtimeConfig.state.configSaving = false;
    notifyRuntimeConfig();
    await vi.waitFor(() => expect(requestCount(request, "models.authOrderSet")).toBe(2));
    await vi.waitFor(() => expect(page.profileOrders.openai).toBeUndefined());
  });

  it("keeps the latest profile order visible while saves are queued", async () => {
    const { context, request } = createHarness("main");
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    const originalRequest = request.getMockImplementation()!;
    const firstSave = deferred<unknown>();
    let orderRequests = 0;
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "models.authOrderSet") {
        orderRequests += 1;
        if (orderRequests === 1) {
          return firstSave.promise;
        }
        return {};
      }
      void params;
      return originalRequest(method);
    });

    page.setProfileOrder("openai", "openai", ["openai:two", "openai:one"]);
    await vi.waitFor(() => expect(orderRequests).toBe(1));
    page.setProfileOrder("openai", "openai", ["openai:one", "openai:two"]);

    expect(page.profileOrders.openai).toEqual(["openai:one", "openai:two"]);
    expect(orderRequests).toBe(1);
    firstSave.resolve({});
    await vi.waitFor(() => expect(orderRequests).toBe(2));
    await vi.waitFor(() => expect(page.profileOrders.openai).toBeUndefined());
    expect(page.messages.openai).toBeUndefined();
  });

  it("keeps a saved auth-owner order on every alias route", async () => {
    const { context, request } = createHarness("main");
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    page.data = {
      ...EMPTY_MODEL_PROVIDERS_DATA,
      config: {},
      authStatus: {
        ts: 1,
        providers: [
          {
            provider: "claude-cli",
            authProvider: "anthropic",
            displayName: "Claude",
            status: "ok",
            profiles: [
              { profileId: "claude:one", type: "oauth", status: "ok" },
              { profileId: "claude:two", type: "oauth", status: "ok" },
            ],
            profileOrder: ["claude:one", "claude:two"],
          },
        ],
      },
      updatedAt: 1,
    };

    page.setProfileOrder("anthropic", "anthropic", ["claude:two", "claude:one"]);

    await vi.waitFor(() => expect(requestCount(request, "models.authOrderSet")).toBe(1));
    await vi.waitFor(() => expect(page.profileOrders.anthropic).toBeUndefined());
    expect(page.data.authStatus?.providers[0]?.profileOrder).toEqual(["claude:two", "claude:one"]);
  });

  it("keeps a saved profile order when an older refresh finishes afterward", async () => {
    const { context, request } = createHarness("main");
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    const originalRequest = request.getMockImplementation()!;
    const staleStatus = deferred<unknown>();
    const authStatus = {
      ts: 1,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          status: "ok" as const,
          profiles: [
            { profileId: "openai:one", type: "oauth" as const, status: "ok" as const },
            { profileId: "openai:two", type: "oauth" as const, status: "ok" as const },
          ],
          profileOrder: ["openai:one", "openai:two"],
        },
      ],
    };
    const refreshedStatus = {
      ...authStatus,
      ts: 2,
      providers: [
        {
          ...authStatus.providers[0],
          profileOrder: ["openai:two", "openai:one"],
        },
      ],
    };
    page.data = {
      ...EMPTY_MODEL_PROVIDERS_DATA,
      config: {},
      authStatus,
      updatedAt: 1,
    };
    request.mockClear();
    let authStatusCalls = 0;
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "models.authStatus") {
        authStatusCalls += 1;
        return authStatusCalls === 1 ? staleStatus.promise : refreshedStatus;
      }
      if (method === "models.authOrderSet") {
        return {};
      }
      void params;
      return originalRequest(method);
    });

    const refreshing = page.refresh({ force: true });
    await vi.waitFor(() => expect(requestCount(request, "models.authStatus")).toBe(1));
    page.setProfileOrder("openai", "openai", ["openai:two", "openai:one"]);
    await vi.waitFor(() => expect(requestCount(request, "models.authOrderSet")).toBe(1));
    await vi.waitFor(() => expect(authStatusCalls).toBe(2));
    await vi.waitFor(() => expect(page.profileOrders.openai).toBeUndefined());
    expect(page.data.authStatus?.providers[0]?.profileOrder).toEqual(["openai:two", "openai:one"]);

    staleStatus.resolve(authStatus);
    await refreshing;

    expect(page.data.authStatus?.providers[0]?.profileOrder).toEqual(["openai:two", "openai:one"]);
  });
});
