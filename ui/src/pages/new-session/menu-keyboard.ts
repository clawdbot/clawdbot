/** Focusable rows for the menu keyboard contract (menu items + browser rows). */
export const MENU_ITEM_SELECTOR =
  ".session-menu__item:not(:disabled), .new-session-page__browser-entry:not(:disabled)";

/** Arrow keys wrap through rows; Home/End jump. Text fields retain native behavior. */
export function handleMenuNavigation(event: KeyboardEvent) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    return;
  }
  const origin = event.target as HTMLElement;
  if (origin instanceof HTMLInputElement || origin instanceof HTMLTextAreaElement) {
    return;
  }
  const items = [
    ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR),
  ];
  if (items.length === 0) {
    return;
  }
  event.preventDefault();
  const index = items.indexOf(document.activeElement as HTMLElement);
  const target =
    event.key === "Home"
      ? items[0]
      : event.key === "End"
        ? items.at(-1)
        : items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
  target?.focus();
}
