import { Routes } from "discord-api-types/v10";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestClient } from "./internal/discord.js";
import { EMPTY_DISCORD_TEST_CONFIG } from "./test-support/config.js";

const resolveDiscordRestMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  resolveDiscordRest: resolveDiscordRestMock,
}));

let sendTypingDiscord: typeof import("./send.typing.js").sendTypingDiscord;

beforeAll(async () => {
  ({ sendTypingDiscord } = await import("./send.typing.js"));
});

beforeEach(() => {
  resolveDiscordRestMock.mockReset();
});

describe("sendTypingDiscord", () => {
  it("sends a typing event to the resolved Discord channel route", async () => {
    const post = vi.fn(async () => undefined);
    resolveDiscordRestMock.mockReturnValue({
      post,
    } as unknown as RequestClient);

    const result = await sendTypingDiscord("12345", {
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      accountId: "ops",
    });

    expect(resolveDiscordRestMock).toHaveBeenCalledWith({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      accountId: "ops",
    });
    expect(post).toHaveBeenCalledWith(Routes.channelTyping("12345"));
    expect(result).toEqual({ ok: true, channelId: "12345" });
  });
});
