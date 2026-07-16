import { describe, expect, it } from "vitest";
import { nextcloudTalkApprovalAuth } from "./approval-auth.js";

describe("nextcloudTalkApprovalAuth", () => {
  it("matches Nextcloud Talk actor ids case-insensitively", () => {
    const cfg = { channels: { "nextcloud-talk": { allowFrom: ["Owner"] } } };

    expect(
      nextcloudTalkApprovalAuth.authorizeActorAction({
        cfg,
        senderId: "owner",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });
});
