import { describe, expect, it } from "vitest";
import { pickFallbackThinkingLevel } from "./thinking.js";

describe("pickFallbackThinkingLevel", () => {
  it("returns undefined for empty message", () => {
    expect(pickFallbackThinkingLevel({ message: "", attempted: new Set() })).toBeUndefined();
  });

  it("returns undefined for undefined message", () => {
    expect(pickFallbackThinkingLevel({ message: undefined, attempted: new Set() })).toBeUndefined();
  });

  it("extracts supported values from error message", () => {
    const result = pickFallbackThinkingLevel({
      message: 'Supported values are: "high", "medium"',
      attempted: new Set(),
    });
    expect(result).toBe("high");
  });

  it("skips already attempted values", () => {
    const result = pickFallbackThinkingLevel({
      message: 'Supported values are: "high", "medium"',
      attempted: new Set(["high"]),
    });
    expect(result).toBe("medium");
  });

  it('falls back to "off" when error says "not supported" without listing values', () => {
    const result = pickFallbackThinkingLevel({
      message: '400 think value "low" is not supported for this model',
      attempted: new Set(),
    });
    expect(result).toBe("off");
  });

  it('falls back to "minimal" when the endpoint requires reasoning', () => {
    const result = pickFallbackThinkingLevel({
      message: "400 Reasoning is mandatory for this endpoint and cannot be disabled.",
      attempted: new Set(["off"]),
    });
    expect(result).toBe("minimal");
  });

  it('returns undefined for reasoning-required errors after "minimal" was attempted', () => {
    const result = pickFallbackThinkingLevel({
      message: "400 Reasoning is mandatory for this endpoint and cannot be disabled.",
      attempted: new Set(["off", "minimal"]),
    });
    expect(result).toBeUndefined();
  });

  it('falls back to "off" for generic not-supported messages', () => {
    const result = pickFallbackThinkingLevel({
      message: "thinking level not supported by this provider",
      attempted: new Set(),
    });
    expect(result).toBe("off");
  });

  it('returns undefined if "off" was already attempted', () => {
    const result = pickFallbackThinkingLevel({
      message: '400 think value "low" is not supported for this model',
      attempted: new Set(["off"]),
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined for unrelated error messages", () => {
    const result = pickFallbackThinkingLevel({
      message: "rate limit exceeded, please retry after 30 seconds",
      attempted: new Set(),
    });
    expect(result).toBeUndefined();
  });
});
