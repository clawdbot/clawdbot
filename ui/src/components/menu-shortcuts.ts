import { html } from "lit";

// Single-letter context-menu shortcuts. Items opt in via data-shortcut plus a
// rendered hint; menu hosts route non-Escape keydowns here so a bare letter
// clicks the matching enabled item and disabled items swallow nothing.
export function menuShortcutHint(key: string) {
  return html`<span class="session-menu__shortcut" aria-hidden="true">${key.toUpperCase()}</span>`;
}

export function activateMenuShortcut(root: ParentNode, event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return false;
  }
  const key = event.key.toLowerCase();
  // Letters and digits only (digits number submenu entries): keeps the
  // querySelector below safe and leaves navigation keys (arrows, Tab, Enter)
  // to native menu focus handling.
  if (!/^[a-z0-9]$/.test(key)) {
    return false;
  }
  const item = root.querySelector<HTMLButtonElement>(`button[data-shortcut="${key}"]`);
  if (!item || item.disabled) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  item.click();
  return true;
}
