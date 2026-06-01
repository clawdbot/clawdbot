import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  boundedRequestLogBody,
  isRequestBodyTooLargeError,
  readBody,
  readMockOpenAiHttpLimits,
} from "../../scripts/e2e/lib/mock-openai-http.mjs";

function bodyStream(text: string) {
  const stream = new PassThrough();
  stream.end(text);
  return stream;
}

describe("mock OpenAI HTTP helpers", () => {
  it("reads request bodies within the configured ceiling", async () => {
    await expect(readBody(bodyStream("small"), { requestMaxBytes: 8 })).resolves.toBe("small");
  });

  it("rejects request bodies that exceed the configured ceiling", async () => {
    const error = await readBody(bodyStream("too large"), { requestMaxBytes: 4 }).catch(
      (cause: unknown) => cause,
    );

    expect(isRequestBodyTooLargeError(error)).toBe(true);
    expect(error).toMatchObject({
      code: "ETOOBIG",
      message: "mock OpenAI request body exceeded 4 bytes",
    });
  });

  it("truncates oversized request-log bodies", () => {
    expect(
      boundedRequestLogBody(
        { full: "x".repeat(16) },
        JSON.stringify({ full: "x".repeat(16) }),
        { requestLogBodyMaxBytes: 8 },
      ),
    ).toEqual({
      truncated: true,
      byteLength: 27,
      preview: '{"full":"xxxxxxxxxxxxxxxx"}',
    });
  });

  it("keeps small request-log bodies intact", () => {
    const body = { ok: true };
    expect(
      boundedRequestLogBody(body, JSON.stringify(body), { requestLogBodyMaxBytes: 64 }),
    ).toBe(body);
  });

  it("rejects loose numeric env limits instead of parsing prefixes", () => {
    expect(() =>
      readMockOpenAiHttpLimits({
        OPENCLAW_MOCK_OPENAI_REQUEST_MAX_BYTES: "1000ms",
      }),
    ).toThrow("invalid OPENCLAW_MOCK_OPENAI_REQUEST_MAX_BYTES: 1000ms");
    expect(() =>
      readMockOpenAiHttpLimits({
        OPENCLAW_MOCK_OPENAI_REQUEST_LOG_BODY_MAX_BYTES: "1e3",
      }),
    ).toThrow("invalid OPENCLAW_MOCK_OPENAI_REQUEST_LOG_BODY_MAX_BYTES: 1e3");
  });
});
