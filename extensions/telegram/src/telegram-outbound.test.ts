// Telegram tests cover telegram outbound plugin behavior.
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
    expect(telegramOutbound.sanitizeText).toBeUndefined();
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

  it("passes markdown table mode to the outbound markdown chunker", () => {
    clearTelegramRuntime();
    const text = ["| Name | Value |", "|------|-------|", "| A | 1 |"].join("\n");

    const chunks = telegramOutbound.chunker?.(text, 4000, {
      formatting: { tableMode: "bullets" },
    });

    expect(chunks?.join("\n")).toContain("Value: 1");
    expect(chunks?.join("\n")).not.toContain("| Name | Value |");
  });
});
