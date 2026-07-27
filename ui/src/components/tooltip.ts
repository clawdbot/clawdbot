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
const RICH_CONTENT_CLOSE_DELAY = 100;

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
  private closeTimer: number | null = null;
  private touchTimer: number | null = null;
  private touchCloseTimer: number | null = null;
  private touchStart: { x: number; y: number } | null = null;
  private triggerHovered = false;
  private contentHovered = false;
  private suppressPointerFocus = false;
  private describedBy: string | null = null;
  private descriptionCaptured = false;
  private descriptionElement: HTMLSpanElement | null = null;
  private richContentObserver: MutationObserver | null = null;
  private tooltipProvider: TooltipProvider | null = null;
  private readonly tooltipId = createTooltipId();
  private readonly descriptionId = `${this.tooltipId}-description`;

  static override styles = css`
    :host {
      display: contents;
    }

    wa-tooltip {
      --max-width: var(--openclaw-tooltip-max-width, min(260px, calc(100vw - 16px)));
      --wa-tooltip-arrow-size: 6px;
      --wa-tooltip-background-color: color-mix(in srgb, var(--card) 94%, black 6%);
      --wa-tooltip-border-color: color-mix(in srgb, var(--border-strong) 84%, transparent);
      --wa-tooltip-border-width: 1px;
      --wa-tooltip-border-style: solid;
      --wa-tooltip-content-color: var(--text);
      --wa-tooltip-border-radius: var(--radius-md);
      font-family: var(--font-body);
    }

    wa-tooltip::part(body) {
      padding: 7px 9px;
      box-shadow: var(--shadow-md);
      font-size: 12px;
      font-weight: 500;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }

    .tooltip-content {
      display: block;
      text-align: center;
      white-space: pre-line;
    }

    .tooltip-rich-content {
      display: block;
      pointer-events: auto;
      text-align: left;
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.tooltipProvider = this.closest<TooltipProvider>("openclaw-tooltip-provider");
    this.style.display = "contents";
  }

  protected override updated() {
    this.attachTrigger();
    this.syncDescription();
    this.syncWebAwesomeTooltip();
  }

  override disconnectedCallback() {
    this.close();
    this.triggerHovered = false;
    this.contentHovered = false;
    this.richContentObserver?.disconnect();
    this.richContentObserver = null;
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
    const slot = this.renderRoot.querySelector<HTMLSlotElement>("slot:not([name])");
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
    tooltip.showDelay = 0;
    tooltip.hideDelay = 0;
    const trigger = this.triggerElement;
    // WaTooltip's initial `for` watcher clears a directly assigned anchor.
    // Reapply it after that update or an open tooltip has no popup geometry.
    void tooltip.updateComplete.then(() => {
      if (this.webAwesomeTooltip === tooltip && this.triggerElement === trigger) {
        tooltip.anchor = trigger;
      }
    });
  }

  private readonly handlePointerEnter = (event: PointerEvent) => {
    if (event.pointerType !== "touch") {
      this.triggerHovered = true;
      this.clearCloseTimer();
      this.scheduleOpen();
    }
  };

  private readonly handlePointerLeave = (event: PointerEvent) => {
    if (event.pointerType !== "touch") {
      this.triggerHovered = false;
      this.maybeClose();
    }
  };

  private readonly handleContentPointerEnter = (event: PointerEvent) => {
    if (event.pointerType !== "touch") {
      this.contentHovered = true;
      this.clearCloseTimer();
      this.show();
    }
  };

  private readonly handleContentPointerLeave = (event: PointerEvent) => {
    if (event.pointerType !== "touch") {
      this.contentHovered = false;
      this.maybeClose();
    }
  };

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
  private readonly handleFocusOut = (event: FocusEvent) => {
    if (
      (event.relatedTarget instanceof Node && this.contains(event.relatedTarget)) ||
      this.triggerHovered ||
      this.contentHovered
    ) {
      return;
    }
    this.close();
  };
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
    if (!tooltip || !this.triggerElement || !this.tooltipText || this.isRedundant()) {
      return;
    }
    this.clearTimers(false);
    this.provider?.openTooltip(this);
    this.syncDescription();
    tooltip.open = true;
  }

  private close() {
    this.clearTimers();
    this.triggerHovered = false;
    this.contentHovered = false;
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
    if (this.richContentText) {
      return false;
    }
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
    this.descriptionElement.textContent = this.tooltipText;
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

  private clearCloseTimer() {
    if (this.closeTimer !== null) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  private shouldRemainOpen() {
    const activeElement = document.activeElement;
    return (
      this.triggerHovered ||
      this.contentHovered ||
      (activeElement instanceof Node && this.contains(activeElement))
    );
  }

  private maybeClose() {
    this.clearCloseTimer();
    if (this.shouldRemainOpen()) {
      return;
    }
    if (!this.richContentText) {
      this.close();
      return;
    }
    this.closeTimer = window.setTimeout(() => {
      this.closeTimer = null;
      if (!this.shouldRemainOpen()) {
        this.close();
      }
    }, RICH_CONTENT_CLOSE_DELAY);
  }

  private clearTimers(resetHover = true) {
    if (this.openTimer !== null) {
      window.clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    this.clearCloseTimer();
    if (resetHover) {
      this.triggerHovered = false;
      this.contentHovered = false;
    }
    this.clearTouchTimer();
    if (this.touchCloseTimer !== null) {
      window.clearTimeout(this.touchCloseTimer);
      this.touchCloseTimer = null;
    }
  }

  private get richContentText() {
    const slot = this.renderRoot.querySelector<HTMLSlotElement>('slot[name="content"]');
    return normalizeTooltipText(
      slot
        ?.assignedNodes({ flatten: true })
        .map((node) => node.textContent ?? "")
        .join(" ") ?? "",
    );
  }

  private get tooltipText() {
    return this.richContentText || this.content;
  }

  private observeRichContent() {
    this.richContentObserver?.disconnect();
    this.richContentObserver ??= new MutationObserver(() => this.syncDescription());
    const slot = this.renderRoot.querySelector<HTMLSlotElement>('slot[name="content"]');
    for (const node of slot?.assignedNodes({ flatten: true }) ?? []) {
      this.richContentObserver.observe(node, {
        characterData: true,
        childList: true,
        subtree: true,
      });
    }
  }

  private readonly handleContentSlotChange = () => {
    this.observeRichContent();
    this.syncDescription();
    if (!this.tooltipText) {
      this.close();
    }
  };

  override render() {
    return html`
      <slot @slotchange=${() => this.attachTrigger()}></slot>
      <wa-tooltip id=${this.tooltipId} trigger="manual">
        <span class="tooltip-content">${this.content}</span>
        <span
          class="tooltip-rich-content"
          @pointerenter=${this.handleContentPointerEnter}
          @pointerleave=${this.handleContentPointerLeave}
          @focusin=${this.handleFocusIn}
          @focusout=${this.handleFocusOut}
        >
          <slot name="content" @slotchange=${this.handleContentSlotChange}></slot>
        </span>
      </wa-tooltip>
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
