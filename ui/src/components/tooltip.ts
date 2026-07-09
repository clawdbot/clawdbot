import { html } from "lit";
import { property } from "lit/decorators.js";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";

const HOVER_DELAY = 150;
const TOUCH_DELAY = 450;
const TOUCH_VISIBLE = 900;
const MOVE_LIMIT = 10;
const SKIP_DELAY = 300;
const VIEWPORT_PADDING = 8;
const TOOLTIP_GAP = 8;

let nextTooltipId = 0;

function createTooltipId() {
  nextTooltipId += 1;
  return `openclaw-tooltip-${nextTooltipId}`;
}

class TooltipProvider extends OpenClawLitElement {
  @property({ type: Number }) delay = HOVER_DELAY;
  @property({ type: Number }) skipDelay = SKIP_DELAY;
  @property({ type: Number }) touchDelay = TOUCH_DELAY;

  private delayed = true;
  private skipDelayTimer: number | null = null;
  private activeTooltip: Tooltip | null = null;
  private suppressFocus = false;

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
    this.addEventListener("pointerdown", this.handlePointerDown, true);
  }

  override disconnectedCallback() {
    this.removeEventListener("pointerdown", this.handlePointerDown, true);
    // Sever ownership first so child teardown cannot start a skip-delay window
    // on a provider that is no longer available.
    const activeTooltip = this.activeTooltip;
    this.activeTooltip = null;
    activeTooltip?.closeFromProvider();
    this.clearSkipDelayTimer();
    this.delayed = true;
    this.suppressFocus = false;
    super.disconnectedCallback();
  }

  private readonly handlePointerDown = () => {
    this.suppressFocus = true;
    this.activeTooltip?.closeFromProvider();
  };

  suppressNextFocus() {
    this.suppressFocus = true;
  }

  consumeFocusSuppression() {
    if (!this.suppressFocus) {
      return false;
    }
    this.suppressFocus = false;
    return true;
  }

  openTooltip(tooltip: Tooltip) {
    if (this.activeTooltip && this.activeTooltip !== tooltip) {
      this.activeTooltip.closeFromProvider();
    }
    this.activeTooltip = tooltip;
    this.delayed = false;
    this.clearSkipDelayTimer();
  }

  closeTooltip(tooltip: Tooltip) {
    if (this.activeTooltip !== tooltip) {
      return;
    }
    this.activeTooltip = null;
    this.clearSkipDelayTimer();
    if (this.skipDelay <= 0) {
      this.delayed = true;
      return;
    }
    this.skipDelayTimer = window.setTimeout(() => {
      this.skipDelayTimer = null;
      this.delayed = true;
    }, this.skipDelay);
  }

  shouldDelayOpen() {
    return this.delayed;
  }

  private clearSkipDelayTimer() {
    if (this.skipDelayTimer === null) {
      return;
    }
    window.clearTimeout(this.skipDelayTimer);
    this.skipDelayTimer = null;
  }

  override render() {
    return html`<slot></slot>`;
  }
}

class Tooltip extends OpenClawLitElement {
  @property() content = "";

