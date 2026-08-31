import { Routes } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";

const restMock = {
  get: vi.fn(),
};

vi.mock("./send.shared.js", () => ({
  resolveDiscordRest: () => restMock,
}));

vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMediaRaw: vi.fn(),
}));

const { fetchVoiceStatusDiscord } = await import("./send.guild.js");

describe("fetchVoiceStatusDiscord", () => {
  beforeEach(() => {
    restMock.get.mockReset();
  });

  it("returns active voice states from the REST client", async () => {
    const voiceState = {
      guild_id: "g1",
      user_id: "u1",
      channel_id: "c1",
      session_id: "s1",
      deaf: false,
      mute: false,
      self_deaf: false,
      self_mute: false,
      suppress: false,
    };
    restMock.get.mockResolvedValueOnce(voiceState);

    const result = await fetchVoiceStatusDiscord("g1", "u1", { cfg: {} as never });

    expect(result).toEqual(voiceState);
    expect(restMock.get).toHaveBeenCalledWith(Routes.guildVoiceState("g1", "u1"));
  });

  it("returns an absent status when Discord reports an unknown voice state", async () => {
    restMock.get.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404, discordCode: 10065 }),
    );

    const result = await fetchVoiceStatusDiscord("g1", "u1", { cfg: {} as never });

    expect(result).toEqual({
      guild_id: "g1",
      user_id: "u1",
      channel_id: null,
      connected: false,
      absent: true,
      reason: "unknown_voice_state",
    });
  });

  it("recognizes legacy unknown voice state error messages", async () => {
    restMock.get.mockRejectedValueOnce(new Error("DiscordError: Unknown Voice State"));

    const result = await fetchVoiceStatusDiscord("g1", "u1", { cfg: {} as never });

    expect(result).toMatchObject({
      guild_id: "g1",
      user_id: "u1",
      channel_id: null,
      connected: false,
      absent: true,
      reason: "unknown_voice_state",
    });
  });

  it.each([
    Object.assign(new Error("Unknown Guild"), { status: 404, discordCode: 10004 }),
    Object.assign(new Error("Not Found"), { status: 404 }),
    new Error("Discord API error"),
  ])("propagates non-voice-state REST failures", async (error) => {
    restMock.get.mockRejectedValueOnce(error);

    await expect(fetchVoiceStatusDiscord("g1", "u1", { cfg: {} as never })).rejects.toBe(error);
  });
});
