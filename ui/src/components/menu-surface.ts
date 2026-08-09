/**
 * Promotes a connected element into the browser popover top layer so transient
 * menus paint above every in-page stacking context (e.g. the sidebar resizer
 * divider that sits above the nav's z-index 10 context). Falls back to
 * in-flow rendering when the Popover API is unavailable (older engines, jsdom).
 */
export function promoteToPopoverTopLayer(element: HTMLElement) {
  element.setAttribute("popover", "manual");
  if (typeof element.showPopover === "function") {
    try {
      element.showPopover();
      return;
    } catch {
      // Fall through to in-flow rendering when the top-layer API is unavailable.
    }
  }
  element.removeAttribute("popover");
}

/**
 * Light-DOM host that lifts template-rendered menus into the popover top
 * layer on connect. Hosts render fixed-position menu markup as children;
 * closing removes the element, which auto-hides the popover.
 */
class MenuSurface extends HTMLElement {
  connectedCallback() {
    promoteToPopoverTopLayer(this);
  }
}

if (!customElements.get("openclaw-menu-surface")) {
  customElements.define("openclaw-menu-surface", MenuSurface);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-menu-surface": MenuSurface;
  }
}
