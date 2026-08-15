import { describe, expect, it } from "vitest";
import {
  assertWidgetHtmlSize,
  isCompleteHtmlDocument,
  WidgetHtmlInputError,
} from "./widget-html.js";

describe("widget HTML helpers", () => {
  it("detects complete HTML documents after leading whitespace", () => {
    expect(isCompleteHtmlDocument("  <!DOCTYPE html><html></html>")).toBe(true);
    expect(isCompleteHtmlDocument('\n<HTML lang="en"></html>')).toBe(true);
    expect(isCompleteHtmlDocument("<section>fragment</section>")).toBe(false);
    expect(isCompleteHtmlDocument("<!doctype svg><svg></svg>")).toBe(false);
  });

  it("enforces UTF-8 byte limits by default", () => {
    expect(() => assertWidgetHtmlSize("é", 2)).not.toThrow();
    expect(() => assertWidgetHtmlSize("é", 1)).toThrow("html exceeds maximum size (1 bytes)");
  });

  it("can preserve character-count limits and custom input names", () => {
    expect(() =>
      assertWidgetHtmlSize("é", 1, { inputName: "widget_code", unit: "characters" }),
    ).not.toThrow();
    expect(() =>
      assertWidgetHtmlSize("😀", 1, { inputName: "widget_code", unit: "characters" }),
    ).toThrow("widget_code exceeds maximum size (1 characters)");
  });

  it("uses the tool input error identity", () => {
    let error: unknown;
    try {
      assertWidgetHtmlSize("too large", 1);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(WidgetHtmlInputError);
    expect(error).toMatchObject({ name: "ToolInputError" });
  });
});
