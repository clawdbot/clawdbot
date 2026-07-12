// Mattermost tests cover client plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

import {
  createMattermostClient,
  createMattermostDirectChannelWithRetry,
  createMattermostPost,
  normalizeMattermostBaseUrl,
  readMattermostError,
  updateMattermostPost,
} from "./client.js";

// ── Helper: mock fetch that captures requests ────────────────────────

function createMockFetch(response?: { status?: number; body?: unknown; contentType?: string }) {
  const status = response?.status ?? 200;
  const body = response?.body ?? {};
  const contentType = response?.contentType ?? "application/json";

  const calls: Array<{ url: string; init?: RequestInit }> = [];

  const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = requestUrl(url);
    calls.push({ url: urlStr, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": contentType },
    });
  });

  return { mockFetch: mockFetch as typeof fetch, calls };
}

function requestUrl(url: string | URL | Request): string {
  if (typeof url === "string") {
    return url;
  }
  if (url instanceof URL) {
    return url.toString();
  }
  return url.url;
}

function parseRequestJson(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("expected JSON request body");
  }
  const parsed: unknown = JSON.parse(init.body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected JSON object request body");
  }
  return parsed as Record<string, unknown>;
}

function requireRequestCall(
  calls: readonly { url: string; init?: RequestInit }[],
  index = 0,
): { url: string; init?: RequestInit } {
  return expectDefined(calls[index], `Mattermost request call ${index}`);
}

