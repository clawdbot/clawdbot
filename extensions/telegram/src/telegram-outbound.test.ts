import { chunkMarkdownTextWithMode } from "openclaw/plugin-sdk/reply-chunking";
import { sendTextMediaPayload } from "openclaw/plugin-sdk/reply-payload";
// Telegram tests cover telegram outbound plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { splitTelegramHtmlChunks } from "./format.js";
import { telegramOutbound } from "./outbound-adapter.js";
import { clearTelegramRuntime } from "./runtime.js";

function markdownTable(columns: number): string {
  return [
    Array.from({ length: columns }, (_, index) => `H${index + 1}`).join(" | "),
    Array.from({ length: columns }, () => "---").join(" | "),
    Array.from({ length: columns }, (_, index) => String(index + 1)).join(" | "),
  ]
    .map((row) => `| ${row} |`)
    .join("\n");
}

describe("telegramPlugin outbound", () => {
  it("uses static outbound contract when Telegram runtime is uninitialized", () => {
    clearTelegramRuntime();
    const text = `${"hello\n".repeat(1200)}tail`;
    const expected = chunkMarkdownTextWithMode(text, 4000, "length");

    expect(telegramOutbound.chunker?.(text, 4000)).toEqual(expected);
    expect(telegramOutbound.deliveryMode).toBe("direct");
    expect(telegramOutbound.chunkerMode).toBe("markdown");
    expect(telegramOutbound.chunkedTextFormatting).toBeUndefined();
    expect(telegramOutbound.textChunkLimit).toBe(4000);
    expect(telegramOutbound.presentationCapabilities?.limits?.text?.markdownDialect).toBe(
      "markdown",
    );
    expect(telegramOutbound.pollMaxOptions).toBe(10);
  });

  it("strips assistant-visible tool traces before outbound delivery", () => {
    clearTelegramRuntime();
    const text = 'Done.\n⚠️ 🛠️ `search "Pipeline" in ~/.openclaw/workspace-* (agent)` failed';

    expect(telegramOutbound.sanitizeText?.({ text, payload: { text } })).toBe("Done.");
  });

  it("preserves ordinary outbound text while sanitizing", () => {
    clearTelegramRuntime();
    const text = "The pipeline has 3 deals.";

    expect(telegramOutbound.sanitizeText?.({ text, payload: { text } })).toBe(text);
  });

  it("preserves explicit HTML parse mode before chunking", () => {
    clearTelegramRuntime();
    const text = "<b>hi</b>";

    expect(telegramOutbound.chunker?.(text, 4000, { formatting: { parseMode: "HTML" } })).toEqual(
      splitTelegramHtmlChunks(text, 4000),
    );
    expect(telegramOutbound.chunker?.(text, 4000)).toEqual([text]);
  });

  it("delivers bounded HTML through the shared payload path when tag overhead overflows", async () => {
    clearTelegramRuntime();
    const oversizedLink = `<a href="https://example.com/${"x".repeat(4_000)}">first</a>`;
    const text = `${oversizedLink}<b>second</b>`;
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "tg-1", chatId: "12345" });

    await sendTextMediaPayload({
      channel: "telegram",
      ctx: {
        cfg: {},
        to: "12345",
        text: "",
        payload: { text },
        formatting: { parseMode: "HTML" },
        deps: { sendTelegram },
      },
      adapter: telegramOutbound,
    });

    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram).toHaveBeenCalledWith(
      "12345",
      "first<b>second</b>",
      expect.objectContaining({ textMode: "html" }),
    );
  });

  it("keeps astral characters whole at positive configured chunk limits", () => {
    clearTelegramRuntime();

    expect(telegramOutbound.chunker?.("A😀B", 1)).toEqual(["A", "😀", "B"]);
    expect(telegramOutbound.chunker?.("A😀B", 1, { formatting: { parseMode: "HTML" } })).toEqual([
      "A",
      "😀",
      "B",
    ]);
  });

  it("preserves markdown tables for the configured delivery renderer", () => {
    clearTelegramRuntime();
    const text = ["| Name | Value |", "|------|-------|", "| A | 1 |"].join("\n");

    const chunks = telegramOutbound.chunker?.(text, 4000, {
      formatting: { tableMode: "bullets" },
    });

    expect(chunks).toEqual([text]);
  });

  it("keeps wide markdown tables as visible text in the HTML text path", () => {
    clearTelegramRuntime();
    const text = markdownTable(21);

    const chunks = telegramOutbound.chunker?.(text, 4000);

    expect(chunks).toHaveLength(1);
    expect(chunks?.[0]).toContain("| H21 |");
    expect(chunks?.[0]).toContain("| 1 | 2 | 3 |");
  });

  it("preserves both fenced and unfenced wide tables as visible text", () => {
    clearTelegramRuntime();
    const fencedTable = markdownTable(25);
    const outsideTable = markdownTable(21);
    const text = ["Before", "~~~", fencedTable, "~~~", "After", outsideTable].join("\n");

    const chunks = telegramOutbound.chunker?.(text, 4000);

    expect(chunks).toHaveLength(1);
    expect(chunks?.[0]).toContain("Before");
    expect(chunks?.[0]).toContain("After");
    expect(chunks?.[0]).toContain(fencedTable);
    expect(chunks?.[0]).toContain(outsideTable);
  });

  it("chunks long markdown paragraphs by the Telegram text-message limit", () => {
    clearTelegramRuntime();
    const text = Array.from({ length: 900 }, (_, index) => `Paragraph ${index + 1}`).join("\n\n");

    const chunks = telegramOutbound.chunker?.(text, 4000);

    expect((chunks?.length ?? 0) > 1).toBe(true);
    expect(chunks?.every((chunk) => chunk.length <= 4000)).toBe(true);
    expect(chunks?.join("")).toContain("Paragraph 900");
  });

  it("chunks long markdown headings by the Telegram text-message limit", () => {
    clearTelegramRuntime();
    const text = Array.from({ length: 600 }, (_, index) => `# Heading ${index + 1}`).join("\n");

    const chunks = telegramOutbound.chunker?.(text, 4000);

    expect((chunks?.length ?? 0) > 1).toBe(true);
    expect(chunks?.every((chunk) => chunk.length <= 4000)).toBe(true);
    expect(chunks?.join("")).toContain("Heading 600");
  });

  it("chunks long markdown lists by the Telegram text-message limit", () => {
    clearTelegramRuntime();
    const text = Array.from({ length: 600 }, (_, index) => `- Item ${index + 1}`).join("\n");

    const chunks = telegramOutbound.chunker?.(text, 4000);

    expect((chunks?.length ?? 0) > 1).toBe(true);
    expect(chunks?.every((chunk) => chunk.length <= 4000)).toBe(true);
    expect(chunks?.join("")).toContain("Item 600");
  });

  it("chunks tall markdown tables by the Telegram text-message limit", () => {
    clearTelegramRuntime();
    const text = [
      "| Name | Value |",
      "| --- | --- |",
      ...Array.from({ length: 600 }, (_, index) => `| Row ${index + 1} | ${index + 1} |`),
    ].join("\n");

    const chunks = telegramOutbound.chunker?.(text, 4000);

    expect((chunks?.length ?? 0) > 1).toBe(true);
    expect(chunks?.every((chunk) => chunk.length <= 4000)).toBe(true);
    expect(chunks?.join("")).toContain("Row 600");
  });
});
