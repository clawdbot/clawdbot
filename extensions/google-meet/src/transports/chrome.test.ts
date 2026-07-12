// Google Meet tests cover chrome plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testing } from "./chrome.js";

describe("google meet chrome transport", () => {
  afterEach(() => testing.setDepsForTest(null));

  it("wraps malformed browser status JSON", () => {
    expect(() =>
      testing.parseMeetBrowserStatusForTest({
        result: "{not json",
      }),
    ).toThrow("Google Meet browser status JSON is malformed.");
  });

  it("caps browser gateway timeout padding", () => {
    expect(testing.resolveBrowserGatewayTimeoutMsForTest(10_000)).toBe(15_000);
    expect(testing.resolveBrowserGatewayTimeoutMsForTest(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });

  it("keeps Gateway-hosted local browser calls inside the trusted runtime", async () => {
    const callGatewayFromCli = vi.fn();
    const gatewayRequest = vi.fn(async () => ({ tabs: [] }));
    const runtime = {
      gateway: {
        isAvailable: vi.fn(async () => true),
        request: gatewayRequest,
      },
    } as unknown as PluginRuntime;
    testing.setDepsForTest({ callGatewayFromCli });

    const callBrowser = await testing.resolveLocalBrowserRequestForTest(runtime);
    await callBrowser({ method: "GET", path: "/tabs", timeoutMs: 5_000 });

    expect(gatewayRequest).toHaveBeenCalledWith(
      "browser.request",
      {
        method: "GET",
        path: "/tabs",
        body: undefined,
        timeoutMs: 5_000,
      },
      { timeoutMs: 10_000, scopes: ["operator.admin"] },
    );
    expect(callGatewayFromCli).not.toHaveBeenCalled();
  });
});
