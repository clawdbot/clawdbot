// Telegram outbound sanitize gating: rich accounts keep the HTML island
// contract; non-rich accounts keep the legacy plain conversion.
import { describe, expect, it, vi } from "vitest";

vi.mock("./send.js", () => ({
  pinMessageTelegram: vi.fn(),
  reactMessageTelegram: vi.fn(),
  sendPollTelegram: vi.fn(),
  sendLocationTelegram: vi.fn(),
  sendMessageTelegram: vi.fn(),
}));

import { telegramOutbound } from "./outbound-adapter.js";

describe("telegramOutbound.sanitizeText", () => {
  const islandText =
    'before <details><summary>More</summary>body</details> <tg-math-block>x^2</tg-math-block> <ul><li><input type="checkbox" checked/>done</li></ul>';

  it("keeps the rich HTML island contract intact for rich accounts", () => {
    const sanitized = telegramOutbound.sanitizeText?.({
      text: islandText,
      payload: { text: islandText },
      cfg: { channels: { telegram: { richMessages: true } } } as never,
      accountId: "default",
    });
    expect(sanitized).toContain("<details><summary>More</summary>");
    expect(sanitized).toContain("<tg-math-block>x^2</tg-math-block>");
    expect(sanitized).toContain('<input type="checkbox" checked/>');
  });

  it("converts HTML to plain markers for non-rich accounts", () => {
    const sanitized = telegramOutbound.sanitizeText?.({
      text: islandText,
      payload: { text: islandText },
      cfg: { channels: { telegram: {} } } as never,
      accountId: "default",
    });
    expect(sanitized).not.toContain("<details>");
    expect(sanitized).toContain("• done");
  });

  it("resolves the effective named default account when accountId is omitted", () => {
    const cfg = {
      channels: {
        telegram: {
          defaultAccount: "rich-bot",
          accounts: { "rich-bot": { richMessages: true } },
        },
      },
    } as never;
    const sanitized = telegramOutbound.sanitizeText?.({
      text: islandText,
      payload: { text: islandText },
      cfg,
    });
    expect(sanitized).toContain("<details><summary>More</summary>");
  });

  it("stays on the plain path when config is unavailable", () => {
    const sanitized = telegramOutbound.sanitizeText?.({
      text: islandText,
      payload: { text: islandText },
    });
    expect(sanitized).not.toContain("<details>");
  });
});
