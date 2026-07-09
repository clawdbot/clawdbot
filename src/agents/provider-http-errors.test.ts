// Verifies provider HTTP error parsing, redaction, and response-size limits.
import { describe, expect, it, vi } from "vitest";
import {
  assertOkOrThrowProviderError,
  assertOkOrThrowHttpError,
  createProviderHttpError,
  extractProviderErrorDetail,
  extractProviderRequestId,
  ProviderHttpError,
  readProviderBinaryResponse,
  readProviderJsonResponse,
  readProviderTextResponse,
  readResponseTextLimited,
} from "./provider-http-errors.js";

function createStreamingBinaryResponse(params: {
  chunkCount: number;
  chunkSize: number;
  byte: number;
}): { response: Response; getReadCount: () => number } {
  // Streaming fixture proves oversized binary reads stop before buffering everything.
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads >= params.chunkCount) {
        controller.close();
        return;
      }
      reads += 1;
      controller.enqueue(new Uint8Array(params.chunkSize).fill(params.byte));
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    }),
    getReadCount: () => reads,
  };
}

function createStreamingJsonResponse(params: { chunkCount: number; chunkSize: number }): {
  response: Response;
  getReadCount: () => number;
} {
  // Streaming fixture proves oversized JSON reads stop before buffering everything.
  let reads = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads >= params.chunkCount) {
        controller.close();
        return;
      }
      reads += 1;
      controller.enqueue(encoder.encode("a".repeat(params.chunkSize)));
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    getReadCount: () => reads,
  };
}

function createStreamingTextResponse(params: { chunkCount: number; chunkSize: number }): {
  response: Response;
  getReadCount: () => number;
} {
  let reads = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads >= params.chunkCount) {
        controller.close();
        return;
      }
      reads += 1;
      controller.enqueue(encoder.encode("x".repeat(params.chunkSize)));
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    }),
    getReadCount: () => reads,
  };
}

