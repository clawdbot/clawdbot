import { beforeEach, describe, expect, it, vi } from "vitest";

const transcribeFirstAudioMock = vi.hoisted(() => vi.fn());

vi.mock("./preflight-audio.runtime.js", () => ({
  transcribeFirstAudio: transcribeFirstAudioMock,
}));

import { resolveDiscordPreflightAudioMentionContext } from "./preflight-audio.js";

const cfg = {} as import("openclaw/plugin-sdk/config-types").OpenClawConfig;

describe("resolveDiscordPreflightAudioMentionContext", () => {
  beforeEach(() => {
    transcribeFirstAudioMock.mockReset();
  });

  it("preflights direct-message audio without requiring a mention", async () => {
    transcribeFirstAudioMock.mockResolvedValue("hello from dm");

    const result = await resolveDiscordPreflightAudioMentionContext({
      message: {
        attachments: [
          {
            url: "https://cdn.discordapp.com/attachments/voice.ogg",
            content_type: "audio/ogg",
            filename: "voice.ogg",
          },
        ],
      },
      isDirectMessage: true,
      shouldRequireMention: false,
      mentionRegexes: [],
      cfg,
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          MediaUrls: ["https://cdn.discordapp.com/attachments/voice.ogg"],
          MediaTypes: ["audio/ogg"],
        }),
      }),
    );
    expect(result).toEqual({
      hasAudioAttachment: true,
      hasTypedText: false,
      transcript: "hello from dm",
    });
  });

  it("preflights audio by filename when Discord omits content type", async () => {
    transcribeFirstAudioMock.mockResolvedValue("filename transcript");

    await resolveDiscordPreflightAudioMentionContext({
      message: {
        attachments: [
          {
            url: "https://cdn.discordapp.com/attachments/voice.opus",
            filename: "voice.opus",
          },
        ],
      },
      isDirectMessage: true,
      shouldRequireMention: false,
      mentionRegexes: [],
      cfg,
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          MediaUrls: ["https://cdn.discordapp.com/attachments/voice.opus"],
          MediaTypes: ["audio/opus"],
        }),
      }),
    );
  });

  it("preflights Discord voice attachments by waveform metadata", async () => {
    transcribeFirstAudioMock.mockResolvedValue("metadata transcript");

    await resolveDiscordPreflightAudioMentionContext({
      message: {
        attachments: [
          {
            url: " https://cdn.discordapp.com/attachments/voice ",
            filename: "voice",
            duration_secs: 1.5,
            waveform: "AAAA",
          },
        ],
      },
      isDirectMessage: true,
      shouldRequireMention: false,
      mentionRegexes: [],
      cfg,
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          MediaUrls: ["https://cdn.discordapp.com/attachments/voice"],
          MediaTypes: ["audio/ogg"],
        }),
      }),
    );
  });

  it("does not preflight typed direct-message audio", async () => {
    const result = await resolveDiscordPreflightAudioMentionContext({
      message: {
        content: "typed caption",
        attachments: [
          {
            url: "https://cdn.discordapp.com/attachments/voice.ogg",
            content_type: "audio/ogg",
            filename: "voice.ogg",
          },
        ],
      },
      isDirectMessage: true,
      shouldRequireMention: false,
      mentionRegexes: [],
      cfg,
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      hasAudioAttachment: true,
      hasTypedText: true,
    });
  });

  it("ignores URL-less audio attachments", async () => {
    const result = await resolveDiscordPreflightAudioMentionContext({
      message: {
        attachments: [
          {
            content_type: "audio/ogg",
            filename: "voice.ogg",
          },
        ],
      },
      isDirectMessage: true,
      shouldRequireMention: false,
      mentionRegexes: [],
      cfg,
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      hasAudioAttachment: false,
      hasTypedText: false,
    });
  });
});
