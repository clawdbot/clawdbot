import { beforeEach, describe, expect, it, vi } from "vitest";

const clientFetchMocks = vi.hoisted(() => ({
  fetchBrowserJson: vi.fn(async (..._args: unknown[]) => ({ ok: true, targetId: "tab-1" })),
}));

vi.mock("./client-fetch.js", () => clientFetchMocks);

import { browserNavigate } from "./client-actions-core.js";

function lastNavigationRequest(): {
  url: string;
  options: { body?: string; timeoutMs?: number };
} {
  const call = clientFetchMocks.fetchBrowserJson.mock.calls.at(-1);
  if (!call) {
    throw new Error("fetchBrowserJson was not called");
  }
  return {
    url: String(call[0]),
    options: call[1] as { body?: string; timeoutMs?: number },
  };
}

describe("browser navigation client actions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards an explicit operation timeout and leaves transport watchdog grace", async () => {
    const options = {
      url: "https://example.com/slow",
      targetId: "tab-1",
      timeoutMs: 45_000,
      profile: "openclaw",
    };

    await browserNavigate(undefined, options);

    const request = lastNavigationRequest();
    expect(request.url).toBe("/navigate?profile=openclaw");
    expect(request.options.timeoutMs).toBe(50_000);
    expect(JSON.parse(request.options.body ?? "{}")).toEqual({
      url: "https://example.com/slow",
      targetId: "tab-1",
      timeoutMs: 45_000,
    });
  });

  it.each([
    { requestedTimeoutMs: 10, expectedTimeoutMs: 1_000 },
    { requestedTimeoutMs: 180_000, expectedTimeoutMs: 120_000 },
    { requestedTimeoutMs: Number.MAX_SAFE_INTEGER, expectedTimeoutMs: 120_000 },
  ])(
    "normalizes navigation timeout $requestedTimeoutMs before arming its transport watchdog",
    async ({ requestedTimeoutMs, expectedTimeoutMs }) => {
      await browserNavigate(undefined, {
        url: "https://example.com/slow",
        targetId: "tab-1",
        timeoutMs: requestedTimeoutMs,
      });

      const request = lastNavigationRequest();
      expect(request.options.timeoutMs).toBe(expectedTimeoutMs + 5_000);
      expect(JSON.parse(request.options.body ?? "{}")).toEqual({
        url: "https://example.com/slow",
        targetId: "tab-1",
        timeoutMs: expectedTimeoutMs,
      });
    },
  );

  it("keeps the default navigation timeout inside its transport watchdog", async () => {
    await browserNavigate(undefined, { url: "https://example.com" });

    const request = lastNavigationRequest();
    expect(request.options.timeoutMs).toBe(25_000);
    expect(JSON.parse(request.options.body ?? "{}")).toEqual({
      url: "https://example.com",
      timeoutMs: 20_000,
    });
  });
});
