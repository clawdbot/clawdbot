export const DEBUG_OVERLAY_REQUEST_EVENT = "openclaw:debug-overlay-request";
export const DEBUG_OVERLAY_TOGGLE_EVENT = "openclaw:debug-overlay-toggle";

export const DEBUG_OVERLAY_SHORTCUT_LABEL = /Mac|iP(hone|ad|od)/i.test(
  globalThis.navigator?.platform ?? "",
)
  ? "⌘⇧D"
  : "Ctrl+Shift+D";

export function requestDebugOverlayToggle(): void {
  window.dispatchEvent(new CustomEvent(DEBUG_OVERLAY_REQUEST_EVENT));
}
