import type { CuaLastFrame } from "./frame.js";

const MODIFIER_ALIASES = new Map<string, string>([
  ["ctrl", "ctrl"],
  ["control", "ctrl"],
  ["shift", "shift"],
  ["alt", "alt"],
  ["menu", "alt"],
  ["option", "alt"],
  ["mod1", "alt"],
  ["cmd", "meta"],
  ["command", "meta"],
  ["meta", "meta"],
  ["super", "meta"],
  ["win", "meta"],
  ["windows", "meta"],
  ["mod4", "meta"],
]);

const KEY_ALIASES = new Map<string, string>([
  ["return", "enter"],
  ["enter", "enter"],
  ["tab", "tab"],
  ["escape", "escape"],
  ["esc", "escape"],
  ["space", "space"],
  ["backspace", "backspace"],
  ["delete", "delete"],
  ["del", "delete"],
  ["insert", "insert"],
  ["ins", "insert"],
  ["home", "home"],
  ["end", "end"],
  ["pageup", "pageup"],
  ["pgup", "pageup"],
  ["pagedown", "pagedown"],
  ["pgdn", "pagedown"],
  ["up", "up"],
  ["down", "down"],
  ["left", "left"],
  ["right", "right"],
  ["capslock", "capslock"],
  ["numlock", "numlock"],
  // Punctuation aliases are intentionally absent: they resolve to characters
  // whose shift/AltGr state is layout-dependent and dropped by cua-driver, the
  // same reason single punctuation chars are rejected below. Route them to the
  // `type` action instead.
]);

for (let index = 1; index <= 12; index += 1) {
  KEY_ALIASES.set(`f${index}`, `f${index}`);
}

function unsupportedKey(message: string): Error {
  return new Error(`COMPUTER_UNSUPPORTED_KEY: ${message}`);
}

function modifierAlias(value: string, platform: NodeJS.Platform): string | undefined {
  const normalized = MODIFIER_ALIASES.get(value.toLowerCase());
  // CUA's macOS backend silently ignores meta; Linux requires that spelling.
  // Resolve against the provider's platform for both chords and pointer input.
  return platform === "darwin" && normalized === "meta" ? "cmd" : normalized;
}

function normalizeModifierList(entries: string[], platform: NodeJS.Platform): string[] {
  return entries.map((entry) => {
    const raw = entry.trim();
    const normalized = modifierAlias(raw, platform);
    if (!normalized) {
      throw unsupportedKey(`unknown modifier ${JSON.stringify(raw)}`);
    }
    return normalized;
  });
}

export function normalizeModifiers(value: string | undefined, platform: NodeJS.Platform): string[] {
  return value?.trim() ? normalizeModifierList(value.split("+"), platform) : [];
}

function normalizeKey(value: string, platform: NodeJS.Platform): string {
  const raw = value.trim();
  if (!raw) {
    throw unsupportedKey("key chord contains an empty key");
  }
  const lowered = raw.toLowerCase();
  const named = modifierAlias(lowered, platform) ?? KEY_ALIASES.get(lowered);
  if (named) {
    return named;
  }
  // CUA Driver's key contract carries a base key, not the layout-specific
  // shift/AltGr state required for arbitrary characters. ASCII letters remain
  // valid chord keys (for example ctrl+c); send digits and punctuation through
  // `type` rather than risk a layout-dependent misfire.
  if (/^[a-z]$/i.test(raw)) {
    return lowered;
  }
  if (raw.length === 1) {
    throw unsupportedKey(
      `single-character key ${JSON.stringify(raw)} loses layout shift state in cua-driver; use the type action instead`,
    );
  }
  throw unsupportedKey(`unknown key ${JSON.stringify(raw)}`);
}

export function parseKeyChord(value: string | undefined, platform: NodeJS.Platform) {
  const segments = value?.split("+").map((entry) => entry.trim()) ?? [];
  const rawKey = segments.pop();
  if (!rawKey) {
    throw unsupportedKey("key chord is empty");
  }
  const modifiers = normalizeModifierList(segments, platform);
  return { key: normalizeKey(rawKey, platform), modifiers };
}

export function scalePoint(
  frame: CuaLastFrame,
  x: number | undefined,
  y: number | undefined,
  label: string,
): { x: number; y: number } {
  if (x === undefined || y === undefined) {
    throw new Error(`COMPUTER_INVALID_REQUEST: ${label} coordinates are required`);
  }
  if (x >= frame.deliveredWidth || y >= frame.deliveredHeight) {
    throw new Error(
      `COMPUTER_INVALID_REQUEST: ${label} coordinates are outside the captured primary-display frame`,
    );
  }
  return {
    x: Math.min(frame.nativeWidth - 1, Math.round((x * frame.nativeWidth) / frame.deliveredWidth)),
    y: Math.min(
      frame.nativeHeight - 1,
      Math.round((y * frame.nativeHeight) / frame.deliveredHeight),
    ),
  };
}
