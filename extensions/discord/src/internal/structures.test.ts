import { ChannelType } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import { channelFactory, type StructureClient } from "./structures.js";

const client: StructureClient = {
  rest: {} as StructureClient["rest"],
  async fetchUser() {
    throw new Error("not used");
  },
};

describe("channelFactory", () => {
  it("maps Discord API thread owner and parent fields to camelCase aliases", () => {
    const channel = channelFactory(client, {
      id: "thread-1",
      type: ChannelType.PublicThread,
      guild_id: "guild-1",
      name: "support",
      owner_id: "owner-1",
      parent_id: "parent-1",
      last_message_id: null,
      rate_limit_per_user: 0,
      thread_metadata: {
        archived: false,
        auto_archive_duration: 60,
        locked: false,
        archive_timestamp: new Date(0).toISOString(),
      },
      message_count: 1,
      member_count: 1,
      total_message_sent: 1,
    });

    expect(channel.parentId).toBe("parent-1");
    expect(channel.ownerId).toBe("owner-1");
    expect(
      channel.rawData && "parent_id" in channel.rawData ? channel.rawData.parent_id : undefined,
    ).toBe("parent-1");
    expect(
      channel.rawData && "owner_id" in channel.rawData ? channel.rawData.owner_id : undefined,
    ).toBe("owner-1");
  });
});
