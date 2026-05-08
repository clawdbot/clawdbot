import { describe, expect, it } from "vitest";
import { markdownToTelegramHtmlChunks } from "./format.js";
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
    expect(telegramOutbound.textChunkLimit).toBe(4000);
    expect(telegramOutbound.pollMaxOptions).toBe(10);
  });
});
