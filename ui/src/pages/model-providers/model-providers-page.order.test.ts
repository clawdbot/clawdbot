/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
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
});
