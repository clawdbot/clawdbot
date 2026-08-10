import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { validateGatewaySuspendPrepareParams } from "./index.js";
import { GatewaySuspendBlockerSchema } from "./schema/gateway-suspend.js";

describe("gateway suspension protocol", () => {
  it("keeps prepare params closed and bounded", () => {
    expect(validateGatewaySuspendPrepareParams({ requestId: "host-request" })).toBe(true);
    expect(validateGatewaySuspendPrepareParams({ requestId: "   " })).toBe(false);
    expect(validateGatewaySuspendPrepareParams({ requestId: "host-request", extra: true })).toBe(
      false,
    );
  });

  it("accepts non-quiescent session lifecycle blockers", () => {
    expect(
      Value.Check(GatewaySuspendBlockerSchema, {
        kind: "session-blocker",
        count: 1,
        message: "1 non-quiescent session lifecycle blocker(s)",
      }),
    ).toBe(true);
  });
});
