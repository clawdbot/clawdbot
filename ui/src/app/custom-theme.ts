import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
// Control UI module implements custom theme behavior.
import { normalizeOptionalString } from "../lib/string-coerce.ts";

const TWEAKCN_HOSTS = new Set(["tweakcn.com", "www.tweakcn.com"]);
const THEME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CUSTOM_THEME_STYLE_ID = "openclaw-custom-theme";
const MAX_TWEAKCN_THEME_BYTES = 200_000;
const MAX_CSS_TOKEN_LENGTH = 240;
const TWEAKCN_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_FONT_BODY =
  '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const DEFAULT_MONO =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace';
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
const SAFE_COLOR_KEYWORDS = new Set(["black", "white", "transparent", "currentcolor"]);
const SAFE_COLOR_FUNCTION_PATTERN =
  /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\([a-z0-9+\-.,/%\s]+\)$/i;
const SAFE_HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
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

// Shape checks are intentionally shallow: normalizeStoredTokenMap and
// resolveModeVar re-validate every token (presence, length, safe CSS) and
// throw on anything off, so no schema library is needed at this boundary.
function readThemeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type TweakcnThemeResolution = {
  sourceUrl: string;
  fetchUrl: string;
  themeId: string;
};

function requireThemeId(value: string) {
  if (!THEME_ID_PATTERN.test(value)) {
    throw new Error("Unsupported tweakcn link. Expected a theme share URL.");
  }
}

function normalizeThemeIdFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  const themeId = segments.at(-1);
  if (!themeId) {
    return null;
  }
  if (segments.length === 2 && segments[0] === "themes") {
    requireThemeId(themeId);
    return themeId;
  }
  if (segments.length === 3 && segments[0] === "r" && segments[1] === "themes") {
    requireThemeId(themeId);
    return themeId;
  }
  return null;
}

