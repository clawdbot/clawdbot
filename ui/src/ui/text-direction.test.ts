// Control UI tests cover text direction behavior.
import { describe, expect, it } from "vitest";
import { detectTextDirection } from "./text-direction.ts";

describe("detectTextDirection", () => {
  it("returns ltr for null and empty input", () => {
    expect(detectTextDirection(null)).toBe("ltr");
    expect(detectTextDirection("")).toBe("ltr");
  });

  it("detects rtl when first significant char is rtl script", () => {
    expect(detectTextDirection("שלום עולם")).toBe("rtl");
    expect(detectTextDirection("مرحبا")).toBe("rtl");
  });

  it("detects ltr when first significant char is ltr", () => {
    expect(detectTextDirection("Hello world")).toBe("ltr");
  });

  it("skips punctuation and markdown prefix characters before detection", () => {
    expect(detectTextDirection("**שלום")).toBe("rtl");
    expect(detectTextDirection("# مرحبا")).toBe("rtl");
    expect(detectTextDirection("- hello")).toBe("ltr");
  });
});
