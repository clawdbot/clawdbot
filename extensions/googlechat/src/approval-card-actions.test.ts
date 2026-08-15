import { afterEach, describe, expect, it } from "vitest";
import {
  getGoogleChatApprovalCardBinding,
  registerGoogleChatManualApprovalFollowupSuppression as registerGoogleChatManualApprovalFollowupSuppressionRaw,
  registerGoogleChatApprovalCardBinding as registerGoogleChatApprovalCardBindingRaw,
  shouldSuppressGoogleChatManualExecApprovalFollowupPayload,
  shouldSuppressGoogleChatManualExecApprovalFollowupText,
  unregisterGoogleChatApprovalCardBindings,
  unregisterGoogleChatManualApprovalFollowupSuppression,
} from "./approval-card-actions.js";

const approvalId = "12345678-1234-1234-1234-123456789012";
type TestExecApprovalDecision = "allow-once" | "allow-always" | "deny";
let tokenCounter = 0;
const registeredTokens = new Set<string>();
const registeredApprovalIds = new Set<string>();

function registerGoogleChatApprovalCardBinding(
  binding: Parameters<typeof registerGoogleChatApprovalCardBindingRaw>[0],
): boolean {
  registeredTokens.add(binding.token);
  registeredApprovalIds.add(binding.approvalId);
  return registerGoogleChatApprovalCardBindingRaw(binding);
}

function registerGoogleChatManualApprovalFollowupSuppression(
  suppression: Parameters<typeof registerGoogleChatManualApprovalFollowupSuppressionRaw>[0],
): boolean {
  registeredApprovalIds.add(suppression.approvalId);
  return registerGoogleChatManualApprovalFollowupSuppressionRaw(suppression);
}

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
  afterEach(() => {
    unregisterGoogleChatApprovalCardBindings([...registeredTokens]);
    for (const registeredApprovalId of registeredApprovalIds) {
      unregisterGoogleChatManualApprovalFollowupSuppression(registeredApprovalId);
    }
    registeredTokens.clear();
    registeredApprovalIds.clear();
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

  it("evicts oldest approval card bindings once the cache exceeds its cap", () => {
    const firstToken = "token-first";
    registerGoogleChatApprovalCardBinding({
      token: firstToken,
      accountId: "default",
      approvalId: "approval-first",
      approvalKind: "exec",
      decision: "allow-once",
      allowedDecisions: ["allow-once", "deny"],
      spaceName: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      expiresAtMs: Date.now() + 60_000,
    });
    expect(getGoogleChatApprovalCardBinding(firstToken)).not.toBeNull();

    for (let i = 1; i <= 1024; i += 1) {
      registerGoogleChatApprovalCardBinding({
        token: `token-fill-${i}`,
        accountId: "default",
        approvalId: `approval-fill-${i}`,
        approvalKind: "exec",
        decision: "allow-once",
        allowedDecisions: ["allow-once", "deny"],
        spaceName: "spaces/AAA",
        messageName: `spaces/AAA/messages/msg-${i}`,
        expiresAtMs: Date.now() + 60_000,
      });
    }

    expect(getGoogleChatApprovalCardBinding(firstToken)).toBeNull();
    expect(getGoogleChatApprovalCardBinding("token-fill-1024")).not.toBeNull();
  });

  it("evicts oldest manual approval follow-up suppressions once the cache exceeds its cap", () => {
    const firstApprovalId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    registerGoogleChatManualApprovalFollowupSuppression({
      approvalId: firstApprovalId,
      approvalKind: "exec",
      allowedDecisions: ["allow-once", "deny"],
      expiresAtMs: Date.now() + 60_000,
    });
    expect(
      shouldSuppressGoogleChatManualExecApprovalFollowupText(
        `/approve ${firstApprovalId.slice(0, 8)} allow-once`,
      ),
    ).toBe(true);

    for (let i = 1; i <= 1024; i += 1) {
      registerGoogleChatManualApprovalFollowupSuppression({
        approvalId: `${i.toString().padStart(8, "0")}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`,
        approvalKind: "exec",
        allowedDecisions: ["allow-once", "deny"],
        expiresAtMs: Date.now() + 60_000,
      });
    }

    expect(
      shouldSuppressGoogleChatManualExecApprovalFollowupText(
        `/approve ${firstApprovalId.slice(0, 8)} allow-once`,
      ),
    ).toBe(false);
    expect(
      shouldSuppressGoogleChatManualExecApprovalFollowupText(
        `/approve ${"1024".padStart(8, "0")} allow-once`,
      ),
    ).toBe(true);
  });
});
