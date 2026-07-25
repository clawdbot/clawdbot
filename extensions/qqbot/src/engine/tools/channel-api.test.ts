// Qqbot tests cover channel-api tool behavior.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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

function qqbotCfg(qqbot: Record<string, unknown>): OpenClawConfig {
  return { channels: { qqbot } } as OpenClawConfig;
}

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
    vi.useRealTimers();
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

  it.each([
    { label: "successful", responseInit: { status: 200 } },
    {
      label: "error",
      responseInit: { status: 503, statusText: "Service Unavailable" },
    },
  ])("keeps the request deadline through $label response body reads", async ({ responseInit }) => {
    vi.useFakeTimers();
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockImplementationOnce(async ({ init }: { init?: RequestInit }) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) {
        throw new Error("expected channel API request signal");
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(signal.reason), {
            once: true,
          });
        },
      });
      return {
        response: new Response(body, responseInit),
        release,
      };
    });

    const resultPromise = executeChannelApi(
      { method: "GET", path: "/guilds/123/channels" },
      { accessToken: "token-1" },
    );
    await vi.advanceTimersByTimeAsync(30_000);

    const result = await resultPromise;
    expect(result.details).toEqual({
      error: "Request timed out after 30000ms",
      path: "/guilds/123/channels",
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("clears the request deadline when guarded fetch fails before headers", async () => {
    vi.useFakeTimers();
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("offline"));

    const result = await executeChannelApi(
      { method: "GET", path: "/guilds/123/channels" },
      { accessToken: "token-1" },
    );

    expect(result.details).toEqual({
      error: "Network error: offline",
      path: "/guilds/123/channels",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not label an unrelated body abort as a request timeout", async () => {
    const release = vi.fn(async () => {});
    const bodyError = new Error("upstream body aborted");
    bodyError.name = "AbortError";
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(bodyError);
          },
        }),
        { status: 200 },
      ),
      release,
    });

    const result = await executeChannelApi(
      { method: "GET", path: "/guilds/123/channels" },
      { accessToken: "token-1" },
    );

    expect(result.details).toEqual({
      error: "upstream body aborted",
      path: "/guilds/123/channels",
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("blocks guild listing when qqbot groups are scoped", async () => {
    const result = await executeChannelApi(
      { method: "GET", path: "/users/@me/guilds" },
      {
        accessToken: "token-1",
        cfg: qqbotCfg({ groups: { G1: {} } }),
      },
    );

    expect(result.details).toEqual({
      error: "QQ channel API guild listing is unavailable while qqbot groups are scoped.",
      path: "/users/@me/guilds",
    });
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("blocks guild paths when qqbot groups are scoped", async () => {
    const result = await executeChannelApi(
      { method: "GET", path: "/guilds/G1/channels" },
      {
        accessToken: "token-1",
        cfg: qqbotCfg({ groups: { G1: {} } }),
      },
    );

    expect(result.details).toEqual({
      error: "QQ channel API guild paths are unavailable while qqbot groups are scoped.",
      path: "/guilds/G1/channels",
    });
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("blocks channel paths when qqbot groups are scoped", async () => {
    const result = await executeChannelApi(
      { method: "GET", path: "/channels/C1/threads" },
      {
        accessToken: "token-1",
        cfg: qqbotCfg({ groups: { C1: {} } }),
      },
    );

    expect(result.details).toEqual({
      error: "QQ channel API channel paths are unavailable while qqbot groups are scoped.",
      path: "/channels/C1/threads",
    });
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("allows guild paths with wildcard qqbot groups", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ id: "channel-1" }), { status: 200 }),
      release,
    });

    const result = await executeChannelApi(
      { method: "GET", path: "/guilds/G1/channels" },
      {
        accessToken: "token-1",
        cfg: qqbotCfg({ groups: { "*": {} } }),
      },
    );

    expect(result.details).toMatchObject({
      success: true,
      status: 200,
      path: "/guilds/G1/channels",
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.sgroup.qq.com/guilds/G1/channels",
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("allows global guild listing with wildcard qqbot groups", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify([{ id: "guild-1" }]), { status: 200 }),
      release,
    });

    const result = await executeChannelApi(
      { method: "GET", path: "/users/@me/guilds" },
      {
        accessToken: "token-1",
        cfg: qqbotCfg({ groups: { "*": {} } }),
      },
    );

    expect(result.details).toMatchObject({
      success: true,
      status: 200,
      path: "/users/@me/guilds",
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.sgroup.qq.com/users/@me/guilds",
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
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

  it("requires confirmation before DELETE requests", async () => {
    const result = await executeChannelApi(
      { method: "DELETE", path: "/channels/123" },
      { accessToken: "token-1" },
    );

    expect(result.details).toEqual({
      error:
        "DELETE requests require confirmed=true after the user confirms the exact QQ resource.",
      path: "/channels/123",
    });
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("allows confirmed DELETE requests", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(null, { status: 204, statusText: "No Content" }),
      release,
    });

    const result = await executeChannelApi(
      { method: "DELETE", path: "/channels/123", confirmed: true },
      { accessToken: "token-1" },
    );

    expect(result.details).toEqual({
      success: true,
      status: 204,
      path: "/channels/123",
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.sgroup.qq.com/channels/123",
        init: expect.objectContaining({ method: "DELETE" }),
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("requires separate confirmation before bulk announcement deletes", async () => {
    const result = await executeChannelApi(
      { method: "DELETE", path: "/guilds/123/announces/all", confirmed: true },
      { accessToken: "token-1" },
    );

    expect(result.details).toEqual({
      error:
        "Deleting all announcements requires bulkConfirmed=true after a separate bulk-delete confirmation.",
      path: "/guilds/123/announces/all",
    });
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("requires bulk confirmation for encoded all announcement sentinel", async () => {
    const result = await executeChannelApi(
      { method: "DELETE", path: "/guilds/123/announces/%61%6c%6c", confirmed: true },
      { accessToken: "token-1" },
    );

    expect(result.details).toEqual({
      error:
        "Deleting all announcements requires bulkConfirmed=true after a separate bulk-delete confirmation.",
      path: "/guilds/123/announces/%61%6c%6c",
    });
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("rejects encoded path separators before fetch", async () => {
    const result = await executeChannelApi(
      { method: "GET", path: "/guilds/123%2fannounces" },
      { accessToken: "token-1" },
    );

    expect(result.details).toEqual({ error: "path contains encoded path separators" });
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("allows bulk announcement deletes after both confirmations", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(null, { status: 204, statusText: "No Content" }),
      release,
    });

    const result = await executeChannelApi(
      {
        method: "DELETE",
        path: "/guilds/123/announces/all",
        confirmed: true,
        bulkConfirmed: true,
      },
      { accessToken: "token-1" },
    );

    expect(result.details).toEqual({
      success: true,
      status: 204,
      path: "/guilds/123/announces/all",
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.sgroup.qq.com/guilds/123/announces/all",
        init: expect.objectContaining({ method: "DELETE" }),
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });
});
