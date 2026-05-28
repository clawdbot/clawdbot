import * as fs from "node:fs";
import * as path from "node:path";
import {
  type EditorTheme,
  getCapabilities,
  type MarkdownTheme,
  type SelectListTheme,
  type SettingsListTheme,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { getCustomThemesDir, getThemesDir } from "../../../config.js";
import type { SourceInfo } from "../../../sessions/source-info.js";
import { closeWatcher, watchWithErrorHandler } from "../../../utils/fs-watch.js";
import { highlight, supportsLanguage } from "../../../utils/syntax-highlight.js";

// ============================================================================
// Types & Schema
// ============================================================================

const ColorValueSchema = Type.Union([
  Type.String(), // hex "#ff0000", var ref "primary", or empty ""
  Type.Integer({ minimum: 0, maximum: 255 }), // 256-color index
]);

type ColorValue = Static<typeof ColorValueSchema>;

const ThemeJsonSchema = Type.Object({
  $schema: Type.Optional(Type.String()),
  name: Type.String(),
  vars: Type.Optional(Type.Record(Type.String(), ColorValueSchema)),
  colors: Type.Object({
    // Core UI (10 colors)
    accent: ColorValueSchema,
    border: ColorValueSchema,
    borderAccent: ColorValueSchema,
    borderMuted: ColorValueSchema,
    success: ColorValueSchema,
    error: ColorValueSchema,
    warning: ColorValueSchema,
    muted: ColorValueSchema,
    dim: ColorValueSchema,
    text: ColorValueSchema,
    thinkingText: ColorValueSchema,
    // Backgrounds & Content Text (11 colors)
    selectedBg: ColorValueSchema,
    userMessageBg: ColorValueSchema,
    userMessageText: ColorValueSchema,
    customMessageBg: ColorValueSchema,
    customMessageText: ColorValueSchema,
    customMessageLabel: ColorValueSchema,
    toolPendingBg: ColorValueSchema,
    toolSuccessBg: ColorValueSchema,
    toolErrorBg: ColorValueSchema,
    toolTitle: ColorValueSchema,
    toolOutput: ColorValueSchema,
    // Markdown (10 colors)
    mdHeading: ColorValueSchema,
    mdLink: ColorValueSchema,
    mdLinkUrl: ColorValueSchema,
    mdCode: ColorValueSchema,
    mdCodeBlock: ColorValueSchema,
    mdCodeBlockBorder: ColorValueSchema,
    mdQuote: ColorValueSchema,
    mdQuoteBorder: ColorValueSchema,
    mdHr: ColorValueSchema,
    mdListBullet: ColorValueSchema,
    // Tool Diffs (3 colors)
    toolDiffAdded: ColorValueSchema,
    toolDiffRemoved: ColorValueSchema,
    toolDiffContext: ColorValueSchema,
    // Syntax Highlighting (9 colors)
    syntaxComment: ColorValueSchema,
    syntaxKeyword: ColorValueSchema,
    syntaxFunction: ColorValueSchema,
    syntaxVariable: ColorValueSchema,
    syntaxString: ColorValueSchema,
    syntaxNumber: ColorValueSchema,
    syntaxType: ColorValueSchema,
    syntaxOperator: ColorValueSchema,
    syntaxPunctuation: ColorValueSchema,
    // Thinking Level Borders (6 colors)
    thinkingOff: ColorValueSchema,
    thinkingMinimal: ColorValueSchema,
    thinkingLow: ColorValueSchema,
    thinkingMedium: ColorValueSchema,
    thinkingHigh: ColorValueSchema,
    thinkingXhigh: ColorValueSchema,
    // Bash Mode (1 color)
    bashMode: ColorValueSchema,
  }),
  export: Type.Optional(
    Type.Object({
      pageBg: Type.Optional(ColorValueSchema),
      cardBg: Type.Optional(ColorValueSchema),
      infoBg: Type.Optional(ColorValueSchema),
    }),
  ),
});

type ThemeJson = Static<typeof ThemeJsonSchema>;

const validateThemeJson = Compile(ThemeJsonSchema);

export type ThemeColor =
  | "accent"
  | "border"
  | "borderAccent"
  | "borderMuted"
  | "success"
  | "error"
  | "warning"
  | "muted"
  | "dim"
  | "text"
  | "thinkingText"
  | "userMessageText"
  | "customMessageText"
  | "customMessageLabel"
  | "toolTitle"
  | "toolOutput"
  | "mdHeading"
  | "mdLink"
  | "mdLinkUrl"
  | "mdCode"
  | "mdCodeBlock"
  | "mdCodeBlockBorder"
  | "mdQuote"
  | "mdQuoteBorder"
  | "mdHr"
  | "mdListBullet"
  | "toolDiffAdded"
  | "toolDiffRemoved"
  | "toolDiffContext"
  | "syntaxComment"
  | "syntaxKeyword"
  | "syntaxFunction"
  | "syntaxVariable"
  | "syntaxString"
  | "syntaxNumber"
  | "syntaxType"
  | "syntaxOperator"
  | "syntaxPunctuation"
  | "thinkingOff"
  | "thinkingMinimal"
  | "thinkingLow"
  | "thinkingMedium"
  | "thinkingHigh"
  | "thinkingXhigh"
  | "bashMode";

export type ThemeBg =
  | "selectedBg"
  | "userMessageBg"
  | "customMessageBg"
  | "toolPendingBg"
  | "toolSuccessBg"
  | "toolErrorBg";

type ColorMode = "truecolor" | "256color";

// ============================================================================
// Color Utilities
// ============================================================================

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const cleaned = hex.replace("#", "");
  if (cleaned.length !== 6) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  const r = Number.parseInt(cleaned.slice(0, 2), 16);
  const g = Number.parseInt(cleaned.slice(2, 4), 16);
  const b = Number.parseInt(cleaned.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  return { r, g, b };
}

// The 6x6x6 color cube channel values (indices 0-5)
const CUBE_VALUES = [0, 95, 135, 175, 215, 255];

// Grayscale ramp values (indices 232-255, 24 grays from 8 to 238)
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);

