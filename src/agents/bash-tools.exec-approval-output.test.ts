import { describe, expect, it } from "vitest";
import { formatExecApprovalContinuationOutput } from "./bash-tools.exec-approval-output.js";

// Pinned so a budget change is a deliberate edit rather than a silent drift.
const MAX_UTF16_UNITS = 16_000;
const MARKER =
  "[... truncated to fit the continuation budget; more output may have been dropped when it was captured ...]";

describe("formatExecApprovalContinuationOutput", () => {
  it("returns empty output when no stream carries content", () => {
    expect(formatExecApprovalContinuationOutput([])).toBe("");
    expect(
      formatExecApprovalContinuationOutput([
        { label: "stdout", value: "" },
        { label: "stderr", value: undefined },
        { label: "error", value: null },
      ]),
    ).toBe("");
  });

  it("leaves a single stream verbatim and unlabelled", () => {
    const value = "line one\nline two\n";
    expect(
      formatExecApprovalContinuationOutput([
        { label: "stdout", value },
        { label: "stderr", value: "" },
      ]),
    ).toBe(value);
  });

  it("preserves LF, CRLF, tabs, indentation, blank lines and trailing whitespace", () => {
    const value = "first\r\n\tindented\n\n  spaced  \ttrailing\t\n   ";
    expect(formatExecApprovalContinuationOutput([{ label: "stdout", value }])).toBe(value);
  });

  it("does not collapse whitespace the way the compact notify formatter does", () => {
    const value = "a\n\n\nb    c";
    const formatted = formatExecApprovalContinuationOutput([{ label: "stdout", value }]);
    expect(formatted).toBe(value);
    expect(formatted).not.toBe(value.replace(/\s+/g, " ").trim());
  });

  it("labels streams in deterministic order when several carry content", () => {
    expect(
      formatExecApprovalContinuationOutput([
        { label: "stdout", value: "out\n" },
        { label: "stderr", value: "err\n" },
        { label: "error", value: "boom" },
      ]),
    ).toBe("[stdout]\nout\n\n[stderr]\nerr\n\n[error]\nboom");
  });

  it("keeps error-only output unlabelled", () => {
    expect(
      formatExecApprovalContinuationOutput([
        { label: "stdout", value: "" },
        { label: "stderr", value: "" },
        { label: "error", value: "spawn failed" },
      ]),
    ).toBe("spawn failed");
  });

  it("is byte-identical at and below the cap", () => {
    const exact = "x".repeat(MAX_UTF16_UNITS);
    expect(formatExecApprovalContinuationOutput([{ label: "stdout", value: exact }])).toBe(exact);
    const under = "y".repeat(MAX_UTF16_UNITS - 1);
    expect(formatExecApprovalContinuationOutput([{ label: "stdout", value: under }])).toBe(under);
  });

  it("keeps head and tail within the cap and marks the cut once", () => {
    const value = `${"a".repeat(30_000)}\n${"b".repeat(30_000)}`;
    const formatted = formatExecApprovalContinuationOutput([{ label: "stdout", value }]);
    expect(formatted.length).toBeLessThanOrEqual(MAX_UTF16_UNITS);
    expect(formatted.split(MARKER)).toHaveLength(2);
    expect(formatted.startsWith("a")).toBe(true);
    expect(formatted.endsWith("b")).toBe(true);
  });

  it("does not claim an exact omission count", () => {
    const formatted = formatExecApprovalContinuationOutput([
      { label: "stdout", value: "z".repeat(50_000) },
    ]);
    // Source-side capture can already have dropped output without a marker, so the
    // continuation must not imply this cut is the whole story.
    expect(formatted).toContain("may have been dropped when it was captured");
    expect(formatted).not.toMatch(/\d+\s+(characters|units|chars)\s+omitted/);
  });

  it("never splits a surrogate pair at either cut", () => {
    const value = "😀".repeat(20_000);
    const formatted = formatExecApprovalContinuationOutput([{ label: "stdout", value }]);
    expect(formatted.length).toBeLessThanOrEqual(MAX_UTF16_UNITS);
    for (const part of formatted.split(MARKER)) {
      expect(part).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(part).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });

  it("never emits a partial generated stream header", () => {
    // Sized so both the head cut and the tail cut land inside the "[stderr]" header.
    const headBudget = Math.floor((MAX_UTF16_UNITS - MARKER.length - 2) * 0.75);
    const formatted = formatExecApprovalContinuationOutput([
      { label: "stdout", value: "s".repeat(headBudget - 3) },
      { label: "stderr", value: "e".repeat(MAX_UTF16_UNITS) },
    ]);
    expect(formatted.length).toBeLessThanOrEqual(MAX_UTF16_UNITS);
    for (const partial of ["[st\n", "[std\n", "[stde", "[stder", "[stderr\n"]) {
      expect(formatted).not.toContain(partial);
    }
  });

  it("keeps a source-side truncation marker visible when it fits", () => {
    const value = "head output\n... (truncated)\ntail output";
    expect(formatExecApprovalContinuationOutput([{ label: "stdout", value }])).toContain(
      "... (truncated)",
    );
  });
});
