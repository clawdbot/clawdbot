// Assistant identity tests cover normalized assistant names and metadata values.
import { describe, expect, it } from "vitest";
import { coerceIdentityValue } from "./assistant-identity-values.js";

describe("shared/assistant-identity-values", () => {
  it("returns undefined for missing or blank values", () => {
    expect(coerceIdentityValue(undefined, 10)).toBeUndefined();
    expect(coerceIdentityValue("   ", 10)).toBeUndefined();
    expect(coerceIdentityValue(42 as unknown as string, 10)).toBeUndefined();
  });

  it("trims values and preserves strings within the limit", () => {
    expect(coerceIdentityValue("  OpenClaw  ", 20)).toBe("OpenClaw");
    expect(coerceIdentityValue("  OpenClaw  ", 8)).toBe("OpenClaw");
  });

  it("truncates overlong trimmed values at the exact limit", () => {
    expect(coerceIdentityValue("  OpenClaw Assistant  ", 8)).toBe("OpenClaw");
  });

  it("returns an empty string when truncating to a zero-length limit", () => {
    expect(coerceIdentityValue("  OpenClaw  ", 0)).toBe("");
    expect(coerceIdentityValue("  OpenClaw  ", -1)).toBe("OpenCla");
  });
});
