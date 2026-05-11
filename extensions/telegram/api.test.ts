import { describe, expect, it } from "vitest";
import { escapeTelegramHtml, markdownToTelegramHtml } from "./api.js";

describe("@openclaw/telegram api re-exports", () => {
  it("re-exports markdownToTelegramHtml as a working function", () => {
    expect(typeof markdownToTelegramHtml).toBe("function");
    const rendered = markdownToTelegramHtml("**bold** plain");
    expect(rendered).toContain("<b>");
    expect(rendered).toContain("plain");
  });

  it("re-exports escapeTelegramHtml that escapes Telegram-reserved characters", () => {
    expect(typeof escapeTelegramHtml).toBe("function");
    expect(escapeTelegramHtml("<b>x & y</b>")).toBe("&lt;b&gt;x &amp; y&lt;/b&gt;");
  });
});
