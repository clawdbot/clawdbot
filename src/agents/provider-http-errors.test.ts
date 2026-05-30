import { describe, expect, it } from "vitest";
import {
  assertOkOrThrowProviderError,
  assertOkOrThrowHttpError,
  extractProviderErrorDetail,
  extractProviderErrorInfo,
  extractProviderRequestId,
  ProviderHttpError,
  readProviderBinaryResponse,
  readProviderJsonResponse,
} from "./provider-http-errors.js";

function createStreamingBinaryResponse(params: {
  chunkCount: number;
  chunkSize: number;
  byte: number;
}): { response: Response; getReadCount: () => number } {
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

  it("attaches structured provider error metadata", async () => {
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

    const info = await extractProviderErrorInfo(response.clone());
    expect(info).toMatchObject({
      code: "insufficient_quota",
      type: "rate_limit_error",
      requestId: "req_456",
    });
    expect(info.detail).toContain("Quota exceeded");
    expect(info.body).toContain("Quota exceeded");
    expect(info.body).not.toContain("sk-secret1234567890abcd");

    await expect(
      assertOkOrThrowProviderError(response, "Provider API error"),
    ).rejects.toMatchObject({
      name: "ProviderHttpError",
      status: 429,
      statusCode: 429,
      code: "insufficient_quota",
      errorCode: "insufficient_quota",
      errorType: "rate_limit_error",
      requestId: "req_456",
    } satisfies Partial<ProviderHttpError>);
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
