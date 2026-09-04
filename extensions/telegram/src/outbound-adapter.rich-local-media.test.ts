// Telegram rich-message local media tests for the outbound adapter.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageTelegramMock = vi.fn();
const pinMessageTelegramMock = vi.fn();
const reactMessageTelegramMock = vi.fn();
const sendPollTelegramMock = vi.fn();
const sendLocationTelegramMock = vi.fn();
const loadWebMediaMock = vi.fn();

vi.mock("./send.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.runtime.js")>()),
  loadWebMedia: (...args: unknown[]) => loadWebMediaMock(...args),
}));

vi.mock("./send.js", () => ({
  pinMessageTelegram: (...args: unknown[]) => pinMessageTelegramMock(...args),
  reactMessageTelegram: (...args: unknown[]) => reactMessageTelegramMock(...args),
  sendPollTelegram: (...args: unknown[]) => sendPollTelegramMock(...args),
  sendLocationTelegram: (...args: unknown[]) => sendLocationTelegramMock(...args),
  sendMessageTelegram: (...args: unknown[]) => sendMessageTelegramMock(...args),
}));

import { telegramOutbound } from "./outbound-adapter.js";

type MockWithCalls = {
  mock: { calls: unknown[][] };
};

function callOptionsAt(
  mock: MockWithCalls,
  index: number,
  expectedTo: string,
  expectedText: string,
): Record<string, unknown> {
  const call = mock.mock.calls[index];
  expect(call?.[0]).toBe(expectedTo);
  expect(call?.[1]).toBe(expectedText);
  const options = call?.[2];
  expect(options).toBeTruthy();
  return options as Record<string, unknown>;
}

