import { describe, expect, it } from "vitest";
import { classifyFailoverReason, classifyFailoverSignal } from "./classify.js";

describe("Claude CLI logged-out failures", () => {
  const loggedOutMessage = "Not logged in · Please run /login";

  it("classifies the logged-out response as auth only for claude-cli", () => {
    expect(classifyFailoverReason(loggedOutMessage, { provider: "claude-cli" })).toBe("auth");
    expect(classifyFailoverReason(loggedOutMessage, { provider: "openai" })).toBeNull();
    expect(classifyFailoverReason(loggedOutMessage)).toBeNull();
  });
});

describe("OAuth session expiry", () => {
  const expiredMessage = "Failed to authenticate: OAuth session expired and could not be refreshed";

  it("classifies OAuth expiry as auth only for claude-cli", () => {
    expect(classifyFailoverReason(expiredMessage, { provider: "claude-cli" })).toBe("auth");
    expect(classifyFailoverReason(expiredMessage, { provider: "custom-cli" })).toBe(
      "session_expired",
    );
    expect(classifyFailoverReason(expiredMessage)).toBe("session_expired");
  });
});

describe("HTTP 5xx status classification", () => {
  // A provider-side 5xx is not a timing failure. Naming it "timeout" both tells
  // the user the request timed out and takes the "timeout" carve-outs in
  // resolveRunFailoverDecision, which skip retry-limit model fallback.
  it.each([500, 502, 503, 505, 507, 520, 521, 523])(
    "classifies an untyped %i as server_error",
    (status) => {
      expect(classifyFailoverSignal({ status, message: "upstream failure" })).toEqual({
        kind: "reason",
        reason: "server_error",
      });
    },
  );

  it.each([499, 504, 522, 524])("keeps gateway-timeout status %i as timeout", (status) => {
    expect(classifyFailoverSignal({ status, message: "upstream failure" })).toEqual({
      kind: "reason",
      reason: "timeout",
    });
  });

  it.each([502, 503, 521])("classifies a CDN HTML error page at %i as server_error", (status) => {
    // An HTML body means a CDN answered instead of the provider, so there is
    // no provider error type to read. It is still an upstream failure.
    const html = `${status} <!doctype html><html><head><title>${status}</title></head><body>Cloudflare</body></html>`;
    expect(classifyFailoverSignal({ message: html })).toEqual({
      kind: "reason",
      reason: "server_error",
    });
  });

  it("keeps a CDN HTML error page at a gateway-timeout status as timeout", () => {
    const html =
      "504 <!doctype html><html><head><title>504</title></head><body>Cloudflare</body></html>";
    expect(classifyFailoverSignal({ message: html })).toEqual({
      kind: "reason",
      reason: "timeout",
    });
  });

  it("still prefers a provider-typed body over the status mapping", () => {
    expect(
      classifyFailoverSignal({
        status: 502,
        message: '{"error":{"type":"overloaded_error","message":"Overloaded"}}',
      }),
    ).toEqual({ kind: "reason", reason: "overloaded" });
  });
});
