const ASCII_SHORTCUT_KEY = /^[a-z0-9]$/;
const PHYSICAL_LETTER_KEY = /^Key([A-Z])$/;
const PHYSICAL_DIGIT_KEY = /^Digit([0-9])$/;

export function resolveAsciiShortcutKey(event: KeyboardEvent): string | null {
  if (event.isComposing || event.keyCode === 229) {
    return null;
  }

  const key = event.key.toLowerCase();
  if (ASCII_SHORTCUT_KEY.test(key)) {
    return key;
  }
  if (event.altKey || event.key === "Dead" || Array.from(event.key).length !== 1) {
    return null;
  }

  // Preserve character-based shortcuts for alternate Latin layouts, then
  // fall back to the physical key so non-Latin layouts can reach the command.
  const letter = PHYSICAL_LETTER_KEY.exec(event.code)?.[1];
  if (letter) {
    return letter.toLowerCase();
  }
  if (!event.shiftKey) {
    return PHYSICAL_DIGIT_KEY.exec(event.code)?.[1] ?? null;
  }
  return null;
}