  private trigger: HTMLElement | null = null;
  private portal: HTMLDivElement | null = null;
  private openTimer: number | null = null;
  private touchTimer: number | null = null;
  private touchCloseTimer: number | null = null;
  private touchStart: { x: number; y: number } | null = null;
  private touchOpened = false;
  private open = false;
  private pointerDown = false;
  private describedBy: string | null = null;
  private activeProvider: TooltipProvider | null = null;
  private readonly tooltipId = createTooltipId();

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
  }

  protected override updated() {
    if (this.isConnected) {
      this.attachTrigger();
    }
  }

  override disconnectedCallback() {
    this.close();
    document.removeEventListener("pointerup", this.handleDocumentPointerUp);
    this.pointerDown = false;
    this.detachTrigger();
    super.disconnectedCallback();
  }

  private attachTrigger() {
    if (!this.isConnected) {
      return;
    }
    const slot = this.renderRoot.querySelector("slot");
    const trigger = slot
      ?.assignedElements({ flatten: true })
      .find((element): element is HTMLElement => element instanceof HTMLElement);
    if (trigger === this.trigger) {
      return;
    }
    this.close();
    this.detachTrigger();
    if (!trigger) {
      return;
    }
    this.trigger = trigger;
    for (const type of [
      "pointermove",
      "pointerdown",
      "pointerup",
      "pointerleave",
      "pointercancel",
    ]) {
      trigger.addEventListener(type, this.handlePointer);
    }
    trigger.addEventListener("focusin", this.handleFocus);
    trigger.addEventListener("focusout", this.handleFocus);
    trigger.addEventListener("click", this.handleClick, true);
    trigger.addEventListener("keydown", this.handleKeyDown);
  }

  private detachTrigger() {
    const trigger = this.trigger;
    if (!trigger) {
      return;
    }
    for (const type of [
      "pointermove",
      "pointerdown",
      "pointerup",
      "pointerleave",
      "pointercancel",
    ]) {
      trigger.removeEventListener(type, this.handlePointer);
    }
    trigger.removeEventListener("focusin", this.handleFocus);
    trigger.removeEventListener("focusout", this.handleFocus);
    trigger.removeEventListener("click", this.handleClick, true);
    trigger.removeEventListener("keydown", this.handleKeyDown);
    this.restoreDescription();
    this.trigger = null;
  }

  private get provider() {
    return this.closest<TooltipProvider>("openclaw-tooltip-provider");
  }

  private get delay() {
    return Math.max(0, this.provider?.delay ?? HOVER_DELAY);
  }

  private get touchDelay() {
    return Math.max(0, this.provider?.touchDelay ?? TOUCH_DELAY);
  }

  private readonly handlePointer = (event: Event) => {
    const pointer = event as PointerEvent;
    if (pointer.pointerType === "touch") {
      if (event.type === "pointerdown") {
        this.pointerDown = true;
        document.addEventListener("pointerup", this.handleDocumentPointerUp, { once: true });
        this.clearTimers();
        this.touchStart = { x: pointer.clientX, y: pointer.clientY };
        this.touchOpened = false;
        this.touchTimer = window.setTimeout(() => {
          this.touchTimer = null;
          this.touchOpened = true;
          this.show();
        }, this.touchDelay);
      } else if (event.type === "pointermove" && this.touchStart) {
        if (
          Math.hypot(pointer.clientX - this.touchStart.x, pointer.clientY - this.touchStart.y) >
          MOVE_LIMIT
        ) {
          this.close();
        }
      } else if (event.type === "pointerup") {
        this.clearTouchTimer();
        this.touchStart = null;
        if (this.touchOpened) {
          this.touchCloseTimer = window.setTimeout(() => this.close(), TOUCH_VISIBLE);
        }
      } else if (event.type === "pointercancel") {
        this.pointerDown = false;
        document.removeEventListener("pointerup", this.handleDocumentPointerUp);
        this.close();
      } else if (event.type === "pointerleave") {
        this.close();
      }
      return;
    }
    if (event.type === "pointermove") {
      if (pointer.buttons === 0) {
        this.scheduleOpen();
      }
    } else if (event.type === "pointerleave" || event.type === "pointerdown") {
      this.pointerDown = event.type === "pointerdown";
      this.close();
      if (this.pointerDown) {
        document.addEventListener("pointerup", this.handleDocumentPointerUp, { once: true });
      }
    }
  };

  private readonly handleFocus = (event: FocusEvent) => {
    if (event.type === "focusin") {
      if (this.provider?.consumeFocusSuppression()) {
        return;
      }
      if (!this.pointerDown) {
        this.show();
      }
      return;
    }
    if (!(event.relatedTarget instanceof Node && this.trigger?.contains(event.relatedTarget))) {
      this.close();
    }
  };

  private readonly handleClick = () => {
    this.provider?.suppressNextFocus();
    this.close();
  };

  private readonly handleDocumentPointerUp = () => {
    this.pointerDown = false;
    if (!this.touchStart) {
      return;
    }
    this.clearTouchTimer();
    this.touchStart = null;
    if (this.touchOpened) {
      this.touchCloseTimer = window.setTimeout(() => this.close(), TOUCH_VISIBLE);
    }
  };

  private readonly handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      this.close();
    }
  };

  private scheduleOpen() {
    if (this.open || !this.trigger || !this.content.trim()) {
      return;
    }
    this.clearOpenTimer();
    const delay = this.provider?.shouldDelayOpen() ? this.delay : 0;
    this.openTimer = window.setTimeout(() => {
      this.openTimer = null;
      this.show();
    }, delay);
  }

  private show() {
    const trigger = this.trigger;
    if (!trigger || !this.content.trim()) {
      return;
    }
    this.clearTimers();
    if (this.open) {
      if (this.portal) {
        this.portal.textContent = this.content;
        this.positionTooltip();
      }
      return;
    }
    const provider = this.provider;
    provider?.openTooltip(this);
    this.activeProvider = provider;
    this.open = true;
    this.describedBy ??= trigger.getAttribute("aria-describedby");
    this.portal = document.createElement("div");
    this.portal.className = "openclaw-tooltip";
    this.portal.id = this.tooltipId;
    this.portal.setAttribute("role", "tooltip");
    this.portal.textContent = this.content;
    this.portal.dataset.open = "true";
    document.body.append(this.portal);
    trigger.setAttribute(
      "aria-describedby",
      this.describedBy ? `${this.describedBy} ${this.tooltipId}` : this.tooltipId,
    );
    window.addEventListener("resize", this.handleViewportChange);
    window.addEventListener("scroll", this.handleViewportChange, true);
    const viewport = window.visualViewport;
    if (typeof viewport?.addEventListener === "function") {
      viewport.addEventListener("resize", this.handleViewportChange);
      viewport.addEventListener("scroll", this.handleViewportChange);
    }
    this.positionTooltip();
  }

  private close() {
    const wasOpen = this.open;
    const provider = this.activeProvider;
    this.activeProvider = null;
    this.clearTimers();
    this.touchStart = null;
    this.touchOpened = false;
    this.open = false;
    if (wasOpen) {
      provider?.closeTooltip(this);
    }
    this.restoreDescription();
    this.portal?.remove();
    this.portal = null;
    window.removeEventListener("resize", this.handleViewportChange);
    window.removeEventListener("scroll", this.handleViewportChange, true);
    const viewport = window.visualViewport;
    if (typeof viewport?.removeEventListener === "function") {
      viewport.removeEventListener("resize", this.handleViewportChange);
      viewport.removeEventListener("scroll", this.handleViewportChange);
    }
  }

  closeFromProvider() {
    this.close();
  }

  private restoreDescription() {
    if (!this.trigger) {
      return;
    }
    if (this.describedBy === null) {
      this.trigger.removeAttribute("aria-describedby");
    } else {
      this.trigger.setAttribute("aria-describedby", this.describedBy);
    }
    this.describedBy = null;
  }

  private readonly handleViewportChange = () => {
    if (this.open) {
      this.positionTooltip();
    }
  };

  private positionTooltip() {
    const trigger = this.trigger;
    const portal = this.portal;
    if (!trigger || !portal) {
      return;
    }
    const triggerRect = trigger.getBoundingClientRect();
    const tooltipRect = portal.getBoundingClientRect();
    const available = {
      top: triggerRect.top - TOOLTIP_GAP - VIEWPORT_PADDING,
      bottom: window.innerHeight - triggerRect.bottom - TOOLTIP_GAP - VIEWPORT_PADDING,
      left: triggerRect.left - TOOLTIP_GAP - VIEWPORT_PADDING,
      right: window.innerWidth - triggerRect.right - TOOLTIP_GAP - VIEWPORT_PADDING,
    };
    const preferredSide =
      available.top >= tooltipRect.height
        ? "top"
        : available.bottom >= tooltipRect.height
          ? "bottom"
          : available.right >= tooltipRect.width
            ? "right"
            : available.left >= tooltipRect.width
              ? "left"
              : available.bottom >= available.top
                ? "bottom"
                : "top";
    const top =
      preferredSide === "top"
        ? triggerRect.top - tooltipRect.height - TOOLTIP_GAP
        : preferredSide === "bottom"
          ? triggerRect.bottom + TOOLTIP_GAP
          : triggerRect.top + (triggerRect.height - tooltipRect.height) / 2;
    const left =
      preferredSide === "left"
        ? triggerRect.left - tooltipRect.width - TOOLTIP_GAP
        : preferredSide === "right"
          ? triggerRect.right + TOOLTIP_GAP
          : triggerRect.left + (triggerRect.width - tooltipRect.width) / 2;
    const maxLeft = Math.max(
      VIEWPORT_PADDING,
      window.innerWidth - tooltipRect.width - VIEWPORT_PADDING,
    );
    const maxTop = Math.max(
      VIEWPORT_PADDING,
      window.innerHeight - tooltipRect.height - VIEWPORT_PADDING,
    );
    portal.dataset.side = preferredSide;
    portal.style.left = `${Math.min(Math.max(VIEWPORT_PADDING, left), maxLeft)}px`;
    portal.style.top = `${Math.min(Math.max(VIEWPORT_PADDING, top), maxTop)}px`;
  }

  private clearTimers() {
    this.clearOpenTimer();
    this.clearTouchTimer();
  }

  private clearOpenTimer() {
    if (this.openTimer !== null) {
      window.clearTimeout(this.openTimer);
      this.openTimer = null;
    }
  }

  private clearTouchTimer() {
    if (this.touchTimer !== null) {
      window.clearTimeout(this.touchTimer);
      this.touchTimer = null;
    }
    if (this.touchCloseTimer !== null) {
      window.clearTimeout(this.touchCloseTimer);
      this.touchCloseTimer = null;
    }
  }

  override render() {
    return html`<slot @slotchange=${() => this.attachTrigger()}></slot>`;
  }
}

if (!customElements.get("openclaw-tooltip-provider")) {
  customElements.define("openclaw-tooltip-provider", TooltipProvider);
}

if (!customElements.get("openclaw-tooltip")) {
  customElements.define("openclaw-tooltip", Tooltip);
}
