import { describe, expect, it } from "vitest";
import { buildTelegramNativeQuoteCandidate } from "./native-quote.js";

describe("Telegram native quote candidates", () => {
  it("uses a Telegram-safe prefix and preserves leading whitespace", () => {
    const candidate = buildTelegramNativeQuoteCandidate({
      text: "  quoted context\nrest",
      maxLength: 10,
    });

    expect(candidate).toEqual({
      text: "  quoted c",
      position: 0,
    });
  });

  it("does not split UTF-16 surrogate pairs at the quote cap", () => {
    const candidate = buildTelegramNativeQuoteCandidate({
      text: `abc😀def`,
      maxLength: 4,
    });

    expect(candidate?.text).toBe("abc");
  });

  it("slices entities to the quoted prefix", () => {
    const candidate = buildTelegramNativeQuoteCandidate({
      text: "hello world",
      maxLength: 8,
      entities: [
        { type: "bold", offset: 0, length: 5 },
        { type: "italic", offset: 6, length: 5 },
      ],
    });

    expect(candidate).toEqual({
      text: "hello wo",
      position: 0,
      entities: [
        { type: "bold", offset: 0, length: 5 },
        { type: "italic", offset: 6, length: 2 },
      ],
    });
  });

  it("omits blank quote candidates", () => {
    expect(buildTelegramNativeQuoteCandidate({ text: " \n\t" })).toBeUndefined();
  });
});
