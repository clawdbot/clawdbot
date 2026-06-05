import { beforeEach, describe, expect, it } from "vitest";
import {
  clearGoogleChatApprovalCardBindingsForTest,
  registerGoogleChatManualApprovalFollowupSuppression,
  registerGoogleChatApprovalCardBinding,
  shouldSuppressGoogleChatManualExecApprovalFollowupPayload,
  shouldSuppressGoogleChatManualExecApprovalFollowupText,
} from "./approval-card-actions.js";

const approvalId = "12345678-1234-1234-1234-123456789012";
type TestExecApprovalDecision = "allow-once" | "allow-always" | "deny";
let tokenCounter = 0;

function registerExecApprovalCard(overrides?: {
  approvalId?: string;
  expiresAtMs?: number;
  allowedDecisions?: readonly TestExecApprovalDecision[];
}): void {
  registerGoogleChatApprovalCardBinding({
    token: `token-${tokenCounter++}`,
    accountId: "default",
    approvalId: overrides?.approvalId ?? approvalId,
    approvalKind: "exec",
    decision: "allow-once",
    allowedDecisions: overrides?.allowedDecisions ?? ["allow-once", "deny"],
    spaceName: "spaces/AAA",
    messageName: "spaces/AAA/messages/msg-1",
    expiresAtMs: overrides?.expiresAtMs ?? Date.now() + 60_000,
  });
}

describe("Google Chat approval card action registry", () => {
  beforeEach(() => {
    clearGoogleChatApprovalCardBindingsForTest();
    tokenCounter = 0;
  });

  it("suppresses manual exec approval follow-up text for an active native card", () => {
    registerExecApprovalCard();

    expect(
      shouldSuppressGoogleChatManualExecApprovalFollowupText(
        `I need approval.\nReply with:\n/approve ${approvalId.slice(0, 8)} allow-once`,
      ),
    ).toBe(true);
    expect(
      shouldSuppressGoogleChatManualExecApprovalFollowupText(
        `Run this if needed: \`/approve ${approvalId} deny\``,
      ),
    ).toBe(true);
  });

  it("suppresses manual exec approval follow-up text after native delivery before token binding", () => {
    registerGoogleChatManualApprovalFollowupSuppression({
      approvalId,
      approvalKind: "exec",
      allowedDecisions: ["allow-once", "deny"],
      expiresAtMs: Date.now() + 60_000,
    });

    expect(
      shouldSuppressGoogleChatManualExecApprovalFollowupText(
        `Please reply with:\n/approve ${approvalId.slice(0, 8)} allow-once`,
      ),
    ).toBe(true);
  });

  it("keeps unrelated, expired, and non-sendable approval text visible", () => {
    registerExecApprovalCard({ expiresAtMs: Date.now() - 1 });
    expect(
      shouldSuppressGoogleChatManualExecApprovalFollowupText(
        `/approve ${approvalId.slice(0, 8)} allow-once`,
      ),
    ).toBe(false);

    clearGoogleChatApprovalCardBindingsForTest();
    registerExecApprovalCard();
    expect(
      shouldSuppressGoogleChatManualExecApprovalFollowupText("/approve deadbeef allow-once"),
    ).toBe(false);
    expect(
      shouldSuppressGoogleChatManualExecApprovalFollowupText(`/approve ${approvalId} nope`),
    ).toBe(false);
  });

  it("suppresses only text-only manual approval follow-up payloads", () => {
    registerExecApprovalCard();

    expect(
      shouldSuppressGoogleChatManualExecApprovalFollowupPayload({
        text: `/approve ${approvalId.slice(0, 8)} allow-once`,
      }),
    ).toBe(true);
    expect(
      shouldSuppressGoogleChatManualExecApprovalFollowupPayload({
        text: `/approve ${approvalId.slice(0, 8)} allow-once`,
        mediaUrl: "https://example.test/image.png",
      }),
    ).toBe(false);
    expect(
      shouldSuppressGoogleChatManualExecApprovalFollowupPayload({
        text: `/approve ${approvalId.slice(0, 8)} allow-once`,
        channelData: { execApproval: { approvalId } },
      }),
    ).toBe(true);
    expect(
      shouldSuppressGoogleChatManualExecApprovalFollowupPayload({
        text: `/approve ${approvalId.slice(0, 8)} allow-once`,
        presentation: { blocks: [] },
      }),
    ).toBe(false);
  });
});
