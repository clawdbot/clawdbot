import type { ProgressCard } from "@openclaw/gateway-protocol";
import { ReactiveElement, render } from "lit";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { t } from "../i18n/index.ts";
import {
  sessionProgressCardsForGateway,
  type SessionProgressCardStore,
} from "../lib/session-progress-cards.ts";
import { createPortaledHovercard, PortaledHovercardController } from "./portaled-hovercard.ts";
import { SessionLinkTitler } from "./session-link-titling.ts";
import { renderSessionProgressCard } from "./session-progress-card.ts";
import { sessionProgressHoverAnchorFromEvent } from "./session-progress-hovercard-target.ts";

const OPEN_DELAY_MS = 350;
let nextHovercardId = 0;

export class SessionProgressHovercardProvider extends ReactiveElement {
  private applicationClient: GatewayBrowserClient | null = null;
  private applicationContext: ApplicationContext | null = null;
  private applicationGateway: ApplicationGateway | null = null;
  private progressCards: SessionProgressCardStore | null = null;
  private stopProgressCardUpdates: (() => void) | null = null;
  private activeAnchor: HTMLAnchorElement | null = null;
  private activeSessionKey: string | null = null;
  private readonly hovercard = new PortaledHovercardController(() => this.close());
  private readonly sessionLinkTitler = new SessionLinkTitler(this);
  private loadGeneration = 0;
  private readonly activeAnchorObserver = new MutationObserver(() => {
    if (this.activeAnchor && !this.contains(this.activeAnchor)) {
      this.close();
    }
  });

  get client(): GatewayBrowserClient | null {
    return this.applicationClient;
  }

  set client(value: GatewayBrowserClient | null) {
    this.applicationClient = value;
    this.sessionLinkTitler.client = value;
  }

  get context(): ApplicationContext | null {
    return this.applicationContext;
  }

  set context(value: ApplicationContext | null) {
    this.applicationContext = value;
    this.sessionLinkTitler.context = value;
    if (this.isConnected) {
      this.sessionLinkTitler.refresh();
    }
  }

  get gateway(): ApplicationGateway | null {
    return this.applicationGateway;
  }

