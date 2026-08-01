import { describe, expect, it } from "vitest";
import { validateGatewaySuspendPrepareParams } from "./index.js";

describe("gateway suspension protocol", () => {
  it("keeps prepare params closed and bounded", () => {
    expect(validateGatewaySuspendPrepareParams({ requestId: "host-request" })).toBe(true);
    expect(validateGatewaySuspendPrepareParams({ requestId: "   " })).toBe(false);
    expect(validateGatewaySuspendPrepareParams({ requestId: "host-request", extra: true })).toBe(
      false,
    );
  });
});
