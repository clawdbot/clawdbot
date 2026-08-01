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
  resolveSlackPreflightAudioTranscript,
  sendSlackPreflightAudioTranscriptEcho,
} from "./preflight-audio.js";

const { sendDurableMessageBatchMock, transcribeFirstAudioMock } = vi.hoisted(() => ({
  sendDurableMessageBatchMock: vi.fn(),
  transcribeFirstAudioMock: vi.fn(),
}));

vi.mock("./preflight-audio.runtime.js", () => ({
  sendDurableMessageBatch: sendDurableMessageBatchMock,
  transcribeFirstAudio: transcribeFirstAudioMock,
}));

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

function createAudioConfig(overrides: Record<string, unknown> = {}): OpenClawConfig {
  return {
    tools: {
      media: {
        audio: {
          enabled: true,
          echoTranscript: true,
          ...overrides,
        },
      },
    },
  } as OpenClawConfig;
}

describe("Slack captionless audio preflight", () => {
  beforeEach(() => {
    sendDurableMessageBatchMock.mockReset();
    sendDurableMessageBatchMock.mockResolvedValue({ status: "sent", messageIds: ["1"] });
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

  it("transcribes the first audio attachment once and suppresses speculative echo", async () => {
    transcribeFirstAudioMock.mockResolvedValue("Bill please review this");
    const cfg = createAudioConfig();
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
      cfg: expect.objectContaining({
        tools: expect.objectContaining({
          media: expect.objectContaining({
            audio: expect.objectContaining({ echoTranscript: false }),
          }),
        }),
      }),
    });
    expect(cfg.tools?.media?.audio?.echoTranscript).toBe(true);
  });

  it("echoes only an admitted transcript and preserves literal replacement tokens", async () => {
    await sendSlackPreflightAudioTranscriptEcho({
      transcript: "cost is $& and $1",
      cfg: createAudioConfig({ echoFormat: "heard: {transcript}" }),
      accountId: "work",
      originatingTo: "channel:C1",
      messageThreadId: "1.000",
    });

    expect(sendDurableMessageBatchMock).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      channel: "slack",
      to: "channel:C1",
      accountId: "work",
      threadId: "1.000",
      payloads: [{ text: "heard: cost is $& and $1" }],
      bestEffort: true,
      durability: "best_effort",
    });

    sendDurableMessageBatchMock.mockClear();
    await sendSlackPreflightAudioTranscriptEcho({
      transcript: "not echoed",
      cfg: createAudioConfig({ echoTranscript: false }),
      accountId: "work",
      originatingTo: "channel:C1",
    });
    expect(sendDurableMessageBatchMock).not.toHaveBeenCalled();
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
