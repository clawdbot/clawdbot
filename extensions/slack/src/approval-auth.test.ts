import { describe, expect, it } from "vitest";
import { slackApprovalAuth } from "./approval-auth.js";

describe("slackApprovalAuth", () => {
  it("authorizes general Slack approvers from allowFrom and defaultTo", () => {
    const cfg = {
      channels: {
        slack: {
          allowFrom: ["slack:U123OWNER"],
          dm: { allowFrom: ["<@U234DM>"] },
          defaultTo: "user:U345DEFAULT",
          execApprovals: { enabled: true, approvers: ["user:U999EXEC"] },
        },
      },
    };

    expect(
      slackApprovalAuth.authorizeActorAction({
        cfg,
        senderId: "U123OWNER",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });

    expect(
      slackApprovalAuth.authorizeActorAction({
        cfg,
        senderId: "U345DEFAULT",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ authorized: true });

    expect(
      slackApprovalAuth.authorizeActorAction({
        cfg,
        senderId: "U999EXEC",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on Slack.",
    });

    expect(
      slackApprovalAuth.authorizeActorAction({
        cfg,
        senderId: "U999ATTACKER",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve exec requests on Slack.",
    });
  });
});
