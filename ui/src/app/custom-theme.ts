import { asNullableRecord as readThemeRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

export const THEME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CUSTOM_THEME_STYLE_ID = "openclaw-custom-theme";
const MAX_CSS_TOKEN_LENGTH = 240;
const FORBIDDEN_CSS_VALUE_PARTS = [
  "url(",
  "image(",
  "image-set(",
  "-webkit-image-set(",
  "cross-fade(",
  "element(",
  "-moz-element(",
  "paint(",
  "@import",
  "expression(",
] as const;
const SAFE_FONT_FAMILY_PUNCTUATION = new Set([",", "'", '"', ".", "_", "-"]);

const MODE_TOKEN_ORDER = [
  "bg",
  "bg-accent",
  "bg-elevated",
  "bg-hover",
  "bg-muted",
  "bg-content",
  "card",
  "card-foreground",
  "card-highlight",
  "popover",
  "popover-foreground",
  "panel",
  "panel-strong",
  "panel-hover",
  "chrome",
  "chrome-strong",
  "text",
  "text-strong",
  "chat-text",
  "muted",
  "muted-strong",
  "muted-foreground",
  "border",
  "border-strong",
  "border-hover",
  "input",
  "ring",
  "accent",
  "accent-hover",
  "accent-muted",
  "accent-subtle",
  "accent-foreground",
  "accent-glow",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "accent-2",
  "accent-2-muted",
  "accent-2-subtle",
  "destructive",
  "destructive-foreground",
  "danger",
  "danger-muted",
  "danger-subtle",
  "focus",
  "focus-ring",
  "focus-glow",
  "font-body",
  "font-display",
  "mono",
  "grid-line",
] as const;

type ModeTokenName = (typeof MODE_TOKEN_ORDER)[number];
type ThemeTokenMap = Record<ModeTokenName, string>;

export type ImportedCustomTheme = {
  sourceUrl: string;
  themeId: string;
  label: string;
  importedAt: string;
  light: ThemeTokenMap;
  dark: ThemeTokenMap;
};

export function requireThemeId(value: string) {
  if (!THEME_ID_PATTERN.test(value)) {
    throw new Error("Unsupported tweakcn link. Expected a theme share URL.");
  }
}

export function requireSafeCssValue(value: unknown, label: string) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`Unsupported tweakcn token: ${label}`);
  }
  if (normalized.length > MAX_CSS_TOKEN_LENGTH) {
    throw new Error(`Unsupported tweakcn token: ${label}`);
  }
  const lowered = normalized.toLowerCase();
  if (FORBIDDEN_CSS_VALUE_PARTS.some((part) => lowered.includes(part))) {
    throw new Error(`Unsupported tweakcn token: ${label}`);
  }
  if (normalized.includes("/*") || normalized.includes("*/") || normalized.includes("\\")) {
    throw new Error(`Unsupported tweakcn token: ${label}`);
  }
  for (const char of normalized) {
    const code = char.charCodeAt(0);
    if (
      code < 0x20 ||
      code === 0x7f ||
      char === "{" ||
      char === "}" ||
      char === ";" ||
      char === "<" ||
      char === ">" ||
      char === "`"
    ) {
      throw new Error(`Unsupported tweakcn token: ${label}`);
    }
  }
  return normalized;
}

function isSafeFontFamilyCharacter(char: string) {
  const code = char.charCodeAt(0);
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    char === " " ||
    SAFE_FONT_FAMILY_PUNCTUATION.has(char)
  );
}

export function requireSafeFontFamilyValue(value: unknown, label: string) {
  const normalized = requireSafeCssValue(value, label);
  if (
    normalized.includes("(") ||
    normalized.includes(")") ||
    !Array.from(normalized).every(isSafeFontFamilyCharacter)
  ) {
    throw new Error(`Unsupported tweakcn token: ${label}`);
  }
  return normalized;
}

export function makeTokenMap(entries: Array<[ModeTokenName, string]>): ThemeTokenMap {
  return Object.fromEntries(entries) as ThemeTokenMap;
}

function normalizeStoredTokenMap(value: Record<string, unknown> | undefined): ThemeTokenMap | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const entries: Array<[ModeTokenName, string]> = [];
  for (const key of MODE_TOKEN_ORDER) {
    const normalized =
      key === "font-body" || key === "font-display" || key === "mono"
        ? requireSafeFontFamilyValue(value[key], key)
        : requireSafeCssValue(value[key], key);
    entries.push([key, normalized]);
  }
  return makeTokenMap(entries);
}

export function describeThemeLabel(value: string | undefined) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return "Custom";
  }
  return truncateUtf16Safe(normalized, 80);
}

export function parseImportedCustomTheme(value: unknown): ImportedCustomTheme | null {
  const record = readThemeRecord(value);
  if (!record) {
    return null;
  }
  const { sourceUrl, themeId, label, importedAt } = record;
  if (
    typeof sourceUrl !== "string" ||
    typeof themeId !== "string" ||
    typeof label !== "string" ||
    typeof importedAt !== "string"
  ) {
    return null;
  }
  try {
    requireThemeId(themeId);
    const light = normalizeStoredTokenMap(readThemeRecord(record.light) ?? undefined);
    const dark = normalizeStoredTokenMap(readThemeRecord(record.dark) ?? undefined);
    if (!light || !dark) {
      return null;
    }
    return {
      sourceUrl,
      themeId,
      label: describeThemeLabel(label),
      importedAt,
      light,
      dark,
    };
  } catch {
    return null;
  }
}

function buildCustomThemeStyles(theme: ImportedCustomTheme) {
  const light = normalizeStoredTokenMap(theme.light);
  const dark = normalizeStoredTokenMap(theme.dark);
  if (!light || !dark) {
    throw new Error("Stored custom theme is missing required tokens.");
  }
  const renderDeclarations = (modeTokens: ThemeTokenMap) =>
    MODE_TOKEN_ORDER.map((key) => `  --${key}: ${modeTokens[key]};`).join("\n");
  return [
    `:root[data-theme="custom"] {`,
    renderDeclarations(dark),
    `}`,
    `:root[data-theme="custom-light"] {`,
    renderDeclarations(light),
    `}`,
  ].join("\n");
}

export function syncCustomThemeStyleTag(theme: ImportedCustomTheme | null | undefined) {
  if (typeof document === "undefined") {
    return;
  }
  let style = document.getElementById(CUSTOM_THEME_STYLE_ID) as HTMLStyleElement | null;
  if (!theme) {
    style?.remove();
    return;
  }
  let cssText;
  try {
    cssText = buildCustomThemeStyles(theme);
  } catch {
    style?.remove();
    return;
  }
  if (!cssText) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = CUSTOM_THEME_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = cssText;
}
