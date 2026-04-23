import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("chat header responsive mobile styles", () => {
  it("keeps the chat header and session controls from clipping on narrow widths", () => {
    const css = readFileSync(new URL("./layout.mobile.css", import.meta.url), "utf8");

    expect(css).toContain("@media (max-width: 1320px)");
    expect(css).toContain(".content--chat .content-header");
    expect(css).toContain(".chat-controls__session-row");
    expect(css).toContain(".chat-controls__thinking-select");
  });
});
