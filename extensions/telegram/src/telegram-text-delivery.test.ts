import { InputFile } from "grammy";
import { describe, expect, it, vi } from "vitest";
import type { InputRichBlock } from "./rich-block-model.js";
import type { TelegramRichLocalMedia } from "./rich-local-media.js";
import {
  planTelegramTextDeliveryPages,
  sendTelegramTextPageParts,
} from "./telegram-text-delivery.js";

function localAudio(index: number): TelegramRichLocalMedia {
  const fileName = `track${index}.mp3`;
  return {
    id: `media${index}`,
    source: `/workspace/${fileName}`,
    fileName,
    media: {
      type: "audio",
      media: new InputFile(Buffer.from(fileName), fileName),
    },
  };
}

describe("Telegram rich local media page delivery", () => {
  it("binds media1 and media10 by exact reference through a page fallback", async () => {
    const media = Array.from({ length: 10 }, (_, index) => localAudio(index + 1));
    const blocks: InputRichBlock[] = media.flatMap((entry) => [
      { type: "paragraph", text: "x" },
      {
        type: "audio",
        audio: { type: "audio", media: `tg://audio?id=${entry.id}` },
      },
    ]);
    const pages = planTelegramTextDeliveryPages({
      text: "",
      maxChars: 1,
      richMessages: true,
      richMessage: { blocks },
      richLocalMedia: media,
    });

    expect(pages).toHaveLength(10);
    const lastPage = pages.at(-1);
    if (!lastPage) {
      throw new Error("expected the final rich-message page");
    }
    expect(lastPage.plainText).toBe("x\ntrack10.mp3");
    expect(lastPage.richLocalMedia?.map((entry) => entry.id)).toEqual(["media10"]);

    const sendPlain = vi.fn(async (text: string) => text);
    const onPlainFallback = vi.fn();
    const delivered: string[] = [];
    for await (const part of sendTelegramTextPageParts({
      page: lastPage,
      context: "page send",
      warn: vi.fn(),
      onPlainFallback,
      sender: {
        sendPlain,
        sendHtml: async () => "html",
        sendRich: async () => {
          throw new Error("Bad Request: RICH_MESSAGE_AUDIO_INVALID");
        },
      },
    })) {
      delivered.push(part.result);
    }

    expect(delivered).toEqual(["x\ntrack10.mp3"]);
    expect(sendPlain).toHaveBeenCalledWith(
      "x\ntrack10.mp3",
      { index: 0, count: 1 },
      "page send-plain",
    );
    expect(onPlainFallback).toHaveBeenCalledWith(lastPage);
  });
});
