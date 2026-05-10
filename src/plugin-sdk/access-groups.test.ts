import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  expandAllowFromWithAccessGroups,
  resolveAccessGroupAllowFromState,
} from "./access-groups.js";

describe("access group allowlists", () => {
  it("reports static, missing, unsupported, failed, and compatibility expansion states", async () => {
    const cfg = {
      accessGroups: {
        admins: { type: "message.senders", members: { "*": ["global"], test: ["local"] } },
        audience: { type: "discord.channelAudience", guildId: "guild-1", channelId: "channel-1" },
      },
    } as OpenClawConfig;

    await expect(
      resolveAccessGroupAllowFromState({
        accessGroups: cfg.accessGroups,
        allowFrom: ["accessGroup:admins", "accessGroup:missing", "accessGroup:audience"],
        channel: "test",
        accountId: "default",
        senderId: "local",
        isSenderAllowed: (senderId, allowFrom) => allowFrom.includes(senderId),
      }),
    ).resolves.toMatchObject({
      referenced: ["admins", "missing", "audience"],
      matched: ["admins"],
      missing: ["missing"],
      unsupported: ["audience"],
      failed: [],
      matchedAllowFromEntries: ["accessGroup:admins"],
      hasReferences: true,
      hasMatch: true,
    });

    await expect(
      resolveAccessGroupAllowFromState({
        accessGroups: cfg.accessGroups,
        allowFrom: ["accessGroup:audience"],
        channel: "discord",
        accountId: "default",
        senderId: "discord:123",
        resolveMembership: async () => {
          throw new Error("discord lookup failed");
        },
      }),
    ).resolves.toMatchObject({ referenced: ["audience"], failed: ["audience"], hasMatch: false });

    await expect(
      expandAllowFromWithAccessGroups({
        cfg,
        allowFrom: ["accessGroup:admins"],
        channel: "test",
        accountId: "default",
        senderId: "local",
        isSenderAllowed: (senderId, allowFrom) => allowFrom.includes(senderId),
      }),
    ).resolves.toEqual(["accessGroup:admins", "local"]);
  });
});
