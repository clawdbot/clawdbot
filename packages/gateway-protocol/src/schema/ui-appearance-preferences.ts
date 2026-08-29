export const UI_APPEARANCE_PREFERENCE_KEYS = {
  theme: "ui.theme",
  themeMode: "ui.themeMode",
  accent: "ui.accent",
  fontUi: "ui.fontUi",
  fontChat: "ui.fontChat",
} as const;

export type UiAppearancePreferenceKey =
  (typeof UI_APPEARANCE_PREFERENCE_KEYS)[keyof typeof UI_APPEARANCE_PREFERENCE_KEYS];

// Wire-contract list of profile-storable theme names. The Control UI derives
// its synced-theme handling from this tuple; a theme shipped in the UI but
// missing here would silently drop that profile preference on read.
// "custom" is deliberately absent: imported palettes are browser-local, so a
// custom selection must never follow the profile to a browser that cannot
// render it — it stays device-local instead.
export const UI_APPEARANCE_THEME_VALUES = [
  "claw",
  "knot",
  "dash",
  "absolutely",
  "tide",
  "beacon",
  "phosphor",
] as const;
// Wire-contract list of profile-storable typefaces. The Control UI derives
// its override normalization from this tuple so browser and profile values agree.
export const UI_APPEARANCE_TYPEFACE_VALUES = [
  "instrument-sans",
  "geist",
  "dm-sans",
  "ibm-plex-sans",
  "space-grotesk",
  "atkinson-hyperlegible",
  "fraunces",
  "lora",
  "jetbrains-mono",
  "system",
] as const;
const UI_APPEARANCE_THEMES = new Set<string>(UI_APPEARANCE_THEME_VALUES);
const UI_APPEARANCE_THEME_MODES = new Set(["light", "dark", "system"]);
const UI_APPEARANCE_TYPEFACES = new Set<string>(UI_APPEARANCE_TYPEFACE_VALUES);

export function normalizeUiAppearancePreference(
  key: UiAppearancePreferenceKey,
  value: unknown,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if (key === UI_APPEARANCE_PREFERENCE_KEYS.accent) {
    return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : undefined;
  }
  if (
    key === UI_APPEARANCE_PREFERENCE_KEYS.fontUi ||
    key === UI_APPEARANCE_PREFERENCE_KEYS.fontChat
  ) {
    return UI_APPEARANCE_TYPEFACES.has(value) ? value : undefined;
  }
  const allowedValues =
    key === UI_APPEARANCE_PREFERENCE_KEYS.theme ? UI_APPEARANCE_THEMES : UI_APPEARANCE_THEME_MODES;
  return allowedValues.has(value) ? value : undefined;
}
