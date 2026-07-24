// Accessible drag-to-resize handle for the chat composer input.
//
// Mirrors the pointer-drag + a11y model of resizable-divider.ts, but drives the
// composer textarea height directly (exact manual height) and renders into
// light DOM so it is styled by the shared chat stylesheet.
import { html } from "lit";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import {
  applyComposerTextareaHeight,
  clampComposerHeight,
  clearComposerFloor,
  COMPOSER_MIN_TEXTAREA_HEIGHT,
  computeComposerMaxHeight,
  readComposerFloor,
  writeComposerFloor,
} from "../composer-height.ts";

/** Movement before a press becomes a drag, so a plain double-click never drags. */
const DRAG_THRESHOLD_PX = 3;
const KEYBOARD_STEP_PX = 16;
const KEYBOARD_STEP_LARGE_PX = 48;
/** CSS height transition (160ms) plus a small buffer before dropping the class. */
const ANIMATE_CLASS_LIFETIME_MS = 220;

type DragPhase = "idle" | "maybe" | "dragging";

class ComposerResizeHandle extends OpenClawLightDomElement {
  private phase: DragPhase = "idle";
  private startY = 0;
  private startHeight = 0;
  private dragFloor: number | null = null;
  private activePointerId: number | null = null;
  private animateTimer: ReturnType<typeof setTimeout> | null = null;
  private dragListenersAttached = false;

  override connectedCallback() {
    super.connectedCallback();
    this.setAttribute("role", "separator");
    this.setAttribute("aria-orientation", "horizontal");
    if (!this.hasAttribute("tabindex")) {
      this.setAttribute("tabindex", "0");
    }
    // Only pointerdown/dblclick/keydown live on the element; the move/up
    // listeners are attached to the document for the duration of a drag (see
    // handlePointerDown), so a drag that leaves the thin strip is not dropped
    // even if pointer capture is unavailable.
    this.addEventListener("pointerdown", this.handlePointerDown);
    this.addEventListener("dblclick", this.handleReset);
    this.addEventListener("keydown", this.handleKeyDown);
    if (typeof window !== "undefined") {
      window.addEventListener("resize", this.handleViewportResize);
    }
    this.syncState();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("pointerdown", this.handlePointerDown);
    this.removeEventListener("dblclick", this.handleReset);
    this.removeEventListener("keydown", this.handleKeyDown);
    if (typeof window !== "undefined") {
      window.removeEventListener("resize", this.handleViewportResize);
    }
    this.detachDragListeners();
    this.phase = "idle";
    this.dragFloor = null;
    this.classList.remove("dragging");
    if (this.animateTimer != null) {
      clearTimeout(this.animateTimer);
      this.animateTimer = null;
    }
    // Drop the transient animation class so a detached textarea keeps no state.
    this.textarea?.classList.remove("composer-animate-height");
    this.releaseActivePointer();
  }

  override render() {
    // Grip is invisible at rest and fades in on hover/focus. The reset hint is
    // absolutely positioned above the top edge (zero layout height) and shares
    // the grip's visibility state via CSS (no independent timer).
    return html`
      <span class="agent-chat__composer-grip" aria-hidden="true"></span>
      <span class="agent-chat__composer-reset-hint" aria-hidden="true"
        >${t("chat.composer.resize.resetHint")}</span
      >
    `;
  }

  protected override updated() {
    // Re-apply attributes so the aria-label tracks locale changes.
    this.syncState();
  }

  private get textarea(): HTMLTextAreaElement | null {
    return this.parentElement?.querySelector<HTMLTextAreaElement>("textarea") ?? null;
  }

  private handlePointerDown = (e: PointerEvent) => {
    // Primary contact only: left mouse button, or primary touch/pen (button 0),
    // or the "no button" sentinel some touch stacks report (-1).
    if (e.button !== 0 && e.button !== -1) {
      return;
    }
    const textarea = this.textarea;
    if (!textarea) {
      return;
    }
    this.startY = e.clientY;
    this.startHeight =
      textarea.getBoundingClientRect().height ||
      readComposerFloor() ||
      COMPOSER_MIN_TEXTAREA_HEIGHT;
    this.dragFloor = null;
    this.phase = "maybe";
    this.capturePointer(e.pointerId);
    this.attachDragListeners();
    // No preventDefault(): it can suppress the native dblclick used for reset.
  };

  private handlePointerMove = (e: PointerEvent) => {
    if (this.phase === "idle") {
      return;
    }
    const textarea = this.textarea;
    if (!textarea) {
      return;
    }
    const delta = this.startY - e.clientY; // drag up = grow
    if (this.phase === "maybe") {
      if (Math.abs(delta) < DRAG_THRESHOLD_PX) {
        return;
      }
      this.phase = "dragging";
      this.classList.add("dragging");
    }
    const max = computeComposerMaxHeight(textarea);
    this.dragFloor = clampComposerHeight(this.startHeight + delta, max);
    applyComposerTextareaHeight(textarea, this.dragFloor);
    this.syncState();
  };