  set gateway(value: ApplicationGateway | null) {
    if (value === this.applicationGateway) {
      return;
    }
    this.disconnectStore();
    this.applicationGateway = value;
    this.close();
    if (this.isConnected) {
      this.connectStore();
    }
  }

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "contents";
    this.addEventListener("pointerover", this.handlePointerOver);
    this.addEventListener("pointerout", this.handlePointerOut);
    this.addEventListener("focusin", this.handleFocusIn);
    this.addEventListener("focusout", this.handleFocusOut);
    this.addEventListener("keydown", this.handleKeyDown);
    this.sessionLinkTitler.connect();
    this.connectStore();
  }

  override disconnectedCallback(): void {
    this.removeEventListener("pointerover", this.handlePointerOver);
    this.removeEventListener("pointerout", this.handlePointerOut);
    this.removeEventListener("focusin", this.handleFocusIn);
    this.removeEventListener("focusout", this.handleFocusOut);
    this.removeEventListener("keydown", this.handleKeyDown);
    this.sessionLinkTitler.disconnect();
    this.disconnectStore();
    this.close();
    super.disconnectedCallback();
  }

  private connectStore(): void {
    if (!this.applicationGateway || this.progressCards) {
      return;
    }
    this.progressCards = sessionProgressCardsForGateway(this.applicationGateway);
    this.stopProgressCardUpdates = this.progressCards.subscribe(this.handleProgressCardUpdate);
  }

  private disconnectStore(): void {
    this.progressCards?.unwatch(this);
    this.stopProgressCardUpdates?.();
    this.stopProgressCardUpdates = null;
    this.progressCards = null;
  }

  private readonly handleProgressCardUpdate = () => {
    const sessionKey = this.activeSessionKey;
    if (!sessionKey || !this.hovercard.held) {
      return;
    }
    const card = this.progressCards?.get(sessionKey);
    if (card) {
      this.show(card);
    } else if (card === null) {
      this.close();
    } else {
      this.hovercard.clearCard();
      this.hovercard.pointerOverCard = false;
      this.hovercard.cardFocusInside = false;
    }
  };

  private readonly handlePointerOver = (event: PointerEvent) => {
    if (event.pointerType === "touch" || !globalThis.matchMedia?.("(hover: hover)").matches) {
      return;
    }
    const anchor = sessionProgressHoverAnchorFromEvent(event);
    if (!anchor) {
      return;
    }
    this.activate(anchor, OPEN_DELAY_MS);
    this.hovercard.pointerInside = true;
  };

  private readonly handlePointerOut = (event: PointerEvent) => {
    const anchor = sessionProgressHoverAnchorFromEvent(event);
    if (!anchor || anchor !== this.activeAnchor) {
      return;
    }
    if (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) {
      return;
    }
    this.hovercard.pointerInside = false;
    this.hovercard.scheduleClose();
  };

  private readonly handleFocusIn = (event: FocusEvent) => {
    const anchor = sessionProgressHoverAnchorFromEvent(event);
    if (!anchor) {
      return;
    }
    this.activate(anchor, 0);
    this.hovercard.focusInside = true;
  };

  private readonly handleFocusOut = (event: FocusEvent) => {
    if (!this.activeAnchor) {
      return;
    }
    if (event.relatedTarget instanceof Node && this.activeAnchor.contains(event.relatedTarget)) {
      return;
    }
    this.hovercard.focusInside = false;
    this.hovercard.scheduleClose();
  };

  private readonly handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      this.close();
      return;
    }
    if (event.key !== "Tab" || event.shiftKey || event.target !== this.activeAnchor) {
      return;
    }
    const first = this.cardFocusables()[0];
    if (first) {
      event.preventDefault();
      first.focus();
    }
  };

  private activate(anchor: HTMLAnchorElement, delay: number): void {
    const sessionKey = anchor.dataset.sessionKey;
    if (!sessionKey || (anchor === this.activeAnchor && sessionKey === this.activeSessionKey)) {
      return;
    }
    this.close();
    this.activeAnchor = anchor;
    this.activeSessionKey = sessionKey;
    this.progressCards?.watch(this, [sessionKey]);
    this.hovercard.markTrigger(anchor);
    this.activeAnchorObserver.observe(this, { childList: true, subtree: true });
    const generation = ++this.loadGeneration;
    this.hovercard.scheduleOpen(delay, () => void this.loadAndShow(sessionKey, generation));
  }

  private async loadAndShow(sessionKey: string, generation: number): Promise<void> {
    const anchor = this.activeAnchor;
    if (anchor?.dataset.sessionKey === sessionKey) {
      void this.sessionLinkTitler.decorate(anchor, true);
    }
    try {
      const card = await this.progressCards?.load(sessionKey);
      if (
        generation !== this.loadGeneration ||
        this.activeSessionKey !== sessionKey ||
        !card ||
        !this.hovercard.held
      ) {
        return;
      }
      this.show(card);
    } catch {
      // A missing or unavailable card has no hover surface by design.
    }
  }

  private show(progressCard: ProgressCard): void {
    const anchor = this.activeAnchor;
    if (!anchor) {
      return;
    }
    if (this.hovercard.card?.dataset.revision === String(progressCard.revision)) {
      return;
    }
    nextHovercardId += 1;
    const card = createPortaledHovercard(
      `openclaw-session-progress-hovercard-${nextHovercardId}`,
      "session-progress-hovercard",
    );
    card.dataset.revision = String(progressCard.revision);
    card.setAttribute("aria-label", t("sessionProgressCard.ariaLabel"));
    render(renderSessionProgressCard(progressCard, "hovercard"), card);
    card.addEventListener("pointerenter", this.handleCardPointerEnter);
    card.addEventListener("pointerleave", this.handleCardPointerLeave);
    card.addEventListener("focusin", this.handleCardFocusIn);
    card.addEventListener("focusout", this.handleCardFocusOut);
    card.addEventListener("keydown", this.handleCardKeyDown);
    this.hovercard.mount(anchor, card, "vertical", false);
  }

  private readonly handleCardPointerEnter = () => {
    this.hovercard.pointerOverCard = true;
    this.hovercard.clearClose();
  };

  private readonly handleCardPointerLeave = () => {
    this.hovercard.pointerOverCard = false;
    this.hovercard.scheduleClose();
  };

  private readonly handleCardFocusIn = () => {
    this.hovercard.cardFocusInside = true;
    this.hovercard.clearClose();
  };

  private readonly handleCardFocusOut = (event: FocusEvent) => {
    if (event.relatedTarget instanceof Node && this.hovercard.card?.contains(event.relatedTarget)) {
      return;
    }
    this.hovercard.cardFocusInside = false;
    this.hovercard.scheduleClose();
  };

  private readonly handleCardKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" && event.key !== "Tab") {
      return;
    }
    const focusables = this.cardFocusables();
    const edge = event.shiftKey ? focusables[0] : focusables.at(-1);
    if (event.key === "Tab" && document.activeElement !== edge) {
      return;
    }
    event.preventDefault();
    const anchor = this.activeAnchor;
    this.close();
    anchor?.focus({ preventScroll: true });
  };

  private cardFocusables(): HTMLElement[] {
    return [...(this.hovercard.card?.querySelectorAll<HTMLElement>("a[href]") ?? [])];
  }

  private close(): void {
    this.hovercard.reset();
    this.loadGeneration += 1;
    this.activeAnchorObserver.disconnect();
    this.progressCards?.unwatch(this);
    this.activeAnchor = null;
    this.activeSessionKey = null;
  }
}
