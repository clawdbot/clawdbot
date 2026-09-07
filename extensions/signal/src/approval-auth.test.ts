// Signal tests cover approval auth plugin behavior.
import { describe, expect, it } from "vitest";
import { getSignalApprovalApprovers, signalApprovalAuth } from "./approval-auth.js";

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

  it("authorizes defaultTo aliases with the canonical Signal target", () => {
    const cfg = {
      channels: {
        signal: {
          allowFrom: [],
          defaultTo: "signal:me",
          aliases: {
            me: "+15551230000",
          },
        },
      },
    };

    expect(
      signalApprovalAuth.authorizeActorAction({
        cfg,
        senderId: "+15551230000",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });

  it("ignores recursive defaultTo aliases when resolving approvers", () => {
    const cfg = {
      channels: {
        signal: {
          allowFrom: [],
          defaultTo: "signal:home",
          aliases: {
            home: "signal:me",
            me: "home",
          },
        },
      },
    };

    expect(getSignalApprovalApprovers({ cfg })).toEqual([]);
  });
});
