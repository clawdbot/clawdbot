const ASCII_SHORTCUT_KEY = /^[a-z0-9]$/;
const PHYSICAL_LETTER_KEY = /^Key([A-Z])$/;
const PHYSICAL_DIGIT_KEY = /^Digit([0-9])$/;

export function handleContextMenuEvent(
  event: MouseEvent | KeyboardEvent,
  trigger: HTMLElement | null,
  open: (trigger: HTMLElement | null, x: number, y: number) => void,
): boolean {
  if (event instanceof MouseEvent) {
    event.preventDefault();
    open(trigger, event.clientX, event.clientY);
    return true;
  }
  if (
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    (event.key !== "ContextMenu" && (event.key !== "F10" || !event.shiftKey))
  ) {
    return false;
  }
  if (!trigger && !(event.target instanceof HTMLElement)) {
    return false;
  }
  // Chromium on macOS needs the keyboard path; preventing the key default also
  // keeps platforms that synthesize `contextmenu` from opening the menu twice.
  event.preventDefault();
  const resolvedTrigger = trigger ?? (event.target as HTMLElement);
  const rect = resolvedTrigger.getBoundingClientRect();
  open(resolvedTrigger, rect.right, rect.bottom + 4);
  return true;
}

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
