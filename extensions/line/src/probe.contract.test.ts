import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { describe, expectTypeOf, it } from "vitest";
import type { LineProbeResult } from "./types.js";

describe("LINE probe contract", () => {
  it("keeps public probe aligned with base contract", () => {
    expectTypeOf<LineProbeResult>().toMatchTypeOf<BaseProbeResult>();
  });
});