function findClosestCubeIndex(value: number): number {
  let minDist = Infinity;
  let minIdx = 0;
  for (let i = 0; i < CUBE_VALUES.length; i++) {
    const dist = Math.abs(value - CUBE_VALUES[i]);
    if (dist < minDist) {
      minDist = dist;
      minIdx = i;
    }
  }
  return minIdx;
}

function findClosestGrayIndex(gray: number): number {
  let minDist = Infinity;
  let minIdx = 0;
  for (let i = 0; i < GRAY_VALUES.length; i++) {
    const dist = Math.abs(gray - GRAY_VALUES[i]);
    if (dist < minDist) {
      minDist = dist;
      minIdx = i;
    }
  }
  return minIdx;
}

function colorDistance(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  // Weighted Euclidean distance (human eye is more sensitive to green)
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

function rgbTo256(r: number, g: number, b: number): number {
  // Find closest color in the 6x6x6 cube
  const rIdx = findClosestCubeIndex(r);
  const gIdx = findClosestCubeIndex(g);
  const bIdx = findClosestCubeIndex(b);
  const cubeR = CUBE_VALUES[rIdx];
  const cubeG = CUBE_VALUES[gIdx];
  const cubeB = CUBE_VALUES[bIdx];
  const cubeIndex = 16 + 36 * rIdx + 6 * gIdx + bIdx;
  const cubeDist = colorDistance(r, g, b, cubeR, cubeG, cubeB);

  // Find closest grayscale
  const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  const grayIdx = findClosestGrayIndex(gray);
  const grayValue = GRAY_VALUES[grayIdx];
  const grayIndex = 232 + grayIdx;
  const grayDist = colorDistance(r, g, b, grayValue, grayValue, grayValue);

  // Check if color has noticeable saturation (hue matters)
  // If max-min spread is significant, prefer cube to preserve tint
  const maxC = Math.max(r, g, b);
  const minC = Math.min(r, g, b);
  const spread = maxC - minC;

  // Only consider grayscale if color is nearly neutral (spread < 10)
  // AND grayscale is actually closer
  if (spread < 10 && grayDist < cubeDist) {
    return grayIndex;
  }

  return cubeIndex;
}

function hexTo256(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return rgbTo256(r, g, b);
}

function fgAnsi(color: string | number, mode: ColorMode): string {
  if (color === "") {
    return "\x1b[39m";
  }
  if (typeof color === "number") {
    return `\x1b[38;5;${color}m`;
  }
  if (color.startsWith("#")) {
    if (mode === "truecolor") {
      const { r, g, b } = hexToRgb(color);
      return `\x1b[38;2;${r};${g};${b}m`;
    }
    const index = hexTo256(color);
    return `\x1b[38;5;${index}m`;
  }
  throw new Error(`Invalid color value: ${color}`);
}

function bgAnsi(color: string | number, mode: ColorMode): string {
  if (color === "") {
    return "\x1b[49m";
  }
  if (typeof color === "number") {
    return `\x1b[48;5;${color}m`;
  }
  if (color.startsWith("#")) {
    if (mode === "truecolor") {
      const { r, g, b } = hexToRgb(color);
      return `\x1b[48;2;${r};${g};${b}m`;
    }
    const index = hexTo256(color);
    return `\x1b[48;5;${index}m`;
  }
  throw new Error(`Invalid color value: ${color}`);
}

function resolveVarRefs(
  value: ColorValue,
  vars: Record<string, ColorValue>,
  visited = new Set<string>(),
): string | number {
  if (typeof value === "number" || value === "" || value.startsWith("#")) {
    return value;
  }
  if (visited.has(value)) {
    throw new Error(`Circular variable reference detected: ${value}`);
  }
  if (!(value in vars)) {
    throw new Error(`Variable reference not found: ${value}`);
  }
  visited.add(value);
  return resolveVarRefs(vars[value], vars, visited);
}

function resolveThemeColors<T extends Record<string, ColorValue>>(
  colors: T,
  vars: Record<string, ColorValue> = {},
): Record<keyof T, string | number> {
  const resolved: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(colors)) {
    resolved[key] = resolveVarRefs(value, vars);
  }
  return resolved as Record<keyof T, string | number>;
}

