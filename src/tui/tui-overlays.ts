// Renders TUI overlays for help, sessions, status, and command UI.
import type { Component, TUI } from "@earendil-works/pi-tui";

// Small adapter around pi-tui overlay focus behavior.
type OverlayHost = Pick<TUI, "showOverlay" | "hideOverlay" | "hasOverlay" | "setFocus">;

/** Creates open/close handlers that restore focus when no overlay is active. */
export function createOverlayHandlers(host: OverlayHost, fallbackFocus: Component) {
  const openOverlay = (component: Component) => {
    host.showOverlay(component);
  };

  const closeOverlay = () => {
    if (host.hasOverlay()) {
      host.hideOverlay();
      return;
    }
    host.setFocus(fallbackFocus);
  };

  return { openOverlay, closeOverlay };
}
