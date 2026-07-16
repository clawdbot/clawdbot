import { describe, expect, it } from "vitest";
import { signalApprovalAuth } from "./approval-auth.js";

describe("signalApprovalAuth", () => {
  it("authorizes phone and uuid approvers with stable sender ids", () => {
    const cfg = {
      channels: {
        signal: {
          allowFrom: ["uuid:ABCDEF12-3456-7890-ABCD-EF1234567890", "+1 (555) 123-0000"],
        },
      },
    };

    expect(
      signalApprovalAuth.authorizeActorAction({
        cfg,
        senderId: "uuid:abcdef12-3456-7890-abcd-ef1234567890",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });

    expect(
      signalApprovalAuth.authorizeActorAction({
        cfg,
        senderId: "+15551230000",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });
});
