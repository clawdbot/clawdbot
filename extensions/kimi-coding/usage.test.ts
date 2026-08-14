// Covers Kimi Coding plan usage parsing.
import { createProviderUsageFetch, makeResponse } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { fetchKimiUsage, isManagedKimiUsageBaseUrl, normalizeKimiUsageBaseUrl } from "./usage.js";

async function expectParsedWindows(body: unknown) {
  const mockFetch = createProviderUsageFetch(async () => makeResponse(200, body));
  const result = await fetchKimiUsage("kimi-key", 5000, mockFetch);
  return result.windows;
}

describe("fetchKimiUsage", () => {
  it("returns token-expired errors and cancels unread auth-failure bodies", async () => {
    const cancel = vi.fn(async () => undefined);
    const mockFetch = createProviderUsageFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {},
            cancel,
          }),
          { status: 401 },
        ),
    );

    const result = await fetchKimiUsage("key", 5000, mockFetch);

    expect(result).toMatchObject({
      provider: "kimi",
      displayName: "Kimi",
      windows: [],
      error: "Token expired",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("returns a stable error for malformed successful JSON", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(200, "{not json"));

    const result = await fetchKimiUsage("key", 5000, mockFetch);

    expect(result.error).toBe("Malformed usage response");
    expect(result.windows).toEqual([]);
  });

  it("fetches the Kimi coding usages endpoint with bearer auth", async () => {
    const mockFetch = createProviderUsageFetch(async (url, init) => {
      expect(url).toBe("https://api.kimi.com/coding/v1/usages");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer kimi-key",
        Accept: "application/json",
      });
      return makeResponse(200, {
        usage: { limit: 100, used: 18 },
        limits: [{ name: "5h", detail: { limit: 50, used: 7 } }],
      });
    });

    const result = await fetchKimiUsage("kimi-key", 5000, mockFetch);

    expect(result).toEqual({
      provider: "kimi",
      displayName: "Kimi",
      windows: [
        { label: "5h", usedPercent: 14 },
        { label: "7d", usedPercent: 18 },
      ],
    });
  });

  it("parses a chunked JSON response through the bounded reader", async () => {
    const encoded = new TextEncoder().encode(
      JSON.stringify({
        usage: { limit: 100, used: 18 },
        limits: [{ name: "5h", detail: { limit: 50, used: 7 } }],
      }),
    );
    const mockFetch = createProviderUsageFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoded.slice(0, 17));
              controller.enqueue(encoded.slice(17));
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    await expect(fetchKimiUsage("key", 5000, mockFetch)).resolves.toMatchObject({
      windows: [
        { label: "5h", usedPercent: 14 },
        { label: "7d", usedPercent: 18 },
      ],
    });
  });

  it("returns the stable malformed error and cancels oversized response bodies", async () => {
    let pullCount = 0;
    const cancel = vi.fn(async () => undefined);
    const mockFetch = createProviderUsageFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pullCount += 1;
              controller.enqueue(new Uint8Array(pullCount === 1 ? 16 * 1024 * 1024 + 1 : 1));
            },
            cancel,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    await expect(fetchKimiUsage("key", 5000, mockFetch)).resolves.toMatchObject({
      provider: "kimi",
      windows: [],
      error: "Malformed usage response",
    });
    expect(pullCount).toBeLessThanOrEqual(2);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("fetchKimiUsage window parsing", () => {
  it("parses seven-day usage and five-hour named limit", async () => {
    await expect(
      expectParsedWindows({
        usage: { limit: 1000, used: 250 },
        limits: [
          { name: "daily", detail: { limit: 100, used: 20 } },
          { name: "Kimi Code 5-hour quota", detail: { limit: 200, remaining: 150 } },
        ],
      }),
    ).resolves.toEqual([
      { label: "5h", usedPercent: 25 },
      { label: "7d", usedPercent: 25 },
    ]);
  });

  it("recognizes duration-based five-hour windows", async () => {
    await expect(
      expectParsedWindows({
        usage: { limit: "100", remaining: "90" },
        limits: [
          {
            window: { duration: 300, timeUnit: "MINUTE" },
            detail: { limit: "40", remaining: "30" },
          },
        ],
      }),
    ).resolves.toEqual([
      { label: "5h", usedPercent: 25 },
      { label: "7d", usedPercent: 10 },
    ]);

    await expect(
      expectParsedWindows({
        limits: [{ duration: 5, timeUnit: "HOUR", limit: 10, used: 4 }],
      }),
    ).resolves.toEqual([{ label: "5h", usedPercent: 40 }]);
  });

  it("clamps malformed or out-of-range usage rows", async () => {
    await expect(
      expectParsedWindows({
        usage: { limit: 100, used: 150 },
        limits: [
          { name: "5h", detail: { limit: 0, used: 1 } },
          { name: "5h", detail: { limit: 100, remaining: 110 } },
        ],
      }),
    ).resolves.toEqual([
      { label: "5h", usedPercent: 0 },
      { label: "7d", usedPercent: 100 },
    ]);
  });

  it.each([{ unexpected: "object" }, "unexpected"])(
    "retains seven-day usage when limits is non-array: %j",
    async (limits) => {
      await expect(
        expectParsedWindows({
          usage: { limit: 100, used: 20 },
          limits,
        }),
      ).resolves.toEqual([{ label: "7d", usedPercent: 20 }]);
    },
  );
});

describe("normalizeKimiUsageBaseUrl", () => {
  it.each([
    { input: undefined, expected: "https://api.kimi.com/coding/v1" },
    { input: "https://api.kimi.com/coding/", expected: "https://api.kimi.com/coding/v1" },
    { input: "https://api.kimi.com/coding/v1/", expected: "https://api.kimi.com/coding/v1" },
    { input: "https://proxy.example/kimi/v1/", expected: "https://proxy.example/kimi/v1" },
  ])("normalizes %j", ({ input, expected }) => {
    expect(normalizeKimiUsageBaseUrl(input)).toBe(expected);
  });
});

describe("isManagedKimiUsageBaseUrl", () => {
  it.each([undefined, "https://api.kimi.com/coding/", "https://api.kimi.com/coding/v1/"])(
    "accepts managed Kimi Coding baseUrl %j",
    (input) => {
      expect(isManagedKimiUsageBaseUrl(input)).toBe(true);
    },
  );

  it.each(["https://proxy.example/kimi/v1/", "https://api.kimi.com/other/", "not-a-url"])(
    "rejects non-managed Kimi usage baseUrl %j",
    (input) => {
      expect(isManagedKimiUsageBaseUrl(input)).toBe(false);
    },
  );
});
