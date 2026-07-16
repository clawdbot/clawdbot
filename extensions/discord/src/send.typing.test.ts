import type { RequestClient } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

    const result = await sendTypingDiscord("12345", { accountId: "ops" });

    expect(resolveDiscordRestMock).toHaveBeenCalledWith({ accountId: "ops" });
    expect(post).toHaveBeenCalledWith(Routes.channelTyping("12345"));
    expect(result).toEqual({ ok: true, channelId: "12345" });
  });
});