// ============================================================================
// Theme Class
// ============================================================================

export class Theme {
  readonly name?: string;
  readonly sourcePath?: string;
  sourceInfo?: SourceInfo;
  private fgColors: Map<ThemeColor, string>;
  private bgColors: Map<ThemeBg, string>;
  private mode: ColorMode;

  constructor(
    fgColors: Record<ThemeColor, string | number>,
    bgColors: Record<ThemeBg, string | number>,
    mode: ColorMode,
    options: { name?: string; sourcePath?: string; sourceInfo?: SourceInfo } = {},
  ) {
    this.name = options.name;
    this.sourcePath = options.sourcePath;
    this.sourceInfo = options.sourceInfo;
    this.mode = mode;
    this.fgColors = new Map();
    for (const [key, value] of Object.entries(fgColors) as [ThemeColor, string | number][]) {
      this.fgColors.set(key, fgAnsi(value, mode));
    }
    this.bgColors = new Map();
    for (const [key, value] of Object.entries(bgColors) as [ThemeBg, string | number][]) {
      this.bgColors.set(key, bgAnsi(value, mode));
    }
  }

  fg(color: ThemeColor, text: string): string {
    const ansi = this.fgColors.get(color);
    if (!ansi) {
      throw new Error(`Unknown theme color: ${color}`);
    }
    return `${ansi}${text}\x1b[39m`; // Reset only foreground color
  }

  bg(color: ThemeBg, text: string): string {
    const ansi = this.bgColors.get(color);
    if (!ansi) {
      throw new Error(`Unknown theme background color: ${color}`);
    }
    return `${ansi}${text}\x1b[49m`; // Reset only background color
  }

  bold(text: string): string {
    return chalk.bold(text);
  }

  italic(text: string): string {
    return chalk.italic(text);
  }

  underline(text: string): string {
    return chalk.underline(text);
  }

  inverse(text: string): string {
    return chalk.inverse(text);
  }

  strikethrough(text: string): string {
    return chalk.strikethrough(text);
  }

  getFgAnsi(color: ThemeColor): string {
    const ansi = this.fgColors.get(color);
    if (!ansi) {
      throw new Error(`Unknown theme color: ${color}`);
    }
    return ansi;
  }

  getBgAnsi(color: ThemeBg): string {
    const ansi = this.bgColors.get(color);
    if (!ansi) {
      throw new Error(`Unknown theme background color: ${color}`);
    }
    return ansi;
  }

  getColorMode(): ColorMode {
    return this.mode;
  }

  getThinkingBorderColor(
    level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
  ): (str: string) => string {
    // Map thinking levels to dedicated theme colors
    switch (level) {
      case "off":
        return (str: string) => this.fg("thinkingOff", str);
      case "minimal":
        return (str: string) => this.fg("thinkingMinimal", str);
      case "low":
        return (str: string) => this.fg("thinkingLow", str);
      case "medium":
        return (str: string) => this.fg("thinkingMedium", str);
      case "high":
        return (str: string) => this.fg("thinkingHigh", str);
      case "xhigh":
        return (str: string) => this.fg("thinkingXhigh", str);
      default:
        return (str: string) => this.fg("thinkingOff", str);
    }
  }

  getBashModeBorderColor(): (str: string) => string {
    return (str: string) => this.fg("bashMode", str);
  }
}

// ============================================================================
// Theme Loading
// ============================================================================

let BUILTIN_THEMES: Record<string, ThemeJson> | undefined;

function getBuiltinThemes(): Record<string, ThemeJson> {
  if (!BUILTIN_THEMES) {
    const themesDir = getThemesDir();
    const darkPath = path.join(themesDir, "dark.json");
    const lightPath = path.join(themesDir, "light.json");
    BUILTIN_THEMES = {
      dark: JSON.parse(fs.readFileSync(darkPath, "utf-8")) as ThemeJson,
      light: JSON.parse(fs.readFileSync(lightPath, "utf-8")) as ThemeJson,
    };
  }
  return BUILTIN_THEMES;
}

