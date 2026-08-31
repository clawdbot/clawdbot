import { describe, expect, it } from "vitest";
import { isRephrasedReefResend, reefMessageTextHash } from "./rejection-resend.js";

describe("Reef rejection resend policy", () => {
  it("rejects empty, unchanged, and whitespace-only rewrites", () => {
    const originalTextHash = reefMessageTextHash("ordinary coordination");

    expect(isRephrasedReefResend("", originalTextHash)).toBe(false);
    expect(isRephrasedReefResend("ordinary coordination", originalTextHash)).toBe(false);
    expect(isRephrasedReefResend("  ordinary coordination\n", originalTextHash)).toBe(false);
    expect(isRephrasedReefResend("ordinary  coordination", originalTextHash)).toBe(false);
    expect(isRephrasedReefResend("ordinary\n\tcoordination", originalTextHash)).toBe(false);
  });

  it("allows one materially changed message only with a bound original hash", () => {
    const originalTextHash = reefMessageTextHash("ordinary coordination");

    expect(isRephrasedReefResend("Could you share the result?", originalTextHash)).toBe(true);
    expect(isRephrasedReefResend("Could you share the result?", undefined)).toBe(false);
  });
});
