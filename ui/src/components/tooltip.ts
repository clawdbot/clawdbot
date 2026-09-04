// Control UI adapter for Web Awesome tooltips. OpenClaw keeps its terse
// wrapper API and manual dismissal; Web Awesome owns positioning and rendering.
import "@awesome.me/webawesome/dist/components/tooltip/tooltip.js";
import type WaTooltip from "@awesome.me/webawesome/dist/components/tooltip/tooltip.js";
import { css, html } from "lit";
import { property, query } from "lit/decorators.js";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import {
  isTooltipTextRedundant,
  isTooltipTriggerElement,
  normalizeTooltipText,
} from "./tooltip-content.ts";

const DESCRIBABLE_SELECTOR =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
const HOVER_DELAY = 150;
const SKIP_DELAY = 300;
const RICH_CONTENT_CLOSE_DELAY = 100;

let nextTooltipId = 0;

function createTooltipId() {
  return `openclaw-tooltip-${++nextTooltipId}`;
}

class TooltipProvider extends OpenClawLitElement {
  @property({ type: Number }) delay = HOVER_DELAY;
  @property({ type: Number }) skipDelay = SKIP_DELAY;

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
    Tooltip.closeForProvider(this);
    this.clearSkipDelayTimer();
    this.delayed = true;
    super.disconnectedCallback();
  }

  focusOpensTooltip() {
    return this.focusInput === "keyboard";
  }

  openTooltip() {
    this.delayed = false;
    this.clearSkipDelayTimer();
  }

  closeTooltip() {
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
  private static readonly activeByDocument = new WeakMap<Document, Tooltip>();

  static readonly consumeEscape = (event: KeyboardEvent, ownerDocument: Document): boolean => {
    if (event.key !== "Escape" || event.defaultPrevented) {
      return false;
    }
    const active = Tooltip.activeByDocument.get(ownerDocument);
    if (!active) {
      return false;
    }
    // Block native dialog cancellation and later listeners on this capture target.
    event.preventDefault();
    event.stopImmediatePropagation();
    active.close();
    return true;
  };

  static closeForProvider(provider: TooltipProvider) {
    const active = Tooltip.activeByDocument.get(provider.ownerDocument);
    if (active?.tooltipProvider === provider) {
      active.close();
    }
  }

  @property() content = "";

  @property({ type: Number }) closeDelay = RICH_CONTENT_CLOSE_DELAY;

  @property({ type: Number }) delay?: number;

  @property({ type: Boolean }) describe = true;

  @property({ type: Boolean }) disabled = false;

  /** Let a reveal-only trigger open on click instead of dismissing. */
  @property({ type: Boolean, attribute: "open-on-click" }) openOnClick = false;

  @property({ attribute: false }) anchor: HTMLElement | SVGElement | null = null;

  @query("wa-tooltip") private webAwesomeTooltip?: WaTooltip;

  private triggerElement: HTMLElement | SVGElement | null = null;
  private pinned = false;
  private describedElement: Element | null = null;
  private openTimer: number | null = null;
  private closeTimer: number | null = null;
  private triggerHovered = false;
  private contentHovered = false;
  private describedBy: string | null = null;
  private descriptionCaptured = false;
  private suppressNextFocusOpen = false;
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

    :host(.sidebar-hover-tooltip) wa-tooltip[open]::part(base__popup) {
      animation: var(--openclaw-tooltip-open-animation);
    }

    @media (prefers-reduced-motion: reduce) {
      wa-tooltip {
        --show-duration: 0ms;
        --hide-duration: 0ms;
      }

      :host(.sidebar-hover-tooltip) wa-tooltip[open]::part(base__popup) {
        animation: none;
      }
    }

    @keyframes openclaw-tooltip-hover-card-in {
      from {
        opacity: 0;
        transform: scale(0.95);
      }
      to {
        opacity: 1;
        transform: scale(1);
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
    this.style.display = "contents";
  }

  protected override updated() {
    this.attachTrigger();
    this.syncDescription();
    this.syncWebAwesomeTooltip();
    // Closed tooltips check redundancy in show(); measuring their triggers here
    // forces layout while a new transcript is still rendering.
    if (
      this.disabled ||
      !this.tooltipText ||
      (this.webAwesomeTooltip?.open && this.isRedundant())
    ) {
      this.close();
    }
  }

  override disconnectedCallback() {
    this.close();
    this.richContentObserver?.disconnect();
    this.richContentObserver = null;
    this.tooltipProvider = null;
    this.detachTrigger();
    super.disconnectedCallback();
  }

  private attachTrigger() {
    const slot = this.renderRoot.querySelector<HTMLSlotElement>("slot:not([name])");
    const trigger =
      this.anchor ?? slot?.assignedElements({ flatten: true }).find(isTooltipTriggerElement);
    if (trigger === this.triggerElement) {
      return;
    }
    this.close();
    this.detachTrigger();
    if (!trigger) {
      return;
    }
    this.triggerElement = trigger;
    this.tooltipProvider = null;
    let owner: Element | null = trigger;
    while (owner) {
      const provider = owner.closest<TooltipProvider>("openclaw-tooltip-provider");
      if (provider) {
        this.tooltipProvider = provider;
        break;
      }
      const root = owner.getRootNode();
      owner = root instanceof ShadowRoot ? root.host : null;
    }
    trigger.addEventListener("pointerenter", this.handlePointerEnter);
    trigger.addEventListener("pointerleave", this.handlePointerLeave);
    trigger.addEventListener("pointerdown", this.handlePointerDown);
    trigger.addEventListener("pointercancel", this.handlePointerCancel);
    trigger.addEventListener("focusin", this.handleFocusIn);
    trigger.addEventListener("focusout", this.handleFocusOut);
    trigger.addEventListener("click", this.handleClick, true);
    this.observeRichContent();
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
    this.restoreDescription();
    this.triggerElement = null;
  }

  /** Attribute hints share the wrapped trigger's lifecycle without reparenting its DOM. */
  previewForAnchor(anchor: HTMLElement | SVGElement, content: string, input: "pointer" | "focus") {
    this.anchor = anchor;
    this.content = content;
    void this.updateComplete.then(() => {
      if (this.anchor !== anchor || !anchor.isConnected || !this.isConnected) {
        return;
      }
      if (input === "focus") {
        this.handleFocusIn();
      } else {
        this.triggerHovered = true;
        this.scheduleOpen();
      }
    });
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

  private readonly handlePointerEnter = (event: Event) => {
    if (!("pointerType" in event) || event.pointerType !== "touch") {
      this.triggerHovered = true;
      this.clearCloseTimer();
      this.scheduleOpen();
    }
  };

  private readonly handlePointerLeave = (event: Event) => {
    if (!("pointerType" in event) || event.pointerType !== "touch") {
      this.triggerHovered = false;
      this.clearTimers(false);
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
    if (!this.openOnClick) {
      this.close();
    }
  };

  private readonly handlePointerCancel = () => {
    this.close();
  };
  private readonly handleFocusIn = () => {
    if (this.suppressNextFocusOpen) {
      this.suppressNextFocusOpen = false;
      this.close();
      return;
    }
    if (this.tooltipProvider?.focusOpensTooltip() !== false) {
      this.show();
    }
  };
  private readonly handleFocusOut = (event: Event) => {
    if (
      (event instanceof FocusEvent &&
        event.relatedTarget instanceof Node &&
        this.containsInteractionTarget(event.relatedTarget)) ||
      this.pinned ||
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
    if (this.openOnClick && !this.pinned) {
      this.show();
      this.pinned = this.webAwesomeTooltip?.open === true;
      return;
    }
    this.close();
  };

  private scheduleOpen() {
    if (this.disabled || this.webAwesomeTooltip?.open || this.openTimer !== null) {
      return;
    }
    const provider = this.tooltipProvider;
    const delay =
      this.delay === undefined && provider?.delayed === false
        ? 0
        : Math.max(0, this.delay ?? provider?.delay ?? HOVER_DELAY);
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
    const active = Tooltip.activeByDocument.get(this.ownerDocument);
    if (active && active !== this) {
      active.close();
    }
    // Portaled menus and modal roots can sit outside the provider. The document
    // owns exclusivity; providers configure timing and input modality only.
    Tooltip.activeByDocument.set(this.ownerDocument, this);
    this.tooltipProvider?.openTooltip();
    this.syncDescription();
    tooltip.open = true;
    // Light-DOM owners can retain a revealed trigger without another popup lifecycle.
    this.setAttribute("open", "");
    this.ownerDocument.addEventListener("pointerdown", this.handleDocumentDismiss, true);
    this.ownerDocument.addEventListener("focusin", this.handleDocumentDismiss, true);
    this.ownerDocument.defaultView?.addEventListener("keydown", this.handleWindowKeyDown, true);
  }

  // Manual WA tooltips have no Escape handler. Capture before dialogs/default
  // actions; earlier capture owners use the same consumer before handling keys.
  private readonly handleWindowKeyDown = (event: KeyboardEvent) => {
    Tooltip.consumeEscape(event, this.ownerDocument);
  };

  private readonly handleDocumentDismiss = (event: Event) => {
    if (!event.composedPath().some((target) => target === this || target === this.triggerElement)) {
      this.close();
    }
  };

  private containsInteractionTarget(target: Node) {
    return this.contains(target) || this.triggerElement?.contains(target) === true;
  }

  private close() {
    this.pinned = false;
    this.removeAttribute("open");
    this.ownerDocument.removeEventListener("pointerdown", this.handleDocumentDismiss, true);
    this.ownerDocument.removeEventListener("focusin", this.handleDocumentDismiss, true);
    this.ownerDocument.defaultView?.removeEventListener("keydown", this.handleWindowKeyDown, true);
    this.clearTimers();
    if (this.webAwesomeTooltip?.open) {
      this.webAwesomeTooltip.open = false;
    }
    if (Tooltip.activeByDocument.get(this.ownerDocument) === this) {
      Tooltip.activeByDocument.delete(this.ownerDocument);
      this.tooltipProvider?.closeTooltip();
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

  private resolveDescribedElement(): Element | null {
    const trigger = this.triggerElement;
    if (!trigger) {
      return null;
    }
    return trigger.matches(DESCRIBABLE_SELECTOR)
      ? trigger
      : (trigger.querySelector(DESCRIBABLE_SELECTOR) ?? trigger);
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
      const root = trigger.getRootNode();
      (root instanceof ShadowRoot ? root : this).append(description);
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
    const root = this.triggerElement?.getRootNode();
    const activeElement =
      root instanceof ShadowRoot ? root.activeElement : this.ownerDocument.activeElement;
    return (
      this.pinned ||
      this.triggerHovered ||
      this.contentHovered ||
      (activeElement instanceof Node && this.containsInteractionTarget(activeElement))
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
      <wa-tooltip id=${this.tooltipId} trigger="manual" @wa-hide=${() => this.close()}>
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

  focusTriggerWithoutOpening(target: HTMLElement) {
    if (target === this.triggerElement && !target.matches(":focus")) {
      // Navigation can replace a focused toggle with its inverse. Preserve the
      // focus handoff without presenting it as fresh tooltip intent.
      this.suppressNextFocusOpen = true;
    }
    target.focus();
  }
}

export const consumeTooltipEscape = Tooltip.consumeEscape;

export function focusWithoutTooltip(target: HTMLElement | null | undefined) {
  const tooltip = target?.closest<Tooltip>("openclaw-tooltip");
  if (tooltip && target) {
    tooltip.focusTriggerWithoutOpening(target);
  } else {
    target?.focus();
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
