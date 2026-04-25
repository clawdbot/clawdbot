import { describe, expect, it } from "vitest";
import {
  assertOkOrThrowProviderError,
  assertOkOrThrowHttpError,
  extractProviderErrorDetail,
  extractProviderRequestId,
} from "./provider-http-errors.js";

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
});
