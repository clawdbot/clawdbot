import { describe, expect, it } from "vitest";
import { isGatewayEventFrame, isGatewayResponseFrame } from "./frame-guards.js";

describe("gateway frame guards", () => {
  it("accepts additive event fields while validating dispatch fields", () => {
    expect(
      isGatewayEventFrame({
        type: "event",
        event: "tick",
        seq: 0,
        payload: { future: true },
        futureEnvelopeField: true,
      }),
    ).toBe(true);
    expect(isGatewayEventFrame({ type: "event", event: "", seq: 0 })).toBe(false);
    expect(isGatewayEventFrame({ type: "event", event: "tick", seq: -1 })).toBe(false);
  });

  it("accepts additive response fields while validating errors", () => {
    expect(
      isGatewayResponseFrame({
        type: "res",
        id: "request-1",
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "try later",
          retryable: true,
          retryAfterMs: 10,
        },
        futureEnvelopeField: true,
      }),
    ).toBe(true);
    expect(
      isGatewayResponseFrame({
        type: "res",
        id: "request-1",
        ok: false,
        error: { code: "UNAVAILABLE", message: "", retryAfterMs: 10 },
      }),
    ).toBe(false);
    expect(
      isGatewayResponseFrame({
        type: "res",
        id: "request-1",
        ok: false,
        error: { code: "UNAVAILABLE", message: "try later", retryAfterMs: -1 },
      }),
    ).toBe(false);
  });
});
