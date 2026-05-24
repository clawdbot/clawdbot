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

function selectorBlocks(css: string, selector: string): string[] {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`, "gs"))].map(
    (match) => match[0],
  );
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

  it("keeps chat session picker search icons from stretching in mobile controls", () => {
    const css = readMobileCss();

    expect(css).toContain(".chat-session-picker__icon-button.btn--icon {");
    expect(css).toContain("flex: 0 0 44px;");
    expect(css).toContain("width: 44px;");
    expect(css).toContain("min-width: 44px;");
  });

  it("keeps focused chat from reserving hidden page-header height", () => {
    const layoutCss = readLayoutCss();
    const mobileCss = readMobileCss();
    const focusedShell = selectorBlocks(layoutCss, ".shell--chat-focus").join("\n");
    const focusedMobileShell = selectorBlocks(mobileCss, ".shell--chat-focus").join("\n");
    const focusedTopbar = selectorBlocks(layoutCss, ".shell--chat-focus .topbar").join("\n");
    const focusedHeaderSelector = ".shell--chat-focus .content--chat .content-header";
    const expectedDeclarations = [
      "min-height: 0;",
      "max-height: 0;",
      "padding-top: 0;",
      "padding-bottom: 0;",
      "overflow: hidden;",
    ];

    expect(focusedShell).toContain("grid-template-rows: 0 minmax(0, 1fr);");
    expect(focusedMobileShell).toContain("grid-template-rows: 0 minmax(0, 1fr);");
    expect(focusedTopbar).toContain("min-height: 0;");
    expect(focusedTopbar).toContain("height: 0;");
    expect(focusedTopbar).toContain("padding-top: 0;");
    expect(focusedTopbar).toContain("padding-bottom: 0;");
    expect(focusedTopbar).toContain("overflow: hidden;");

    for (const css of [layoutCss, mobileCss]) {
      const block = selectorBlocks(css, focusedHeaderSelector).join("\n");
      expect(block).toBeTruthy();
      for (const declaration of expectedDeclarations) {
        expect(block).toContain(declaration);
      }
    }
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

describe("topbar theme mode tooltip styles", () => {
  it("clamps the rightmost color mode tooltip inside the viewport edge", () => {
    const css = readLayoutCss();

    expect(css).toMatch(
      /\.topbar-theme-mode__btn:last-child\[data-tooltip\]::after \{[\s\S]*right: 0;/,
    );
    expect(css).toMatch(
      /\.topbar-theme-mode__btn:last-child\[data-tooltip\]:hover::after \{[\s\S]*transform: translateY\(0\);/,
    );
    expect(css).toMatch(
      /\.topbar-theme-mode__btn:last-child\[data-tooltip\]:focus-visible::after \{[\s\S]*transform: translateY\(0\);/,
    );
    const tooltipBlock =
      selectorBlocks(css, ".topbar-theme-mode__btn[data-tooltip]::after").find((block) =>
        block.includes("content: attr(data-tooltip);"),
      ) ?? "";
    expect(tooltipBlock).toBeTruthy();
    expect(tooltipBlock).not.toContain("min-width:");
    expect(tooltipBlock).toContain("max-width: min(220px, 60vw);");
  });
});

describe("grouped chat width styles", () => {
  it("uses the config-fed CSS variable with the current fallback", () => {
    const css = readGroupedChatCss();

    expect(css).toContain("max-width: var(--chat-message-max-width, min(900px, 68%));");
  });

  it("excludes tool shells from light hover without overriding user bubble hover", () => {
    const css = readGroupedChatCss();

    expect(css).toContain(
      ':root[data-theme-mode="light"] .chat-bubble:not(:where(.chat-bubble--tool-shell)):hover',
    );
    expect(css).not.toContain(
      ':root[data-theme-mode="light"] .chat-bubble:not(.chat-bubble--tool-shell):hover',
    );
  });
});
