// Control UI component implements the resizable divider element.
import { css, nothing } from "lit";
import { property } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";

const DRAG_END_EVENTS = ["pointerup", "pointercancel", "blur"] as const;

/**
 * An accessible draggable divider for resizable split views.
 * Dispatches 'resize' events with the current ratio and 'resize-end' after the interaction.
 */
class ResizableDivider extends OpenClawLitElement {
  @property({ type: Number }) splitRatio = 0.6;
  @property({ type: Number }) minRatio = 0.4;
  @property({ type: Number }) maxRatio = 0.7;
  @property({ type: String }) label = "";
  @property({ type: String, reflect: true }) orientation: "vertical" | "horizontal" = "vertical";
  @property({ attribute: false }) measureRatio?: () => number;
  @property({ attribute: false }) measureSize?: () => number;

  private startPosition = 0;
  private startRatio = 0;
  private dragRatio = 0;
  private activePointerId: number | null = null;

  static override styles = css`
    :host {
      width: var(--resize-handle-size, 6px);
      cursor: col-resize;
      flex-shrink: 0;
      position: relative;
      touch-action: none;
      user-select: none;
    }
    :host::before {
      content: "";
      position: absolute;
      top: 0;
      left: -4px;
      right: -4px;
      bottom: 0;
    }
    /* The visible divider is a centered hairline, not the whole gutter:
       filling the host paints a fat bar that stacks with neighboring pane
       borders into a multi-line smear while dragging. */
    :host::after {
      content: "";
      position: absolute;
      top: 0;
      bottom: 0;
      inset-inline-start: var(--resize-handle-line-inline, 50%);
      width: var(--resize-handle-line-size, 1px);
      transform: translateX(-50%);
      background: var(--resize-handle-rest-color, var(--border, #1e2028));
      transition:
        background 150ms ease-out,
        width 150ms ease-out;
    }
    :host(:hover)::after,
    :host(.dragging)::after,
    :host(:focus-visible)::after {
      width: var(--resize-handle-active-line-size, 2px);
      background: var(--resize-handle-active-color, currentColor);
    }
    :host(:focus-visible) {
      outline: 2px solid var(--accent, #ff5c5c);
      outline-offset: 2px;
    }
    :host([orientation="horizontal"]) {
      width: auto;
      height: var(--resize-handle-size, 6px);
      cursor: row-resize;
    }
    :host([orientation="horizontal"])::before {
      top: -4px;
      left: 0;
      right: 0;
      bottom: -4px;
    }
    :host([orientation="horizontal"])::after {
      top: var(--resize-handle-line-block, 50%);
      bottom: auto;
      inset-inline-start: 0;
      left: 0;
      right: 0;
      width: auto;
      height: var(--resize-handle-line-size, 1px);
      transform: translateY(-50%);
      transition:
        background 150ms ease-out,
        height 150ms ease-out;
    }
    :host([orientation="horizontal"]:hover)::after,
    :host([orientation="horizontal"].dragging)::after,
    :host([orientation="horizontal"]:focus-visible)::after {
      width: auto;
      height: var(--resize-handle-active-line-size, 2px);
    }
  `;

