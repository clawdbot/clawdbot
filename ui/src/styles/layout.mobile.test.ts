import { describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";

function readMobileCss(): string {
  return readStyleSheet("ui/src/styles/layout.mobile.css");
}

function readLayoutCss(): string {
  return readStyleSheet("ui/src/styles/layout.css");
}

function readGroupedChatCss(): string {
  return readStyleSheet("ui/src/styles/chat/grouped.css");
}

describe("chat header responsive mobile styles", () => {
  it("keeps the chat header and session controls from clipping on narrow widths", () => {
    const css = readMobileCss();

    expect(css).toContain("@media (max-width: 1320px)");
    expect(css).toContain(".content--chat .content-header");
    expect(css).toContain(".chat-controls__session-row");
    expect(css).toContain(".chat-controls__thinking-select");
  });
});

describe("sidebar menu trigger styles", () => {
  it("keeps the mobile sidebar trigger visibly interactive on hover and keyboard focus", () => {
    const css = readLayoutCss();

    expect(css).toContain(".sidebar-menu-trigger {");
    expect(css).toContain("cursor: pointer;");
    expect(css).toContain(".sidebar-menu-trigger:hover {");
    expect(css).toContain("background: color-mix(in srgb, var(--bg-hover) 84%, transparent);");
    expect(css).toContain("color: var(--text);");
    expect(css).toContain(".sidebar-menu-trigger:focus-visible {");
    expect(css).toContain("box-shadow: var(--focus-ring);");
    expect(css).toContain(".topbar-nav-toggle {");
    expect(css).toContain("display: none;");
  });
});

describe("grouped chat width styles", () => {
  it("uses the config-fed CSS variable with the current fallback", () => {
    const css = readGroupedChatCss();

    expect(css).toContain("max-width: var(--chat-message-max-width, min(900px, 68%));");
  });
});
