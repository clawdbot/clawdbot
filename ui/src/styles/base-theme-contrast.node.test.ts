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

/*
 * Separation guardrail for the markdown code chip.
 *
 * Text contrast was never the failure mode here: the chip surface itself
 * collapsed. Every dark palette sets `--secondary` to the same hex as `--card`,
 * so a chip painted with it was invisible inside a user bubble while light mode
 * (which overrode the surface) looked correct. The chip tokens are read out of
 * the live rule so swapping them back for a collapsing pair fails here.
 */
// Recognized workspace paths are excluded from the chip: they render as file
// links, so their contrast comes from the link color, not this surface.
const CODE_CHIP_RULE = ".chat-text :where(:not(pre, a.markdown-file-link) > code)";
const CODE_CHIP_HOST_SURFACES = ["--card", "--bg"] as const;
const CHIP_SURFACE_MIN_STEP = 1.05;
const CHIP_BORDER_MIN_STEP = 1.25;

type TokenMap = Map<string, string>;

function parseThemeBlocks(baseCss: string): Map<string, TokenMap> {
  const blocks = new Map<string, TokenMap>();
  const blockPattern = /(:root(?:\[data-theme(?:-mode)?="[^"]+"\])?)\s*\{([^}]*)\}/g;
  for (const match of baseCss.matchAll(blockPattern)) {
    const selector = match[1] ?? "";
    const body = match[2] ?? "";
    // base.css declares `:root` more than once (palette, then the standalone
    // --cursor-action blocks). Merging keeps the palette; overwriting made the
    // default `dark` theme resolve to an empty map and skip every assertion.
    const tokens: TokenMap = blocks.get(selector) ?? new Map();
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

/** Read the surface/border tokens the shipped code-chip rule actually paints. */
function readCodeChipTokens(chatTextCss: string): { surface: string; border: string } {
  const rule = chatTextCss.split(CODE_CHIP_RULE)[1]?.split("}")[0] ?? "";
  const surface = rule.match(/background:\s*var\((--[\w-]+)\)/u)?.[1];
  const border = rule.match(/border:[^;]*var\((--[\w-]+)\)/u)?.[1];
  if (!surface || !border) {
    throw new Error(`could not read chip tokens from "${CODE_CHIP_RULE}"`);
  }
  return { surface, border };
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

  it("keeps the markdown code chip separated from every surface it sits on", () => {
    const chatTextCss = fs.readFileSync(path.join(stylesDir, "chat", "text.css"), "utf8");
    const chip = readCodeChipTokens(chatTextCss);
    const failures: string[] = [];
    for (const [themeName, tokens] of themes) {
      const surface = tokens.get(chip.surface);
      const border = tokens.get(chip.border);
      expect(surface, `${themeName}: ${chip.surface} is not a hex token`).toMatch(/^#/u);
      expect(border, `${themeName}: ${chip.border} is not a hex token`).toMatch(/^#/u);
      for (const hostToken of CODE_CHIP_HOST_SURFACES) {
        const host = tokens.get(hostToken);
        if (!host?.startsWith("#")) {
          continue;
        }
        const surfaceStep = contrastRatio(surface ?? "", host);
        const borderStep = contrastRatio(border ?? "", host);
        if (surfaceStep < CHIP_SURFACE_MIN_STEP) {
          failures.push(
            `${themeName}: chip ${chip.surface} ${surface} on ${hostToken} ${host} = ${surfaceStep.toFixed(2)}:1 (< ${CHIP_SURFACE_MIN_STEP}:1)`,
          );
        }
        if (borderStep < CHIP_BORDER_MIN_STEP) {
          failures.push(
            `${themeName}: chip border ${chip.border} ${border} on ${hostToken} ${host} = ${borderStep.toFixed(2)}:1 (< ${CHIP_BORDER_MIN_STEP}:1)`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
