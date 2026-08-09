import { getGlobalDispatcher, request } from "undici";
import { describe, expect, it } from "vitest";
import { createMockHttp, useMockHttp } from "./mock-http.js";

describe("useMockHttp", () => {
  const mockHttp = useMockHttp();

  it("routes Node global fetch through the mock dispatcher", async () => {
    mockHttp.intercept({
      url: "https://example.test/global-fetch",
      reply: { json: { source: "global-fetch" } },
    });

    const response = await globalThis.fetch("https://example.test/global-fetch");

    await expect(response.json()).resolves.toEqual({ source: "global-fetch" });
  });

  it("matches undici requests by URL, method, headers, and body", async () => {
    mockHttp.intercept({
      url: "https://example.test/undici-request?mode=test",
      method: "POST",
      requestHeaders: { "content-type": "application/json" },
      requestBody: JSON.stringify({ ready: true }),
      reply: { status: 201, body: "created" },
    });

    const response = await request("https://example.test/undici-request?mode=test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ready: true }),
    });

    expect(response.statusCode).toBe(201);
    await expect(response.body.text()).resolves.toBe("created");
  });

  it("returns per-request replies in registration order", async () => {
    mockHttp.intercept({
      url: "https://example.test/sequence",
      reply: { json: { sequence: 1 } },
    });
    mockHttp.intercept({
      url: "https://example.test/sequence",
      reply: { json: { sequence: 2 } },
    });

    const first = await globalThis.fetch("https://example.test/sequence");
    const second = await globalThis.fetch("https://example.test/sequence");

    await expect(first.json()).resolves.toEqual({ sequence: 1 });
    await expect(second.json()).resolves.toEqual({ sequence: 2 });
    expect(mockHttp.requests().map((entry) => entry.fullUrl)).toEqual([
      "https://example.test/sequence",
      "https://example.test/sequence",
    ]);
  });
});

describe("createMockHttp", () => {
  it("reports unused interceptors while restoring the previous dispatcher", async () => {
    const previousDispatcher = getGlobalDispatcher();
    const previousFetch = globalThis.fetch;
    const mockHttp = createMockHttp();
    mockHttp.setup();
    mockHttp.intercept({
      url: "https://example.test/unused",
      reply: { status: 204 },
    });

    await expect(mockHttp.cleanup()).rejects.toThrow(/interceptor is pending/);
    expect(getGlobalDispatcher()).toBe(previousDispatcher);
    expect(globalThis.fetch).toBe(previousFetch);
  });
});
