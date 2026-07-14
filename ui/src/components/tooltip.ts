// Control UI adapter for Web Awesome tooltips. OpenClaw keeps its terse
// wrapper API; Web Awesome owns popup positioning, rendering, and dismissal.
import "@awesome.me/webawesome/dist/components/tooltip/tooltip.js";
import type WaTooltip from "@awesome.me/webawesome/dist/components/tooltip/tooltip.js";
import { css, html } from "lit";
import { property, query } from "lit/decorators.js";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";

const HOVER_DELAY = 150;
const TOUCH_DELAY = 450;
const TOUCH_VISIBLE = 900;
const SKIP_DELAY = 300;
const MOVE_LIMIT = 10;

let nextTooltipId = 0;

function createTooltipId() {
  nextTooltipId += 1;
  return `openclaw-tooltip-${nextTooltipId}`;
}

function normalizeTooltipText(text: string) {
  return text.replace(/\s+/gu, " ").trim();
}

class TooltipProvider extends OpenClawLitElement {
  @property({ type: Number }) delay = HOVER_DELAY;
  @property({ type: Number }) skipDelay = SKIP_DELAY;
  @property({ type: Number }) touchDelay = TOUCH_DELAY;

  private activeTooltip: Tooltip | null = null;
  private delayed = true;
  private skipDelayTimer: number | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
  }

  override disconnectedCallback() {
    const activeTooltip = this.activeTooltip;
    this.activeTooltip = null;
    activeTooltip?.closeFromProvider();
    this.clearSkipDelayTimer();
    this.delayed = true;
    super.disconnectedCallback();
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
    if (this.skipDelayTimer !== null) {
      window.clearTimeout(this.skipDelayTimer);
      this.skipDelayTimer = null;
    }
  }

  override render() {
    return html`<slot></slot>`;
  }
}

class Tooltip extends OpenClawLitElement {
  @property() content = "";

  @query("wa-tooltip") private webAwesomeTooltip?: WaTooltip;

  private triggerElement: HTMLElement | null = null;
  private openTimer: number | null = null;
  private touchTimer: number | null = null;
  private touchCloseTimer: number | null = null;
  private touchStart: { x: number; y: number } | null = null;
  private suppressPointerFocus = false;
  private describedBy: string | null = null;
  private descriptionCaptured = false;
  private descriptionElement: HTMLSpanElement | null = null;
  private tooltipProvider: TooltipProvider | null = null;
  private readonly tooltipId = createTooltipId();
  private readonly descriptionId = `${this.tooltipId}-description`;