  override render() {
    return nothing;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.setStaticAccessibilityAttributes();
    this.addEventListener("pointerdown", this.handlePointerDown);
    this.addEventListener("keydown", this.handleKeyDown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("pointerdown", this.handlePointerDown);
    this.removeEventListener("keydown", this.handleKeyDown);
    this.stopDragging();
  }

  protected override updated() {
    this.setAttribute("aria-valuemin", String(this.toAriaValue(this.minRatio)));
    this.setAttribute("aria-valuemax", String(this.toAriaValue(this.maxRatio)));
    this.setCurrentAriaValue(this.currentRatio());
    this.setAttribute("aria-label", this.label || t("common.resizeSplitView"));
    this.setAttribute("aria-orientation", this.orientation);
  }

  private handlePointerDown = (e: PointerEvent) => {
    if (e.button !== 0) {
      return;
    }
    this.startPosition = this.orientation === "horizontal" ? e.clientY : e.clientX;
    this.startRatio = this.currentRatio();
    this.dragRatio = this.startRatio;
    this.classList.add("dragging");
    this.capturePointer(e.pointerId);

    window.addEventListener("pointermove", this.handlePointerMove);
    for (const type of DRAG_END_EVENTS) {
      window.addEventListener(type, this.finishDragging);
    }

    e.preventDefault();
  };

  private handlePointerMove = (e: PointerEvent) => {
    if (this.activePointerId === null) {
      return;
    }

    const container = this.parentElement;
    if (!container) {
      return;
    }

    // Ratio is local to the two adjacent siblings, not the whole container:
    // split-view rows/columns hold N panes, and a drag must only redistribute
    // the pair this divider sits between. Container size is the 2-child
    // fallback (legacy chat sidebar split).
    const previousBounds = this.previousElementSibling?.getBoundingClientRect();
    const nextBounds = this.nextElementSibling?.getBoundingClientRect();
    const containerBounds = container.getBoundingClientRect();
    const measuredSize = this.measureSize?.() ?? 0;
    const siblingSize =
      this.orientation === "horizontal"
        ? (previousBounds?.height ?? 0) + (nextBounds?.height ?? 0)
        : (previousBounds?.width ?? 0) + (nextBounds?.width ?? 0);
    const containerSize =
      measuredSize > 0
        ? measuredSize
        : siblingSize ||
          (this.orientation === "horizontal" ? containerBounds.height : containerBounds.width);
    if (containerSize <= 0) {
      return;
    }
    const position = this.orientation === "horizontal" ? e.clientY : e.clientX;
    const deltaRatio = (position - this.startPosition) / containerSize;

    this.dragRatio = this.emitResize(this.startRatio + deltaRatio);
  };

  private handleKeyDown = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.05 : 0.02;
    const currentRatio = this.currentRatio();
    let nextRatio: number | null = null;

    const decreaseKey = this.orientation === "horizontal" ? "ArrowUp" : "ArrowLeft";
    const increaseKey = this.orientation === "horizontal" ? "ArrowDown" : "ArrowRight";
    if (e.key === decreaseKey) {
      nextRatio = currentRatio - step;
    } else if (e.key === increaseKey) {
      nextRatio = currentRatio + step;
    } else if (e.key === "Home") {
      nextRatio = this.minRatio;
    } else if (e.key === "End") {
      nextRatio = this.maxRatio;
    }

    if (nextRatio == null) {
      return;
    }

    e.preventDefault();
    this.emitResize(nextRatio);
    this.emitResizeEnd(nextRatio);
  };

  private readonly finishDragging = () => {
    if (this.activePointerId !== null) {
      this.emitResizeEnd(this.dragRatio);
    }
    this.stopDragging();
  };

  private stopDragging() {
    if (this.activePointerId === null) {
      return;
    }
    this.classList.remove("dragging");
    this.releaseActivePointer();

    window.removeEventListener("pointermove", this.handlePointerMove);
    for (const type of DRAG_END_EVENTS) {
      window.removeEventListener(type, this.finishDragging);
    }
  }

  private emitResize(nextRatio: number) {
    const splitRatio = this.clampRatio(nextRatio);
    this.setCurrentAriaValue(splitRatio);
    this.dispatchEvent(
      new CustomEvent("resize", {
        detail: { splitRatio },
        bubbles: true,
        composed: true,
      }),
    );
    return splitRatio;
  }

  private emitResizeEnd(nextRatio: number) {
    this.dispatchEvent(
      new CustomEvent("resize-end", {
        detail: { splitRatio: this.clampRatio(nextRatio) },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private clampRatio(value: number) {
    return Math.max(this.minRatio, Math.min(this.maxRatio, value));
  }

  private currentRatio() {
    const measuredRatio = this.measureRatio?.();
    return measuredRatio !== undefined && Number.isFinite(measuredRatio)
      ? this.clampRatio(measuredRatio)
      : this.splitRatio;
  }

  private toAriaValue(value: number) {
    return Math.round(value * 100);
  }

  private setCurrentAriaValue(value: number) {
    this.setAttribute("aria-valuenow", String(this.toAriaValue(value)));
  }

  private setStaticAccessibilityAttributes() {
    this.setAttribute("role", "separator");
    this.setAttribute("tabindex", "0");
    this.setAttribute("aria-orientation", this.orientation);
  }

  private capturePointer(pointerId: number) {
    this.activePointerId = pointerId;
    if (typeof this.setPointerCapture !== "function") {
      return;
    }
    this.setPointerCapture(pointerId);
  }

  private releaseActivePointer() {
    const pointerId = this.activePointerId;
    this.activePointerId = null;
    if (pointerId == null || typeof this.releasePointerCapture !== "function") {
      return;
    }
    if (typeof this.hasPointerCapture === "function" && !this.hasPointerCapture(pointerId)) {
      return;
    }
    this.releasePointerCapture(pointerId);
  }
}

if (!customElements.get("resizable-divider")) {
  customElements.define("resizable-divider", ResizableDivider);
}

declare global {
  interface HTMLElementTagNameMap {
    "resizable-divider": ResizableDivider;
  }
}
