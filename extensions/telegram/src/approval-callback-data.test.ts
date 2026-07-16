import { describe, expect, it } from "vitest";
import {
  fitsTelegramCallbackData,
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
});
