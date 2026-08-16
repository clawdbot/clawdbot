import { describe, expect, it } from "vitest";
import { prepareDailyMemoryFlushAppend } from "./memory-flush-append.js";

describe("prepareDailyMemoryFlushAppend", () => {
  it("accepts content at the exact structural limits by default", () => {
    const content = `${"x".repeat(500)}\n${"y".repeat(299)}`;
    expect(prepareDailyMemoryFlushAppend({ content, existingContent: "seed" })).toEqual({
      status: "accepted",
      content,
      appendedLines: 2,
      appendChars: 800,
    });
  });

  it.each([
    { name: "empty payload", content: " \n\t", error: /at least one non-empty line/ },
    { name: "line length", content: "x".repeat(501), error: /line too long/ },
    {
      name: "leading whitespace line length",
      content: `${" ".repeat(501)}x`,
      error: /line too long/,
    },
    {
      name: "trailing whitespace line length",
      content: `x${" ".repeat(501)}`,
      error: /line too long/,
    },
    {
      name: "line count",
      content: "- one\n- two\n- three\n- four",
      error: /too many lines/,
    },
    {
      name: "bare carriage-return line count",
      content: "- one\r- two\r- three\r- four",
      error: /too many lines/,
    },
    {
      name: "payload length",
      content: `${"x".repeat(400)}\n${"y".repeat(400)}`,
      error: /content too large/,
    },
  ])("rejects $name", ({ content, error }) => {
    expect(() =>
      prepareDailyMemoryFlushAppend({
        content,
        existingContent: "seed",
      }),
    ).toThrow(error);
  });

  it("allows headings and exact duplicate lines", () => {
    const content = "# Memory - 2026-08-01\n- existing durable note";
    expect(
      prepareDailyMemoryFlushAppend({ content, existingContent: "- existing durable note" }),
    ).toMatchObject({ status: "accepted", content });
  });

  it("preserves all accepted payload bytes", () => {
    const content = "  - first indented note\n\n- second note\n";
    expect(prepareDailyMemoryFlushAppend({ content, existingContent: "" })).toMatchObject({
      status: "accepted",
      content,
      appendedLines: 2,
      appendChars: content.length,
    });
  });
});