export function getAvailableThemes(): string[] {
  const themes = new Set<string>(Object.keys(getBuiltinThemes()));
  const customThemesDir = getCustomThemesDir();
  if (fs.existsSync(customThemesDir)) {
    const files = fs.readdirSync(customThemesDir);
    for (const file of files) {
      if (file.endsWith(".json")) {
        themes.add(file.slice(0, -5));
      }
    }
  }
  for (const name of registeredThemes.keys()) {
    themes.add(name);
  }
  return Array.from(themes).toSorted();
}

export interface ThemeInfo {
  name: string;
  path: string | undefined;
}

export function getAvailableThemesWithPaths(): ThemeInfo[] {
  const themesDir = getThemesDir();
  const customThemesDir = getCustomThemesDir();
  const result: ThemeInfo[] = [];

  // Built-in themes
  for (const name of Object.keys(getBuiltinThemes())) {
    result.push({ name, path: path.join(themesDir, `${name}.json`) });
  }

  // Custom themes
  if (fs.existsSync(customThemesDir)) {
    for (const file of fs.readdirSync(customThemesDir)) {
      if (file.endsWith(".json")) {
        const name = file.slice(0, -5);
        if (!result.some((t) => t.name === name)) {
          result.push({ name, path: path.join(customThemesDir, file) });
        }
      }
    }
  }

  for (const [name, theme] of registeredThemes.entries()) {
    if (!result.some((t) => t.name === name)) {
      result.push({ name, path: theme.sourcePath });
    }
  }

  return result.toSorted((a, b) => a.name.localeCompare(b.name));
}

function parseThemeJson(label: string, json: unknown): ThemeJson {
  if (!validateThemeJson.Check(json)) {
    const errors = Array.from(validateThemeJson.Errors(json));
    const missingColors = new Set<string>();
    const otherErrors: string[] = [];

    for (const error of errors) {
      if (error.keyword === "required" && error.instancePath === "/colors") {
        const requiredProperties = (error.params as { requiredProperties?: string[] })
          .requiredProperties;
        for (const requiredProperty of requiredProperties ?? []) {
          missingColors.add(requiredProperty);
        }
        continue;
      }

      const path = error.instancePath || "/";
      otherErrors.push(`  - ${path}: ${error.message}`);
    }

    let errorMessage = `Invalid theme "${label}":\n`;
    if (missingColors.size > 0) {
      errorMessage += "\nMissing required color tokens:\n";
      errorMessage += Array.from(missingColors)
        .toSorted()
        .map((color) => `  - ${color}`)
        .join("\n");
      errorMessage += '\n\nPlease add these colors to your theme\'s "colors" object.';
      errorMessage += "\nSee the built-in themes (dark.json, light.json) for reference values.";
    }
    if (otherErrors.length > 0) {
      errorMessage += `\n\nOther errors:\n${otherErrors.join("\n")}`;
    }

    throw new Error(errorMessage);
  }

  return json;
}

