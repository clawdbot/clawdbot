import { describe, expect, it } from "vitest";
import {
  createResolvedApproverActionAuthAdapter,
  isImplicitSameChatApprovalAuthorization,
} from "./approval-auth-helpers.js";

describe("createResolvedApproverActionAuthAdapter", () => {
  it.each([
    {
      name: "falls back to generic same-chat auth when no approvers resolve",
      channelLabel: "Slack",
      resolveApprovers: () => [],
      normalizeSenderId: undefined,
      cases: [
        {
          senderId: "U_OWNER",
          approvalKind: "exec" as const,
          expected: { authorized: true },
        },
      ],
    },
    {
      name: "allows matching normalized approvers and rejects others",
      channelLabel: "Signal",
      resolveApprovers: () => ["uuid:owner"],
      normalizeSenderId: (value: string) => value.trim().toLowerCase(),
      cases: [
        {
          senderId: " UUID:OWNER ",
          approvalKind: "plugin" as const,
          expected: { authorized: true },
        },
        {
          senderId: "uuid:attacker",
          approvalKind: "plugin" as const,
          expected: {
            authorized: false,
            reason: "❌ You are not authorized to approve plugin requests on Signal.",
          },
        },
      ],
    },
  ])("$name", ({ channelLabel, resolveApprovers, normalizeSenderId, cases }) => {
    const auth = createResolvedApproverActionAuthAdapter({
      channelLabel,
      resolveApprovers,
      normalizeSenderId,
    });

    for (const testCase of cases) {
      expect(
        auth.authorizeActorAction({
          cfg: {},
          senderId: testCase.senderId,
          action: "approve",
          approvalKind: testCase.approvalKind,
        }),
      ).toEqual(testCase.expected);
    }
  });

  it("marks empty-approver fallback auth as implicit", () => {
    const auth = createResolvedApproverActionAuthAdapter({
      channelLabel: "Signal",
      resolveApprovers: () => [],
    });
    const result = auth.authorizeActorAction({
      cfg: {},
      senderId: "uuid:attacker",
      action: "approve",
      approvalKind: "exec",
    });

    expect(result).toEqual({ authorized: true });
    expect(isImplicitSameChatApprovalAuthorization(result)).toBe(true);
  });

  it("does not mark configured-approver auth as implicit", () => {
    const auth = createResolvedApproverActionAuthAdapter({
      channelLabel: "Signal",
      resolveApprovers: () => ["uuid:owner"],
    });
    const result = auth.authorizeActorAction({
      cfg: {},
      senderId: "uuid:owner",
      action: "approve",
      approvalKind: "exec",
    });

    expect(result).toEqual({ authorized: true });
    expect(isImplicitSameChatApprovalAuthorization(result)).toBe(false);
  });
});
