import { describe, expect, it } from "vitest";
import { parseInlineOptionToken } from "./inline-option-token.js";

describe("parseInlineOptionToken", () => {
  it("preserves equals signs after the first separator", () => {
    expect(parseInlineOptionToken("--config=a=b.json")).toEqual({
      name: "--config",
      hasInlineValue: true,
      inlineValue: "a=b.json",
    });
    expect(parseInlineOptionToken("--token=abc==")).toEqual({
      name: "--token",
      hasInlineValue: true,
      inlineValue: "abc==",
    });
  });

  it("distinguishes empty inline values from missing separators", () => {
    expect(parseInlineOptionToken("--token=")).toEqual({
      name: "--token",
      hasInlineValue: true,
      inlineValue: "",
    });
    expect(parseInlineOptionToken("--token")).toEqual({
      name: "--token",
      hasInlineValue: false,
    });
  });
});
