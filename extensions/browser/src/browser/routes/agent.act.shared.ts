/**
 * Shared browser action enums and parsers.
 *
 * Keeps route normalization, schema tests, and action dispatch using the same
 * action names, mouse buttons, and keyboard modifier vocabulary.
 */
const ACT_KINDS = [
  "batch",
  "click",
  "clickCoords",
  "close",
  "drag",
  "evaluate",
  "fill",
  "hover",
  "scrollIntoView",
  "press",
  "resize",
  "select",
  "type",
  "wait",
] as const;

export type ActKind = (typeof ACT_KINDS)[number];

/** Return true when a raw value names a supported browser action kind. */
export function isActKind(value: unknown): value is ActKind {
  if (typeof value !== "string") {
    return false;
  }
  return (ACT_KINDS as readonly string[]).includes(value);
}

type ClickButton = "left" | "right" | "middle";
type ClickModifier = "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift";

const ALLOWED_CLICK_MODIFIERS = new Set<ClickModifier>([
  "Alt",
  "Control",
  "ControlOrMeta",
  "Meta",
  "Shift",
]);

/** Parse a model/client mouse button string into the supported click button set. */
export function parseClickButton(raw: string): ClickButton | undefined {
  if (raw === "left" || raw === "right" || raw === "middle") {
    return raw;
  }
  return undefined;
}

/** Parse and validate click modifier names accepted by Playwright actions. */
export function parseClickModifiers(raw: string[]): {
  modifiers?: ClickModifier[];
  error?: string;
} {
  const invalid = raw.filter((m) => !ALLOWED_CLICK_MODIFIERS.has(m as ClickModifier));
  if (invalid.length) {
    return { error: "modifiers must be Alt|Control|ControlOrMeta|Meta|Shift" };
  }
  return { modifiers: raw.length ? (raw as ClickModifier[]) : undefined };
}
