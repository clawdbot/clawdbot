import { UI_APPEARANCE_TYPEFACE_VALUES } from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";
import { inferControlUiPublicAssetPath } from "./public-assets.ts";
import type { ThemeName } from "./theme.ts";

export type TypefaceId = (typeof UI_APPEARANCE_TYPEFACE_VALUES)[number];
type TypefacePair = { ui: TypefaceId; chat: TypefaceId };

const FONT_FALLBACKS = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace',
};
const TYPEFACE_METADATA: Record<
  TypefaceId,
  { label: string; family?: string; kind: keyof typeof FONT_FALLBACKS }
> = {
  "instrument-sans": { label: "Instrument Sans", kind: "sans" },
  geist: { label: "Geist", kind: "sans" },
  "dm-sans": { label: "DM Sans", kind: "sans" },
  "ibm-plex-sans": { label: "IBM Plex Sans", kind: "sans" },
  "space-grotesk": { label: "Space Grotesk", kind: "sans" },
  "atkinson-hyperlegible": {
    label: "Atkinson Hyperlegible",
    family: "Atkinson Hyperlegible Next",
    kind: "sans",
  },
  fraunces: { label: "Fraunces", kind: "serif" },
  lora: { label: "Lora", kind: "serif" },
  "jetbrains-mono": { label: "JetBrains Mono", kind: "mono" },
  system: { label: "System", kind: "sans" },
};

export const TYPEFACES = Object.fromEntries(
  UI_APPEARANCE_TYPEFACE_VALUES.map((id) => {
    const { label, family = label, kind } = TYPEFACE_METADATA[id];
    const stack = id === "system" ? FONT_FALLBACKS.sans : `"${family}", ${FONT_FALLBACKS[kind]}`;
    return [id, { label, stack, asset: id === "system" ? undefined : `fonts/${id}.css` }] as const;
  }),
  // SAFETY: Mapping the complete wire tuple emits one typed entry for every TypefaceId.
) as Record<
  TypefaceId,
  { label: string; stack: string; asset: `fonts/${TypefaceId}.css` | undefined }
>;

export const THEME_TYPEFACES = {
  claw: { ui: "instrument-sans", chat: "instrument-sans" },
  knot: { ui: "geist", chat: "geist" },
  dash: { ui: "dm-sans", chat: "fraunces" },
  absolutely: { ui: "space-grotesk", chat: "lora" },
  tide: { ui: "ibm-plex-sans", chat: "ibm-plex-sans" },
  beacon: { ui: "atkinson-hyperlegible", chat: "atkinson-hyperlegible" },
  phosphor: { ui: "jetbrains-mono", chat: "jetbrains-mono" },
  crt: { ui: "jetbrains-mono", chat: "jetbrains-mono" },
  manuscript: { ui: "lora", chat: "lora" },
  rose: { ui: "dm-sans", chat: "dm-sans" },
  miami: { ui: "space-grotesk", chat: "space-grotesk" },
  custom: { ui: "system", chat: "system" },
} satisfies Record<ThemeName, TypefacePair>;

// The wire contract owns storable overrides; browser and profile inputs must
// reject the same unknown values rather than turning them into CSS families.
export function normalizeTypefaceOverride(value: unknown): TypefaceId | undefined {
  return UI_APPEARANCE_TYPEFACE_VALUES.find((face) => face === value);
}

export function resolveTypefaces(
  theme: ThemeName,
  ui?: TypefaceId,
  chat?: TypefaceId,
): TypefacePair {
  const defaults = THEME_TYPEFACES[theme];
  return { ui: ui ?? defaults.ui, chat: chat ?? defaults.chat };
}

// Load faces only when selected or previewed; retain them so switching slots
// or reopening specimens never replaces an already loaded stylesheet.
function loadTypefaceStylesheet(face: TypefaceId): void {
  const id = `openclaw-typeface-${face}`;
  const asset = TYPEFACES[face].asset;
  if (!asset || document.getElementById(id)) {
    return;
  }
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = inferControlUiPublicAssetPath(asset);
  document.head.append(link);
}

export function syncTypefaceStylesheets(faces: TypefacePair): void {
  if (typeof document === "undefined") {
    return;
  }
  loadTypefaceStylesheet(faces.ui);
  loadTypefaceStylesheet(faces.chat);
  // base.css --mono names JetBrains Mono for every theme's code spans, but only
  // the @font-face declaration here makes that true; the woff2 itself downloads
  // lazily on the first rendered code glyph, so this costs one small stylesheet.
  loadTypefaceStylesheet("jetbrains-mono");
}

export function loadTypefaceSpecimens(): void {
  UI_APPEARANCE_TYPEFACE_VALUES.forEach(loadTypefaceStylesheet);
}

export function applyTypefaceOverrides(ui?: TypefaceId, chat?: TypefaceId): void {
  for (const [property, face] of [
    ["--font-body", ui],
    ["--font-chat", chat],
  ] as const) {
    if (face) {
      document.documentElement.style.setProperty(property, TYPEFACES[face].stack);
    } else {
      document.documentElement.style.removeProperty(property);
    }
  }
}

/* Serif hairlines at chat size need macOS stem darkening; the app-wide
   `antialiased` smoothing (base.css body) thins them into gray smear, so serif
   chat faces opt chat prose back into `auto` (.chat-text consumes the
   variable). Sans and mono faces keep the inherited app default. */
export function applyChatFontSmoothing(chat: TypefaceId): void {
  if (TYPEFACE_METADATA[chat].kind === "serif") {
    document.documentElement.style.setProperty("--chat-font-smoothing", "auto");
  } else {
    document.documentElement.style.removeProperty("--chat-font-smoothing");
  }
}