function parseThemeJsonContent(label: string, content: string): ThemeJson {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse theme ${label}: ${message}`, { cause: error });
  }
  return parseThemeJson(label, json);
}

function loadThemeJson(name: string): ThemeJson {
  const builtinThemes = getBuiltinThemes();
  if (name in builtinThemes) {
    return builtinThemes[name];
  }
  const registeredTheme = registeredThemes.get(name);
  if (registeredTheme?.sourcePath) {
    const content = fs.readFileSync(registeredTheme.sourcePath, "utf-8");
    return parseThemeJsonContent(registeredTheme.sourcePath, content);
  }
  if (registeredTheme) {
    throw new Error(`Theme "${name}" does not have a source path for export`);
  }
  const customThemesDir = getCustomThemesDir();
  const themePath = path.join(customThemesDir, `${name}.json`);
  if (!fs.existsSync(themePath)) {
    throw new Error(`Theme not found: ${name}`);
  }
  const content = fs.readFileSync(themePath, "utf-8");
  return parseThemeJsonContent(name, content);
}

function createTheme(themeJson: ThemeJson, mode?: ColorMode, sourcePath?: string): Theme {
  const colorMode = mode ?? (getCapabilities().trueColor ? "truecolor" : "256color");
  const resolvedColors = resolveThemeColors(themeJson.colors, themeJson.vars);
  const fgColors: Record<ThemeColor, string | number> = {} as Record<ThemeColor, string | number>;
  const bgColors: Record<ThemeBg, string | number> = {} as Record<ThemeBg, string | number>;
  const bgColorKeys: Set<string> = new Set([
    "selectedBg",
    "userMessageBg",
    "customMessageBg",
    "toolPendingBg",
    "toolSuccessBg",
    "toolErrorBg",
  ]);
  for (const [key, value] of Object.entries(resolvedColors)) {
    if (bgColorKeys.has(key)) {
      bgColors[key as ThemeBg] = value;
    } else {
      fgColors[key as ThemeColor] = value;
    }
  }
  return new Theme(fgColors, bgColors, colorMode, {
    name: themeJson.name,
    sourcePath,
  });
}

export function loadThemeFromPath(themePath: string, mode?: ColorMode): Theme {
  const content = fs.readFileSync(themePath, "utf-8");
  const themeJson = parseThemeJsonContent(themePath, content);
  return createTheme(themeJson, mode, themePath);
}

function loadTheme(name: string, mode?: ColorMode): Theme {
  const registeredTheme = registeredThemes.get(name);
  if (registeredTheme) {
    return registeredTheme;
  }
  const themeJson = loadThemeJson(name);
  return createTheme(themeJson, mode);
}

export function getThemeByName(name: string): Theme | undefined {
  try {
    return loadTheme(name);
  } catch {
    return undefined;
  }
}

export type TerminalTheme = "dark" | "light";

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface TerminalThemeDetection {
  theme: TerminalTheme;
  source: "terminal background" | "COLORFGBG" | "fallback";
  detail: string;
  confidence: "high" | "low";
}

export interface TerminalThemeDetectionOptions {
  env?: NodeJS.ProcessEnv;
}

function getColorFgBgBackgroundIndex(colorfgbg: string): number | undefined {
  const parts = colorfgbg.split(";");
  for (let i = parts.length - 1; i >= 0; i--) {
    const bg = Number.parseInt(parts[i].trim(), 10);
    if (Number.isInteger(bg) && bg >= 0 && bg <= 255) {
      return bg;
    }
  }
  return undefined;
}

function getRgbColorLuminance({ r, g, b }: RgbColor): number {
  const toLinear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function getAnsiColorLuminance(index: number): number {
  return getRgbColorLuminance(hexToRgb(ansi256ToHex(index)));
}

export function getThemeForRgbColor(rgb: RgbColor): TerminalTheme {
  return getRgbColorLuminance(rgb) >= 0.5 ? "light" : "dark";
}

function parseOscHexChannel(channel: string): number | undefined {
  if (!/^[0-9a-f]+$/i.test(channel)) {
    return undefined;
  }
  const max = 16 ** channel.length - 1;
  if (max <= 0) {
    return undefined;
  }
  return Math.round((Number.parseInt(channel, 16) / max) * 255);
}

export function parseOsc11BackgroundColor(data: string): RgbColor | undefined {
  const prefix = "\u001B]11;";
  const belSuffix = "\u0007";
  const escSuffix = "\u001B\\";
  if (!data.startsWith(prefix)) {
    return undefined;
  }

  const suffixLength = data.endsWith(belSuffix)
    ? belSuffix.length
    : data.endsWith(escSuffix)
      ? escSuffix.length
      : 0;
  if (suffixLength === 0) {
    return undefined;
  }

  const value = data.slice(prefix.length, -suffixLength).trim();
  if (value.includes("\u0007") || value.includes("\u001B")) {
    return undefined;
  }
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    if (/^[0-9a-f]{6}$/i.test(hex)) {
      return hexToRgb(value);
    }
    if (/^[0-9a-f]{12}$/i.test(hex)) {
      const r = parseOscHexChannel(hex.slice(0, 4));
      const g = parseOscHexChannel(hex.slice(4, 8));
      const b = parseOscHexChannel(hex.slice(8, 12));
      return r !== undefined && g !== undefined && b !== undefined ? { r, g, b } : undefined;
    }
    return undefined;
  }

  const rgbValue = value.replace(/^rgba?:/i, "");
  const [red, green, blue] = rgbValue.split("/");
  if (red === undefined || green === undefined || blue === undefined) {
    return undefined;
  }
  const r = parseOscHexChannel(red);
  const g = parseOscHexChannel(green);
  const b = parseOscHexChannel(blue);
  return r !== undefined && g !== undefined && b !== undefined ? { r, g, b } : undefined;
}

export function detectTerminalBackground(
  options: TerminalThemeDetectionOptions = {},
): TerminalThemeDetection {
  const env = options.env ?? process.env;
  const colorfgbg = env.COLORFGBG || "";
  const bg = getColorFgBgBackgroundIndex(colorfgbg);
  if (bg !== undefined) {
    return {
      theme: getAnsiColorLuminance(bg) >= 0.5 ? "light" : "dark",
      source: "COLORFGBG",
      detail: `background color index ${bg}`,
      confidence: "high",
    };
  }

  return {
    theme: "dark",
    source: "fallback",
    detail: "no terminal background hint found",
    confidence: "low",
  };
}

export function getDefaultTheme(): string {
  return detectTerminalBackground().theme;
}

// ============================================================================
// Global Theme Instance
// ============================================================================

// Use globalThis to share theme across module loaders (tsx + jiti in dev mode)
const THEME_KEY = Symbol.for("openclaw:agent-theme");

// Export theme as a getter that reads from globalThis
// This ensures all module instances (tsx, jiti) see the same theme
export const theme: Theme = new Proxy({} as Theme, {
  get(_target, prop) {
    const t = (globalThis as Record<symbol, Theme>)[THEME_KEY];
    if (!t) {
      throw new Error("Theme not initialized. Call initTheme() first.");
    }
    return (t as unknown as Record<string | symbol, unknown>)[prop];
  },
});

function setGlobalTheme(t: Theme): void {
  (globalThis as Record<symbol, Theme>)[THEME_KEY] = t;
}

let currentThemeName: string | undefined;
let themeWatcher: fs.FSWatcher | undefined;
let themeReloadTimer: NodeJS.Timeout | undefined;
let onThemeChangeCallback: (() => void) | undefined;
const registeredThemes = new Map<string, Theme>();

export function setRegisteredThemes(themes: Theme[]): void {
  registeredThemes.clear();
  for (const theme of themes) {
    if (theme.name) {
      registeredThemes.set(theme.name, theme);
    }
  }
}

export function initTheme(themeName?: string, enableWatcher: boolean = false): void {
  const name = themeName ?? getDefaultTheme();
  currentThemeName = name;
  try {
    setGlobalTheme(loadTheme(name));
    if (enableWatcher) {
      startThemeWatcher();
    }
  } catch {
    // Theme is invalid - fall back to dark theme silently
    currentThemeName = "dark";
    setGlobalTheme(loadTheme("dark"));
    // Don't start watcher for fallback theme
  }
}

export function setTheme(
  name: string,
  enableWatcher: boolean = false,
): { success: boolean; error?: string } {
  currentThemeName = name;
  try {
    setGlobalTheme(loadTheme(name));
    if (enableWatcher) {
      startThemeWatcher();
    }
    if (onThemeChangeCallback) {
      onThemeChangeCallback();
    }
    return { success: true };
  } catch (error) {
    // Theme is invalid - fall back to dark theme
    currentThemeName = "dark";
    setGlobalTheme(loadTheme("dark"));
    // Don't start watcher for fallback theme
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function setThemeInstance(themeInstance: Theme): void {
  setGlobalTheme(themeInstance);
  currentThemeName = "<in-memory>";
  stopThemeWatcher(); // Can't watch a direct instance
  if (onThemeChangeCallback) {
    onThemeChangeCallback();
  }
}

export function onThemeChange(callback: () => void): void {
  onThemeChangeCallback = callback;
}

function startThemeWatcher(): void {
  stopThemeWatcher();

  // Only watch if it's a custom theme (not built-in)
  if (!currentThemeName || currentThemeName === "dark" || currentThemeName === "light") {
    return;
  }

  const customThemesDir = getCustomThemesDir();
  const watchedThemeName = currentThemeName;
  const watchedFileName = `${watchedThemeName}.json`;
  const themeFile = path.join(customThemesDir, watchedFileName);

  // Only watch if the file exists
  if (!fs.existsSync(themeFile)) {
    return;
  }

  const scheduleReload = () => {
    if (themeReloadTimer) {
      clearTimeout(themeReloadTimer);
    }
    themeReloadTimer = setTimeout(() => {
      themeReloadTimer = undefined;

      // Ignore stale timers after switching themes or stopping the watcher
      if (currentThemeName !== watchedThemeName) {
        return;
      }

      // Keep the last successfully loaded theme active if the file is temporarily missing
      if (!fs.existsSync(themeFile)) {
        return;
      }

      try {
        // Reload the theme from disk and refresh the registry cache
        const reloadedTheme = loadThemeFromPath(themeFile);
        registeredThemes.set(watchedThemeName, reloadedTheme);
        setGlobalTheme(reloadedTheme);
        // Notify callback (to invalidate UI)
        if (onThemeChangeCallback) {
          onThemeChangeCallback();
        }
      } catch {
        // Ignore errors (file might be in invalid state while being edited)
      }
    }, 100);
  };

  themeWatcher =
    watchWithErrorHandler(
      customThemesDir,
      (_eventType, filename) => {
        if (currentThemeName !== watchedThemeName) {
          return;
        }
        if (!filename) {
          scheduleReload();
          return;
        }
        if (filename !== watchedFileName) {
          return;
        }
        scheduleReload();
      },
      () => {
        closeWatcher(themeWatcher);
        themeWatcher = undefined;
      },
    ) ?? undefined;
}

export function stopThemeWatcher(): void {
  if (themeReloadTimer) {
    clearTimeout(themeReloadTimer);
    themeReloadTimer = undefined;
  }
  closeWatcher(themeWatcher);
  themeWatcher = undefined;
}

// ============================================================================
// HTML Export Helpers
// ============================================================================

/**
 * Convert a 256-color index to hex string.
 * Indices 0-15: basic colors (approximate)
 * Indices 16-231: 6x6x6 color cube
 * Indices 232-255: grayscale ramp
 */
function ansi256ToHex(index: number): string {
  // Basic colors (0-15) - approximate common terminal values
  const basicColors = [
    "#000000",
    "#800000",
    "#008000",
    "#808000",
    "#000080",
    "#800080",
    "#008080",
    "#c0c0c0",
    "#808080",
    "#ff0000",
    "#00ff00",
    "#ffff00",
    "#0000ff",
    "#ff00ff",
    "#00ffff",
    "#ffffff",
  ];
  if (index < 16) {
    return basicColors[index];
  }

  // Color cube (16-231): 6x6x6 = 216 colors
  if (index < 232) {
    const cubeIndex = index - 16;
    const r = Math.floor(cubeIndex / 36);
    const g = Math.floor((cubeIndex % 36) / 6);
    const b = cubeIndex % 6;
    const toHex = (n: number) => (n === 0 ? 0 : 55 + n * 40).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  // Grayscale (232-255): 24 shades
  const gray = 8 + (index - 232) * 10;
  const grayHex = gray.toString(16).padStart(2, "0");
  return `#${grayHex}${grayHex}${grayHex}`;
}

