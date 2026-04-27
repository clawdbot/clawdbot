import { describe, expect, it } from "vitest";
import {
  diagnosticErrorCategory,
  diagnosticErrorFailureKind,
  diagnosticHttpStatusCode,
  diagnosticProviderRequestIdHash,
} from "./diagnostic-error-metadata.js";

describe("diagnostic error metadata", () => {
  it("returns stable categories without reading mutable Error.name", () => {
    const namedFailure = new Error("bad");
    Object.defineProperty(namedFailure, "name", {
      get() {
        throw new Error("should not read name");
      },
    });

    expect(diagnosticErrorCategory(new TypeError("bad"))).toBe("TypeError");
    expect(diagnosticErrorCategory(namedFailure)).toBe("Error");
    expect(diagnosticErrorCategory("bad")).toBe("string");
    expect(diagnosticErrorCategory(null)).toBe("null");
  });

  it("accepts only own HTTP status data properties as error codes", () => {
    expect(diagnosticHttpStatusCode({ status: 429 })).toBe("429");
    expect(diagnosticHttpStatusCode({ statusCode: 503 })).toBe("503");
    expect(diagnosticHttpStatusCode({ code: "SECRET_TOKEN" })).toBeUndefined();
    expect(diagnosticHttpStatusCode({ status: 99 })).toBeUndefined();
    expect(diagnosticHttpStatusCode({ status: "https://example.invalid/secret" })).toBeUndefined();
  });

  it("does not invoke throwing getters while extracting status codes", () => {
    const errorLike = {};
    Object.defineProperty(errorLike, "status", {
      get() {
        throw new Error("should not read getter");
      },
    });

    expect(diagnosticHttpStatusCode(errorLike)).toBeUndefined();
  });

  it("contains proxy traps during extraction", () => {
    const errorLike = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("hostile descriptor");
        },
      },
    );

    expect(diagnosticHttpStatusCode(errorLike)).toBeUndefined();
  });

  it("extracts bounded provider request id hashes without exposing raw ids", () => {
    expect(diagnosticProviderRequestIdHash({ requestId: "req_123" })).toMatch(
      /^sha256:[a-f0-9]{12}$/,
    );
    expect(
      diagnosticProviderRequestIdHash(
        new Error("Provider API error (429): quota [request_id=req_456]"),
      ),
    ).toMatch(/^sha256:[a-f0-9]{12}$/);
    expect(
      diagnosticProviderRequestIdHash({ requestId: "https://example.invalid/secret" }),
    ).toBeUndefined();
  });

  it("does not invoke throwing getters while extracting provider request ids", () => {
    const errorLike = {};
    Object.defineProperty(errorLike, "requestId", {
      get() {
        throw new Error("should not read getter");
      },
    });

    expect(diagnosticProviderRequestIdHash(errorLike)).toBeUndefined();
  });

  it("classifies low-cardinality transport failure kinds without exposing messages", () => {
    expect(diagnosticErrorFailureKind(new Error("terminated"))).toBe("terminated");
    expect(
      diagnosticErrorFailureKind(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" })),
    ).toBe("connection_reset");
    expect(
      diagnosticErrorFailureKind({
        error: Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" }),
      }),
    ).toBe("connection_closed");
    expect(diagnosticErrorFailureKind(new Error("request timed out after 120000ms"))).toBe(
      "timeout",
    );
    expect(diagnosticErrorFailureKind(new Error("operation was aborted"))).toBe("aborted");
    expect(diagnosticErrorFailureKind(new Error("provider rejected the request"))).toBeUndefined();
  });

  it("does not invoke throwing getters while classifying failure kinds", () => {
    const errorLike = {};
    Object.defineProperty(errorLike, "code", {
      get() {
        throw new Error("should not read getter");
      },
    });
    Object.defineProperty(errorLike, "message", {
      get() {
        throw new Error("should not read getter");
      },
    });

    expect(diagnosticErrorFailureKind(errorLike)).toBeUndefined();
  });
});
