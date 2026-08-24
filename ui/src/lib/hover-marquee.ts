// Hover marquee for truncated single-line labels: on pointer enter, animate
// text-indent to slide the clipped tail into view; on leave, the base
// transition in styles/components.css (.hover-marquee) snaps it back quickly.
// text-indent (not an inner transform wrapper) because text-overflow renders
// no ellipsis for atomic inline children, which would lose the resting "…".
const MARQUEE_SPEED_PX_PER_SEC = 80;
const MARQUEE_MIN_DURATION_MS = 300;
const MARQUEE_HOVER_DELAY_MS = 500;
type PendingMarquee = { frame: number; timer?: number };

const pendingMarquees = new WeakMap<HTMLElement, PendingMarquee>();

function findMarqueeLabel(host: HTMLElement): HTMLElement | null {
  return host.classList.contains("hover-marquee")
    ? host
    : host.querySelector<HTMLElement>(".hover-marquee");
}

function getMarqueeViewportWidth(label: HTMLElement, host: HTMLElement): number {
  let width = label.clientWidth;
  for (
    let ancestor = label.parentElement;
    ancestor && ancestor !== host;
    ancestor = ancestor.parentElement
  ) {
    const style = getComputedStyle(ancestor);
    if (style.overflowX !== "hidden" && style.overflowX !== "clip") {
      continue;
    }
    const padding =
      (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
    width = Math.min(width, Math.max(0, ancestor.clientWidth - padding));
  }
  return width;
}

function clearPendingMarquee(label: HTMLElement): void {
  const pending = pendingMarquees.get(label);
  if (pending === undefined) {
    return;
  }
  window.cancelAnimationFrame(pending.frame);
  if (pending.timer !== undefined) {
    window.clearTimeout(pending.timer);
  }
  pendingMarquees.delete(label);
}

export function startHoverMarquee(host: HTMLElement): void {
  const label = findMarqueeLabel(host);
  if (
    !label ||
    label.classList.contains("hover-marquee--scrolling") ||
    pendingMarquees.has(label)
  ) {
    return;
  }
  // Catalog renders can reconnect refs while the pointer stays on the row.
  // Preserve this label's delay; keyed label replacements get fresh state.
  // Mouseenter fires before hover-only actions finish affecting layout. Measure
  // on the next frame so the marquee sees the width the user actually sees.
  const pending: PendingMarquee = {
    frame: window.requestAnimationFrame(() => {
      if (pendingMarquees.get(label) !== pending) {
        return;
      }
      // A negative mid-transition indent (re-hover while snapping back) shrinks
      // scrollWidth; add it back when calculating the clipped distance.
      const indent = Number.parseFloat(getComputedStyle(label).textIndent) || 0;
      const shift = label.scrollWidth - indent - getMarqueeViewportWidth(label, host);
      if (shift <= 1) {
        pendingMarquees.delete(label);
        return;
      }
      const durationMs = Math.max(
        MARQUEE_MIN_DURATION_MS,
        Math.round((shift / MARQUEE_SPEED_PX_PER_SEC) * 1000),
      );
      label.style.setProperty("--hover-marquee-shift", `${-shift}px`);
      label.style.setProperty("--hover-marquee-duration", `${durationMs}ms`);
      // Keep quick pointer passes quiet; leaving before the timer fires cancels it.
      pending.timer = window.setTimeout(() => {
        pendingMarquees.delete(label);
        label.classList.add("hover-marquee--scrolling");
      }, MARQUEE_HOVER_DELAY_MS);
    }),
  };
  pendingMarquees.set(label, pending);
}

export function stopHoverMarquee(host: HTMLElement): void {
  const label = findMarqueeLabel(host);
  if (!label) {
    return;
  }
  clearPendingMarquee(label);
  label.classList.remove("hover-marquee--scrolling");
}

export function restartHoverMarqueeIfHovered(element: Element | undefined): void {
  if (!(element instanceof HTMLElement)) {
    return;
  }
  queueMicrotask(() => {
    const host = element.isConnected
      ? element.closest<HTMLElement>(".session-row-host")
      : undefined;
    if (host?.matches(":hover")) {
      startHoverMarquee(host);
    }
  });
}

export function startHoverMarqueeFromEvent(event: Event): void {
  if (event.currentTarget instanceof HTMLElement) {
    startHoverMarquee(event.currentTarget);
  }
}

export function stopHoverMarqueeFromEvent(event: Event): void {
  if (event.currentTarget instanceof HTMLElement) {
    stopHoverMarquee(event.currentTarget);
  }
}