/**
 * Get resolved theme colors as CSS-compatible hex strings.
 * Used by HTML export to generate CSS custom properties.
 */
export function getResolvedThemeColors(themeName?: string): Record<string, string> {
  const name = themeName ?? currentThemeName ?? getDefaultTheme();
  const isLight = name === "light";
  const themeJson = loadThemeJson(name);
  const resolved = resolveThemeColors(themeJson.colors, themeJson.vars);

  // Default text color for empty values (terminal uses default fg color)
  const defaultText = isLight ? "#000000" : "#e5e5e7";

  const cssColors: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value === "number") {
      cssColors[key] = ansi256ToHex(value);
    } else if (value === "") {
      // Empty means default terminal color - use sensible fallback for HTML
      cssColors[key] = defaultText;
    } else {
      cssColors[key] = value;
    }
  }
  return cssColors;
}

/**
 * Check if a theme is a "light" theme (for CSS that needs light/dark variants).
 */
export function isLightTheme(themeName?: string): boolean {
  // Currently just check the name - could be extended to analyze colors
  return themeName === "light";
}

/**
 * Get explicit export colors from theme JSON, if specified.
 * Returns undefined for each color that isn't explicitly set.
 */
export function getThemeExportColors(themeName?: string): {
  pageBg?: string;
  cardBg?: string;
  infoBg?: string;
} {
  const name = themeName ?? currentThemeName ?? getDefaultTheme();
  try {
    const themeJson = loadThemeJson(name);
    const exportSection = themeJson.export;
    if (!exportSection) {
      return {};
    }

    const vars = themeJson.vars ?? {};
    const resolve = (value: ColorValue | undefined): string | undefined => {
      if (value === undefined) {
        return undefined;
      }
      const resolved = resolveVarRefs(value, vars);
      if (typeof resolved === "number") {
        return ansi256ToHex(resolved);
      }
      if (resolved === "") {
        return undefined;
      }
      return resolved;
    };

    return {
      pageBg: resolve(exportSection.pageBg),
      cardBg: resolve(exportSection.cardBg),
      infoBg: resolve(exportSection.infoBg),
    };
  } catch {
    return {};
  }
}

