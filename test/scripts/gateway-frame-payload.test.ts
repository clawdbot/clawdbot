// Gateway Frame Payload tests cover gateway frame payload script behavior.
import { describe, expect, it } from "vitest";
import { resolveGatewaySuccessPayload } from "../../scripts/e2e/lib/gateway-frame-payload.mjs";

describe("gateway frame payload resolution", () => {
  it("preserves explicit nullish payload fields", () => {
    expect(resolveGatewaySuccessPayload({ payload: null, result: { stale: true } })).toBeNull();
    expect(
      resolveGatewaySuccessPayload({ payload: undefined, result: { stale: true } }),
    ).toBeUndefined();
  });

  it("falls back to result only when payload is absent", () => {
    expect(resolveGatewaySuccessPayload({ result: null })).toBeNull();
    expect(resolveGatewaySuccessPayload({ result: false })).toBe(false);
    expect(resolveGatewaySuccessPayload({ result: 0 })).toBe(0);
  });
});