describe("telegramOutbound rich local media", () => {
  beforeEach(() => {
    sendMessageTelegramMock.mockReset();
    loadWebMediaMock.mockReset();
  });

  it("prefers the payload route only for rich text with local media", () => {
    const payload = { text: "Chart", mediaUrls: ["FILE:///workspace/chart.png"] };
    expect(
      telegramOutbound.preferPayloadForMedia?.({
        payload,
        cfg: { channels: { telegram: { richMessages: true } } } as never,
      }),
    ).toBe(true);
    expect(
      telegramOutbound.preferPayloadForMedia?.({
        payload,
        cfg: { channels: { telegram: { richMessages: true } } } as never,
        forceDocument: true,
      }),
    ).toBe(false);
    expect(
      telegramOutbound.preferPayloadForMedia?.({
        payload: { text: "Chart", mediaUrls: ["https://example.com/chart.png"] },
        cfg: { channels: { telegram: { richMessages: true } } } as never,
      }),
    ).toBe(false);
    expect(
      telegramOutbound.preferPayloadForMedia?.({
        payload: { text: "Chart", mediaUrls: [String.raw`C:\workspace\chart.png`] },
        cfg: { channels: { telegram: { richMessages: true } } } as never,
      }),
    ).toBe(true);
    expect(
      telegramOutbound.preferPayloadForMedia?.({
        payload: { text: "Chart", mediaUrls: ["K:/workspace/chart.png"] },
        cfg: { channels: { telegram: { richMessages: true } } } as never,
      }),
    ).toBe(false);
  });

  it("keeps explicit voice and video-note requests on the legacy media route", () => {
    const cfg = { channels: { telegram: { richMessages: true } } } as never;

    expect(
      telegramOutbound.preferPayloadForMedia?.({
        payload: {
          text: "Voice",
          mediaUrls: ["/workspace/voice.ogg"],
          audioAsVoice: true,
        },
        cfg,
      }),
    ).toBe(false);
    expect(
      telegramOutbound.preferPayloadForMedia?.({
        payload: {
          text: "Video note",
          mediaUrls: ["/workspace/note.mp4"],
          videoAsNote: true,
        },
        cfg,
      }),
    ).toBe(false);
  });

  it.each([
    [
      "voice",
      {
        text: "Voice",
        mediaUrls: ["/workspace/voice.ogg"],
        audioAsVoice: true,
      },
      { asVoice: true },
    ],
    [
      "video note",
      {
        text: "Video note",
        mediaUrls: ["/workspace/note.mp4"],
        videoAsNote: true,
      },
      { asVideoNote: true },
    ],
  ] as const)(
    "preserves explicit %s delivery through sendPayload",
    async (_label, payload, mode) => {
      loadWebMediaMock.mockRejectedValue(new Error("rich local media resolution must not run"));
      sendMessageTelegramMock.mockResolvedValue({ messageId: "tg-1", chatId: "12345" });

      await telegramOutbound.sendPayload!({
        cfg: { channels: { telegram: { richMessages: true } } } as never,
        to: "12345",
        text: "",
        payload: { ...payload, mediaUrls: [...payload.mediaUrls] },
        mediaLocalRoots: ["/workspace"],
        deps: { sendTelegram: sendMessageTelegramMock },
      });

      expect(loadWebMediaMock).not.toHaveBeenCalled();
      expect(sendMessageTelegramMock).toHaveBeenCalledTimes(1);
      expect(callOptionsAt(sendMessageTelegramMock, 0, "12345", payload.text)).toMatchObject({
        mediaUrl: payload.mediaUrls[0],
        ...mode,
      });
    },
  );

  it("keeps legacy-path attachments in payload order beside embedded local media", async () => {
    loadWebMediaMock.mockImplementation(async (source: string) =>
      source.endsWith(".mp3")
        ? { buffer: Buffer.from("audio"), contentType: "audio/mpeg", fileName: "track.mp3" }
        : { buffer: Buffer.from("pdf"), contentType: "application/pdf", fileName: "notes.pdf" },
    );
    sendMessageTelegramMock.mockResolvedValue({ messageId: "tg-1", chatId: "12345" });

    await telegramOutbound.sendPayload!({
      cfg: { channels: { telegram: { richMessages: true } } } as never,
      to: "12345",
      text: "",
      payload: {
        text: "Report",
        mediaUrls: [
          "https://example.com/a.jpg",
          "/workspace/notes.pdf",
          "https://example.com/b.jpg",
          "/workspace/track.mp3",
        ],
      },
      mediaLocalRoots: ["/workspace"],
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    expect(loadWebMediaMock.mock.calls.map(([source]) => source)).toEqual([
      "/workspace/notes.pdf",
      "/workspace/track.mp3",
    ]);
    expect(sendMessageTelegramMock).toHaveBeenCalledTimes(4);
    const richOptions = callOptionsAt(
      sendMessageTelegramMock,
      0,
      "12345",
      'Report\n\n<figure><audio src="tg://audio?id=media1"/></figure>',
    );
    expect(richOptions.mediaUrl).toBeUndefined();
    expect(richOptions.richLocalMedia).toMatchObject([
      { id: "media1", source: "/workspace/track.mp3", media: { type: "audio" } },
    ]);
    expect(
      sendMessageTelegramMock.mock.calls
        .slice(1)
        .map((call) => [call[1], (call[2] as { mediaUrl?: string }).mediaUrl]),
    ).toEqual([
      ["", "https://example.com/a.jpg"],
      ["", "/workspace/notes.pdf"],
      ["", "https://example.com/b.jpg"],
    ]);
  });

  it("keeps implicit first replies on the rich send only when attachments remain", async () => {
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("audio"),
      contentType: "audio/mpeg",
      fileName: "track.mp3",
    });
    sendMessageTelegramMock.mockResolvedValue({ messageId: "tg-1", chatId: "12345" });

    await telegramOutbound.sendPayload!({
      cfg: { channels: { telegram: { richMessages: true } } } as never,
      to: "12345",
      text: "",
      payload: {
        text: "Report",
        mediaUrls: ["/workspace/track.mp3", "https://example.com/a.jpg"],
      },
      mediaLocalRoots: ["/workspace"],
      replyToId: "900",
      replyToIdSource: "implicit",
      replyToMode: "first",
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    expect(sendMessageTelegramMock).toHaveBeenCalledTimes(2);
    const richOptions = callOptionsAt(
      sendMessageTelegramMock,
      0,
      "12345",
      'Report\n\n<figure><audio src="tg://audio?id=media1"/></figure>',
    );
    expect(richOptions.replyToMessageId).toBe(900);
    const remainingOptions = callOptionsAt(sendMessageTelegramMock, 1, "12345", "");
    expect(remainingOptions.mediaUrl).toBe("https://example.com/a.jpg");
    expect(remainingOptions.replyToMessageId).toBeUndefined();
    expect(remainingOptions.replyToIdSource).toBeUndefined();
    expect(remainingOptions.replyToMode).toBeUndefined();
  });
});
