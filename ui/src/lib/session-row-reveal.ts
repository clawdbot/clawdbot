// Hover/focus reveal for truncated session titles. Entering a row publishes how
// far the management actions actually float over it and, when the title is
// genuinely clipped, animates text-indent to slide the hidden tail out from
// under them; leaving snaps back through the base transition in
// styles/components.css (.hover-marquee).
// text-indent (not an inner transform wrapper) because text-overflow renders
// no ellipsis for atomic inline children, which would lose the resting "…".
const MARQUEE_MS_PER_PIXEL = 10;
const MARQUEE_MIN_DURATION_MS = 900;
const MARQUEE_MAX_DURATION_MS = 1600;
const MARQUEE_HOVER_DELAY_MS = 500;
// Matches the mask ramp in layout.css: the tail must finish past the fade or
// its last characters would arrive already dimmed.
const MARQUEE_FADE_PX = 10;
const ACTION_COVER_PROPERTY = "--session-row-action-cover";
// Set by the row renderer on the same element that carries the cover.
const MENU_OPEN_CLASS = "session-row-host--menu-open";
// Published on a container whose hover-driven surfaces must stay still -- the
// sidebar sets it while any session menu is open. An open menu owns the
// pointer, so crossing a sibling row on the way to it must not start that row
// revealing behind the surface the operator is actually reading.
const HOVER_SUPPRESSED_SCOPE = "[data-hover-suppressed]";
const pendingMarquees = new WeakMap<HTMLElement, number>();

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

interface RowRevealMetrics {
  /** Link-trailing-edge to action edge. Pure geometry: where the fade ramps. */
  readonly cover: number;
  /** Title text the reader cannot see: the clipped tail plus whatever the actions sit on. */
  readonly hidden: number;
}

/**
 * The two distances a reveal needs. They must not be conflated: the fade rides
 * on the link box and only cares where the controls begin, while the traversal
 * may move only text that is genuinely out of sight.
 */
function measureRowReveal(host: HTMLElement, label: HTMLElement | null): RowRevealMetrics {
  const actions = host.querySelector<HTMLElement>(".session-row-actions");
  const link = host.querySelector<HTMLElement>(".sidebar-recent-session__link");
  if (!actions || !link) {
    return { cover: 0, hidden: 0 };
  }
  // Coarse pointers keep the actions in flow past the link, where they cover
  // nothing; the same subtraction reports that as zero without a branch.
  const actionsLeft = actions.getBoundingClientRect().left;
  const cover = Math.max(0, link.getBoundingClientRect().right - actionsLeft);
  if (!label) {
    return { cover, hidden: 0 };
  }
  // The label is a flexible flex item: its box marks where the row ran out of
  // room, not where the title ends, so a short title reaches under the actions
  // and would report itself covered. A range over its contents is the span the
  // reader actually sees, and its width is unaffected by a reveal in flight.
  const range = document.createRange();
  range.selectNodeContents(label);
  const textWidth = range.getBoundingClientRect().width;
  const clipped = Math.max(0, textWidth - label.clientWidth);
  const visibleRight = label.getBoundingClientRect().left + Math.min(textWidth, label.clientWidth);
  return { cover, hidden: Math.round(clipped + Math.max(0, visibleRight - actionsLeft)) };
}

/**
 * Puts a row into management mode: publishes the measured action overlap so the
 * fade lands on the real edge and, when the title is genuinely clipped, arms
 * its traversal.
 */
export function revealSessionRow(host: HTMLElement): void {
  const label = findMarqueeLabel(host);
  // Measure at hover time: labels resize with the sidebar and with hover-only
  // row actions, so a cached width would drift.
  const { cover, hidden } = measureRowReveal(host, label);
  // The fade is not part of the reveal: CSS shows the actions on :hover on its
  // own, and the mask in layout.css ramps at this measurement. Skipping it while
  // a menu is open would leave those actions sitting on unfaded title text, so
  // the cover is published for every hovered row and only the traversal below
  // is suppressed.
  host.style.setProperty(ACTION_COVER_PROPERTY, `${Math.round(cover)}px`);
  if (!label || label.classList.contains("hover-marquee--scrolling")) {
    return;
  }
  clearPendingMarquee(label);
  // The menu owner keeps its own traversal; a sibling crossed on the way to the
  // menu holds still, so only one row is ever moving under the pointer.
  const suppressed =
    host.closest(HOVER_SUPPRESSED_SCOPE) !== null && !host.classList.contains(MENU_OPEN_CLASS);
  if (hidden <= 1 || suppressed) {
    return;
  }
  const distance = hidden + MARQUEE_FADE_PX;
  const durationMs = Math.min(
    MARQUEE_MAX_DURATION_MS,
    Math.max(MARQUEE_MIN_DURATION_MS, Math.round(distance * MARQUEE_MS_PER_PIXEL)),
  );
  // An RTL title clips at its leading edge, so its tail arrives from the other
  // side and the indent that reveals it is positive.
  const shift = getComputedStyle(label).direction === "rtl" ? distance : -distance;
  label.style.setProperty("--hover-marquee-shift", `${shift}px`);
  label.style.setProperty("--hover-marquee-duration", `${durationMs}ms`);
  if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  // Keep quick pointer passes quiet; leaving before the timer fires cancels it.
  pendingMarquees.set(
    label,
    window.setTimeout(() => {
      pendingMarquees.delete(label);
      label.classList.add("hover-marquee--scrolling");
    }, MARQUEE_HOVER_DELAY_MS),
  );
}

/**
 * Returns a row to rest. Pointer and focus both hold the reveal open, so
 * `next` — where the pointer or focus is heading — decides: clicking Pin must
 * not snap the title back under the pointer still sitting on the row, and a
 * pointer leaving must not cancel a reveal the keyboard is still holding.
 */
export function restSessionRow(host: HTMLElement, next: Node | null): void {
  if (
    host.contains(next) ||
    host.matches(":hover") ||
    host.contains(document.activeElement) ||
    // An open row menu is promoted to the top layer, so it is never a descendant
    // of the row it acts on: none of the guards above see it. Without this, the
    // pointer moving onto the menu rests the row and drops the measured cover,
    // leaving an opaque title under buttons the menu is still holding visible.
    host.classList.contains(MENU_OPEN_CLASS)
  ) {
    return;
  }
  host.style.removeProperty(ACTION_COVER_PROPERTY);
  const label = findMarqueeLabel(host);
  if (!label) {
    return;
  }
  clearPendingMarquee(label);
  label.classList.remove("hover-marquee--scrolling");
}