// ============================================================================
// TUI Helpers
// ============================================================================

type CliHighlightTheme = Record<string, (s: string) => string>;

let cachedHighlightThemeFor: Theme | undefined;
let cachedCliHighlightTheme: CliHighlightTheme | undefined;

function buildCliHighlightTheme(t: Theme): CliHighlightTheme {
  return {
    keyword: (s: string) => t.fg("syntaxKeyword", s),
    built_in: (s: string) => t.fg("syntaxType", s),
    literal: (s: string) => t.fg("syntaxNumber", s),
    number: (s: string) => t.fg("syntaxNumber", s),
    string: (s: string) => t.fg("syntaxString", s),
    comment: (s: string) => t.fg("syntaxComment", s),
    function: (s: string) => t.fg("syntaxFunction", s),
    title: (s: string) => t.fg("syntaxFunction", s),
    class: (s: string) => t.fg("syntaxType", s),
    type: (s: string) => t.fg("syntaxType", s),
    attr: (s: string) => t.fg("syntaxVariable", s),
    variable: (s: string) => t.fg("syntaxVariable", s),
    params: (s: string) => t.fg("syntaxVariable", s),
    operator: (s: string) => t.fg("syntaxOperator", s),
    punctuation: (s: string) => t.fg("syntaxPunctuation", s),
  };
}

