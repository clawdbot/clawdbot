import { asNullableRecord as readThemeRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  THEME_ID_PATTERN,
  describeThemeLabel,
  makeTokenMap,
  requireSafeCssValue,
  requireSafeFontFamilyValue,
  requireThemeId,
  type ImportedCustomTheme,
} from "../../app/custom-theme.ts";
import { readResponseTextWithLimit } from "../../lib/response-body.ts";

const TWEAKCN_HOSTS = new Set(["tweakcn.com", "www.tweakcn.com"]);
const MAX_TWEAKCN_THEME_BYTES = 200_000;
const TWEAKCN_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_FONT_BODY =
  '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const DEFAULT_MONO =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace';
const SAFE_COLOR_KEYWORDS = new Set(["black", "white", "transparent", "currentcolor"]);
const SAFE_COLOR_FUNCTION_PATTERN =
  /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\([a-z0-9+\-.,/%\s]+\)$/i;
const SAFE_HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// resolveModeVar validates every imported token; app/custom-theme.ts separately
// validates stored palettes before applying them during startup.
type TweakcnThemeResolution = {
  sourceUrl: string;
  fetchUrl: string;
  themeId: string;
};

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

function requireSafeExternalModeValue(value: unknown, label: string) {
  if (label === "font-sans" || label === "font-mono") {
    return requireSafeFontFamilyValue(value, label);
  }
  return requireSafeExternalColorValue(value, label);
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
): ImportedCustomTheme["light"] {
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

async function readJsonResponseWithLimit(response: Response): Promise<unknown> {
  const text = await readResponseTextWithLimit(response, {
    maxBytes: MAX_TWEAKCN_THEME_BYTES,
    tooLargeMessage: "tweakcn theme payload is too large.",
    missingBodyMessage: "tweakcn returned an unreadable theme payload.",
  });
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