function streamingMattermostResponse(body: unknown): {
  response: Response;
  arrayBuffer: ReturnType<typeof vi.fn>;
} {
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
  const arrayBuffer = vi.fn(async () => {
    throw new Error("guarded Mattermost responses must stay streaming");
  });
  return {
    response: {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/json" }),
      body: stream,
      arrayBuffer,
    } as unknown as Response,
    arrayBuffer,
  };
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

function createTestClient(response?: { status?: number; body?: unknown; contentType?: string }) {
  const { mockFetch, calls } = createMockFetch(response);
  const client = createMattermostClient({
    baseUrl: "http://localhost:8065",
    botToken: "tok",
    fetchImpl: mockFetch,
  });
  return { client, calls };
}

async function updatePostAndCapture(
  update: Parameters<typeof updateMattermostPost>[2],
  response?: { status?: number; body?: unknown; contentType?: string },
) {
  const { client, calls } = createTestClient(response ?? { body: { id: "post1" } });
  await updateMattermostPost(client, "post1", update);
  return {
    calls,
    body: parseRequestJson(requireRequestCall(calls).init),
  };
}

// ── normalizeMattermostBaseUrl ────────────────────────────────────────

describe("normalizeMattermostBaseUrl", () => {
  it("strips trailing slashes", () => {
    expect(normalizeMattermostBaseUrl("http://localhost:8065/")).toBe("http://localhost:8065");
  });

  it("strips /api/v4 suffix", () => {
    expect(normalizeMattermostBaseUrl("http://localhost:8065/api/v4")).toBe(
      "http://localhost:8065",
    );
  });

  it("returns undefined for empty input", () => {
    expect(normalizeMattermostBaseUrl("")).toBeUndefined();
    expect(normalizeMattermostBaseUrl(null)).toBeUndefined();
    expect(normalizeMattermostBaseUrl(undefined)).toBeUndefined();
  });

  it("preserves valid base URL", () => {
    expect(normalizeMattermostBaseUrl("http://mm.example.com")).toBe("http://mm.example.com");
  });
});

// ── readMattermostError ───────────────────────────────────────────────

describe("readMattermostError", () => {
  it("bounds null-body JSON errors without response.json/text", async () => {
    const response = new Response(null, {
      status: 401,
      headers: { "content-type": "application/json" },
    });
    const jsonSpy = vi.spyOn(response, "json").mockRejectedValue(new Error("unbounded"));
    const textSpy = vi.spyOn(response, "text").mockRejectedValue(new Error("unbounded"));

    await expect(readMattermostError(response)).resolves.toBe("");

    expect(jsonSpy).not.toHaveBeenCalled();
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("parses bounded JSON error messages from response bodies", async () => {
    const response = new Response(JSON.stringify({ message: "invalid token", id: "app.error" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
    const jsonSpy = vi.spyOn(response, "json").mockRejectedValue(new Error("unbounded"));
    const textSpy = vi.spyOn(response, "text").mockRejectedValue(new Error("unbounded"));

    await expect(readMattermostError(response)).resolves.toBe("invalid token");

    expect(jsonSpy).not.toHaveBeenCalled();
    expect(textSpy).not.toHaveBeenCalled();
  });
});

// ── createMattermostClient ───────────────────────────────────────────

describe("createMattermostClient", () => {
  it("keeps guarded Mattermost responses streaming until callers consume them", async () => {
    const release = vi.fn(async () => {});
    const { response, arrayBuffer } = streamingMattermostResponse({ id: "u1" });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({ response, release });
    const client = createMattermostClient({
      baseUrl: "https://chat.example.com",
      botToken: "test-token",
    });

    await expect(client.request("/users/me")).resolves.toEqual({ id: "u1" });

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("reads guarded null-body Mattermost errors without response.json/text", async () => {
    const release = vi.fn(async () => {});
    const response = new Response(null, {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "content-type": "application/json" },
    });
    const jsonSpy = vi.spyOn(response, "json").mockRejectedValue(new Error("unbounded"));
    const textSpy = vi.spyOn(response, "text").mockRejectedValue(new Error("unbounded"));
    fetchWithSsrFGuardMock.mockResolvedValueOnce({ response, release });
    const client = createMattermostClient({
      baseUrl: "https://chat.example.com",
      botToken: "test-token",
    });

    await expect(client.request("/users/me")).rejects.toThrow(
      "Mattermost API 503 Service Unavailable: unknown error",
    );
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(textSpy).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("bounds and cancels guarded Mattermost error bodies", async () => {
    const release = vi.fn(async () => {});
    const tracked = cancelTrackedResponse(`${"upstream unavailable ".repeat(512)}tail`, {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "content-type": "text/plain" },
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({ response: tracked.response, release });
    const client = createMattermostClient({
      baseUrl: "https://chat.example.com",
      botToken: "test-token",
    });

    let caught: Error | undefined;
    try {
      await client.request("/users/me");
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toContain("Mattermost API 503 Service Unavailable");
    expect(caught?.message).toContain("upstream unavailable");
    expect(caught?.message).not.toContain("tail");
    expect(caught?.message.length).toBeLessThan(8_300);
    expect(tracked.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("bounds and cancels oversized guarded Mattermost success JSON bodies", async () => {
    const release = vi.fn(async () => {});
    let canceled = false;
    let pulled = 0;
    const oversizeChunk = new Uint8Array(2 * 1024 * 1024).fill(0x7b); // 2 MiB of '{'
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        // Flood far past the 16 MiB JSON cap; an unbounded reader would buffer
        // the whole stream before parsing.
        controller.enqueue(oversizeChunk);
      },
      cancel() {
        canceled = true;
      },
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release,
    });
    const client = createMattermostClient({
      baseUrl: "https://chat.example.com",
      botToken: "test-token",
    });

    let caught: Error | undefined;
    try {
      await client.request("/users/me");
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toContain("JSON response exceeds 16777216 bytes");
    // The reader is cancelled at the cap instead of draining the flood: ~8
    // chunks of 2 MiB reach the 16 MiB ceiling, never the unbounded tail.
    expect(canceled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(12);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized guarded Mattermost success text bodies instead of truncating", async () => {
    const release = vi.fn(async () => {});
    const tracked = cancelTrackedResponse(`${"plain success ".repeat(7000)}tail`, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({ response: tracked.response, release });
    const client = createMattermostClient({
      baseUrl: "https://chat.example.com",
      botToken: "test-token",
    });

    await expect(client.request("/users/me")).rejects.toThrow(
      "Mattermost API /users/me: text response exceeds 65536 bytes",
    );
    expect(tracked.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases guarded Mattermost responses when upstream body reads fail", async () => {
    const release = vi.fn(async () => {});
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("upstream body failed");
      },
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release,
    });
    const client = createMattermostClient({
      baseUrl: "https://chat.example.com",
      botToken: "test-token",
    });

    await expect(client.request("/users/me")).rejects.toThrow("upstream body failed");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("creates a client with normalized baseUrl", () => {
    const { mockFetch } = createMockFetch();
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065/",
      botToken: "tok",
      fetchImpl: mockFetch,
    });
    expect(client.baseUrl).toBe("http://localhost:8065");
    expect(client.apiBaseUrl).toBe("http://localhost:8065/api/v4");
  });

  it("throws on empty baseUrl", () => {
    expect(() => createMattermostClient({ baseUrl: "", botToken: "tok" })).toThrow(
      "baseUrl is required",
    );
  });

  it("sends Authorization header with Bearer token", async () => {
    const { mockFetch, calls } = createMockFetch({ body: { id: "u1" } });
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065",
      botToken: "my-secret-token",
      fetchImpl: mockFetch,
    });
    await client.request("/users/me");
    const headers = new Headers(requireRequestCall(calls).init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer my-secret-token");
  });

  it("sets Content-Type for string bodies", async () => {
    const { mockFetch, calls } = createMockFetch({ body: { id: "p1" } });
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065",
      botToken: "tok",
      fetchImpl: mockFetch,
    });
    await client.request("/posts", { method: "POST", body: JSON.stringify({ message: "hi" }) });
    const headers = new Headers(requireRequestCall(calls).init?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("throws on non-ok responses", async () => {
    const { mockFetch } = createMockFetch({
      status: 404,
      body: { message: "Not Found" },
    });
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065",
      botToken: "tok",
      fetchImpl: mockFetch,
    });
    await expect(client.request("/missing")).rejects.toThrow("Mattermost API 404");
  });

  it("returns undefined on 204 responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      return new Response(null, { status: 204 });
    });
    const client = createMattermostClient({
      baseUrl: "https://chat.example.com",
      botToken: "test-token",
      fetchImpl,
    });
    const result = await client.request<unknown>("/anything", { method: "DELETE" });
    expect(result).toBeUndefined();
  });
});

// ── createMattermostPost ─────────────────────────────────────────────

describe("createMattermostPost", () => {
  it("sends channel_id and message", async () => {
    const { mockFetch, calls } = createMockFetch({ body: { id: "post1" } });
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065",
      botToken: "tok",
      fetchImpl: mockFetch,
    });

    await createMattermostPost(client, {
      channelId: "ch123",
      message: "Hello world",
    });

    const body = parseRequestJson(requireRequestCall(calls).init);
    expect(body.channel_id).toBe("ch123");
    expect(body.message).toBe("Hello world");
  });

  it("includes rootId when provided", async () => {
    const { mockFetch, calls } = createMockFetch({ body: { id: "post2" } });
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065",
      botToken: "tok",
      fetchImpl: mockFetch,
    });

    await createMattermostPost(client, {
      channelId: "ch123",
      message: "Reply",
      rootId: "root456",
    });

    const body = parseRequestJson(requireRequestCall(calls).init);
    expect(body.root_id).toBe("root456");
  });

  it("includes fileIds when provided", async () => {
    const { mockFetch, calls } = createMockFetch({ body: { id: "post3" } });
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065",
      botToken: "tok",
      fetchImpl: mockFetch,
    });

    await createMattermostPost(client, {
      channelId: "ch123",
      message: "With file",
      fileIds: ["file1", "file2"],
    });

    const body = parseRequestJson(requireRequestCall(calls).init);
    expect(body.file_ids).toEqual(["file1", "file2"]);
  });

  it("includes props when provided (for interactive buttons)", async () => {
    const { mockFetch, calls } = createMockFetch({ body: { id: "post4" } });
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065",
      botToken: "tok",
      fetchImpl: mockFetch,
    });

    const props = {
      attachments: [
        {
          text: "Choose:",
          actions: [{ id: "btn1", type: "button", name: "Click" }],
        },
      ],
    };

    await createMattermostPost(client, {
      channelId: "ch123",
      message: "Pick an option",
      props,
    });

    const body = parseRequestJson(requireRequestCall(calls).init);
    expect(body).toEqual({
      channel_id: "ch123",
      message: "Pick an option",
      props,
    });
  });

  it("omits props when not provided", async () => {
    const { mockFetch, calls } = createMockFetch({ body: { id: "post5" } });
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065",
      botToken: "tok",
      fetchImpl: mockFetch,
    });

    await createMattermostPost(client, {
      channelId: "ch123",
      message: "No props",
    });

    const body = parseRequestJson(requireRequestCall(calls).init);
    expect(body.props).toBeUndefined();
  });
});

