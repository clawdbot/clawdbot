// Control UI component implements the resizable divider element.
import { css, nothing } from "lit";
import { property } from "lit/decorators.js";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";

/**
 * An accessible draggable divider for resizable split views.
 * Dispatches 'resize' events with { splitRatio: number } detail.
 */
export class ResizableDivider extends OpenClawLitElement {
  @property({ type: Number }) splitRatio = 0.6;
  @property({ type: Number }) minRatio = 0.4;
  @property({ type: Number }) maxRatio = 0.7;
  @property({ type: String }) label = "Resize split view";
  @property({ type: String, reflect: true }) orientation: "vertical" | "horizontal" = "vertical";

  private isDragging = false;
  private startPosition = 0;
  private startRatio = 0;
  private activePointerId: number | null = null;

  static override styles = css`
    :host {
      width: 4px;
      cursor: col-resize;
      background: var(--border, #333);
      transition: background 150ms ease-out;
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
    :host(:hover) {
      background: var(--accent, #007bff);
    }
    :host(.dragging) {
      background: var(--accent, #007bff);
    }
    :host(:focus-visible) {
      outline: 2px solid var(--accent, #007bff);
      outline-offset: 2px;
      background: var(--accent, #007bff);
    }
    :host([orientation="horizontal"]) {
      width: auto;
      height: 4px;
      cursor: row-resize;
    }
    :host([orientation="horizontal"])::before {
      top: -4px;
      left: 0;
      right: 0;
      bottom: -4px;
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
    if (this.label) {
      this.setAttribute("aria-label", this.label);
    } else {
      this.removeAttribute("aria-label");
    }
    this.setAttribute("aria-orientation", this.orientation);
  }

  private handlePointerDown = (e: PointerEvent) => {
    if (e.button !== 0) {
      return;
    }
    this.isDragging = true;
    this.startPosition = this.orientation === "horizontal" ? e.clientY : e.clientX;
    this.startRatio = this.splitRatio;
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
    const containerSize =
      this.orientation === "horizontal"
        ? (previousBounds?.height ?? 0) + (nextBounds?.height ?? 0) || containerBounds.height
        : (previousBounds?.width ?? 0) + (nextBounds?.width ?? 0) || containerBounds.width;
    const position = this.orientation === "horizontal" ? e.clientY : e.clientX;
    const deltaRatio = (position - this.startPosition) / containerSize;

    this.emitResize(this.startRatio + deltaRatio);
  };

  private handlePointerUp = () => {
    this.stopDragging();
  };

  private handleKeyDown = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.05 : 0.02;
    let nextRatio: number | null = null;

    const decreaseKey = this.orientation === "horizontal" ? "ArrowUp" : "ArrowLeft";
    const increaseKey = this.orientation === "horizontal" ? "ArrowDown" : "ArrowRight";
    if (e.key === decreaseKey) {
      nextRatio = this.splitRatio - step;
    } else if (e.key === increaseKey) {
      nextRatio = this.splitRatio + step;
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
