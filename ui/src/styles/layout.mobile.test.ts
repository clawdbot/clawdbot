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
    const layoutCss = readLayoutCss();

    expect(css).toContain("@media (max-width: 1320px)");
    expect(css).toContain(".content--chat .content-header");
    expect(css).toContain("max-height: 44px;");
    expect(layoutCss).toContain(".content--chat .content-header .chat-controls__session-notice");
    expect(layoutCss).toContain("position: absolute;");
    expect(css).toContain(".chat-controls__session-row");
    expect(css).toContain(".chat-controls__thinking-select");
  });

  it("lays out mobile chat header action icons as an even full-width grid", () => {
    const css = readMobileCss();

    expect(css).toContain(
      ".chat-mobile-controls-wrapper .chat-controls-dropdown .chat-controls__thinking",
    );
    expect(css).toContain("grid-template-columns: repeat(5, minmax(0, 1fr));");
    expect(css).toContain(
      ".chat-mobile-controls-wrapper .chat-controls-dropdown .btn--icon {\n    width: 100%;",
    );
    expect(css).toContain("height: 44px;");
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

  it("keeps the sidebar new-session button inset and its icon visible", () => {
    const css = readLayoutCss();

    expect(css).toMatch(/\.sidebar-sessions \{[\s\S]*padding: 0 8px;/);
    expect(css).toMatch(/\.sidebar-new-session \{[\s\S]*min-height: 38px;/);
    expect(css).toMatch(/\.sidebar-new-session \{[\s\S]*box-sizing: border-box;/);
    expect(css).toMatch(
      /\.sidebar-new-session__icon svg \{[\s\S]*stroke: currentColor;[\s\S]*fill: none;/,
    );
    expect(css).toMatch(/\.sidebar--collapsed \.sidebar-sessions \{[\s\S]*padding: 0;/);
  });
});

describe("grouped chat width styles", () => {
  it("uses the config-fed CSS variable with the current fallback", () => {
    const css = readGroupedChatCss();

    expect(css).toContain("max-width: var(--chat-message-max-width, min(900px, 68%));");
  });
});
