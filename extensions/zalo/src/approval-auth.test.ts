import { describe, expect, it } from "vitest";
import { zaloApprovalAuth } from "./approval-auth.js";

describe("zaloApprovalAuth", () => {
  it("authorizes numeric Zalo user ids", () => {
    const cfg = { channels: { zalo: { allowFrom: ["zl:123"] } } };

    expect(
      zaloApprovalAuth.authorizeActorAction({
        cfg,
        senderId: "123",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });
});
