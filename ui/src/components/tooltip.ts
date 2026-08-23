// Control UI adapter for Web Awesome tooltips. OpenClaw keeps its terse
// wrapper API; Web Awesome owns popup positioning, rendering, and dismissal.
import "@awesome.me/webawesome/dist/components/tooltip/tooltip.js";
import type WaTooltip from "@awesome.me/webawesome/dist/components/tooltip/tooltip.js";
import { css, html } from "lit";
import { property, query } from "lit/decorators.js";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";

const DESCRIBABLE_SELECTOR =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
const HOVER_DELAY = 150;
const SKIP_DELAY = 300;
const RICH_CONTENT_CLOSE_DELAY = 100;

let nextTooltipId = 0;

function createTooltipId() {
  return `openclaw-tooltip-${++nextTooltipId}`;
}

function normalizeTooltipText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function isHtmlElement(element: unknown): element is HTMLElement {
  return (
    typeof element === "object" &&
    element !== null &&
    "namespaceURI" in element &&
    element.namespaceURI === "http://www.w3.org/1999/xhtml"
  );
}

function isElementNode(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

function collectVisibleText(element: Element): string {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (
    element.hasAttribute("hidden") ||
    style?.display === "none" ||
    style?.contentVisibility === "hidden"
  ) {
    return "";
  }
  const rendersOwnText =
    style?.visibility !== "hidden" &&
    style?.visibility !== "collapse" &&
    (style?.display === "contents" ||
      typeof element.checkVisibility !== "function" ||
      element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  return [...element.childNodes]
    .map((node) => {
      if (isElementNode(node)) {
        return collectVisibleText(node);
      }
      return node.nodeType === Node.TEXT_NODE && rendersOwnText ? (node.textContent ?? "") : "";
    })
    .join(" ");
}

function hasTooltipOverflow(element: HTMLElement) {
  return (
    element.matches("[data-tooltip-overflow]") ||
    element.scrollWidth > element.clientWidth ||
    element.scrollHeight > element.clientHeight
  );
}

function isTooltipTextRedundant(content: string, trigger: HTMLElement) {
  const tooltipText = normalizeTooltipText(content);
  const triggerText = normalizeTooltipText(collectVisibleText(trigger));
  if (!tooltipText || !triggerText.includes(tooltipText)) {
    return false;
  }
  if (hasTooltipOverflow(trigger)) {
    return false;
  }
  for (const element of trigger.querySelectorAll("*")) {
    if (isHtmlElement(element) && hasTooltipOverflow(element)) {
      return false;
    }
  }
  return true;
}

export function installNativeTitleGuard(ownerDocument: Document) {
  const suppressed = new Map<HTMLElement, string>();
  const restore = (trigger: HTMLElement) => {
    const title = suppressed.get(trigger);
    if (title === undefined) {
      return;
    }
    suppressed.delete(trigger);
    trigger.removeEventListener("pointerleave", handlePointerLeave);
    if (trigger.getAttribute("title") === "") {
      trigger.setAttribute("title", title);
    }
  };
  const handlePointerLeave = (event: Event) => {
    if (isHtmlElement(event.currentTarget)) {
      restore(event.currentTarget);
    }
  };
  const handlePointerOver = (event: PointerEvent) => {
    if (event.pointerType === "touch") {
      return;
    }
    const path = event.composedPath();
    for (const trigger of suppressed.keys()) {
      if (!path.includes(trigger)) {
        restore(trigger);
      }
    }
    for (const candidate of path) {
      if (!isHtmlElement(candidate)) {
        continue;
      }
      const title = candidate.getAttribute("title");
      const previous = suppressed.get(candidate);
      if (previous) {
        if (title === "") {
          continue;
        }
        candidate.removeEventListener("pointerleave", handlePointerLeave);
        suppressed.delete(candidate);
      }
      if (!title || !isTooltipTextRedundant(title, candidate)) {
        continue;
      }
      suppressed.set(candidate, title);
      // An empty title also blocks inherited native titles until the pointer
      // truly leaves this trigger; removing the attribute would expose them.
      candidate.setAttribute("title", "");
      candidate.addEventListener("pointerleave", handlePointerLeave, { once: true });
    }
  };
  ownerDocument.addEventListener("pointerover", handlePointerOver, true);
  return () => {
    ownerDocument.removeEventListener("pointerover", handlePointerOver, true);
    for (const trigger of suppressed.keys()) {
      restore(trigger);
    }
  };
}

class TooltipProvider extends OpenClawLitElement {
  @property({ type: Number }) delay = HOVER_DELAY;
  @property({ type: Number }) skipDelay = SKIP_DELAY;

  private activeTooltip: Tooltip | null = null;
  delayed = true;
  private focusInput: "keyboard" | "pointer" = "keyboard";
  private skipDelayTimer: number | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
    this.focusInput = "keyboard";
    // Pointer focus can arrive after an action re-renders. Keep modality at
    // the provider so delayed focus cannot reopen the action's tooltip.
    this.ownerDocument.addEventListener("keydown", this.handleDocumentKeyDown, true);
    this.ownerDocument.addEventListener("pointerdown", this.handleDocumentPointerDown, true);
  }

  override disconnectedCallback() {
    this.ownerDocument.removeEventListener("keydown", this.handleDocumentKeyDown, true);
    this.ownerDocument.removeEventListener("pointerdown", this.handleDocumentPointerDown, true);
    const activeTooltip = this.activeTooltip;
    this.activeTooltip = null;
    activeTooltip?.closeFromProvider();
    this.clearSkipDelayTimer();
    this.delayed = true;
    super.disconnectedCallback();
  }

  focusOpensTooltip() {
    return this.focusInput === "keyboard";
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

  private clearSkipDelayTimer() {
    if (this.skipDelayTimer !== null) {
      window.clearTimeout(this.skipDelayTimer);
      this.skipDelayTimer = null;
    }
  }

  private readonly handleDocumentKeyDown = (event: KeyboardEvent) => {
    if (!["Alt", "Control", "Meta", "Shift"].includes(event.key)) {
      this.focusInput = "keyboard";
    }
  };

  private readonly handleDocumentPointerDown = () => {
    this.focusInput = "pointer";
  };

  override render() {
    return html`<slot></slot>`;
  }
}

class Tooltip extends OpenClawLitElement {
  @property() content = "";

  @property({ type: Number }) closeDelay = RICH_CONTENT_CLOSE_DELAY;

  @property({ type: Boolean }) describe = true;

  @property({ type: Boolean }) disabled = false;

  /** Let a reveal-only trigger open on click instead of dismissing. */
  @property({ type: Boolean, attribute: "open-on-click" }) openOnClick = false;

  @query("wa-tooltip") private webAwesomeTooltip?: WaTooltip;

  private triggerElement: HTMLElement | null = null;
  private describedElement: HTMLElement | null = null;
  private openTimer: number | null = null;
  private closeTimer: number | null = null;
  private triggerHovered = false;
  private contentHovered = false;
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
      --wa-tooltip-arrow-size: var(--openclaw-tooltip-arrow-size, 0px);
      --wa-tooltip-background-color: var(
        --openclaw-tooltip-background-color,
        color-mix(in srgb, var(--bg-elevated) 97%, var(--text) 3%)
      );
      --wa-tooltip-border-color: var(
        --openclaw-tooltip-border-color,
        var(--overlay-border, var(--border-strong))
      );
      --wa-tooltip-border-width: 1px;
      --wa-tooltip-border-style: solid;
      --wa-tooltip-content-color: var(--text);
      --wa-tooltip-border-radius: var(--openclaw-tooltip-border-radius, var(--radius-md));
      --show-duration: var(--openclaw-tooltip-popup-show-duration, var(--wa-transition-fast));
      --hide-duration: var(--openclaw-tooltip-popup-hide-duration, var(--wa-transition-fast));
      font-family: var(--font-body);
    }

    wa-tooltip::part(body) {
      padding: var(--openclaw-tooltip-padding, 5px 7px);
      box-shadow: var(--openclaw-tooltip-shadow, var(--overlay-shadow, var(--shadow-md)));
      font-size: 11px;
      font-weight: 500;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }

    wa-tooltip[open]::part(body) {
      animation: var(--openclaw-tooltip-open-animation, none);
    }

    @keyframes openclaw-tooltip-hover-card-in {
      from {
        opacity: 0;
        transform: translateY(8px) scale(0.95);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
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
    if (this.disabled) {
      this.close();
    }
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

  private attachTrigger() {
    const slot = this.renderRoot.querySelector<HTMLSlotElement>("slot:not([name])");
    const trigger = slot?.assignedElements({ flatten: true }).find(isHtmlElement);
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
    trigger.removeEventListener("pointercancel", this.handlePointerCancel);
    trigger.removeEventListener("focusin", this.handleFocusIn);
    trigger.removeEventListener("focusout", this.handleFocusOut);
    trigger.removeEventListener("click", this.handleClick, true);
    trigger.removeEventListener("keydown", this.handleKeyDown);
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

  private readonly handlePointerDown = () => {
    this.close();
  };

  private readonly handlePointerCancel = () => {
    this.close();
  };
  private readonly handleFocusIn = () => {
    if (this.tooltipProvider?.focusOpensTooltip() !== false) {
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
  // Pointer activation normally dismisses, so an action button never strands an
  // open tooltip. A trigger whose only job is to reveal the tip opts out: on
  // touch and in browsers that do not focus buttons on click there is no other
  // way to read it.
  private readonly handleClick = () => {
    if (this.openOnClick) {
      this.show();
      return;
    }
    this.close();
  };
  private readonly handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      this.close();
    }
  };

  private scheduleOpen() {
    if (this.disabled || this.webAwesomeTooltip?.open || this.openTimer !== null) {
      return;
    }
    const provider = this.tooltipProvider;
    const delay = provider?.delayed === false ? 0 : Math.max(0, provider?.delay ?? HOVER_DELAY);
    this.openTimer = window.setTimeout(() => {
      this.openTimer = null;
      this.show();
    }, delay);
  }

  private show() {
    const tooltip = this.webAwesomeTooltip;
    if (
      this.disabled ||
      !tooltip ||
      !this.triggerElement ||
      !this.tooltipText ||
      this.isRedundant()
    ) {
      return;
    }
    this.clearTimers(false);
    this.tooltipProvider?.openTooltip(this);
    this.syncDescription();
    tooltip.open = true;
  }

  private close() {
    this.clearTimers();
    this.triggerHovered = false;
    this.contentHovered = false;
    if (this.webAwesomeTooltip?.open) {
      this.webAwesomeTooltip.open = false;
    }
    this.tooltipProvider?.closeTooltip(this);
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
    return isTooltipTextRedundant(this.content, trigger);
  }

  private resolveDescribedElement(): HTMLElement | null {
    const trigger = this.triggerElement;
    if (!trigger) {
      return null;
    }
    return trigger.matches(DESCRIBABLE_SELECTOR)
      ? trigger
      : (trigger.querySelector<HTMLElement>(DESCRIBABLE_SELECTOR) ?? trigger);
  }

  private syncDescription() {
    if (!this.describe) {
      this.restoreDescription();
      return;
    }
    const trigger = this.resolveDescribedElement();
    if (!trigger) {
      return;
    }
    this.describedElement = trigger;
    const current = trigger.getAttribute("aria-describedby");
    if (!this.descriptionCaptured) {
      this.describedBy = current;
      this.descriptionCaptured = true;
    }
    if (!this.descriptionElement) {
      // ownerDocument, not the global: slotchange can fire after a test
      // environment tears down its window, where bare `document` throws.
      const description = this.ownerDocument.createElement("span");
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
    const described = this.describedElement ?? this.triggerElement;
    if (!described) {
      return;
    }
    if (this.describedBy) {
      described.setAttribute("aria-describedby", this.describedBy);
    } else {
      described.removeAttribute("aria-describedby");
    }
    this.describedElement = null;
    this.descriptionElement?.remove();
    this.descriptionElement = null;
    this.describedBy = null;
    this.descriptionCaptured = false;
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
    }, this.closeDelay);
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
