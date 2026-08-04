/** Canonical debug-proxy capture header redaction. */
import { afterEach, describe, expect, it } from "vitest";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import {
  redactCaptureText,
  redactedCaptureHeaders,
  redactedCaptureHeadersBounded,
} from "./header-redaction.js";

afterEach(() => {
  resetSecretRedactionRegistryForTest();
});

describe("redactedCaptureHeaders", () => {
  it("fully redacts registered secrets in capture text", () => {
    const secret = "registered-secret-with-visible-edges";
    registerSecretValueForRedaction(secret);
    const redacted = redactCaptureText(`before ${secret} after`);
    expect(redacted).toBe("before [REDACTED] after");
    expect(redacted).not.toContain(secret.slice(0, 6));
    expect(redacted).not.toContain(secret.slice(-4));
  });

  it("redacts credential-bearing header names regardless of case", () => {
    const redacted = redactedCaptureHeaders({
      Authorization: "Bearer live-token",
      COOKIE: "session=abc",
      "X-Api-Key": "sk-live",
      "content-type": "application/json",
    });
    expect(redacted).toEqual({
      Authorization: "[REDACTED]",
      COOKIE: "[REDACTED]",
      "X-Api-Key": "[REDACTED]",
      "content-type": "application/json",
    });
  });

  it("bounds header inputs before redacting ordinary values", () => {
    const captured = redactedCaptureHeadersBounded(
      {
        authorization: "x".repeat(10_000),
        "x-oversized": "x".repeat(101),
        "x-visible": "kept",
        "x-after-limit": "omitted",
      },
      {
        maxEntries: 3,
        maxNameChars: 40,
        maxValueChars: 100,
        maxTotalValueChars: 100,
      },
    );
    expect(captured).toEqual({
      headers: { authorization: "[REDACTED]", "x-visible": "kept" },
      truncated: true,
    });
  });

  it("redacts a registered secret pasted into an otherwise innocuous header", () => {
    // The name check alone would pass this through; value redaction is what
    // keeps a leaked token out of the capture.
    registerSecretValueForRedaction("super-secret-value");
    const redacted = redactedCaptureHeaders({ "x-trace-note": "ctx super-secret-value end" });
    expect(redacted?.["x-trace-note"]).not.toContain("super-secret-value");
  });

  it("redacts caller-declared sensitive header names regardless of case", () => {
    const redacted = redactedCaptureHeaders(
      {
        "X-Routing-Target": "staging-private-route",
        Accept: "text/plain",
      },
      ["x-routing-target"],
    );
    expect(redacted).toEqual({
      "X-Routing-Target": "[REDACTED]",
      Accept: "text/plain",
    });
  });

  it("flattens node's array-valued headers instead of dropping them", () => {
    // node:http exposes repeated headers as arrays; the standalone proxy feeds
    // those in directly.
    const redacted = redactedCaptureHeaders({
      "set-cookie": ["a=1", "b=2"],
      via: ["1.1 a", "1.1 b"],
    });
    expect(redacted?.["set-cookie"]).toBe("[REDACTED]");
    expect(redacted?.via).toBe("1.1 a, 1.1 b");
  });

  it("accepts a Headers instance", () => {
    const redacted = redactedCaptureHeaders(
      new Headers({ authorization: "Bearer x", accept: "text/plain" }),
    );
    expect(redacted?.authorization).toBe("[REDACTED]");
    expect(redacted?.accept).toBe("text/plain");
  });

  it("returns undefined when there are no headers", () => {
    expect(redactedCaptureHeaders(undefined)).toBeUndefined();
  });

  it("treats token-ish name fragments as sensitive", () => {
    const redacted = redactedCaptureHeaders({
      "x-vendor-access-token": "abc",
      "x-session-id": "s-1",
      "accept-language": "en-US",
    });
    expect(redacted).toEqual({
      "x-vendor-access-token": "[REDACTED]",
      "x-session-id": "[REDACTED]",
      "accept-language": "en-US",
    });
  });
});
