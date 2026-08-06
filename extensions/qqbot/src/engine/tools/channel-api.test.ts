// Qqbot tests cover channel-api tool behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../../../../test-support/streaming-error-response.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

import { executeChannelApi } from "./channel-api.js";

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

describe("executeChannelApi", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    fetchWithSsrFGuardMock.mockReset();
  });

  it("uses guarded QQ API fetches and releases successful responses", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ id: "guild-1" }), { status: 200 }),
      release,
    });

    const result = await executeChannelApi(
      { method: "GET", path: "/users/@me/guilds", query: { limit: "1" } },
      { accessToken: "token-1" },
    );

    expect(result.details).toEqual({
      success: true,
      status: 200,
      path: "/users/@me/guilds",
      data: { id: "guild-1" },
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
      url: "https://api.sgroup.qq.com/users/@me/guilds?limit=1",
      init: {
        method: "GET",
        headers: {
          Authorization: "QQBot token-1",
          "Content-Type": "application/json",
        },
        signal: expect.any(AbortSignal),
      },
      auditContext: "qqbot-channel-api",
      policy: {
        hostnameAllowlist: ["api.sgroup.qq.com"],
        allowRfc2544BenchmarkRange: true,
      },
    });
  });

  it("bounds error bodies without using response.text()", async () => {
    const release = vi.fn(async () => {});
    const tracked = cancelTrackedResponse(`${"channel api unavailable ".repeat(1024)}tail`, {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: tracked.response,
      release,
    });

    const result = await executeChannelApi(
      { method: "GET", path: "/guilds/123/channels" },
      { accessToken: "token-1" },
    );

    expect(result.details).toMatchObject({
      error: "503 Service Unavailable",
      status: 503,
      path: "/guilds/123/channels",
    });
    const bodyPreview = (result.details as { details?: unknown }).details;
    expect(typeof bodyPreview).toBe("string");
    expect(bodyPreview).toContain("channel api unavailable");
    expect(bodyPreview).not.toContain("tail");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("bounds successful response bodies without using response.text()", async () => {
    const release = vi.fn(async () => {});
    const streamed = createStreamingResponse({
      chunkCount: 32,
      chunkSize: 1024 * 1024,
      text: "x",
      headers: { "content-type": "application/json" },
    });
    const textSpy = vi.spyOn(streamed.response, "text").mockRejectedValue(new Error("unbounded"));
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: streamed.response,
      release,
    });

    const result = await executeChannelApi(
      { method: "GET", path: "/guilds/123/channels" },
      { accessToken: "token-1" },
    );

    expect(result.details).toMatchObject({
      error: "QQ channel API response: text response exceeds 16777216 bytes",
      path: "/guilds/123/channels",
    });
    expect(streamed.getReadCount()).toBeLessThan(32);
    expect(streamed.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
