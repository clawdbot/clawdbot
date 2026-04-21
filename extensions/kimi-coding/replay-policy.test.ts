import { describe, expect, it } from "vitest";
import { KIMI_REPLAY_POLICY } from "./replay-policy.js";

describe("kimi replay policy", () => {
  it("disables signature preservation for replay repair", () => {
    expect(KIMI_REPLAY_POLICY).toEqual({
      preserveSignatures: false,
    });
  });
});
