import { describe, expect, it, vi } from "vitest";
import { attachBrowserNodeDelegationResolver } from "../plugins/runtime/browser-node-delegation.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { resolveLocalMeetingBrowserRequest } from "./browser-request.js";

function createRuntime(params: {
  available: boolean;
  request?: (
    method: string,
    values: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
}): PluginRuntime {
  return {
    gateway: {
      isAvailable: vi.fn(async () => params.available),
      request: vi.fn(
        (method: string, values: Record<string, unknown>, options?: Record<string, unknown>) =>
          params.request?.(method, values, options),
      ),
    },
  } as unknown as PluginRuntime;
}

describe("meeting browser request routes", () => {
  it("keeps the legacy local helper on the Browser Gateway compatibility route", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const runtime = createRuntime({ available: true, request });
    const callBrowser = await resolveLocalMeetingBrowserRequest(runtime);

    await callBrowser({ method: "GET", path: "/tabs", timeoutMs: 1_000 });

    expect(request).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        legacyMeetingRuntime: true,
        method: "GET",
        path: "/tabs",
      }),
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
  });

  it("fails closed when the Browser-owned route has no Gateway", async () => {
    const runtime = createRuntime({ available: false });

    await expect(resolveLocalMeetingBrowserRequest(runtime, "browser-steward")).rejects.toThrow(
      "Browser-owned browser capability unavailable",
    );
  });

  it("uses the exact attached Browser-owned capability for the strict route", async () => {
    const runtime = createRuntime({ available: true });
    const request = vi.fn(async () => ({ ok: true }));
    attachBrowserNodeDelegationResolver(runtime, () => ({
      request,
    }));

    const callBrowser = await resolveLocalMeetingBrowserRequest(runtime, "browser-steward");
    await callBrowser({
      method: "POST",
      path: "/act",
      body: { request: { kind: "click" } },
      timeoutMs: 1_000,
    });

    expect(request).toHaveBeenCalledWith({
      method: "POST",
      path: "/act",
      body: { request: { kind: "click" } },
      timeoutMs: 1_000,
      nodeId: "",
    });
  });
});
