// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = path.dirname(fileURLToPath(import.meta.url));

/*
 * WCAG 2.1 AA guardrail for text-bearing theme tokens.
 *
 * Palette edits historically dimmed secondary text below the AA floor without
 * anyone noticing (issue #107299 measured `--muted` at 3.1–3.5:1 on dark
 * surfaces). Hex tokens are cheap to audit mechanically, so every
 * text-on-surface pairing a theme can produce is asserted here at >= 4.5:1
 * (AA, normal-size text). Non-hex values (rgba tints, color-mix) are skipped:
 * their contrast depends on a compositing surface and is audited in the
 * base.css comments instead.
 */

const TEXT_TOKENS = [
  "--text",
  "--text-strong",
  "--chat-text",
  "--muted",
  "--muted-strong",
  "--muted-foreground",
] as const;

const SURFACE_TOKENS = ["--bg", "--bg-elevated", "--bg-muted", "--card", "--panel"] as const;

const AA_NORMAL_TEXT_MIN = 4.5;

type TokenMap = Map<string, string>;

function parseThemeBlocks(baseCss: string): Map<string, TokenMap> {
  const blocks = new Map<string, TokenMap>();
  const blockPattern = /(:root(?:\[data-theme(?:-mode)?="[^"]+"\])?)\s*\{([^}]*)\}/g;
  for (const match of baseCss.matchAll(blockPattern)) {
    const selector = match[1] ?? "";
    const body = match[2] ?? "";
    const tokens: TokenMap = new Map();
    for (const line of body.split("\n")) {
      const declaration = line.match(/^\s*(--[\w-]+)\s*:\s*([^;]+);/);
      const name = declaration?.[1];
      const value = declaration?.[2];
      if (name && value) {
        tokens.set(name, value.trim());
      }
    }
    blocks.set(selector, tokens);
  }
  return blocks;
}

/** Compose each selectable theme the way theme.ts layers blocks over :root. */
function resolveThemes(blocks: Map<string, TokenMap>): Map<string, TokenMap> {
  const root = blocks.get(":root") ?? new Map();
  const light = blocks.get(':root[data-theme-mode="light"]') ?? new Map();
  const layer = (...overrides: (TokenMap | undefined)[]): TokenMap => {
    const merged: TokenMap = new Map(root);
    for (const override of overrides) {
      for (const [key, value] of override ?? []) {
        merged.set(key, value);
      }
    }
    return merged;
  };
  return new Map([
    ["dark", layer(blocks.get(':root[data-theme="dark"]'))],
    ["light", layer(light)],
    ["openknot", layer(blocks.get(':root[data-theme="openknot"]'))],
    ["openknot-light", layer(light, blocks.get(':root[data-theme="openknot-light"]'))],
    ["dash", layer(blocks.get(':root[data-theme="dash"]'))],
    ["dash-light", layer(light, blocks.get(':root[data-theme="dash-light"]'))],
  ]);
}

function relativeLuminance(hex: string): number {
  const [red = 0, green = 0, blue = 0] = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset + 1, offset + 3), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foregroundHex: string, backgroundHex: string): number {
  const [lighter = 0, darker = 0] = [
    relativeLuminance(foregroundHex),
    relativeLuminance(backgroundHex),
  ].toSorted((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("Control UI theme contrast", () => {
  const baseCss = fs.readFileSync(path.join(stylesDir, "base.css"), "utf8");
  const themes = resolveThemes(parseThemeBlocks(baseCss));

  it("keeps every text token at WCAG AA on every theme surface", () => {
    const failures: string[] = [];
    for (const [themeName, tokens] of themes) {
      for (const textToken of TEXT_TOKENS) {
        const foreground = tokens.get(textToken);
        if (!foreground?.startsWith("#")) {
          continue;
        }
        for (const surfaceToken of SURFACE_TOKENS) {
          const background = tokens.get(surfaceToken);
          if (!background?.startsWith("#")) {
            continue;
          }
          const ratio = contrastRatio(foreground, background);
          if (ratio < AA_NORMAL_TEXT_MIN) {
            failures.push(
              `${themeName}: ${textToken} ${foreground} on ${surfaceToken} ${background} = ${ratio.toFixed(2)}:1 (< ${AA_NORMAL_TEXT_MIN}:1)`,
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
