// Global drag-to-resize composer height store plus the shared textarea autosize.
//
// Scope is intentionally GLOBAL: one manual floor applies to every session and
// pane. It is persisted under a namespaced key so a per-session variant can be
// layered on later without a rewrite. This deliberately does NOT reuse the
// per-session composer-outbox/composer-storage machinery.
import { getSafeLocalStorage } from "../../local-storage.ts";

/** Namespaced, migration-friendly key holding a single integer px (global). */
const COMPOSER_HEIGHT_STORAGE_KEY = "openclaw.control.composer.height.v1";

/** Minimum composer textarea height (~1 line + inset); mirrors the CSS min-height. */
export const COMPOSER_MIN_TEXTAREA_HEIGHT = 36;

/**
 * Auto-size cap preserved from the pre-resize behavior. With no manual floor
 * set the textarea keeps growing only up to this height, so the box only
 * exceeds the old cap once the user has dragged.
 */
const COMPOSER_AUTO_HEIGHT_CAP = 150;

/** Manual floor tops out at this share of the chat viewport height. */
const COMPOSER_MAX_VIEWPORT_RATIO = 0.55;

/**
 * Read the persisted global manual floor.
 * Returns `null` for pure auto behavior (default / after reset).
 */
export function readComposerFloor(): number | null {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return null;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(COMPOSER_HEIGHT_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw == null) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/** Persist the global manual floor. */
export function writeComposerFloor(px: number): void {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(COMPOSER_HEIGHT_STORAGE_KEY, String(Math.round(px)));
  } catch {
    // Ignore quota / privacy-mode failures; the live drag still applied.
  }
}

/** Clear the manual floor everywhere and return to pure auto behavior. */
export function clearComposerFloor(): void {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(COMPOSER_HEIGHT_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

/** Dynamic max height = ~55% of the chat viewport (falls back to the window). */
export function computeComposerMaxHeight(el: HTMLElement): number {
  const chatViewport = el.closest<HTMLElement>(".chat")?.clientHeight ?? 0;
  const windowHeight = typeof window !== "undefined" ? window.innerHeight : 0;
  const viewport = chatViewport || windowHeight;
  const dynamicMax = Math.round(viewport * COMPOSER_MAX_VIEWPORT_RATIO);
  return Math.max(COMPOSER_MIN_TEXTAREA_HEIGHT, dynamicMax || COMPOSER_AUTO_HEIGHT_CAP);
}

/** Clamp a candidate height into [min, max]. */
export function clampComposerHeight(px: number, max: number): number {
  return Math.max(COMPOSER_MIN_TEXTAREA_HEIGHT, Math.min(max, px));
}

/**
 * Autosize the composer textarea, or apply the exact manual height (Option A').
 *
 * The textarea is the resized element and is never flex-stretched inside a
 * fixed-height box, so `scrollHeight` reports true content height. Behavior:
 *   floor == null → auto: clamp(min(content, autoCap), min, dynamicMax)
 *   floor != null → manual: clamp(floor, min, dynamicMax)  (content IGNORED)
 *
 * In manual mode autosizing is disabled entirely: the height is exactly what
 * the user set, so they can shrink the box BELOW the current content (which
 * then scrolls). Auto mode grows with content up to the original auto cap.
 *
 * @param floorOverride Live drag value; omit to read the persisted floor.
 */
export function applyComposerTextareaHeight(
  el: HTMLTextAreaElement,
  floorOverride?: number | null,
): void {
  const floor = floorOverride === undefined ? readComposerFloor() : floorOverride;
  const dynamicMax = computeComposerMaxHeight(el);
  if (floor != null) {
    // Manual mode: apply the exact height. Content is intentionally NOT measured
    // (no forced reflow) and may scroll; this also keeps the CSS height
    // transition baseline intact for animated keyboard nudges.
    el.style.height = `${clampComposerHeight(floor, dynamicMax)}px`;
    el.style.overflowY = el.scrollHeight > el.clientHeight ? "auto" : "hidden";
    return;
  }
  // Auto mode: size to content up to the original cap. Measure at height:auto,
  // then restore the prior height before applying the target so an animated
  // change (reset) transitions from the real starting height instead of snapping.
  const previousHeight = el.style.height;
  el.style.overflowY = "hidden";
  el.style.height = "auto";
  const content = el.scrollHeight;
  el.style.height = previousHeight;
  // Measuring at `auto` above forces a layout that would otherwise become the
  // CSS transition's starting point (making an animated reset snap 40->40).
  // When animating, force a reflow at the restored height so the transition
  // baseline is the real starting height and the change glides.
  if (el.classList.contains("composer-animate-height")) {
    void el.offsetHeight;
  }
  const target = clampComposerHeight(Math.min(content, COMPOSER_AUTO_HEIGHT_CAP), dynamicMax);
  el.style.height = `${target}px`;
  el.style.overflowY = el.scrollHeight > el.clientHeight ? "auto" : "hidden";
}
