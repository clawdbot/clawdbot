import type { Component, TUI } from "@mariozechner/pi-tui";

type OverlayHost = Pick<TUI, "showOverlay" | "hideOverlay" | "hasOverlay" | "setFocus">;

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
