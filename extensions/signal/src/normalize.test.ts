import { describe, expect, it } from "vitest";
import { looksLikeSignalTargetId, normalizeSignalMessagingTarget } from "./normalize.js";

describe("normalizeSignalMessagingTarget", () => {
  it("normalizes uuid targets by stripping uuid:", () => {
    expect(normalizeSignalMessagingTarget("uuid:123E4567-E89B-12D3-A456-426614174000")).toBe(
      "123e4567-e89b-12d3-a456-426614174000",
    );
  });

  it("normalizes signal:uuid targets", () => {
    expect(normalizeSignalMessagingTarget("signal:uuid:123E4567-E89B-12D3-A456-426614174000")).toBe(
      "123e4567-e89b-12d3-a456-426614174000",
    );
  });

  it("preserves case for group targets", () => {
    expect(
      normalizeSignalMessagingTarget("signal:group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg="),
    ).toBe("group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=");
  });

  it("preserves case for base64-like group IDs without signal prefix", () => {
    expect(
      normalizeSignalMessagingTarget("group:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/ABCD="),
    ).toBe("group:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/ABCD=");
  });
});

describe("looksLikeSignalTargetId", () => {
  it("accepts uuid prefixes for target detection", () => {
    expect(looksLikeSignalTargetId("uuid:123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    expect(looksLikeSignalTargetId("signal:uuid:123e4567-e89b-12d3-a456-426614174000")).toBe(true);
  });

  it("accepts signal-prefixed E.164 targets for detection", () => {
    expect(looksLikeSignalTargetId("signal:+15551234567")).toBe(true);
    expect(looksLikeSignalTargetId("signal:15551234567")).toBe(true);
  });

  it("accepts compact UUIDs for target detection", () => {
    expect(looksLikeSignalTargetId("123e4567e89b12d3a456426614174000")).toBe(true);
    expect(looksLikeSignalTargetId("uuid:123e4567e89b12d3a456426614174000")).toBe(true);
  });

  it("rejects invalid uuid prefixes", () => {
    expect(looksLikeSignalTargetId("uuid:")).toBe(false);
    expect(looksLikeSignalTargetId("uuid:not-a-uuid")).toBe(false);
  });
});
