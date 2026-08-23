import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { GatewaySuspendBlockerSchema, validateGatewaySuspendPrepareParams } from "./index.js";

describe("gateway suspension protocol", () => {
  it("keeps prepare params closed and bounded", () => {
    expect(validateGatewaySuspendPrepareParams({ requestId: "host-request" })).toBe(true);
    expect(
      validateGatewaySuspendPrepareParams({
        requestId: "host-request",
        terminalPolicy: "preserve",
      }),
    ).toBe(true);
    expect(
      validateGatewaySuspendPrepareParams({
        requestId: "host-request",
        terminalPolicy: "terminate",
      }),
    ).toBe(true);
    expect(validateGatewaySuspendPrepareParams({ requestId: "   " })).toBe(false);
    expect(
      validateGatewaySuspendPrepareParams({ requestId: "host-request", terminalPolicy: "close" }),
    ).toBe(false);
    expect(validateGatewaySuspendPrepareParams({ requestId: "host-request", extra: true })).toBe(
      false,
    );
  });

  it("keeps the historical terminal-session blocker wire-compatible", () => {
    expect(
      Value.Check(GatewaySuspendBlockerSchema, {
        kind: "terminal-session",
        count: 1,
        message: "1 open terminal session(s)",
      }),
    ).toBe(true);
  });
});
