// Slack tests cover the transport-private approval callback envelope.
import { buildApprovalResolutionRef } from "openclaw/plugin-sdk/approval-reference-runtime";
import { describe, expect, it } from "vitest";
import {
  decodeSlackApprovalAction,
  encodeSlackApprovalAction,
  encodeSlackEnterpriseApprovalAction,
  verifySlackEnterpriseApprovalAction,
} from "./approval-actions.js";
import { SLACK_BUTTON_VALUE_MAX } from "./presentation.js";

const ENTERPRISE_PREFIX = "openclaw:approval:v2:";

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

  it("round-trips signed Enterprise approval facts for the canonical team", () => {
    const action = {
      type: "approval" as const,
      approvalId: "req/50%/😀",
      approvalKind: "exec" as const,
      decision: "allow-once" as const,
    };
    const encoded = encodeSlackEnterpriseApprovalAction({
      action,
      teamId: "t123",
      signingKey: "signing-key",
    });

    const envelope = JSON.parse(encoded.slice(ENTERPRISE_PREFIX.length)) as Record<string, unknown>;
    expect(Object.keys(envelope)).toEqual([
      "approvalId",
      "approvalKind",
      "decision",
      "teamId",
      "signature",
    ]);
    expect(envelope).toEqual({
      approvalId: action.approvalId,
      approvalKind: action.approvalKind,
      decision: action.decision,
      teamId: "T123",
      signature: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
    expect(decodeSlackApprovalAction(encoded)).toBeNull();
    expect(
      verifySlackEnterpriseApprovalAction({
        value: encoded,
        teamId: "T123",
        signingKey: "signing-key",
      }),
    ).toEqual(action);
  });

  it.each([
    { name: "wrong team", teamId: "T999", signingKey: "signing-key" },
    { name: "wrong key", teamId: "T123", signingKey: "other-key" },
  ])("rejects a signed Enterprise action with the $name", ({ teamId, signingKey }) => {
    const value = encodeSlackEnterpriseApprovalAction({
      action: {
        type: "approval",
        approvalId: "req-1",
        approvalKind: "exec",
        decision: "deny",
      },
      teamId: "T123",
      signingKey: "signing-key",
    });

    expect(verifySlackEnterpriseApprovalAction({ value, teamId, signingKey })).toBeNull();
  });

  it("rejects tampering with signed Enterprise action fields", () => {
    const value = encodeSlackEnterpriseApprovalAction({
      action: {
        type: "approval",
        approvalId: "req-1",
        approvalKind: "exec",
        decision: "allow-once",
      },
      teamId: "T123",
      signingKey: "signing-key",
    });
    const envelope = JSON.parse(value.slice(ENTERPRISE_PREFIX.length)) as Record<string, unknown>;
    const tampered = `${ENTERPRISE_PREFIX}${JSON.stringify({
      ...envelope,
      decision: "deny",
    })}`;

    expect(
      verifySlackEnterpriseApprovalAction({
        value: tampered,
        teamId: "T123",
        signingKey: "signing-key",
      }),
    ).toBeNull();
  });

  it.each([
    "openclaw:approval:v2:",
    "openclaw:approval:v2:{}",
    'openclaw:approval:v2:{"approvalId":"req-1","approvalKind":"exec","decision":"allow-once","teamId":"T123"}',
    'openclaw:approval:v2:{"approvalId":"req-1","approvalKind":"invalid","decision":"allow-once","teamId":"T123","signature":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}',
    'openclaw:approval:v2:{"approvalId":"req-1","approvalKind":"exec","decision":"invalid","teamId":"T123","signature":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}',
    'openclaw:approval:v2:{"approvalId":"req-1","approvalKind":"exec","decision":"allow-once","teamId":"t123","signature":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}',
    'openclaw:approval:v2:{"approvalKind":"exec","approvalId":"req-1","decision":"allow-once","teamId":"T123","signature":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}',
    'openclaw:approval:v2:{"approvalId":"req-1","approvalKind":"exec","decision":"allow-once","teamId":"T123","signature":"short"}',
    'openclaw:approval:v2:{"approvalId":"req-1","approvalKind":"exec","decision":"allow-once","teamId":"T123","signature":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","extra":true}',
  ])("rejects malformed signed Enterprise input %#", (value) => {
    expect(
      verifySlackEnterpriseApprovalAction({
        value,
        teamId: "T123",
        signingKey: "signing-key",
      }),
    ).toBeNull();
  });

  it("uses the durable transport reference when a signed Enterprise id exceeds its limit", () => {
    const approvalId = `approval/${"\u{1F4F1}".repeat(SLACK_BUTTON_VALUE_MAX)}`;
    const action = {
      type: "approval" as const,
      approvalId,
      approvalKind: "exec" as const,
      decision: "deny" as const,
    };
    const encoded = encodeSlackEnterpriseApprovalAction({
      action,
      teamId: "T123",
      signingKey: "signing-key",
    });

    expect(encoded.length).toBeLessThanOrEqual(SLACK_BUTTON_VALUE_MAX);
    expect(
      verifySlackEnterpriseApprovalAction({
        value: encoded,
        teamId: "T123",
        signingKey: "signing-key",
      }),
    ).toEqual({
      ...action,
      approvalId: buildApprovalResolutionRef({ approvalId, approvalKind: "exec" }),
    });
  });
});
