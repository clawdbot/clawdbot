import { describe, expect, it } from "vitest";
import { markdownToTelegramHtmlChunks, splitTelegramHtmlChunks } from "./format.js";
import { telegramOutbound } from "./outbound-adapter.js";
import { clearTelegramRuntime } from "./runtime.js";

describe("telegramPlugin outbound", () => {
  it("uses static outbound contract when Telegram runtime is uninitialized", () => {
    clearTelegramRuntime();
    const text = `${"hello\n".repeat(1200)}tail`;
    const expected = markdownToTelegramHtmlChunks(text, 4000);

    expect(telegramOutbound.chunker?.(text, 4000)).toEqual(expected);
    expect(telegramOutbound.deliveryMode).toBe("direct");
    expect(telegramOutbound.chunkerMode).toBe("markdown");
    expect(telegramOutbound.chunkedTextFormatting).toEqual({ parseMode: "HTML" });
    expect(telegramOutbound.textChunkLimit).toBe(4000);
    expect(telegramOutbound.pollMaxOptions).toBe(10);
  });

  it("preserves explicit HTML parse mode before chunking", () => {
    clearTelegramRuntime();
    const text = "<b>hi</b>";

    expect(telegramOutbound.chunker?.(text, 4000, { formatting: { parseMode: "HTML" } })).toEqual(
      splitTelegramHtmlChunks(text, 4000),
    );
    expect(telegramOutbound.chunker?.(text, 4000)).toEqual(
      markdownToTelegramHtmlChunks(text, 4000),
    );
  });
});
