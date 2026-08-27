import { UI_APPEARANCE_TYPEFACE_VALUES } from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";
import { inferControlUiPublicAssetPath } from "./public-assets.ts";
import type { ThemeName } from "./theme.ts";

export type TypefaceId = (typeof UI_APPEARANCE_TYPEFACE_VALUES)[number];
type TypefacePair = { ui: TypefaceId; chat: TypefaceId };

const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace';

export const TYPEFACES = {
  "instrument-sans": {
    label: "Instrument Sans",
    stack: `"Instrument Sans", ${SANS}`,
    asset: "fonts/instrument-sans.css",
  },
  geist: { label: "Geist", stack: `"Geist", ${SANS}`, asset: "fonts/geist.css" },
  "dm-sans": { label: "DM Sans", stack: `"DM Sans", ${SANS}`, asset: "fonts/dm-sans.css" },
  "ibm-plex-sans": {
    label: "IBM Plex Sans",
    stack: `"IBM Plex Sans", ${SANS}`,
    asset: "fonts/ibm-plex-sans.css",
  },
  "space-grotesk": {
    label: "Space Grotesk",
    stack: `"Space Grotesk", ${SANS}`,
    asset: "fonts/space-grotesk.css",
  },
  "atkinson-hyperlegible": {
    label: "Atkinson Hyperlegible",
    stack: `"Atkinson Hyperlegible Next", ${SANS}`,
    asset: "fonts/atkinson-hyperlegible.css",
  },
  fraunces: { label: "Fraunces", stack: `"Fraunces", ${SERIF}`, asset: "fonts/fraunces.css" },
  lora: { label: "Lora", stack: `"Lora", ${SERIF}`, asset: "fonts/lora.css" },
  "jetbrains-mono": {
    label: "JetBrains Mono",
    stack: `"JetBrains Mono", ${MONO}`,
    asset: "fonts/jetbrains-mono.css",
  },
  system: { label: "System", stack: SANS, asset: undefined },
} satisfies Record<
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

/* Fetch only the active faces until the picker opens. Loading with the app
   bundle costs one font-display: swap on a cold load. Mount-relative hrefs and
   stylesheet-relative url() sources keep both levels working below a base path. */
function syncTypefaceLink(id: string, face?: TypefaceId): void {
  const asset = face && TYPEFACES[face].asset;
  const existing = document.getElementById(id);
  if (!asset) {
    existing?.remove();
    return;
  }
  const href = inferControlUiPublicAssetPath(asset);
  const link = existing instanceof HTMLLinkElement ? existing : document.createElement("link");
  if (link.getAttribute("href") !== href) {
    link.href = href;
  }
  if (!existing) {
    link.id = id;
    link.rel = "stylesheet";
    document.head.append(link);
  }
}

export function syncTypefaceStylesheets(faces: TypefacePair): void {
  if (typeof document === "undefined") {
    return;
  }
  for (const slot of ["ui", "chat"] as const) {
    const face = faces[slot];
    const duplicate =
      (slot === "chat" && face === faces.ui) ||
      document.getElementById(`openclaw-typeface-${face}`);
    syncTypefaceLink(`openclaw-font-${slot}`, duplicate ? undefined : face);
  }
}

/** Retain picker specimens once requested, reusing already active links. */
export function loadTypefaceSpecimens(): void {
  for (const face of UI_APPEARANCE_TYPEFACE_VALUES) {
    const id = `openclaw-typeface-${face}`;
    const asset = TYPEFACES[face].asset;
    if (asset && !document.getElementById(id)) {
      const href = inferControlUiPublicAssetPath(asset);
      const active = ["ui", "chat"]
        .map((slot) => document.getElementById(`openclaw-font-${slot}`))
        .find((link) => link?.getAttribute("href") === href);
      if (active) {
        active.id = id;
      }
      syncTypefaceLink(id, face);
    }
  }
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
