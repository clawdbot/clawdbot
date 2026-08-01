import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { describe, expect, it } from "vitest";
import {
  isDurablyRetryableInboundMediaError,
  isRecoverableMediaGroupError,
} from "./bot-handlers.media.js";

describe("isDurablyRetryableInboundMediaError", () => {
  const networkCause = () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  const abortCause = () => Object.assign(new Error("aborted"), { name: "AbortError" });

  it("retries transient network and shutdown abort fetch failures", () => {
    expect(
      isDurablyRetryableInboundMediaError(
        new MediaFetchError("fetch_failed", "x", { cause: networkCause() }),
      ),
    ).toBe(true);
    expect(
      isDurablyRetryableInboundMediaError(
        new MediaFetchError("fetch_failed", "x", { cause: abortCause() }),
      ),
    ).toBe(true);
  });

  it("retries 408, 429, and 5xx HTTP fetch failures", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(
        isDurablyRetryableInboundMediaError(new MediaFetchError("http_error", "x", { status })),
      ).toBe(true);
    }
  });

  it("does not retry permanent media failures", () => {
    expect(
      isDurablyRetryableInboundMediaError(
        new MediaFetchError("fetch_failed", "blocked: private address", {
          cause: new Error("blocked: private address"),
        }),
      ),
    ).toBe(false);
    for (const status of [400, 401, 403, 404]) {
      expect(
        isDurablyRetryableInboundMediaError(new MediaFetchError("http_error", "x", { status })),
      ).toBe(false);
    }
    expect(isDurablyRetryableInboundMediaError(new MediaFetchError("max_bytes", "too big"))).toBe(
      false,
    );
  });
});

describe("isRecoverableMediaGroupError preserves album partial delivery (#55216)", () => {
  it("still skips-and-warns unclassified and permanent album fetch failures", () => {
    expect(isRecoverableMediaGroupError(new MediaFetchError("fetch_failed", "x"))).toBe(true);
    expect(isRecoverableMediaGroupError(new MediaFetchError("max_bytes", "x"))).toBe(true);
  });

  it("classifies transient album failures for durable retry while preserving live partial delivery", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      const error = new MediaFetchError("http_error", "temporary", { status });
      expect(isDurablyRetryableInboundMediaError(error)).toBe(true);
      expect(isRecoverableMediaGroupError(error)).toBe(true);
    }
    const networkError = new MediaFetchError("fetch_failed", "temporary", {
      cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
    });
    expect(isDurablyRetryableInboundMediaError(networkError)).toBe(true);
    expect(isRecoverableMediaGroupError(networkError)).toBe(true);
  });
});
