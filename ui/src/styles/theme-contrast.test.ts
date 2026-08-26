// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

function relativeLuminance(hex: string): number {
  const channels = hex
    .replace("#", "")
    .match(/.{2}/g)
    ?.map((part) => Number.parseInt(part, 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  if (!channels || channels.length !== 3) {
    throw new Error(`invalid color: ${hex}`);
  }
  const r = channels[0];
  const g = channels[1];
  const b = channels[2];
  if (r === undefined || g === undefined || b === undefined) {
    throw new Error(`invalid color: ${hex}`);
  }
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground: string, background: string): number {
  const luminances = [relativeLuminance(foreground), relativeLuminance(background)].toSorted(
    (a, b) => b - a,
  );
  const lighter = luminances[0];
  const darker = luminances[1];
  if (lighter === undefined || darker === undefined) {
    throw new Error("expected two luminance values");
  }
  return (lighter + 0.05) / (darker + 0.05);
}

function mixOpaque(foreground: string, background: string, opacity: number): string {
  const fh = foreground.replace("#", "");
  const bh = background.replace("#", "");
  const fr = Number.parseInt(fh.slice(0, 2), 16);
  const fg = Number.parseInt(fh.slice(2, 4), 16);
  const fb = Number.parseInt(fh.slice(4, 6), 16);
  const br = Number.parseInt(bh.slice(0, 2), 16);
  const bg = Number.parseInt(bh.slice(2, 4), 16);
  const bb = Number.parseInt(bh.slice(4, 6), 16);
  const r = Math.round(fr * opacity + br * (1 - opacity));
  const g = Math.round(fg * opacity + bg * (1 - opacity));
  const b = Math.round(fb * opacity + bb * (1 - opacity));
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function readCssVarBlock(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, "u"));
  const block = match?.[1];
  if (!block) {
    throw new Error(`missing CSS block for ${selector}`);
  }
  const vars: Record<string, string> = {};
  for (const line of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/gu)) {
    const name = line[1];
    const value = line[2];
    if (name === undefined || value === undefined) {
      continue;
    }
    vars[name] = value.toLowerCase();
  }
  return vars;
}

function requireCssColor(vars: Record<string, string>, name: string): string {
  const value = vars[name];
  if (value === undefined) {
    throw new Error(`missing CSS color --${name}`);
  }
  return value;
}

function readRuleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u"));
  const body = match?.[1];
  if (!body) {
    throw new Error(`missing CSS rule for ${selector}`);
  }
  return body;
}

function readOpacity(ruleBody: string): number {
  const match = ruleBody.match(/opacity:\s*([0-9.]+)\s*;/u);
  const raw = match?.[1];
  return raw === undefined ? 1 : Number.parseFloat(raw);
}

describe("Control UI theme contrast", () => {
  const baseCss = readFileSync(path.join(here, "base.css"), "utf8");
  const groupedCss = readFileSync(path.join(here, "chat", "grouped.css"), "utf8");
  const chatLayoutCss = readFileSync(path.join(here, "chat", "layout.css"), "utf8");
  const layoutCss = readFileSync(path.join(here, "layout.css"), "utf8");

  it("keeps chat timestamps and slash-arg hints AA without opacity dimming", () => {
    const dark = readCssVarBlock(baseCss, ":root");
    const muted = requireCssColor(dark, "muted");
    const backgrounds = [
      requireCssColor(dark, "bg"),
      requireCssColor(dark, "bg-elevated"),
      requireCssColor(dark, "bg-muted"),
      requireCssColor(dark, "card"),
    ];
    const timestampRule = readRuleBody(groupedCss, ".chat-group-timestamp");
    const slashArgsRule = readRuleBody(chatLayoutCss, ".slash-menu-args,\n.slash-menu-desc");

    expect(timestampRule).toMatch(/color:\s*var\(--muted\)/);
    expect(slashArgsRule).toMatch(/color:\s*var\(--muted\)/);

    const timestampOpacity = readOpacity(timestampRule);
    const slashArgsOpacity = readOpacity(slashArgsRule);
    expect(timestampOpacity).toBe(1);
    expect(slashArgsOpacity).toBe(1);

    for (const background of backgrounds) {
      const timestampFg = mixOpaque(muted, background, timestampOpacity);
      const slashArgsFg = mixOpaque(muted, background, slashArgsOpacity);
      expect(contrastRatio(timestampFg, background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(slashArgsFg, background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps sidebar metadata on the AA-tested muted token without opacity dimming", () => {
    const groupLabelRule = readRuleBody(layoutCss, ".settings-sidebar__group-label");
    const buildRule = readRuleBody(layoutCss, ".settings-sidebar__footer .sidebar-footer-build");
    const sessionLabelRule = readRuleBody(
      layoutCss,
      ".sidebar-recent-sessions__label-text,\n.sidebar-session-catalog-host__label",
    );

    expect(groupLabelRule).toMatch(/color:\s*var\(--muted\)/);
    expect(buildRule).toMatch(/color:\s*var\(--muted\)/);
    expect(sessionLabelRule).toMatch(/color:\s*var\(--muted\)/);
    expect(readOpacity(sessionLabelRule)).toBe(1);

    for (const selector of [
      ':root[data-theme-mode="light"]',
      ':root[data-theme="openknot-light"]',
      ':root[data-theme="dash-light"]',
    ]) {
      const theme = readCssVarBlock(baseCss, selector);
      const muted = requireCssColor(theme, "muted");
      for (const surface of ["bg", "bg-elevated", "bg-muted", "card"]) {
        expect(contrastRatio(muted, requireCssColor(theme, surface))).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
