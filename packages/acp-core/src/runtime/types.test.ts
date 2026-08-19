import { expect, expectTypeOf, it } from "vitest";
import type { AcpElicitationRequest, AcpElicitationResponse } from "./types.js";

it("keeps elicitation requests extensible and response actions closed", () => {
  const customRequest = {
    mode: "vendor/future",
    message: "Choose a value",
    requestId: 7,
    vendorData: { bounded: true },
  } satisfies AcpElicitationRequest;

  expect(customRequest.mode).toBe("vendor/future");
  expectTypeOf<AcpElicitationResponse["action"]>().toEqualTypeOf<"accept" | "decline" | "cancel">();
});
