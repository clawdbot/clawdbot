import WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";

type AnchoredOverlaySide = "top" | "bottom";
type AnchoredOverlayOptions = {
  alignment?: "start" | "end";
  anchor?: Element;
};

const VIEWPORT_MARGIN = 8;
const VIEWPORT_SIDE_MARGIN = 12;

export function syncAnchoredOverlay(
  details: HTMLDetailsElement,
  preferredSide: AnchoredOverlaySide,
  options: AnchoredOverlayOptions = {},
): void {
  const anchor = details.querySelector<HTMLElement>(":scope > summary");
  const popup = details.querySelector<WaPopup>(":scope > wa-popup[data-anchored-overlay]");
  if (!anchor || !popup) {
    return;
  }
  configureAnchoredPopup(popup, options.anchor ?? anchor, preferredSide, options.alignment);
  popup.active = details.open;
}

/** Shared popup geometry; the caller owns opening, focus, and dismissal. */
export function configureAnchoredPopup(
  popup: WaPopup,
  anchor: Element,
  preferredSide: AnchoredOverlaySide,
  alignment: "start" | "end" = "start",
): void {
  popup.anchor = anchor;
  popup.placement = `${preferredSide}-${alignment}`;
  popup.boundary = "viewport";
  popup.distance = 6;
  popup.flip = true;
  popup.flipPadding = VIEWPORT_MARGIN;
  popup.shift = true;
  popup.shiftPadding = VIEWPORT_SIDE_MARGIN;
  popup.autoSize = "vertical";
  popup.autoSizePadding = VIEWPORT_MARGIN;
}
