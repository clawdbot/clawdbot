import { DEBUG_OVERLAY_REQUEST_EVENT } from "../../components/panel-toggle-contract.ts";

export const DEBUG_OVERLAY_SHORTCUT_LABEL = /Mac|iP(hone|ad|od)/i.test(
  globalThis.navigator?.platform ?? "",
)
  ? "⌘⇧D"
  : "Ctrl+Shift+D";

export function requestDebugOverlayToggle(): void {
  window.dispatchEvent(new CustomEvent(DEBUG_OVERLAY_REQUEST_EVENT));
}
