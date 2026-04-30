import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function stylePath(path: string): string {
  const cssPath = [resolve(process.cwd(), path), resolve(process.cwd(), "..", path)].find(
    (candidate) => existsSync(candidate),
  );
  expect(cssPath).toBeTruthy();
  return cssPath!;
}

describe("markdown preview styles", () => {
  it("keeps the preview dialog canvas unified", async () => {
    const css = await readFile(stylePath("ui/src/styles/components.css"), "utf8");

    expect(css).toContain(".md-preview-dialog__header-main");
    expect(css).toContain(".md-preview-dialog__meta");
    expect(css).toContain("--cm-bg: transparent;");
    expect(css).toContain(".md-preview-dialog__reader .cm-preview");
    expect(css).not.toContain("width: min(780px, calc(100vw - 48px));");
    expect(css).not.toContain("background: rgba(0, 0, 0, 0.65);");
    expect(css).not.toContain("color-mix(in srgb, var(--card) 94%, white 6%)");
  });

  it("keeps expanded previews focused on header controls and reading space", async () => {
    const css = await readFile(stylePath("ui/src/styles/components.css"), "utf8");

    expect(css).toContain(".md-preview-dialog__panel.fullscreen .md-preview-dialog__header-main");
    expect(css).toContain("clip-path: inset(50%);");
    expect(css).toMatch(
      /\.md-preview-dialog__panel\.fullscreen\s+\.md-preview-dialog__meta\s*\{[^}]*display:\s*none;/,
    );
    expect(css).toContain(".md-preview-dialog__panel.fullscreen .md-preview-dialog__body");
    expect(css).toContain("width: min(100%, 96ch);");
  });

  it("styles preview header controls as compact icon buttons", async () => {
    const css = await readFile(stylePath("ui/src/styles/components.css"), "utf8");

    expect(css).toContain(".md-preview-icon-btn");
    expect(css).toContain("width: 36px;");
    expect(css).toContain("height: 36px;");
    expect(css).toContain('.md-preview-icon-btn[aria-pressed="true"]');
  });

  it("keeps the sidebar reader shell in sidebar.css", async () => {
    const css = await readFile(stylePath("ui/src/styles/chat/sidebar.css"), "utf8");

    expect(css).toContain(".sidebar-markdown-shell__toolbar");
    expect(css).toContain(".sidebar-markdown-reader");
    expect(css).toContain(".sidebar-markdown-shell__hint");
  });
});