  private handlePointerUp = (e: PointerEvent) => {
    if (this.phase === "idle") {
      this.detachDragListeners();
      return;
    }
    const wasDragging = this.phase === "dragging";
    this.phase = "idle";
    this.classList.remove("dragging");
    this.detachDragListeners();
    this.releaseActivePointer(e.pointerId);
    if (wasDragging && this.dragFloor != null) {
      writeComposerFloor(this.dragFloor);
    }
    this.dragFloor = null;
    this.syncState();
  };

  private handleReset = () => {
    this.animateNextHeightChange();
    clearComposerFloor();
    const textarea = this.textarea;
    if (textarea) {
      applyComposerTextareaHeight(textarea);
    }
    this.syncState();
  };

  private handleKeyDown = (e: KeyboardEvent) => {
    const textarea = this.textarea;
    if (!textarea) {
      return;
    }
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      this.handleReset();
      return;
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") {
      return;
    }
    e.preventDefault();
    const step = e.shiftKey ? KEYBOARD_STEP_LARGE_PX : KEYBOARD_STEP_PX;
    const base = readComposerFloor() ?? textarea.getBoundingClientRect().height;
    const max = computeComposerMaxHeight(textarea);
    const next = clampComposerHeight(base + (e.key === "ArrowUp" ? step : -step), max);
    writeComposerFloor(next);
    this.animateNextHeightChange();
    applyComposerTextareaHeight(textarea);
    this.syncState();
  };

  private handleViewportResize = () => {
    // Skip re-clamping while a drag is in progress to avoid reading stale
    // persisted state and causing visual flicker.
    if (this.phase !== "idle") {
      return;
    }
    const textarea = this.textarea;
    if (!textarea) {
      return;
    }
    // Re-clamp the stored floor against the new dynamic max.
    applyComposerTextareaHeight(textarea);
    this.syncState();
  };

  private attachDragListeners() {
    if (this.dragListenersAttached || typeof document === "undefined") {
      return;
    }
    document.addEventListener("pointermove", this.handlePointerMove);
    document.addEventListener("pointerup", this.handlePointerUp);
    document.addEventListener("pointercancel", this.handlePointerUp);
    this.dragListenersAttached = true;
  }

  private detachDragListeners() {
    if (!this.dragListenersAttached || typeof document === "undefined") {
      return;
    }
    document.removeEventListener("pointermove", this.handlePointerMove);
    document.removeEventListener("pointerup", this.handlePointerUp);
    document.removeEventListener("pointercancel", this.handlePointerUp);
    this.dragListenersAttached = false;
  }

  // Enable the CSS height transition for the next programmatic change only
  // (reset / keyboard nudge). Live drag and typing autosize stay instant.
  private animateNextHeightChange() {
    const textarea = this.textarea;
    if (!textarea) {
      return;
    }
    textarea.classList.add("composer-animate-height");
    if (this.animateTimer != null) {
      clearTimeout(this.animateTimer);
    }
    this.animateTimer = setTimeout(() => {
      this.animateTimer = null;
      this.textarea?.classList.remove("composer-animate-height");
    }, ANIMATE_CLASS_LIFETIME_MS);
  }

  private syncState() {
    const textarea = this.textarea;
    const floor = this.phase === "dragging" ? this.dragFloor : readComposerFloor();
    this.classList.toggle("manual", floor != null);
    const max = textarea ? computeComposerMaxHeight(textarea) : COMPOSER_MIN_TEXTAREA_HEIGHT;
    const now = textarea
      ? Math.round(textarea.getBoundingClientRect().height) || floor || COMPOSER_MIN_TEXTAREA_HEIGHT
      : (floor ?? COMPOSER_MIN_TEXTAREA_HEIGHT);
    this.setAttribute("aria-valuemin", String(COMPOSER_MIN_TEXTAREA_HEIGHT));
    this.setAttribute("aria-valuemax", String(max));
    this.setAttribute("aria-valuenow", String(clampComposerHeight(now, max)));
    this.setAttribute("aria-label", t("chat.composer.resize.label"));
  }

  private capturePointer(pointerId: number) {
    if (typeof this.setPointerCapture !== "function") {
      return;
    }
    try {
      this.setPointerCapture(pointerId);
      this.activePointerId = pointerId;
    } catch {
      // Capture is best-effort; document-level drag listeners cover the fallback.
      this.activePointerId = null;
    }
  }

  private releaseActivePointer(pointerId?: number) {
    const id = pointerId ?? this.activePointerId;
    this.activePointerId = null;
    if (id == null || typeof this.releasePointerCapture !== "function") {
      return;
    }
    if (typeof this.hasPointerCapture === "function" && !this.hasPointerCapture(id)) {
      return;
    }
    this.releasePointerCapture(id);
  }
}

if (!customElements.get("composer-resize-handle")) {
  customElements.define("composer-resize-handle", ComposerResizeHandle);
}

declare global {
  interface HTMLElementTagNameMap {
    "composer-resize-handle": ComposerResizeHandle;
  }
}
