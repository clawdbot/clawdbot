import { hasNativeBrowserBridge } from "../app/native-browser-host.ts";

const listeners = new Set<(occluded: boolean) => void>();
let activeOverlays = 0;

function notify(occluded: boolean) {
  for (const listener of listeners) {
    listener(occluded);
  }
}

/** Native web views sit above the page, including its browser top layer. */
export function acquireNativeOverlayOcclusion(): () => void {
  if (!hasNativeBrowserBridge()) {
    return () => {};
  }
  activeOverlays += 1;
  if (activeOverlays === 1) {
    notify(true);
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    activeOverlays -= 1;
    if (activeOverlays === 0) {
      notify(false);
    }
  };
}

export function subscribeNativeOverlayOcclusion(listener: (occluded: boolean) => void): () => void {
  if (!hasNativeBrowserBridge()) {
    listener(false);
    return () => {};
  }
  listeners.add(listener);
  listener(activeOverlays > 0);
  return () => {
    listeners.delete(listener);
  };
}
