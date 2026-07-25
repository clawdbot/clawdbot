import { z } from "zod";
import type { CuaLastFrame } from "./frame.js";

const COMPUTER_ACTIONS = [
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "mouse_move",
  "left_click_drag",
  "left_mouse_down",
  "left_mouse_up",
  "scroll",
  "type",
  "key",
  "hold_key",
] as const;

export const ComputerActParamsSchema = z.strictObject({
  action: z.enum(COMPUTER_ACTIONS),
  displayFrameId: z.string().optional(),
  x: z.number().finite().nonnegative().optional(),
  y: z.number().finite().nonnegative().optional(),
  fromX: z.number().finite().nonnegative().optional(),
  fromY: z.number().finite().nonnegative().optional(),
  text: z.string().optional(),
  keys: z.string().optional(),
  modifiers: z.string().optional(),
  scrollDirection: z.enum(["up", "down", "left", "right"]).optional(),
  scrollAmount: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  screenIndex: z.number().int().nonnegative().optional(),
  refWidth: z.number().int().positive().optional(),
});

export type ComputerActParams = z.infer<typeof ComputerActParamsSchema>;

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

export function normalizeModifiers(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }
  return value.split("+").map((entry) => {
    const raw = entry.trim();
    const normalized = MODIFIER_ALIASES.get(raw.toLowerCase());
    if (!normalized) {
      throw unsupportedKey(`unknown modifier ${JSON.stringify(raw)}`);
    }
    return normalized;
  });
}

function normalizeKey(value: string): string {
  const raw = value.trim();
  if (!raw) {
    throw unsupportedKey("key chord contains an empty key");
  }
  const lowered = raw.toLowerCase();
  const modifier = MODIFIER_ALIASES.get(lowered);
  if (modifier) {
    return modifier;
  }
  const named = KEY_ALIASES.get(lowered);
  if (named) {
    return named;
  }
  // cua-driver 0.10 resolves single characters through VkKeyScanW/keysym lookups
  // and keeps only the base virtual key, dropping the shift/AltGr state the
  // active layout needs (keyboard.rs key_name_to_vk). ASCII letters are unshifted
  // in every Latin layout, so they stay valid chord keys (e.g. ctrl+c). Digits
  // and punctuation are shifted on some layouts (AZERTY digits, US symbols), so
  // they are rejected toward the `type` action rather than mis-sent.
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

export function parseKeyChord(value: string | undefined): { key: string; modifiers: string[] } {
  const segments = value?.split("+").map((entry) => entry.trim()) ?? [];
  const rawKey = segments.pop();
  if (!rawKey) {
    throw unsupportedKey("key chord is empty");
  }
  const modifiers = segments.map((entry) => {
    const normalized = MODIFIER_ALIASES.get(entry.toLowerCase());
    if (!normalized) {
      throw unsupportedKey(`unknown modifier ${JSON.stringify(entry)}`);
    }
    return normalized;
  });
  return { key: normalizeKey(rawKey), modifiers };
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
