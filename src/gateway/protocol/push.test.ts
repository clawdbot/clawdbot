import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { PushTestResultSchema } from "./schema/push.js";

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