describe("provider error utils", () => {
  it("formats nested provider error details with request ids", async () => {
    const response = new Response(
      JSON.stringify({
        detail: {
          message: "Quota exceeded",
          status: "quota_exceeded",
        },
      }),
      {
        status: 429,
        headers: { "x-request-id": "req_123" },
      },
    );

    await expect(assertOkOrThrowProviderError(response, "Provider API error")).rejects.toThrow(
      "Provider API error (429): Quota exceeded [code=quota_exceeded] [request_id=req_123]",
    );
  });

  it("reads string error fields and fallback request id headers", async () => {
    const response = new Response(JSON.stringify({ error: "Invalid API key" }), {
      status: 401,
      headers: { "request-id": "fallback_req" },
    });

    expect(await extractProviderErrorDetail(response)).toBe("Invalid API key");
    expect(extractProviderRequestId(response)).toBe("fallback_req");
  });

  it("preserves OAuth error descriptions as actionable details", async () => {
    const response = new Response(
      JSON.stringify({
        error: "invalid_request",
        error_description: "AADSTS7000215: Invalid client secret provided.",
      }),
      { status: 400 },
    );

    await expect(
      assertOkOrThrowProviderError(response, "OAuth token exchange failed"),
    ).rejects.toThrow(
      "OAuth token exchange failed (400): AADSTS7000215: Invalid client secret provided. [code=invalid_request]",
    );
  });

  it("does not split UTF-16 surrogate pairs when truncating provider error details", async () => {
    const safePrefix = "a".repeat(218);
    const message = `${safePrefix}😀suffix`;
    const response = new Response(
      JSON.stringify({
        error: { message, code: "utf16_test" },
      }),
      { status: 400 },
    );

    await expect(assertOkOrThrowProviderError(response, "Provider API error")).rejects.toThrow(
      `Provider API error (400): ${safePrefix}… [code=utf16_test]`,
    );
  });

  it("keeps HTTP status metadata when error body reads fail", async () => {
    const response = {
      ok: false,
      status: 503,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => {
            throw new Error("broken response stream");
          },
          cancel: async () => undefined,
        }),
      },
    } as unknown as Response;

    await expect(
      assertOkOrThrowProviderError(response, "Provider API error"),
    ).rejects.toMatchObject({
      name: "ProviderHttpError",
      status: 503,
      statusCode: 503,
      message: "Provider API error (503)",
    } satisfies Partial<ProviderHttpError>);
  });

  it("releases provider error body reader locks after bounded reads complete", async () => {
    const releaseLock = vi.fn();
    const cancel = vi.fn(async () => undefined);
    const chunks: Array<ReadableStreamReadResult<Uint8Array>> = [
      { done: false, value: new TextEncoder().encode("provider error") },
      { done: true, value: undefined },
    ];
    const response = {
      body: {
        getReader: () => ({
          read: async () => chunks.shift() ?? { done: true, value: undefined },
          cancel,
          releaseLock,
        }),
      },
    } as unknown as Response;

    await expect(readResponseTextLimited(response, 64)).resolves.toBe("provider error");
    expect(cancel).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("cancels and releases provider error body readers after diagnostic truncation", async () => {
    const releaseLock = vi.fn();
    const cancel = vi.fn(async () => undefined);
    const response = {
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: new TextEncoder().encode("provider error") }),
          cancel,
          releaseLock,
        }),
      },
    } as unknown as Response;

    await expect(readResponseTextLimited(response, 8)).resolves.toBe("provider");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("drops partial UTF-8 characters when provider error body reads truncate", async () => {
    const response = new Response(new Blob([new TextEncoder().encode("ab😀cd")]).stream());

    await expect(readResponseTextLimited(response, 3)).resolves.toBe("ab");
  });

  it("attaches structured provider error metadata", async () => {
    // API-key-like substrings must be redacted from stored error bodies.
    const response = new Response(
      JSON.stringify({
        error: {
          message: "Quota exceeded for api_key=sk-secret1234567890abcd",
          type: "rate_limit_error",
          code: "insufficient_quota",
        },
      }),
      {
        status: 429,
        headers: { "x-request-id": "req_456" },
      },
    );

    const error = await createProviderHttpError(response, "Provider API error");
    expect(error).toMatchObject({
      name: "ProviderHttpError",
      status: 429,
      statusCode: 429,
      code: "insufficient_quota",
      errorCode: "insufficient_quota",
      errorType: "rate_limit_error",
      requestId: "req_456",
    } satisfies Partial<ProviderHttpError>);
    const providerError = error as ProviderHttpError;
    expect(providerError.message).toContain("Quota exceeded");
    expect(providerError.errorBody).toContain("Quota exceeded");
    expect(providerError.errorBody).not.toContain("sk-secret1234567890abcd");
  });

  it("keeps legacy HTTP status formatting while sharing provider parsing", async () => {
    const response = new Response(
      JSON.stringify({
        error: {
          message: "Bad request",
          code: "invalid_request",
        },
      }),
      {
        status: 400,
        headers: { "x-request-id": "req_legacy" },
      },
    );

    await expect(assertOkOrThrowHttpError(response, "Legacy provider error")).rejects.toThrow(
      "Legacy provider error (HTTP 400): Bad request [code=invalid_request] [request_id=req_legacy]",
    );
  });

  it("wraps malformed successful JSON responses with provider labels", async () => {
    const response = new Response("{ nope", {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await expect(readProviderJsonResponse(response, "Provider catalog failed")).rejects.toThrow(
      "Provider catalog failed: malformed JSON response",
    );
  });

  it("parses well-formed JSON responses under the byte cap", async () => {
    const response = new Response(JSON.stringify({ models: ["a", "b"] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await expect(
      readProviderJsonResponse<{ models: string[] }>(response, "Provider catalog failed"),
    ).resolves.toEqual({ models: ["a", "b"] });
  });

  it("caps successful JSON responses instead of buffering oversized bodies", async () => {
    const streamed = createStreamingJsonResponse({
      chunkCount: 20,
      chunkSize: 1024,
    });

    await expect(
      readProviderJsonResponse(streamed.response, "Provider catalog failed", {
        maxBytes: 2048,
      }),
    ).rejects.toThrow("Provider catalog failed: JSON response exceeds 2048 bytes");

    expect(streamed.getReadCount()).toBeLessThan(20);
  });

  it("caps successful text responses instead of buffering oversized bodies", async () => {
    const streamed = createStreamingTextResponse({
      chunkCount: 20,
      chunkSize: 1024,
    });

    await expect(
      readProviderTextResponse(streamed.response, "Provider text failed", {
        maxBytes: 2048,
      }),
    ).rejects.toThrow("Provider text failed: text response exceeds 2048 bytes");

    expect(streamed.getReadCount()).toBeLessThan(20);
  });

  it("caps successful binary responses instead of buffering oversized bodies", async () => {
    const streamed = createStreamingBinaryResponse({
      chunkCount: 20,
      chunkSize: 1024,
      byte: 121,
    });

    await expect(
      readProviderBinaryResponse(streamed.response, "Provider TTS failed", "audio", {
        maxBytes: 2048,
      }),
    ).rejects.toThrow("Provider TTS failed: audio response exceeds 2048 bytes");

    expect(streamed.getReadCount()).toBeLessThan(20);
  });
});