function normalizePastedThemeInput(input: string): string {
  const normalized = normalizeOptionalString(input);
  if (!normalized) {
    throw new Error("Paste a tweakcn theme link to import.");
  }
  const inputValue = normalized.replace(/[.,;:]+$/, "");
  if (THEME_ID_PATTERN.test(inputValue)) {
    return `https://tweakcn.com/themes/${inputValue}`;
  }
  if (inputValue.startsWith("/themes/") || inputValue.startsWith("/r/themes/")) {
    return `https://tweakcn.com${inputValue}`;
  }
  if (/^(?:www\.)?tweakcn\.com\//i.test(inputValue)) {
    return `https://${inputValue}`;
  }
  const embeddedUrl = inputValue
    .match(/https?:\/\/(?:www\.)?tweakcn\.com\/[^\s<>"')]+/i)?.[0]
    ?.replace(/[.,;:]+$/, "");
  return embeddedUrl ?? inputValue;
}

function normalizeThemeIdFromUrl(parsed: URL): string {
  const pathThemeId = normalizeThemeIdFromPath(parsed.pathname);
  if (pathThemeId) {
    return pathThemeId;
  }
  const queryThemeId =
    parsed.searchParams.get("theme") ??
    parsed.searchParams.get("themeId") ??
    parsed.searchParams.get("id");
  if (queryThemeId) {
    requireThemeId(queryThemeId);
    return queryThemeId;
  }
  throw new Error("Unsupported tweakcn link. Expected a theme share URL.");
}

function requireSafeCssValue(value: unknown, label: string) {
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

function requireSafeExternalColorValue(value: unknown, label: string) {
  const normalized = requireSafeCssValue(value, label);
  const lowered = normalized.toLowerCase();
  if (
    SAFE_COLOR_KEYWORDS.has(lowered) ||
    SAFE_HEX_COLOR_PATTERN.test(normalized) ||
    SAFE_COLOR_FUNCTION_PATTERN.test(normalized)
  ) {
    return normalized;
  }
  throw new Error(`Unsupported tweakcn token: ${label}`);
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

function requireSafeFontFamilyValue(value: unknown, label: string) {
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

function requireSafeExternalModeValue(value: unknown, label: string) {
  if (label === "font-sans" || label === "font-mono") {
    return requireSafeFontFamilyValue(value, label);
  }
  return requireSafeExternalColorValue(value, label);
}

function makeTokenMap(entries: Array<[ModeTokenName, string]>): ThemeTokenMap {
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

function resolveModeVar(
  theme: Record<string, unknown>,
  shared: Record<string, unknown> | undefined,
  key: string,
  fallback?: string,
) {
  const themeValue = normalizeOptionalString(theme[key]);
  if (themeValue) {
    return requireSafeExternalModeValue(themeValue, key);
  }
  const sharedValue = normalizeOptionalString(shared?.[key]);
  if (sharedValue) {
    return requireSafeExternalModeValue(sharedValue, key);
  }
  if (fallback != null) {
    return key === "font-sans" || key === "font-mono"
      ? requireSafeFontFamilyValue(fallback, key)
      : requireSafeCssValue(fallback, key);
  }
  throw new Error(`tweakcn theme is missing required token: ${key}`);
}

function normalizeModeTokenMap(
  mode: "light" | "dark",
  theme: Record<string, unknown>,
  shared: Record<string, unknown> | undefined,
): ThemeTokenMap {
  const isLight = mode === "light";
  const contrastTarget = isLight ? "black" : "white";
  const background = resolveModeVar(theme, shared, "background");
  const foreground = resolveModeVar(theme, shared, "foreground");
  const card = resolveModeVar(theme, shared, "card");
  const cardForeground = resolveModeVar(theme, shared, "card-foreground");
  const popover = resolveModeVar(theme, shared, "popover");
  const popoverForeground = resolveModeVar(theme, shared, "popover-foreground");
  const primary = resolveModeVar(theme, shared, "primary");
  const primaryForeground = resolveModeVar(theme, shared, "primary-foreground");
  const secondary = resolveModeVar(theme, shared, "secondary");
  const secondaryForeground = resolveModeVar(theme, shared, "secondary-foreground");
  const muted = resolveModeVar(theme, shared, "muted");
  const mutedForeground = resolveModeVar(theme, shared, "muted-foreground");
  const accent = resolveModeVar(theme, shared, "accent");
  const accentForeground = resolveModeVar(theme, shared, "accent-foreground");
  const destructive = resolveModeVar(theme, shared, "destructive");
  const destructiveForeground = resolveModeVar(theme, shared, "destructive-foreground");
  const border = resolveModeVar(theme, shared, "border");
  const input = resolveModeVar(theme, shared, "input");
  const ring = resolveModeVar(theme, shared, "ring");
  const fontBody = resolveModeVar(theme, shared, "font-sans", DEFAULT_FONT_BODY);
  const mono = resolveModeVar(theme, shared, "font-mono", DEFAULT_MONO);

  return makeTokenMap([
    ["bg", background],
    ["bg-accent", "color-mix(in srgb, var(--bg) 88%, var(--card) 12%)"],
    ["bg-elevated", card],
    ["bg-hover", "color-mix(in srgb, var(--muted) 68%, var(--bg) 32%)"],
    ["bg-muted", muted],
    ["bg-content", "color-mix(in srgb, var(--bg) 92%, var(--card) 8%)"],
    ["card", card],
    ["card-foreground", cardForeground],
    ["card-highlight", `color-mix(in srgb, var(--text) ${isLight ? "3" : "5"}%, transparent)`],
    ["popover", popover],
    ["popover-foreground", popoverForeground],
    ["panel", background],
    ["panel-strong", card],
    ["panel-hover", "color-mix(in srgb, var(--card) 76%, var(--muted) 24%)"],
    ["chrome", "color-mix(in srgb, var(--bg) 96%, transparent)"],
    ["chrome-strong", "color-mix(in srgb, var(--bg) 98%, transparent)"],
    ["text", foreground],
    ["text-strong", foreground],
    ["chat-text", foreground],
    ["muted", mutedForeground],
    ["muted-strong", "color-mix(in srgb, var(--muted) 84%, var(--text) 16%)"],
    ["muted-foreground", mutedForeground],
    ["border", border],
    ["border-strong", "color-mix(in srgb, var(--border) 72%, var(--text) 28%)"],
    ["border-hover", "color-mix(in srgb, var(--border) 55%, var(--text) 45%)"],
    ["input", input],
    ["ring", ring],
    ["accent", accent],
    ["accent-hover", `color-mix(in srgb, var(--accent) 82%, ${contrastTarget} 18%)`],
    ["accent-muted", accent],
    ["accent-subtle", `color-mix(in srgb, var(--accent) ${isLight ? "10" : "16"}%, transparent)`],
    ["accent-foreground", accentForeground],
    ["accent-glow", `color-mix(in srgb, var(--accent) ${isLight ? "18" : "30"}%, transparent)`],
    ["primary", primary],
    ["primary-foreground", primaryForeground],
    ["secondary", secondary],
    ["secondary-foreground", secondaryForeground],
    ["accent-2", primary],
    ["accent-2-muted", "color-mix(in srgb, var(--accent-2) 72%, transparent)"],
    [
      "accent-2-subtle",
      `color-mix(in srgb, var(--accent-2) ${isLight ? "8" : "12"}%, transparent)`,
    ],
    ["destructive", destructive],
    ["destructive-foreground", destructiveForeground],
    ["danger", destructive],
    ["danger-muted", "color-mix(in srgb, var(--danger) 75%, transparent)"],
    ["danger-subtle", `color-mix(in srgb, var(--danger) ${isLight ? "8" : "12"}%, transparent)`],
    ["focus", `color-mix(in srgb, var(--ring) ${isLight ? "14" : "22"}%, transparent)`],
    [
      "focus-ring",
      `0 0 0 2px var(--bg), 0 0 0 3px color-mix(in srgb, var(--ring) ${isLight ? "70" : "80"}%, transparent)`,
    ],
    ["focus-glow", "0 0 0 2px var(--bg), 0 0 0 3px var(--ring), 0 0 16px var(--accent-glow)"],
    ["font-body", fontBody],
    ["font-display", fontBody],
    ["mono", mono],
    ["grid-line", `color-mix(in srgb, var(--text) ${isLight ? "4" : "3"}%, transparent)`],
  ]);
}

function describeThemeLabel(value: string | undefined) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return "Custom";
  }
  return truncateUtf16Safe(normalized, 80);
}

function normalizeTweakcnThemeUrl(input: string): TweakcnThemeResolution {
  const normalized = normalizePastedThemeInput(input);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("Paste a full tweakcn URL.");
  }
  if (!TWEAKCN_HOSTS.has(parsed.hostname)) {
    throw new Error("Only tweakcn.com theme links are supported.");
  }
  const themeId = normalizeThemeIdFromUrl(parsed);
  return {
    themeId,
    sourceUrl: `https://tweakcn.com/themes/${themeId}`,
    fetchUrl: `https://tweakcn.com/r/themes/${themeId}`,
  };
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

function normalizeImportedCustomTheme(
  payload: unknown,
  resolution: Pick<TweakcnThemeResolution, "sourceUrl" | "themeId">,
): ImportedCustomTheme {
  const record = readThemeRecord(payload);
  const cssVars = readThemeRecord(record?.cssVars);
  const light = readThemeRecord(cssVars?.light);
  const dark = readThemeRecord(cssVars?.dark);
  const shared = cssVars?.theme === undefined ? undefined : readThemeRecord(cssVars.theme);
  if (!record || !cssVars || !light || !dark || shared === null) {
    throw new Error("tweakcn returned an invalid theme payload.");
  }
  return {
    sourceUrl: resolution.sourceUrl,
    themeId: resolution.themeId,
    label: describeThemeLabel(normalizeOptionalString(record.name)),
    importedAt: new Date().toISOString(),
    light: normalizeModeTokenMap("light", light, shared),
    dark: normalizeModeTokenMap("dark", dark, shared),
  };
}

function assertTweakcnResponseUrl(value: string | undefined) {
  if (!value) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Unexpected tweakcn import response URL.");
  }
  if (parsed.protocol !== "https:" || !TWEAKCN_HOSTS.has(parsed.hostname)) {
    throw new Error("Unexpected redirect during tweakcn import.");
  }
}

function parseContentLength(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function readResponseTextWithLimit(response: Response): Promise<string> {
  const contentLength = parseContentLength(response.headers);
  if (contentLength != null && contentLength > MAX_TWEAKCN_THEME_BYTES) {
    throw new Error("tweakcn theme payload is too large.");
  }

  if (!response.body) {
    throw new Error("tweakcn returned an unreadable theme payload.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_TWEAKCN_THEME_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("tweakcn theme payload is too large.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

async function readJsonResponseWithLimit(response: Response): Promise<unknown> {
  const text = await readResponseTextWithLimit(response);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("tweakcn returned invalid JSON.");
  }
}

export async function importCustomThemeFromUrl(
  input: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ImportedCustomTheme> {
  const resolution = normalizeTweakcnThemeUrl(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TWEAKCN_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(resolution.fetchUrl, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    assertTweakcnResponseUrl(response.url);
    if (!response.ok) {
      throw new Error(`tweakcn import failed (${response.status}).`);
    }
    const payload = await readJsonResponseWithLimit(response);
    return normalizeImportedCustomTheme(payload, resolution);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("tweakcn import timed out.", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
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