// ── updateMattermostPost ─────────────────────────────────────────────

describe("updateMattermostPost", () => {
  it("sends PUT to /posts/{id}", async () => {
    const { calls } = await updatePostAndCapture({ message: "Updated" });

    const firstCall = requireRequestCall(calls);
    expect(firstCall.url).toContain("/posts/post1");
    if (!firstCall.init) {
      throw new Error("expected Mattermost update post request init");
    }
    expect(firstCall.init.method).toBe("PUT");
  });

  it("includes post id in the body", async () => {
    const { body } = await updatePostAndCapture({ message: "Updated" });
    expect(body.id).toBe("post1");
    expect(body.message).toBe("Updated");
  });

  it("includes props for button completion updates", async () => {
    const { body } = await updatePostAndCapture({
      message: "Original message",
      props: {
        attachments: [{ text: "✓ **do_now** selected by @tony" }],
      },
    });
    expect(body).toEqual({
      id: "post1",
      message: "Original message",
      props: {
        attachments: [{ text: "✓ **do_now** selected by @tony" }],
      },
    });
  });

  it("omits message when not provided", async () => {
    const { body } = await updatePostAndCapture({
      props: { attachments: [] },
    });
    expect(body.id).toBe("post1");
    expect(body.message).toBeUndefined();
    expect(body.props).toEqual({ attachments: [] });
  });
});

