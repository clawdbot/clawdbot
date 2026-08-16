// Control UI component implements the resizable divider element.
import { css, nothing } from "lit";
import { property } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";

/**
 * An accessible draggable divider for resizable split views.
 * Dispatches 'resize' events with { splitRatio: number } detail.
 */
class ResizableDivider extends OpenClawLitElement {
  @property({ type: Number }) splitRatio = 0.6;
  @property({ type: Number }) minRatio = 0.4;
  @property({ type: Number }) maxRatio = 0.7;
  @property({ type: String }) label = "";
  @property({ type: String, reflect: true }) orientation: "vertical" | "horizontal" = "vertical";
  @property({ attribute: false }) measureRatio?: () => number;
  @property({ attribute: false }) measureSize?: () => number;

  private isDragging = false;
  private startPosition = 0;
  private startRatio = 0;
  private activePointerId: number | null = null;

  static override styles = css`
    :host {
      width: var(--rail-resizer-size, 4px);
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
      left: 50%;
      width: var(--rail-divider-size, 1px);
      transform: translateX(-50%);
      background: var(--rail-divider-color, var(--border, #1e2028));
      transition:
        background 150ms ease-out,
        width 150ms ease-out;
    }
    :host(:hover)::after,
    :host(.dragging)::after,
    :host(:focus-visible)::after {
      width: var(--rail-divider-active-size, 2px);
      background: var(--accent, #ff5c5c);
    }
    :host(:focus-visible) {
      outline: 2px solid var(--accent, #ff5c5c);
      outline-offset: 2px;
    }
    :host([orientation="horizontal"]) {
      width: auto;
      height: var(--rail-resizer-size, 4px);
      cursor: row-resize;
    }
    :host([orientation="horizontal"])::before {
      top: -4px;
      left: 0;
      right: 0;
      bottom: -4px;
    }
    :host([orientation="horizontal"])::after {
      top: 50%;
      bottom: auto;
      left: 0;
      right: 0;
      width: auto;
      height: var(--rail-divider-size, 1px);
      transform: translateY(-50%);
      transition:
        background 150ms ease-out,
        height 150ms ease-out;
    }
    :host([orientation="horizontal"]:hover)::after,
    :host([orientation="horizontal"].dragging)::after,
    :host([orientation="horizontal"]:focus-visible)::after {
      width: auto;
      height: var(--rail-divider-active-size, 2px);
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
    this.setAttribute("aria-valuenow", String(this.toAriaValue(this.splitRatio)));
    this.setAttribute("aria-label", this.label || t("common.resizeSplitView"));
    this.setAttribute("aria-orientation", this.orientation);
  }

  private handlePointerDown = (e: PointerEvent) => {
    if (e.button !== 0) {
      return;
    }
    this.isDragging = true;
    this.startPosition = this.orientation === "horizontal" ? e.clientY : e.clientX;
    this.startRatio = this.currentRatio();
    this.classList.add("dragging");
    this.focus();
    this.capturePointer(e.pointerId);

    document.addEventListener("pointermove", this.handlePointerMove);
    document.addEventListener("pointerup", this.handlePointerUp);
    document.addEventListener("pointercancel", this.handlePointerUp);

    e.preventDefault();
  };

  private handlePointerMove = (e: PointerEvent) => {
    if (!this.isDragging) {
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

    this.emitResize(this.startRatio + deltaRatio);
  };

  private handlePointerUp = () => {
    this.stopDragging();
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
  };

  private stopDragging() {
    if (!this.isDragging) {
      return;
    }
    this.isDragging = false;
    this.classList.remove("dragging");
    this.releaseActivePointer();

    document.removeEventListener("pointermove", this.handlePointerMove);
    document.removeEventListener("pointerup", this.handlePointerUp);
    document.removeEventListener("pointercancel", this.handlePointerUp);
  }

  private emitResize(nextRatio: number) {
    const splitRatio = this.clampRatio(nextRatio);
    this.dispatchEvent(
      new CustomEvent("resize", {
        detail: { splitRatio },
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

  private setStaticAccessibilityAttributes() {
    this.setAttribute("role", "separator");
    this.setAttribute("tabindex", "0");
    this.setAttribute("aria-orientation", this.orientation);
  }

  private capturePointer(pointerId: number) {
    if (typeof this.setPointerCapture !== "function") {
      return;
    }
    this.setPointerCapture(pointerId);
    this.activePointerId = pointerId;
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
