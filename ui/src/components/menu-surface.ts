import { hasNativeBrowserBridge } from "../app/native-browser-host.ts";
import { acquireNativeOverlayOcclusion } from "../lib/native-overlay-occlusion.ts";

const occludingSurfaces = new WeakSet<HTMLElement>();

function occludeNativeBrowser(element: HTMLElement) {
  if (!hasNativeBrowserBridge() || !element.isConnected || occludingSurfaces.has(element)) {
    return;
  }
  const release = acquireNativeOverlayOcclusion();
  const observer = new MutationObserver(() => {
    if (!element.isConnected) {
      cleanup();
    }
  });
  const onToggle = (event: ToggleEvent) => {
    if (event.target === element && event.newState === "closed") {
      cleanup();
    }
  };
  const cleanup = () => {
    observer.disconnect();
    element.removeEventListener("toggle", onToggle);
    occludingSurfaces.delete(element);
    release();
  };
  occludingSurfaces.add(element);
  element.addEventListener("toggle", onToggle);
  // Observe every containing root: document observers cannot see shadow-tree
  // removals, and an outer host can itself be removed while its tree stays intact.
  let root = element.getRootNode();
  observer.observe(root, { childList: true, subtree: true });
  while (root instanceof ShadowRoot) {
    root = root.host.getRootNode();
    observer.observe(root, { childList: true, subtree: true });
  }
}

/**
 * Promotes a connected element into the browser popover top layer so transient
 * menus paint above every in-page stacking context (e.g. the sidebar resizer
 * divider that sits above the nav's z-index 10 context). Falls back to
 * in-flow rendering when the Popover API is unavailable (older engines, jsdom).
 */
export function promoteToPopoverTopLayer(element: HTMLElement) {
  occludeNativeBrowser(element);
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
