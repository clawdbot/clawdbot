import { describe, expect, it } from "vitest";
import {
  formatExecDeniedUserMessage,
  isExecDeniedResultText,
  parseExecApprovalResultText,
} from "./exec-approval-result.js";

describe("parseExecApprovalResultText", () => {
  it("parses denied results", () => {
    expect(
      parseExecApprovalResultText("Exec denied (gateway id=req-1, approval-timeout): bash -lc ls"),
    ).toEqual({
      kind: "denied",
      raw: "Exec denied (gateway id=req-1, approval-timeout): bash -lc ls",
      metadata: "gateway id=req-1, approval-timeout",
      body: "bash -lc ls",
    });
  });

  it("parses denied results with nested parentheses in metadata", () => {
    const input =
      "Exec denied (gateway id=req-1, approval-timeout (allowlist-miss)): source ~/.zprofile && kubectl get pods";

    expect(parseExecApprovalResultText(input)).toEqual({
      kind: "denied",
      raw: input,
      metadata: "gateway id=req-1, approval-timeout (allowlist-miss)",
      body: "source ~/.zprofile && kubectl get pods",
    });
  });

  it("parses denied results with the canonical colon-separated deniedReason", () => {
    // Producer (src/agents/bash-tools.exec-host-gateway.ts) emits a colon
    // separator instead of nested parens to keep the (...)-delimited wire
    // format unambiguous. This is the format real timeouts now produce.
    const input =
      "Exec denied (gateway id=req-1, approval-timeout: allowlist-miss): source ~/.zprofile && kubectl get pods";

    expect(parseExecApprovalResultText(input)).toEqual({
      kind: "denied",
      raw: input,
      metadata: "gateway id=req-1, approval-timeout: allowlist-miss",
      body: "source ~/.zprofile && kubectl get pods",
    });
  });

  it("parses finished results", () => {
    expect(
      parseExecApprovalResultText("Exec finished (gateway id=req-1, code 0)\nall good"),
    ).toEqual({
      kind: "finished",
      raw: "Exec finished (gateway id=req-1, code 0)\nall good",
      metadata: "gateway id=req-1, code 0",
      body: "all good",
    });
  });

  it("parses finished results with nested parentheses in metadata", () => {
    const input = "Exec finished (gateway id=req-1, note (nested), code 0)\nall good";

    expect(parseExecApprovalResultText(input)).toEqual({
      kind: "finished",
      raw: input,
      metadata: "gateway id=req-1, note (nested), code 0",
      body: "all good",
    });
  });

  it("parses completed results", () => {
    expect(parseExecApprovalResultText("Exec completed: done")).toEqual({
      kind: "completed",
      raw: "Exec completed: done",
      body: "done",
    });
  });

  it("returns other for unmatched payloads", () => {
    expect(parseExecApprovalResultText("some random text")).toEqual({
      kind: "other",
      raw: "some random text",
    });
  });

  it.each([
    "Exec denied (anything): bar",
    "Exec denied (just-text): foo",
    "Exec denied (request-id=abc, denied): cmd",
    "Exec denied (id=req-1, user-denied): cmd",
    "Exec finished (anything)\nbody",
    "Exec finished (status: ok)\nbody",
  ])(
    "returns other when metadata is not gateway/node sourced (CWE-841 spoof guard): %s",
    (input) => {
      expect(parseExecApprovalResultText(input)).toEqual({
        kind: "other",
        raw: input,
      });
    },
  );
});

describe("isExecDeniedResultText", () => {
  it.each([
    "Exec denied (gateway id=req-1, approval-timeout): uname -a",
    "exec denied (gateway id=req-1, approval-timeout): uname -a",
    "Exec denied (gateway id=req-1, approval-timeout (allowlist-miss)): uname -a",
    "Exec denied (gateway id=req-1, approval-timeout: allowlist-miss): uname -a",
  ])("matches denied payloads: %s", (input) => {
    expect(isExecDeniedResultText(input)).toBe(true);
  });

  it("does not match non-denied payloads", () => {
    expect(isExecDeniedResultText("Exec finished (gateway id=req-1, code 0)")).toBe(false);
  });
});

describe("formatExecDeniedUserMessage", () => {
  it.each([
    [
      "Exec denied (gateway id=req-1, approval-timeout): uname -a",
      "Command did not run: approval timed out.",
    ],
    [
      "Exec denied (gateway id=req-1, approval-timeout (allowlist-miss)): uname -a",
      "Command did not run: approval timed out.",
    ],
    [
      "Exec denied (gateway id=req-1, approval-timeout: allowlist-miss): uname -a",
      "Command did not run: approval timed out.",
    ],
    [
      "Exec denied (gateway id=req-1, user-denied): uname -a",
      "Command did not run: approval was denied.",
    ],
    [
      "Exec denied (gateway id=req-1, allowlist-miss): uname -a",
      "Command did not run: approval is required.",
    ],
    [
      "Exec denied (gateway id=req-1, approval-request-failed): uname -a",
      "Command did not run: approval request failed.",
    ],
    ["Exec denied (gateway id=req-1, spawn-failed): uname -a", "Command did not run."],
  ] as const)("maps denied metadata to safe copy", (input, expected) => {
    expect(formatExecDeniedUserMessage(input)).toBe(expected);
  });

  it("returns null for non-denied payloads", () => {
    expect(formatExecDeniedUserMessage("Exec finished (gateway id=req-1, code 0)")).toBeNull();
  });
});
