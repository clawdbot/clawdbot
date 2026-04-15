import { describe, expect, it } from "vitest";
import { matrixApprovalAuth } from "./approval-auth.js";

describe("matrixApprovalAuth", () => {
  it("normalizes Matrix user ids before authorizing", () => {
    const cfg = {
      channels: {
        matrix: {
          dm: { allowFrom: ["matrix:@Owner:Example.org"] },
        },
      },
    };

    expect(
      matrixApprovalAuth.authorizeActorAction({
        cfg,
        senderId: "@owner:example.org",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ authorized: true });
  });
});
