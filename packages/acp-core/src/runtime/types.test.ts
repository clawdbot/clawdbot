import { expectTypeOf, it } from "vitest";
import type { AcpElicitationRequest, AcpElicitationResponse } from "./types.js";

it("keeps elicitation requests extensible and response actions closed", () => {
  void ({
    mode: "vendor/future",
    message: "Choose a value",
    requestId: 7,
    vendorData: { bounded: true },
  } satisfies AcpElicitationRequest);

  expectTypeOf<AcpElicitationResponse["action"]>().toEqualTypeOf<"accept" | "decline" | "cancel">();
});
