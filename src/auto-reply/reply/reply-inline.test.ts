// Tests inline reply directive parsing and whitespace-preserving behavior.
import { describe, expect, it } from "vitest";
import { extractInlineSimpleCommand, stripInlineStatus } from "./reply-inline.js";

describe("stripInlineStatus", () => {
  it("strips /status directive from message", () => {
    const result = stripInlineStatus("/status hello world");
    expect(result.cleaned).toBe("hello world");
    expect(result.didStrip).toBe(true);
  });

  it("preserves newlines in multi-line messages", () => {
    const result = stripInlineStatus("first line\nsecond line\nthird line");
    expect(result.cleaned).toBe("first line\nsecond line\nthird line");
    expect(result.didStrip).toBe(false);
  });

  it("preserves newlines when stripping /status", () => {
    const result = stripInlineStatus("/status\nfirst paragraph\n\nsecond paragraph");
    expect(result.cleaned).toBe("first paragraph\n\nsecond paragraph");
    expect(result.didStrip).toBe(true);
  });

  it("collapses horizontal whitespace but keeps newlines", () => {
    const result = stripInlineStatus("hello   world\n  indented  line");
    expect(result.cleaned).toBe("hello world\n indented line");
    // didStrip is true because whitespace normalization changed the string
    expect(result.didStrip).toBe(true);
  });

  it("returns empty string for whitespace-only input", () => {
    const result = stripInlineStatus("   ");
    expect(result.cleaned).toBe("");
    expect(result.didStrip).toBe(false);
  });
});

describe("extractInlineSimpleCommand", () => {
  it("extracts /help command", () => {
    const result = extractInlineSimpleCommand("/help some question");
    expect(result?.command).toBe("/help");
    expect(result?.cleaned).toBe("some question");
  });

  it("preserves newlines after extracting command", () => {
    const result = extractInlineSimpleCommand("/help first line\nsecond line");
    expect(result?.command).toBe("/help");
    expect(result?.cleaned).toBe("first line\nsecond line");
  });

  it("returns null for empty body", () => {
    expect(extractInlineSimpleCommand("")).toBeNull();
    expect(extractInlineSimpleCommand(undefined)).toBeNull();
  });
});
