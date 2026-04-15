import { describe, expect, it } from "vitest";
import { synologyChatApprovalAuth } from "./approval-auth.js";

describe("synologyChatApprovalAuth", () => {
  it("authorizes numeric Synology Chat user ids", () => {
    const cfg = { channels: { "synology-chat": { allowedUserIds: ["123"] } } };

    expect(
      synologyChatApprovalAuth.authorizeActorAction({
        cfg,
        senderId: "123",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ authorized: true });
  });
});
