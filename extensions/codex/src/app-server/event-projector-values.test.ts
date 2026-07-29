// Tests for event-projector-values utilities.
import { describe, expect, it } from "vitest";
import { extractRawAssistantText } from "./event-projector-values.js";

describe("extractRawAssistantText", () => {
  it("extracts single output_text segment", () => {
    expect(
      extractRawAssistantText({
        content: [{ type: "output_text", text: "Single answer." }],
      }),
    ).toBe("Single answer.");
  });

  it("extracts single text segment", () => {
    expect(
      extractRawAssistantText({
        content: [{ type: "text", text: "Single text." }],
      }),
    ).toBe("Single text.");
  });

  it("concatenates multiple output_text segments (upstream Responses API contract)", () => {
    expect(
      extractRawAssistantText({
        content: [
          { type: "output_text", text: "First" },
          { type: "output_text", text: "Second" },
        ],
      }),
    ).toBe("FirstSecond");
  });

  it("concatenates mixed output_text and text segments", () => {
    expect(
      extractRawAssistantText({
        content: [
          { type: "output_text", text: "Narration." },
          { type: "text", text: "Inline." },
          { type: "output_text", text: "Final." },
        ],
      }),
    ).toBe("Narration.Inline.Final.");
  });

  it("filters out non-text content blocks", () => {
    expect(
      extractRawAssistantText({
        content: [
          { type: "output_text", text: "Visible" },
          { type: "tool_use", name: "some_tool" },
          { type: "output_text", text: "More" },
        ],
      }),
    ).toBe("VisibleMore");
  });

  it("skips entries that are not JSON objects", () => {
    expect(
      extractRawAssistantText({
        content: [{ type: "output_text", text: "Only this" }, "string entry", 42, null],
      }),
    ).toBe("Only this");
  });

  it("returns undefined for empty content array", () => {
    expect(extractRawAssistantText({ content: [] })).toBeUndefined();
  });

  it("returns undefined when content field is missing", () => {
    expect(extractRawAssistantText({})).toBeUndefined();
  });

  it("returns undefined when content is not an array", () => {
    expect(extractRawAssistantText({ content: "not-array" })).toBeUndefined();
  });

  it("trims leading and trailing whitespace from the result", () => {
    expect(
      extractRawAssistantText({
        content: [{ type: "output_text", text: "  Hello world  " }],
      }),
    ).toBe("Hello world");
  });

  it("trims whitespace from the ends of the joined result", () => {
    expect(
      extractRawAssistantText({
        content: [
          { type: "output_text", text: "  First  " },
          { type: "output_text", text: "  Second  " },
        ],
      }),
    ).toBe("First    Second");
  });

  it("returns undefined for whitespace-only content", () => {
    expect(
      extractRawAssistantText({
        content: [{ type: "output_text", text: "   " }],
      }),
    ).toBeUndefined();
  });

  it("returns undefined for empty text values", () => {
    expect(
      extractRawAssistantText({
        content: [{ type: "output_text", text: "" }],
      }),
    ).toBeUndefined();
  });

  it("ignores content entries with unknown types", () => {
    expect(
      extractRawAssistantText({
        content: [
          { type: "refusal", text: "I cannot do that." },
          { type: "output_text", text: "But I can do this." },
        ],
      }),
    ).toBe("But I can do this.");
  });
});
