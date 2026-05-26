import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDiscordRest } from "./send.test-harness.js";

const loadWebMediaRawMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMediaRaw: loadWebMediaRawMock,
}));

const voiceMocks = vi.hoisted(() => ({
  ensureOggOpus: vi.fn(),
  getVoiceMessageMetadata: vi.fn(),
  sendDiscordVoiceMessage: vi.fn(),
}));
vi.mock("./voice-message.js", () => voiceMocks);

const DISCORD_TEST_CFG = {
  channels: { discord: { token: "t" } },
};

let sendVoiceMessageDiscord: typeof import("./send.voice.js").sendVoiceMessageDiscord;

describe("sendVoiceMessageDiscord", () => {
  beforeAll(async () => {
    ({ sendVoiceMessageDiscord } = await import("./send.voice.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    loadWebMediaRawMock.mockResolvedValue({
      buffer: Buffer.from("voice"),
      fileName: "voice.ogg",
      contentType: "audio/ogg",
      kind: "audio",
    });
    voiceMocks.ensureOggOpus.mockImplementation(async (inputPath: string) => ({
      path: inputPath,
      cleanup: false,
    }));
    voiceMocks.getVoiceMessageMetadata.mockResolvedValue({ duration_secs: 1, waveform: "" });
    voiceMocks.sendDiscordVoiceMessage.mockResolvedValue({
      id: "msg1",
      channel_id: "273512430271856640",
    });
  });

  it("treats bare numeric voice targets as channels", async () => {
    const { rest } = makeDiscordRest();

    const result = await sendVoiceMessageDiscord(
      "273512430271856640",
      "https://example.com/voice.ogg",
      {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
      },
    );

    expect(result.channelId).toBe("273512430271856640");
    expect(voiceMocks.sendDiscordVoiceMessage).toHaveBeenCalledTimes(1);
    expect(voiceMocks.sendDiscordVoiceMessage.mock.calls[0]?.[1]).toBe("273512430271856640");
  });
});
