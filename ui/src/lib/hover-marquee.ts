// Hover marquee for truncated single-line labels: on pointer enter, animate
// text-indent to slide the clipped tail into view; on leave, the base
// transition in styles/components.css (.hover-marquee) snaps it back quickly.
// text-indent (not an inner transform wrapper) because text-overflow renders
// no ellipsis for atomic inline children, which would lose the resting "…".
const MARQUEE_SPEED_PX_PER_SEC = 80;
const MARQUEE_MIN_DURATION_MS = 300;
const MARQUEE_HOVER_DELAY_MS = 500;
const pendingMarquees = new WeakMap<HTMLElement, number>();
let marqueeResizeObserver: ResizeObserver | undefined;

function findMarqueeLabel(host: HTMLElement): HTMLElement | null {
  return host.classList.contains("hover-marquee")
    ? host
    : host.querySelector<HTMLElement>(".hover-marquee");
}

function clearPendingMarquee(label: HTMLElement): void {
  const pending = pendingMarquees.get(label);
  if (pending === undefined) {
    return;
  }
  window.clearTimeout(pending);
  pendingMarquees.delete(label);
}

function observeMarquee(label: HTMLElement): void {
  if (!marqueeResizeObserver && typeof ResizeObserver === "function") {
    // Row endcaps can resize an adopted title without replacing its label.
    // Remeasure the active animation so presence and badge changes cannot clip it.
    marqueeResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (!(entry.target instanceof HTMLElement)) {
          continue;
        }
        const resizedLabel = entry.target;
        const host = resizedLabel.closest<HTMLElement>(".session-row-host");
        if (!host?.matches(":hover")) {
          marqueeResizeObserver?.unobserve(resizedLabel);
          continue;
        }
        clearPendingMarquee(resizedLabel);
        resizedLabel.classList.remove("hover-marquee--scrolling");
        startHoverMarquee(host);
      }
    });
  }
  marqueeResizeObserver?.observe(label);
}

function startHoverMarquee(host: HTMLElement): void {
  const label = findMarqueeLabel(host);
  if (!label) {
    return;
  }
  observeMarquee(label);
  if (label.classList.contains("hover-marquee--scrolling")) {
    return;
  }
  clearPendingMarquee(label);
  // Measure at hover time: labels resize with the sidebar and with hover-only
  // row actions, so a cached width would drift. A negative mid-transition
  // indent (re-hover while snapping back) shrinks scrollWidth; add it back.
  const indent = Number.parseFloat(getComputedStyle(label).textIndent) || 0;
  const shift = label.scrollWidth - indent - label.clientWidth;
  if (shift <= 1) {
    label.style.removeProperty("--hover-marquee-shift");
    label.style.removeProperty("--hover-marquee-duration");
    return;
  }
  const durationMs = Math.max(
    MARQUEE_MIN_DURATION_MS,
    Math.round((shift / MARQUEE_SPEED_PX_PER_SEC) * 1000),
  );
  label.style.setProperty("--hover-marquee-shift", `${-shift}px`);
  label.style.setProperty("--hover-marquee-duration", `${durationMs}ms`);
  // Keep quick pointer passes quiet; leaving before the timer fires cancels it.
  pendingMarquees.set(
    label,
    window.setTimeout(() => {
      pendingMarquees.delete(label);
      label.classList.add("hover-marquee--scrolling");
    }, MARQUEE_HOVER_DELAY_MS),
  );
}

function stopHoverMarquee(host: HTMLElement): void {
  const label = findMarqueeLabel(host);
  if (!label) {
    return;
  }
  clearPendingMarquee(label);
  label.classList.remove("hover-marquee--scrolling");
  marqueeResizeObserver?.unobserve(label);
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

export function restartHoverMarqueeIfHovered(element: Element | undefined): void {
  if (!(element instanceof HTMLElement)) {
    return;
  }
  queueMicrotask(() => {
    const host = element.isConnected ? element.closest<HTMLElement>(".session-row-host") : null;
    if (host?.matches(":hover")) {
      startHoverMarquee(host);
    }
  });
}
