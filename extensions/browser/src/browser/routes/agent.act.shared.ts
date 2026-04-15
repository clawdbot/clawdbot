export const ACT_KINDS = [
  "batch",
  "click",
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

export function isActKind(value: unknown): value is ActKind {
  if (typeof value !== "string") {
    return false;
  }
  return (ACT_KINDS as readonly string[]).includes(value);
}

export type ClickButton = "left" | "right" | "middle";
export type ClickModifier = "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift";

const ALLOWED_CLICK_MODIFIERS = new Set<ClickModifier>([
  "Alt",
  "Control",
  "ControlOrMeta",
  "Meta",
  "Shift",
]);

export function parseClickButton(raw: string): ClickButton | undefined {
  if (raw === "left" || raw === "right" || raw === "middle") {
    return raw;
  }
  return undefined;
}

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
