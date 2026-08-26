// Memory Host SDK tests cover post json behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isRemoteProviderQuotaError, postJson, readRemoteProviderErrorFacts } from "./post-json.js";
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

function stallingSuccessResponse(onCancel: () => void): Response {
  const reader = {
    read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}),
    cancel: async () => {
      onCancel();
    },
    releaseLock: () => undefined,
  } as ReadableStreamDefaultReader<Uint8Array>;

  return {
    body: { getReader: () => reader },
    headers: new Headers(),
    ok: true,
    status: 200,
  } as Response;
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

  it("applies abort signals while reading successful response bodies", async () => {
    let canceled = false;
    const controller = new AbortController();
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(
        stallingSuccessResponse(() => {
          canceled = true;
        }),
      );
    });

    const read = postJson({
      url: "https://memory.example/v1/post",
      headers: {},
      body: {},
      signal: controller.signal,
      errorPrefix: "post failed",
      parse: () => ({}),
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    controller.abort(new Error("body aborted"));

    await expect(read).rejects.toThrow("body aborted");
    expect(canceled).toBe(true);
  });

  it("attaches status to every thrown non-ok error", async () => {
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
        parse: () => ({}),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("post failed: 502 bad gateway");
    expect((error as { status?: unknown }).status).toBe(502);
    expect((error as { code?: unknown }).code).toBeUndefined();
    expect((error as { retryAfterMs?: unknown }).retryAfterMs).toBeUndefined();
  });

  it("attaches provider error code, type, and Retry-After delay to quota errors", async () => {
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(
        new Response(
          JSON.stringify({
            error: {
              message: "You have no credits remaining.",
              type: "insufficient_quota",
              code: "credit_balance_exhausted",
            },
          }),
          { status: 429, headers: { "retry-after": "17" } },
        ),
      );
    });

    let error: unknown;
    try {
      await postJson({
        url: "https://memory.example/v1/post",
        headers: {},
        body: {},
        errorPrefix: "openai embeddings failed",
        parse: () => ({}),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("openai embeddings failed: 429");
    expect((error as { status?: unknown }).status).toBe(429);
    expect((error as { code?: unknown }).code).toBe("credit_balance_exhausted");
    expect((error as { errorType?: unknown }).errorType).toBe("insufficient_quota");
    expect((error as { retryAfterMs?: unknown }).retryAfterMs).toBe(17_000);
    expect(isRemoteProviderQuotaError(error)).toBe(true);
  });

  it("ignores prose-shaped error body codes", async () => {
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(
        new Response(JSON.stringify({ error: { code: "not a machine code!" } }), { status: 400 }),
      );
    });

    const error: unknown = await postJson({
      url: "https://memory.example/v1/post",
      headers: {},
      body: {},
      errorPrefix: "post failed",
      parse: () => ({}),
    }).catch((caught: unknown) => caught);

    expect((error as { status?: unknown }).status).toBe(400);
    expect((error as { code?: unknown }).code).toBeUndefined();
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
          headers: { "content-length": "00032" },
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

  it("accepts leading-zero content-length values on successful JSON responses", async () => {
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(
        new Response("{}", {
          status: 200,
          headers: { "content-length": "0002" },
        }),
      );
    });

    const result = await postJson({
      url: "https://memory.example/v1/post",
      headers: {},
      body: {},
      errorPrefix: "post failed",
      maxResponseBytes: 8,
      parse: (payload) => payload,
    });

    expect(result).toEqual({});
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

describe("readRemoteProviderErrorFacts", () => {
  it("reads facts through wrapper cause chains", () => {
    const transport = Object.assign(new Error("openai embeddings failed: 429 no credits"), {
      status: 429,
      code: "credit_balance_exhausted",
      errorType: "insufficient_quota",
      retryAfterMs: 12_000,
    });
    const wrapped = Object.assign(new Error(transport.message), {
      code: "MEMORY_EMBEDDING_OPERATION_FAILED",
      cause: transport,
    });

    expect(readRemoteProviderErrorFacts(wrapped)).toEqual({
      status: 429,
      code: "credit_balance_exhausted",
      errorType: "insufficient_quota",
      retryAfterMs: 12_000,
    });
    expect(isRemoteProviderQuotaError(wrapped)).toBe(true);
  });

  it("recognizes legacy responses that only carry the insufficient_quota code", () => {
    expect(
      isRemoteProviderQuotaError(
        Object.assign(new Error("quota"), { status: 429, code: "insufficient_quota" }),
      ),
    ).toBe(true);
  });

  it("returns no facts for errors without a numeric status", () => {
    expect(readRemoteProviderErrorFacts(new Error("fetch failed"))).toEqual({});
    expect(isRemoteProviderQuotaError(new Error("insufficient_quota mentioned in prose"))).toBe(
      false,
    );
  });
});
