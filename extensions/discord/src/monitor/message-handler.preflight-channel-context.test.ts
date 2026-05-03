import { describe, expect, it } from "vitest";
import { resolveDiscordPreflightChannelContext } from "./message-handler.preflight-channel-context.js";

describe("resolveDiscordPreflightChannelContext", () => {
  it("uses Unicode channel names for display without changing config matching slugs", () => {
    const context = resolveDiscordPreflightChannelContext({
      isGuildMessage: true,
      messageChannelId: "channel-1",
      channelName: "\uC2E4\uD5D8",
      guildName: "Guild",
      guildInfo: null,
      threadChannel: null,
    });

    expect(context.configChannelSlug).toBe("");
    expect(context.displayChannelSlug).toBe("\uC2E4\uD5D8");
  });
});
