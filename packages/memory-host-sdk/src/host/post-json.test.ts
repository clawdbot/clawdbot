// Memory Host SDK tests cover post json behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { postJson } from "./post-json.js";
import { withRemoteHttpResponse } from "./remote-http.js";

vi.mock("./remote-http.js", () => ({
  withRemoteHttpResponse: vi.fn(),
}));

const remoteHttpMock = vi.mocked(withRemoteHttpResponse);

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

function streamingTextResponse(params: {
  body: string;
  status: number;
  headers?: HeadersInit;
  onCancel: () => void;
}): Response {
  const encoded = new TextEncoder().encode(params.body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
    },
    cancel() {
      params.onCancel();
    },
  });
  return new Response(stream, { status: params.status, headers: params.headers });
}

describe("postJson", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses JSON payload on successful response", async () => {
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(jsonResponse({ data: [{ embedding: [1, 2] }] }));
    });

    const result = await postJson({
      url: "https://memory.example/v1/post",
      headers: { Authorization: "Bearer test" },
      body: { input: ["x"] },
      errorPrefix: "post failed",
      parse: (payload) => payload,
    });

    expect(result).toEqual({ data: [{ embedding: [1, 2] }] });
  });

  it("forwards abort signals to the remote HTTP request", async () => {
    const controller = new AbortController();
    remoteHttpMock.mockImplementationOnce(async (params) => {
      expect(params.signal).toBe(controller.signal);
      return await params.onResponse(jsonResponse({ ok: true }));
    });

    await postJson({
      url: "https://memory.example/v1/post",
      headers: {},
      body: {},
      signal: controller.signal,
      errorPrefix: "post failed",
      parse: (payload) => payload,
    });
  });

  it("attaches status to thrown error when requested", async () => {
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(textResponse("bad gateway", 502));
    });

    let error: unknown;
    try {
      await postJson({
        url: "https://memory.example/v1/post",
        headers: {},
        body: {},
        errorPrefix: "post failed",
        attachStatus: true,
        parse: () => ({}),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("post failed: 502 bad gateway");
    expect((error as { status?: unknown }).status).toBe(502);
  });

  it("bounds non-ok response bodies before formatting the error", async () => {
    let canceled = false;
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(
        streamingTextResponse({
          body: "x".repeat(12_000),
          status: 502,
          onCancel: () => {
            canceled = true;
          },
        }),
      );
    });

    await expect(
      postJson({
        url: "https://memory.example/v1/post",
        headers: {},
        body: {},
        errorPrefix: "post failed",
        parse: () => ({}),
      }),
    ).rejects.toThrow(`post failed: 502 ${"x".repeat(1_000)}... [truncated]`);
    expect(canceled).toBe(true);
  });

  it("wraps malformed success JSON with the request error prefix", async () => {
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(textResponse("{ nope", 200));
    });

    await expect(
      postJson({
        url: "https://memory.example/v1/post",
        headers: {},
        body: {},
        errorPrefix: "post failed",
        parse: () => ({}),
      }),
    ).rejects.toThrow("post failed: malformed JSON response");
  });

  it("rejects successful JSON responses with oversized content-length", async () => {
    let canceled = false;
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(
        streamingTextResponse({
          body: "{}",
          status: 200,
          headers: { "content-length": "32" },
          onCancel: () => {
            canceled = true;
          },
        }),
      );
    });

    await expect(
      postJson({
        url: "https://memory.example/v1/post",
        headers: {},
        body: {},
        errorPrefix: "post failed",
        maxResponseBytes: 8,
        parse: () => ({}),
      }),
    ).rejects.toThrow("post failed: response body too large: 32 bytes (limit: 8 bytes)");
    expect(canceled).toBe(true);
  });

  it("cancels successful JSON responses that exceed the streaming byte cap", async () => {
    let canceled = false;
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(
        streamingTextResponse({
          body: `{"data":"${"x".repeat(32)}"}`,
          status: 200,
          onCancel: () => {
            canceled = true;
          },
        }),
      );
    });

    await expect(
      postJson({
        url: "https://memory.example/v1/post",
        headers: {},
        body: {},
        errorPrefix: "post failed",
        maxResponseBytes: 16,
        parse: () => ({}),
      }),
    ).rejects.toThrow("post failed: response body too large");
    expect(canceled).toBe(true);
  });
});
