// @vitest-environment node
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

  it("detects rtl behind a leading bidi control character", () => {
    expect(detectTextDirection("\u200Fשלום עולם")).toBe("rtl"); // RLM
    expect(detectTextDirection("\u2067שלום עולם")).toBe("rtl"); // RLI
    expect(detectTextDirection("\u202Bשלום עולם")).toBe("rtl"); // RLE
    expect(detectTextDirection("\u061Cمرحبا")).toBe("rtl"); // ALM
  });

  it("honors an explicit directional control over the first strong char", () => {
    expect(detectTextDirection("\u200FHello")).toBe("rtl"); // RLM
    expect(detectTextDirection("\u202EHello")).toBe("rtl"); // RLO
    expect(detectTextDirection("\u200Eשלום")).toBe("ltr"); // LRM
    expect(detectTextDirection("\u202Aשלום")).toBe("ltr"); // LRE
    expect(detectTextDirection("\u202Dשלום")).toBe("ltr"); // LRO
    expect(detectTextDirection("\u2066שלום")).toBe("ltr"); // LRI
  });

  it("skips direction-neutral format characters before detection", () => {
    expect(detectTextDirection("\uFEFFשלום")).toBe("rtl"); // BOM
    expect(detectTextDirection("\u2068שלום\u2069")).toBe("rtl"); // FSI/PDI
    expect(detectTextDirection("\u200Dשלום")).toBe("rtl"); // ZWJ
    expect(detectTextDirection("\uFEFFHello")).toBe("ltr");
  });

  it("returns ltr when the text holds only format characters", () => {
    expect(detectTextDirection("\uFEFF\u200D")).toBe("ltr");
  });
});
