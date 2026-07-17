// Control UI component implements the resizable divider element.
import { LitElement, css, html, nothing } from "lit";
import { property } from "lit/decorators.js";

/**
 * An accessible draggable divider for resizable split views.
 * Dispatches 'resize' events with { splitRatio: number } detail.
 *
 * Features:
 * - Keyboard navigation with ArrowLeft/ArrowRight (Shift for larger steps)
 * - Pointer capture for smooth dragging
 * - Visual feedback on hover, focus, and drag
 * - Touch device support with proper hit testing
 * - Screen reader support with ARIA attributes
 */
export class ResizableDivider extends LitElement {
  @property({ type: Number }) splitRatio = 0.6;
  @property({ type: Number }) minRatio = 0.4;
  @property({ type: Number }) maxRatio = 0.7;
  @property({ type: String }) label = "Resize split view";

  private isDragging = false;
  private startX = 0;
  private startRatio = 0;
  private activePointerId: number | null = null;
  private showKeyboardHint = false;
  private keyboardHintTimeout: number | null = null;

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
      left: -8px;
      right: -8px;
      bottom: 0;
      background: transparent;
      transition: background 150ms ease-out;
    }
    :host(:hover)::before {
      background: color-mix(in srgb, var(--accent, #007bff) 15%, transparent);
    }
    :host(:hover) {
      background: var(--accent, #007bff);
    }
    :host(.dragging) {
      background: var(--accent, #007bff);
    }
    :host(.dragging)::before {
      background: color-mix(in srgb, var(--accent, #007bff) 25%, transparent);
    }
    :host(:focus-visible) {
      outline: 2px solid var(--accent, #007bff);
      outline-offset: 2px;
      background: var(--accent, #007bff);
    }
    .divider-handle {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 20px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: opacity 200ms ease-out;
      pointer-events: none;
    }
    :host(:hover) .divider-handle,
    :host(:focus-visible) .divider-handle,
    :host(.dragging) .divider-handle {
      opacity: 0.6;
    }
    .divider-handle svg {
      width: 8px;
      height: 16px;
      stroke: var(--text, #fff);
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .keyboard-hint {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: var(--bg-elevated, #1a1a1a);
      color: var(--text, #fff);
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
      transition: opacity 200ms ease-out;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      z-index: 100;
    }
    :host(.show-keyboard-hint) .keyboard-hint {
      opacity: 1;
    }
    .keyboard-hint kbd {
      display: inline-block;
      padding: 2px 4px;
      margin: 0 2px;
      border-radius: 3px;
      background: var(--bg, #2a2a2a);
      border: 1px solid var(--border, #444);
      font-family: inherit;
      font-size: 10px;
      text-transform: uppercase;
    }
    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      border: 0;
      overflow: hidden;
      clip: rect(0 0 0 0);
      clip-path: inset(50%);
      white-space: nowrap;
    }
  `;

  override render() {
    return html`
      <div class="divider-handle" aria-hidden="true">
        <svg viewBox="0 0 8 16">
          <line x1="4" y1="2" x2="4" y2="14"></line>
          <line x1="2" y1="6" x2="4" y2="8"></line>
          <line x1="6" y1="6" x2="4" y2="8"></line>
          <line x1="2" y1="10" x2="4" y2="8"></line>
          <line x1="6" y1="10" x2="4" y2="8"></line>
        </svg>
      </div>
      <div class="keyboard-hint" aria-hidden="true"><kbd>←</kbd><kbd>→</kbd></div>
    `;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.setStaticAccessibilityAttributes();
    this.addEventListener("pointerdown", this.handlePointerDown);
    this.addEventListener("keydown", this.handleKeyDown);
    this.addEventListener("mouseenter", this.handleMouseEnter);
    this.addEventListener("mouseleave", this.handleMouseLeave);
    this.addEventListener("focusin", this.handleFocusIn);
    this.addEventListener("focusout", this.handleFocusOut);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("pointerdown", this.handlePointerDown);
    this.removeEventListener("keydown", this.handleKeyDown);
    this.removeEventListener("mouseenter", this.handleMouseEnter);
    this.removeEventListener("mouseleave", this.handleMouseLeave);
    this.removeEventListener("focusin", this.handleFocusIn);
    this.removeEventListener("focusout", this.handleFocusOut);
    this.stopDragging();
    this.clearKeyboardHintTimeout();
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
  }

  private handleMouseEnter = () => {
    if (!this.isDragging) {
      this.showKeyboardHint = true;
      this.classList.add("show-keyboard-hint");
      this.clearKeyboardHintTimeout();
      this.keyboardHintTimeout = window.setTimeout(() => {
        this.keyboardHintTimeout = null;
        if (!this.isDragging) {
          this.showKeyboardHint = false;
          this.classList.remove("show-keyboard-hint");
        }
      }, 2000);
    }
  };

  private handleMouseLeave = () => {
    this.clearKeyboardHintTimeout();
    this.showKeyboardHint = false;
    this.classList.remove("show-keyboard-hint");
  };

  private handleFocusIn = () => {
    this.showKeyboardHint = true;
    this.classList.add("show-keyboard-hint");
  };

  private handleFocusOut = () => {
    this.showKeyboardHint = false;
    this.classList.remove("show-keyboard-hint");
  };

  private clearKeyboardHintTimeout() {
    if (this.keyboardHintTimeout !== null) {
      window.clearTimeout(this.keyboardHintTimeout);
      this.keyboardHintTimeout = null;
    }
  }

  private handlePointerDown = (e: PointerEvent) => {
    if (e.button !== 0) {
      return;
    }
    this.isDragging = true;
    this.startX = e.clientX;
    this.startRatio = this.splitRatio;
    this.classList.add("dragging");
    this.showKeyboardHint = false;
    this.classList.remove("show-keyboard-hint");
    this.clearKeyboardHintTimeout();
    this.focus();
    this.capturePointer(e.pointerId);

    document.addEventListener("pointermove", this.handlePointerMove);
    document.addEventListener("pointerup", this.handlePointerUp);
    document.addEventListener("pointercancel", this.handlePointerUp);

    // Provide haptic feedback on mobile devices
    try {
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        navigator.vibrate(10);
      }
    } catch {
      // Ignore errors in non-browser environments (e.g., JSDOM)
    }

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

    const containerWidth = container.getBoundingClientRect().width;
    const deltaX = e.clientX - this.startX;
    const deltaRatio = deltaX / containerWidth;

    this.emitResize(this.startRatio + deltaRatio);
  };

  private handlePointerUp = () => {
    this.stopDragging();
  };

  private handleKeyDown = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.05 : 0.02;
    let nextRatio: number | null = null;
    let direction: "left" | "right" | null = null;

    if (e.key === "ArrowLeft") {
      nextRatio = this.splitRatio - step;
      direction = "left";
    } else if (e.key === "ArrowRight") {
      nextRatio = this.splitRatio + step;
      direction = "right";
    } else if (e.key === "Home") {
      nextRatio = this.minRatio;
      direction = "left";
    } else if (e.key === "End") {
      nextRatio = this.maxRatio;
      direction = "right";
    }

    if (nextRatio == null) {
      return;
    }

    e.preventDefault();

    // Provide haptic feedback on mobile devices
    try {
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        navigator.vibrate(5);
      }
    } catch {
      // Ignore errors in non-browser environments (e.g., JSDOM)
    }

    // Announce the change to screen readers
    this.announceChange(nextRatio, direction);

    this.emitResize(nextRatio);
  };

  private announceChange(ratio: number, direction: "left" | "right" | null) {
    const percentage = Math.round(ratio * 100);
    const directionText = direction === "left" ? "decreased" : "increased";
    const announcement = document.createElement("div");
    announcement.setAttribute("role", "status");
    announcement.setAttribute("aria-live", "polite");
    announcement.setAttribute("aria-atomic", "true");
    announcement.className = "visually-hidden";
    announcement.textContent = `Split view ${directionText} to ${percentage}%. Press Shift for larger steps.`;
    document.body.appendChild(announcement);

    // Remove after announcement is made
    setTimeout(() => {
      document.body.removeChild(announcement);
    }, 1000);
  }

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

    // Provide haptic feedback on mobile devices when drag ends
    try {
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        navigator.vibrate(5);
      }
    } catch {
      // Ignore errors in non-browser environments (e.g., JSDOM)
    }
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
    this.setAttribute("aria-orientation", "vertical");
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
