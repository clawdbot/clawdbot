import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readMobileCss(): string {
  const cssPath = [
    resolve(process.cwd(), "ui/src/styles/layout.mobile.css"),
    resolve(process.cwd(), "..", "ui/src/styles/layout.mobile.css"),
  ].find((candidate) => existsSync(candidate));
  expect(cssPath).toBeTruthy();
  return readFileSync(cssPath!, "utf8");
}

function readLayoutCss(): string {
  const cssPath = [
    resolve(process.cwd(), "ui/src/styles/layout.css"),
    resolve(process.cwd(), "..", "ui/src/styles/layout.css"),
  ].find((candidate) => existsSync(candidate));
  expect(cssPath).toBeTruthy();
  return readFileSync(cssPath!, "utf8");
}

function readGroupedChatCss(): string {
  const cssPath = [
    resolve(process.cwd(), "ui/src/styles/chat/grouped.css"),
    resolve(process.cwd(), "..", "ui/src/styles/chat/grouped.css"),
  ].find((candidate) => existsSync(candidate));
  expect(cssPath).toBeTruthy();
  return readFileSync(cssPath!, "utf8");
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
