import { describe, expect, it } from "vitest";
import { isApprovalPromptToolResult } from "./embedded-agent-subscribe.handlers.tools.results.js";

describe("isApprovalPromptToolResult", () => {
  it("recognizes an approval-pending result", () => {
    expect(isApprovalPromptToolResult({ details: { status: "approval-pending" } })).toBe(true);
  });

  it("recognizes an approval-unavailable result", () => {
    expect(isApprovalPromptToolResult({ details: { status: "approval-unavailable" } })).toBe(true);
  });

  it("rejects an unrelated status", () => {
    expect(isApprovalPromptToolResult({ details: { status: "started" } })).toBe(false);
  });

  it("rejects a result with no details", () => {
    expect(isApprovalPromptToolResult({ text: "ok" })).toBe(false);
  });

  it("rejects a non-object result", () => {
    expect(isApprovalPromptToolResult("ok")).toBe(false);
  });
});