function getCliHighlightTheme(t: Theme): CliHighlightTheme {
  if (cachedHighlightThemeFor !== t || !cachedCliHighlightTheme) {
    cachedHighlightThemeFor = t;
    cachedCliHighlightTheme = buildCliHighlightTheme(t);
  }
  return cachedCliHighlightTheme;
}

/**
 * Highlight code with syntax coloring based on file extension or language.
 * Returns array of highlighted lines.
 */
export function highlightCode(code: string, lang?: string): string[] {
  // Validate language before highlighting to avoid stderr spam from cli-highlight
  const validLang = lang && supportsLanguage(lang) ? lang : undefined;
  // Skip highlighting when no valid language is specified. cli-highlight's
  // auto-detection is unreliable and can misidentify prose as AppleScript,
  // LiveCodeServer, etc., coloring random English words as keywords.
  if (!validLang) {
    return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
  }
  const opts = {
    language: validLang,
    ignoreIllegals: true,
    theme: getCliHighlightTheme(theme),
  };
  try {
    return highlight(code, opts).split("\n");
  } catch {
    return code.split("\n");
  }
}

/**
 * Get language identifier from file path extension.
 */
export function getLanguageFromPath(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext) {
    return undefined;
  }

  const extToLang: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    fish: "fish",
    ps1: "powershell",
    sql: "sql",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    sass: "sass",
    less: "less",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    md: "markdown",
    markdown: "markdown",
    dockerfile: "dockerfile",
    makefile: "makefile",
    cmake: "cmake",
    lua: "lua",
    perl: "perl",
    r: "r",
    scala: "scala",
    clj: "clojure",
    ex: "elixir",
    exs: "elixir",
    erl: "erlang",
    hs: "haskell",
    ml: "ocaml",
    vim: "vim",
    graphql: "graphql",
    proto: "protobuf",
    tf: "hcl",
    hcl: "hcl",
  };

  return extToLang[ext];
}

export function getMarkdownTheme(): MarkdownTheme {
  return {
    heading: (text: string) => theme.fg("mdHeading", text),
    link: (text: string) => theme.fg("mdLink", text),
    linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
    code: (text: string) => theme.fg("mdCode", text),
    codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
    quote: (text: string) => theme.fg("mdQuote", text),
    quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
    hr: (text: string) => theme.fg("mdHr", text),
    listBullet: (text: string) => theme.fg("mdListBullet", text),
    bold: (text: string) => theme.bold(text),
    italic: (text: string) => theme.italic(text),
    underline: (text: string) => theme.underline(text),
    strikethrough: (text: string) => chalk.strikethrough(text),
    highlightCode: (code: string, lang?: string): string[] => {
      // Validate language before highlighting to avoid stderr spam from cli-highlight
      const validLang = lang && supportsLanguage(lang) ? lang : undefined;
      // Skip highlighting when no valid language is specified. cli-highlight's
      // auto-detection is unreliable and can misidentify prose as AppleScript,
      // LiveCodeServer, etc., coloring random English words as keywords.
      if (!validLang) {
        return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
      }
      const opts = {
        language: validLang,
        ignoreIllegals: true,
        theme: getCliHighlightTheme(theme),
      };
      try {
        return highlight(code, opts).split("\n");
      } catch {
        return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
      }
    },
  };
}

export function getSelectListTheme(): SelectListTheme {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("muted", text),
    noMatch: (text: string) => theme.fg("muted", text),
  };
}

export function getEditorTheme(): EditorTheme {
  return {
    borderColor: (text: string) => theme.fg("borderMuted", text),
    selectList: getSelectListTheme(),
  };
}

export function getSettingsListTheme(): SettingsListTheme {
  return {
    label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
    value: (text: string, selected: boolean) =>
      selected ? theme.fg("accent", text) : theme.fg("muted", text),
    description: (text: string) => theme.fg("dim", text),
    cursor: theme.fg("accent", "→ "),
    hint: (text: string) => theme.fg("dim", text),
  };
}
