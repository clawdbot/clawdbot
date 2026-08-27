import { DEBUG_OVERLAY_REQUEST_EVENT } from "../../components/panel-toggle-contract.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../../lib/keyboard-shortcut-catalog.ts";

export const DEBUG_OVERLAY_SHORTCUT_LABEL = formatKeyboardShortcutCombo(
  KEYBOARD_SHORTCUT_COMBOS.debugOverlay,
);

export function requestDebugOverlayToggle(): void {
  window.dispatchEvent(new CustomEvent(DEBUG_OVERLAY_REQUEST_EVENT));
}
