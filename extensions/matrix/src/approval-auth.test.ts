// Matrix tests cover approval auth plugin behavior.
import { describe, expect, it } from "vitest";
import { matrixApprovalAuth } from "./approval-auth.js";

describe("matrixApprovalAuth", () => {
  it("authorizes exact Matrix user ids without case folding", () => {
    const cfg = {
      channels: {
        matrix: {
          dm: { allowFrom: ["matrix:@\u212A:example.org"] },
        },
      },
    };

    expect(
      matrixApprovalAuth.authorizeActorAction({
        cfg,
        senderId: "@\u212A:example.org",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ authorized: true });
    expect(
      matrixApprovalAuth.authorizeActorAction({
        cfg,
        senderId: "@k:example.org",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({
      authorized: false,
      reason: "\u274c You are not authorized to approve plugin requests on Matrix.",
    });
  });
});