  static override styles = css`
    :host {
      display: contents;
    }

    wa-tooltip {
      --max-width: min(260px, calc(100vw - 16px));
      font-family: var(--font-body);
    }

    wa-tooltip::part(body) {
      padding: 7px 9px;
      border: 1px solid color-mix(in srgb, var(--border-strong) 84%, transparent);
      border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--card) 94%, black 6%);
      box-shadow: var(--shadow-md);
      color: var(--text);
      font-size: 12px;
      font-weight: 500;
      line-height: 1.35;
      text-align: center;
      overflow-wrap: anywhere;
      white-space: pre-line;
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.tooltipProvider = this.closest<TooltipProvider>("openclaw-tooltip-provider");
    this.style.display = "contents";
  }

  protected override updated() {
    this.attachTrigger();
    this.syncWebAwesomeTooltip();
  }

  override disconnectedCallback() {
    this.close();
    this.tooltipProvider = null;
    this.detachTrigger();
    super.disconnectedCallback();
  }

  private get provider() {
    return this.tooltipProvider ?? this.closest<TooltipProvider>("openclaw-tooltip-provider");
  }

  private get hoverDelay() {
    return Math.max(0, this.provider?.delay ?? HOVER_DELAY);
  }

  private get touchDelay() {
    return Math.max(0, this.provider?.touchDelay ?? TOUCH_DELAY);
  }

  private attachTrigger() {
    const slot = this.renderRoot.querySelector("slot");
    const trigger = slot
      ?.assignedElements({ flatten: true })
      .find((element): element is HTMLElement => element instanceof HTMLElement);
    if (trigger === this.triggerElement) {
      return;
    }
    this.close();
    this.detachTrigger();
    if (!trigger) {
      return;
    }
    this.triggerElement = trigger;
    trigger.addEventListener("pointerenter", this.handlePointerEnter);
    trigger.addEventListener("pointerleave", this.handlePointerLeave);
    trigger.addEventListener("pointerdown", this.handlePointerDown);
    trigger.addEventListener("pointermove", this.handlePointerMove);
    trigger.addEventListener("pointerup", this.handlePointerUp);
    trigger.addEventListener("pointercancel", this.handlePointerCancel);
    trigger.addEventListener("focusin", this.handleFocusIn);
    trigger.addEventListener("focusout", this.handleFocusOut);
    trigger.addEventListener("click", this.handleClick, true);
    trigger.addEventListener("keydown", this.handleKeyDown);
    this.syncDescription();
    this.syncWebAwesomeTooltip();
  }

  private detachTrigger() {
    const trigger = this.triggerElement;
    if (!trigger) {
      return;
    }
    trigger.removeEventListener("pointerenter", this.handlePointerEnter);
    trigger.removeEventListener("pointerleave", this.handlePointerLeave);
    trigger.removeEventListener("pointerdown", this.handlePointerDown);
    trigger.removeEventListener("pointermove", this.handlePointerMove);
    trigger.removeEventListener("pointerup", this.handlePointerUp);
    trigger.removeEventListener("pointercancel", this.handlePointerCancel);
    trigger.removeEventListener("focusin", this.handleFocusIn);
    trigger.removeEventListener("focusout", this.handleFocusOut);
    trigger.removeEventListener("click", this.handleClick, true);
    trigger.removeEventListener("keydown", this.handleKeyDown);
    document.removeEventListener("pointerup", this.handleDocumentPointerUp);
    this.suppressPointerFocus = false;
    this.restoreDescription();
    this.triggerElement = null;
  }

  private syncWebAwesomeTooltip() {
    const tooltip = this.webAwesomeTooltip;
    if (!tooltip) {
      return;
    }
    tooltip.anchor = this.triggerElement;
    tooltip.showDelay = 0;
    tooltip.hideDelay = 0;
  }

  private readonly handlePointerEnter = (event: PointerEvent) => {
    if (event.pointerType !== "touch") {
      this.scheduleOpen();
    }
  };

  private readonly handlePointerLeave = () => this.close();

  private readonly handlePointerDown = (event: PointerEvent) => {
    if (event.pointerType !== "touch") {
      this.suppressPointerFocus = true;
      document.removeEventListener("pointerup", this.handleDocumentPointerUp);
      document.addEventListener("pointerup", this.handleDocumentPointerUp, { once: true });
      this.close();
      return;
    }
    this.clearTimers();
    this.touchStart = { x: event.clientX, y: event.clientY };
    this.touchTimer = window.setTimeout(() => {
      this.touchTimer = null;
      this.show();
    }, this.touchDelay);
  };

  private readonly handlePointerMove = (event: PointerEvent) => {
    if (
      event.pointerType === "touch" &&
      this.touchStart &&
      Math.hypot(event.clientX - this.touchStart.x, event.clientY - this.touchStart.y) > MOVE_LIMIT
    ) {
      this.close();
    }
  };

  private readonly handlePointerUp = (event: PointerEvent) => {
    if (event.pointerType !== "touch") {
      this.handleDocumentPointerUp();
      return;
    }
    this.clearTouchTimer();
    this.touchStart = null;
    if (this.webAwesomeTooltip?.open) {
      this.touchCloseTimer = window.setTimeout(() => this.close(), TOUCH_VISIBLE);
    }
  };

  private readonly handlePointerCancel = () => {
    this.handleDocumentPointerUp();
    this.close();
  };
  private readonly handleFocusIn = () => {
    if (!this.suppressPointerFocus) {
      this.show();
    }
  };
  private readonly handleFocusOut = () => this.close();
  private readonly handleClick = () => this.close();
  private readonly handleDocumentPointerUp = () => {
    document.removeEventListener("pointerup", this.handleDocumentPointerUp);
    this.suppressPointerFocus = false;
  };
  private readonly handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      this.close();
    }
  };

  private scheduleOpen() {
    if (this.webAwesomeTooltip?.open || this.openTimer !== null || this.isRedundant()) {
      return;
    }
    const delay = this.provider?.shouldDelayOpen() === false ? 0 : this.hoverDelay;
    this.openTimer = window.setTimeout(() => {
      this.openTimer = null;
      this.show();
    }, delay);
  }

  private show() {
    const tooltip = this.webAwesomeTooltip;
    if (!tooltip || !this.triggerElement || !this.content || this.isRedundant()) {
      return;
    }
    this.clearTimers();
    this.provider?.openTooltip(this);
    this.syncDescription();
    tooltip.open = true;
  }

  private close() {
    this.clearTimers();
    this.touchStart = null;
    if (this.webAwesomeTooltip?.open) {
      this.webAwesomeTooltip.open = false;
    }
    this.provider?.closeTooltip(this);
  }

  closeFromProvider() {
    this.clearTimers();
    if (this.webAwesomeTooltip?.open) {
      this.webAwesomeTooltip.open = false;
    }
  }

  private isRedundant() {
    const trigger = this.triggerElement;
    if (!trigger) {
      return false;
    }
    const content = normalizeTooltipText(this.content);
    const triggerText = normalizeTooltipText(trigger.textContent ?? "");
    const clipsContent = [trigger, ...trigger.querySelectorAll("*")].some(
      (element) => element instanceof HTMLElement && element.scrollWidth > element.clientWidth,
    );
    return Boolean(content && triggerText && triggerText.includes(content) && !clipsContent);
  }

  private syncDescription() {
    const trigger = this.triggerElement;
    if (!trigger) {
      return;
    }
    const current = trigger.getAttribute("aria-describedby");
    if (!this.descriptionCaptured) {
      this.describedBy = current;
      this.descriptionCaptured = true;
    }
    if (!this.descriptionElement) {
      const description = document.createElement("span");
      description.id = this.descriptionId;
      description.hidden = true;
      this.append(description);
      this.descriptionElement = description;
    }
    this.descriptionElement.textContent = this.content;
    const ids = new Set((current ?? "").split(/\s+/u).filter(Boolean));
    ids.add(this.descriptionId);
    trigger.setAttribute("aria-describedby", [...ids].join(" "));
  }

  private restoreDescription() {
    if (!this.triggerElement) {
      return;
    }
    if (this.describedBy) {
      this.triggerElement.setAttribute("aria-describedby", this.describedBy);
    } else {
      this.triggerElement.removeAttribute("aria-describedby");
    }
    this.descriptionElement?.remove();
    this.descriptionElement = null;
    this.describedBy = null;
    this.descriptionCaptured = false;
  }

  private clearTouchTimer() {
    if (this.touchTimer !== null) {
      window.clearTimeout(this.touchTimer);
      this.touchTimer = null;
    }
  }

  private clearTimers() {
    if (this.openTimer !== null) {
      window.clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    this.clearTouchTimer();
    if (this.touchCloseTimer !== null) {
      window.clearTimeout(this.touchCloseTimer);
      this.touchCloseTimer = null;
    }
  }

  override render() {
    return html`
      <slot @slotchange=${() => this.attachTrigger()}></slot>
      <wa-tooltip id=${this.tooltipId} trigger="manual">${this.content}</wa-tooltip>
    `;
  }
}

if (!customElements.get("openclaw-tooltip-provider")) {
  customElements.define("openclaw-tooltip-provider", TooltipProvider);
}

if (!customElements.get("openclaw-tooltip")) {
  customElements.define("openclaw-tooltip", Tooltip);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-tooltip-provider": TooltipProvider;
    "openclaw-tooltip": Tooltip;
  }
}
