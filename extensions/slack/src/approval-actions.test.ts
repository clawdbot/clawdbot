// Slack tests cover the transport-private approval callback envelope.
import { buildApprovalResolutionRef } from "openclaw/plugin-sdk/approval-reference-runtime";
import { describe, expect, it } from "vitest";
import { decodeSlackApprovalAction, encodeSlackApprovalAction } from "./approval-actions.js";
import { SLACK_BUTTON_VALUE_MAX } from "./presentation.js";

describe("Slack approval actions", () => {
  it("round-trips explicit approval facts without slash-command inference", () => {
    const action = {
      type: "approval" as const,
      approvalId: "plugin:req/50%/😀",
      approvalKind: "plugin" as const,
      decision: "allow-always" as const,
    };

    const encoded = encodeSlackApprovalAction(action);

    expect(encoded).not.toContain("/approve ");
    expect(decodeSlackApprovalAction(encoded)).toEqual(action);
  });

  it("uses the durable transport reference when a Unicode id exceeds Slack's value limit", () => {
    const approvalId = `approval/${"\u{1F4F1}".repeat(SLACK_BUTTON_VALUE_MAX)}`;
    const action = {
      type: "approval" as const,
      approvalId,
      approvalKind: "exec" as const,
      decision: "deny" as const,
    };

    const encoded = encodeSlackApprovalAction(action);

    expect(encoded.length).toBeLessThanOrEqual(SLACK_BUTTON_VALUE_MAX);
    expect(decodeSlackApprovalAction(encoded)).toEqual({
      ...action,
      approvalId: buildApprovalResolutionRef({ approvalId, approvalKind: "exec" }),
    });
  });

  it.each([
    "callback",
    "openclaw:approval:v1:not-json",
    'openclaw:approval:v1:{"approvalId":"req-1","decision":"allow-once"}',
    'openclaw:approval:v1:{"approvalId":"req-1","approvalKind":"exec","decision":"accept"}',
    'openclaw:approval:v1:{"approvalId":"req-1","approvalKind":"exec","decision":"deny","extra":true}',
  ])("rejects malformed or non-approval input %#", (value) => {
    expect(decodeSlackApprovalAction(value)).toBeNull();
  });
});
