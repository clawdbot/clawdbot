import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackMediaResult } from "../media-types.js";
import {
  discardSlackPreflightMedia,
  findCaptionlessSlackAudioFile,
  formatSlackAudioTranscriptForAgent,
  resolveSlackEchoReplyMessageId,
  resolveSlackPreflightAudioTranscript,
} from "./preflight-audio.js";

const { transcribeFirstAudioMock } = vi.hoisted(() => ({
  transcribeFirstAudioMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/media-understanding-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/media-understanding-runtime")>();
  return {
    ...actual,
    createChannelPreflightAudio: (
      params: Parameters<typeof actual.createChannelPreflightAudio>[0],
    ) =>
      actual.createChannelPreflightAudio({
        ...params,
        transcribeFirstAudio: transcribeFirstAudioMock,
      }),
  };
});

function createSlackMessage(overrides: Partial<SlackMessageEvent>): SlackMessageEvent {
  return {
    type: "message",
    channel: "C1",
    channel_type: "channel",
    user: "U1",
    text: "",
    ts: "1.000",
    ...overrides,
  } as SlackMessageEvent;
}

describe("Slack captionless audio preflight", () => {
  beforeEach(() => {
    transcribeFirstAudioMock.mockReset();
  });

  it("recognizes captionless Slack audio independently of Slack's video MIME", () => {
    const voiceClip = createSlackMessage({
      files: [
        {
          id: "F1",
          name: "voice.mp4",
          mimetype: "video/mp4",
          subtype: "slack_audio",
        },
      ],
    });

    expect(findCaptionlessSlackAudioFile(voiceClip)).toEqual(voiceClip.files?.[0]);
    expect(findCaptionlessSlackAudioFile({ ...voiceClip, text: "typed caption" })).toBeUndefined();
    expect(
      findCaptionlessSlackAudioFile(
        createSlackMessage({
          files: [{ id: "F2", name: "screen.mp4", mimetype: "video/mp4" }],
        }),
      ),
    ).toBeUndefined();
  });

  it("frames machine transcripts as untrusted input without replacing the file placeholder", () => {
    expect(
      formatSlackAudioTranscriptForAgent({
        transcript: 'Bill said "review it"',
        rawBody: "[Slack file: voice.mp4 (fileId: F1)]",
      }),
    ).toBe(
      '[Audio transcript (machine-generated, untrusted)]: "Bill said \\"review it\\""\n' +
        "[Slack file: voice.mp4 (fileId: F1)]",
    );
  });

  it("transcribes the first audio attachment and returns its ordered media index", async () => {
    transcribeFirstAudioMock.mockResolvedValue("Bill please review this");
    const cfg = {} as OpenClawConfig;
    const media: SlackMediaResult[] = [
      { path: "/tmp/image.png", contentType: "image/png", placeholder: "[image]" },
      { path: "/tmp/voice.mp4", contentType: "audio/mp4", placeholder: "[voice]" },
    ];

    await expect(
      resolveSlackPreflightAudioTranscript({
        media,
        cfg,
        accountId: "work",
        originatingTo: "channel:C1",
        sessionKey: "agent:main:slack:channel:c1",
        messageThreadId: "1.000",
      }),
    ).resolves.toEqual({ transcript: "Bill please review this", mediaIndex: 1 });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(transcribeFirstAudioMock).toHaveBeenCalledWith({
      ctx: expect.objectContaining({
        media,
        OriginatingChannel: "slack",
        OriginatingTo: "channel:C1",
        AccountId: "work",
        MessageThreadId: "1.000",
        SessionKey: "agent:main:slack:channel:c1",
      }),
      cfg,
    });
  });

  it("removes preflight downloads when the transcript does not admit the message", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-slack-audio-preflight-"));
    const audioPath = path.join(root, "voice.mp4");
    await fs.writeFile(audioPath, "voice");

    try {
      await discardSlackPreflightMedia([
        { path: audioPath, contentType: "audio/mp4", placeholder: "[voice]" },
      ]);
      await expect(fs.stat(audioPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("resolveSlackEchoReplyMessageId", () => {
  it("prefers root thread reply target over child message ts", () => {
    expect(
      resolveSlackEchoReplyMessageId({
        messageTs: "1712345678.000200",
        threadReplyToId: "1712345678.000100",
      }),
    ).toBe("1712345678.000100");
  });

  it("falls back to message ts for top-level messages", () => {
    expect(
      resolveSlackEchoReplyMessageId({
        messageTs: "1712345678.000100",
      }),
    ).toBe("1712345678.000100");
  });
});