describe("createMattermostDirectChannelWithRetry delay cap", () => {
  it("keeps maxDelayMs authoritative when initialDelayMs exceeds it", async () => {
    vi.useFakeTimers();
    try {
      const mockFetch = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new Error("Mattermost API 503 Service Unavailable"))
        .mockRejectedValueOnce(new Error("Mattermost API 503 Service Unavailable"))
        .mockResolvedValueOnce(Response.json({ id: "dm-channel-cap" }, { status: 201 }));
      const client = createMattermostClient({
        baseUrl: "https://mattermost.example.com",
        botToken: "test-token",
        fetchImpl: mockFetch,
      });
      const delays: number[] = [];
      // The config schema allows initialDelayMs above the defaulted 10s
      // maxDelayMs cap; the cap must still bound every retry delay instead of
      // the base delay overriding it (regression guard for the core-retry
      // migration, which raises maxDelayMs to the minDelayMs floor).
      const promise = createMattermostDirectChannelWithRetry(client, ["user-1", "user-2"], {
        maxRetries: 3,
        initialDelayMs: 60_000,
        onRetry: (_attempt, delayMs) => {
          delays.push(delayMs);
        },
      });
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result.id).toBe("dm-channel-cap");
      expect(delays).toEqual([10_000, 10_000]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
