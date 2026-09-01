// Gateway Protocol tests cover push behavior.
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { PushTestResultSchema } from "./schema/push.js";

/**
 * Push protocol schema regression for APNS test results.
 * The transport field tells operators whether delivery used direct APNS or the
 * relay path, so it is part of the public result contract.
 */
describe("gateway protocol push schema", () => {
  const validatePushTestResult = Compile(PushTestResultSchema);

  it("accepts push.test results with a transport", () => {
    expect(
      validatePushTestResult.Check({
        ok: true,
        status: 200,
        tokenSuffix: "abcd1234",
        topic: "ai.openclaw.ios",
        environment: "production",
        transport: "relay",
      }),
    ).toBe(true);
  });
});
