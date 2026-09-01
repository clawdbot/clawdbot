// Model catalog document support tests keep PDF routing tied to declared input
// capabilities.
import { describe, expect, it } from "vitest";
import { modelSupportsDocument } from "../model-catalog.js";

describe("model catalog document support", () => {
  it("modelSupportsDocument returns true when input includes document", () => {
    expect(
      modelSupportsDocument({
        id: "test",
        name: "test",
        provider: "test",
        input: ["text", "document"],
      }),
    ).toBe(true);
  });

  it("modelSupportsDocument returns false when input lacks document", () => {
    expect(
      modelSupportsDocument({
        id: "test",
        name: "test",
        provider: "test",
        input: ["text", "image"],
      }),
    ).toBe(false);
  });

  it("modelSupportsDocument returns false for undefined entry", () => {
    expect(modelSupportsDocument(undefined)).toBe(false);
  });
});
