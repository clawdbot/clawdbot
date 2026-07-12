// Telegram tests cover approval callback data plugin behavior.
import { buildApprovalResolutionRef } from "openclaw/plugin-sdk/approval-reference-runtime";
import { describe, expect, it } from "vitest";
import {
  buildTelegramApprovalCallbackData,
  fitsTelegramCallbackData,
  parseTelegramApprovalCallbackData,
  rewriteTelegramApprovalDecisionAlias,
  sanitizeTelegramCallbackData,
} from "./approval-callback-data.js";

describe("approval callback data", () => {
  it("enforces Telegram callback byte boundaries", () => {
    expect(fitsTelegramCallbackData("x".repeat(63))).toBe(true);
    expect(fitsTelegramCallbackData("x".repeat(64))).toBe(true);
    expect(fitsTelegramCallbackData("x".repeat(65))).toBe(false);
  });

  it("rewrites /approve allow-always callbacks to always", () => {
    const approvalId = `plugin:${"a".repeat(36)}`;
    expect(rewriteTelegramApprovalDecisionAlias(`/approve ${approvalId} allow-always`)).toBe(
      `/approve ${approvalId} always`,
    );
  });

  it("keeps rewritten allow-always callbacks when canonical form would overflow", () => {
    const approvalId = `plugin:${"a".repeat(36)}`;
    expect(sanitizeTelegramCallbackData(`/approve ${approvalId} allow-always`)).toBe(
      `/approve ${approvalId} always`,
    );
  });

  it("keeps 64-byte callbacks and drops 65-byte callbacks through sanitize", () => {
    expect(sanitizeTelegramCallbackData("x".repeat(64))).toBe("x".repeat(64));
    expect(sanitizeTelegramCallbackData("x".repeat(65))).toBeUndefined();
  });

  it.each([
    ["exec", "allow-once", "tga1:e:o:approval:with:delimiters"],
    ["exec", "allow-always", "tga1:e:a:approval:with:delimiters"],
    ["plugin", "deny", "tga1:p:d:approval:with:delimiters"],
  ] as const)("round-trips explicit %s %s actions", (approvalKind, decision, callbackData) => {
    const action = {
      type: "approval" as const,
      approvalId: "approval:with:delimiters",
      approvalKind,
      decision,
    };

    expect(buildTelegramApprovalCallbackData(action)).toBe(callbackData);
    expect(parseTelegramApprovalCallbackData(callbackData)).toEqual(action);
  });

  it("does not infer approval kind from id spelling", () => {
    const callbackData = buildTelegramApprovalCallbackData({
      type: "approval",
      approvalId: "plugin:still-an-exec-id",
      approvalKind: "exec",
      decision: "deny",
    });

    expect(parseTelegramApprovalCallbackData(callbackData)).toEqual({
      type: "approval",
      approvalId: "plugin:still-an-exec-id",
      approvalKind: "exec",
      decision: "deny",
    });
  });

  it("preserves unicode approval ids exactly", () => {
    const action = {
      type: "approval" as const,
      approvalId: "approval/🦀/%/:",
      approvalKind: "plugin" as const,
      decision: "allow-once" as const,
    };
    const callbackData = buildTelegramApprovalCallbackData(action);

    expect(parseTelegramApprovalCallbackData(callbackData)).toEqual(action);
  });

  it("uses the canonical id at the Unicode byte boundary and compacts beyond it", () => {
    const exactId = "\u{1F4F1}".repeat(13);
    const compactedId = "\u{1F4F1}".repeat(14);
    expect(
      buildTelegramApprovalCallbackData({
        type: "approval",
        approvalId: exactId,
        approvalKind: "exec",
        decision: "deny",
      }),
    ).toBe(`tga1:e:d:${exactId}`);

    const compacted = buildTelegramApprovalCallbackData({
      type: "approval",
      approvalId: compactedId,
      approvalKind: "exec",
      decision: "deny",
    });
    expect(compacted).toHaveLength(52);
    expect(parseTelegramApprovalCallbackData(compacted)).toEqual({
      type: "approval",
      approvalId: buildApprovalResolutionRef({
        approvalId: compactedId,
        approvalKind: "exec",
      }),
      approvalKind: "exec",
      decision: "deny",
    });
  });

  it.each([
    "tga2:e:o:approval-1",
    "tga1:x:o:approval-1",
    "tga1:e:x:approval-1",
    "tga1:e:o:",
    "tga1:e:o",
    `tga1:e:o:${"x".repeat(56)}`,
  ])("rejects malformed private approval callback data: %s", (callbackData) => {
    expect(parseTelegramApprovalCallbackData(callbackData)).toBeNull();
  });
});
