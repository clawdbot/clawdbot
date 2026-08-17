import type { ProgressCard } from "@openclaw/gateway-protocol";
import { ReactiveElement, render } from "lit";
import type { ApplicationGateway } from "../app/gateway.ts";
import { t } from "../i18n/index.ts";
import {
  sessionProgressCardsForGateway,
  type SessionProgressCardStore,
} from "../lib/session-progress-cards.ts";
import { renderSessionProgressCard } from "./session-progress-card.ts";

const OPEN_DELAY_MS = 350;
const CLOSE_DELAY_MS = 120;
const CARD_GAP = 10;
const VIEWPORT_PADDING = 12;
let nextHovercardId = 0;

function sessionRowFromEvent(event: Event): HTMLElement | null {
  for (const target of event.composedPath()) {
    if (target instanceof HTMLElement && target.dataset.sessionKey) {
      return target;
    }
  }
  return null;
}

export class SessionProgressHovercardProvider extends ReactiveElement {
  private applicationGateway: ApplicationGateway | null = null;
  private progressCards: SessionProgressCardStore | null = null;
  private stopProgressCardUpdates: (() => void) | null = null;
  private activeRow: HTMLElement | null = null;
  private activeTrigger: HTMLElement | null = null;
  private activeSessionKey: string | null = null;
  private card: HTMLDivElement | null = null;
  private cardFocusInside = false;
  private closeTimer: number | null = null;
  private focusInside = false;
  private loadGeneration = 0;
  private openTimer: number | null = null;
  private pointerInside = false;
  private pointerOverCard = false;
  private readonly activeRowObserver = new MutationObserver(() => {
    if (this.activeRow && !this.contains(this.activeRow)) {
      this.close();
    }
  });

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
    this.connectStore();
  }

  override disconnectedCallback(): void {
    this.removeEventListener("pointerover", this.handlePointerOver);
    this.removeEventListener("pointerout", this.handlePointerOut);
    this.removeEventListener("focusin", this.handleFocusIn);
    this.removeEventListener("focusout", this.handleFocusOut);
    this.removeEventListener("keydown", this.handleKeyDown);
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
    if (!sessionKey || !this.intentHeld) {
      return;
    }
    const card = this.progressCards?.get(sessionKey);
    if (card) {
      this.show(card);
    } else if (card === null) {
      this.close();
    } else {
      this.card?.remove();
      this.card = null;
      this.pointerOverCard = false;
      this.cardFocusInside = false;
    }
  };

  private readonly handlePointerOver = (event: PointerEvent) => {
    if (event.pointerType === "touch" || !globalThis.matchMedia?.("(hover: hover)").matches) {
      return;
    }
    const row = sessionRowFromEvent(event);
    if (!row) {
      return;
    }
    this.activate(row, row, OPEN_DELAY_MS);
    this.pointerInside = true;
  };

  private readonly handlePointerOut = (event: PointerEvent) => {
    const row = sessionRowFromEvent(event);
    if (!row || row !== this.activeRow) {
      return;
    }
    if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) {
      return;
    }
    this.pointerInside = false;
    this.scheduleClose();
  };

  private readonly handleFocusIn = (event: FocusEvent) => {
    const row = sessionRowFromEvent(event);
    const trigger = event.target instanceof HTMLElement ? event.target : row;
    if (!row || !trigger) {
      return;
    }
    this.activate(row, trigger, 0);
    this.focusInside = true;
  };

  private readonly handleFocusOut = (event: FocusEvent) => {
    if (!this.activeRow) {
      return;
    }
    if (event.relatedTarget instanceof Node && this.activeRow.contains(event.relatedTarget)) {
      return;
    }
    this.focusInside = false;
    this.scheduleClose();
  };

  private readonly handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      this.close();
      return;
    }
    if (event.key !== "Tab" || event.shiftKey || event.target !== this.activeTrigger) {
      return;
    }
    const first = this.cardFocusables()[0];
    if (first) {
      event.preventDefault();
      first.focus();
    }
  };

  private activate(row: HTMLElement, trigger: HTMLElement, delay: number): void {
    const sessionKey = row.dataset.sessionKey;
    if (!sessionKey || (row === this.activeRow && sessionKey === this.activeSessionKey)) {
      return;
    }
    this.close();
    this.activeRow = row;
    this.activeTrigger = trigger;
    this.activeSessionKey = sessionKey;
    this.progressCards?.watch(this, [sessionKey]);
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.setAttribute("aria-expanded", "false");
    this.activeRowObserver.observe(this, { childList: true, subtree: true });
    const generation = ++this.loadGeneration;
    this.openTimer = window.setTimeout(() => {
      this.openTimer = null;
      void this.loadAndShow(sessionKey, generation);
    }, delay);
  }

  private async loadAndShow(sessionKey: string, generation: number): Promise<void> {
    try {
      const card = await this.progressCards?.load(sessionKey);
      if (
        generation !== this.loadGeneration ||
        this.activeSessionKey !== sessionKey ||
        !card ||
        !this.intentHeld
      ) {
        return;
      }
      this.show(card);
    } catch {
      // A missing or unavailable card has no hover surface by design.
    }
  }

  private show(progressCard: ProgressCard): void {
    const row = this.activeRow;
    const trigger = this.activeTrigger;
    if (!row || !trigger) {
      return;
    }
    if (this.card?.dataset.revision === String(progressCard.revision)) {
      return;
    }
    this.card?.remove();
    const card = document.createElement("div");
    nextHovercardId += 1;
    card.id = `openclaw-session-progress-hovercard-${nextHovercardId}`;
    card.className = "session-progress-hovercard";
    card.dataset.open = "true";
    card.dataset.revision = String(progressCard.revision);
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", t("sessionProgressCard.ariaLabel"));
    render(renderSessionProgressCard(progressCard, "hovercard"), card);
    card.addEventListener("pointerenter", this.handleCardPointerEnter);
    card.addEventListener("pointerleave", this.handleCardPointerLeave);
    card.addEventListener("focusin", this.handleCardFocusIn);
    card.addEventListener("focusout", this.handleCardFocusOut);
    card.addEventListener("keydown", this.handleCardKeyDown);
    document.body.append(card);
    this.card = card;
    trigger.setAttribute("aria-controls", card.id);
    trigger.setAttribute("aria-expanded", "true");
    this.listenForViewportChanges();
    this.positionCard();
  }

  private readonly handleCardPointerEnter = () => {
    this.pointerOverCard = true;
    this.clearCloseTimer();
  };

  private readonly handleCardPointerLeave = () => {
    this.pointerOverCard = false;
    this.scheduleClose();
  };

  private readonly handleCardFocusIn = () => {
    this.cardFocusInside = true;
    this.clearCloseTimer();
  };

  private readonly handleCardFocusOut = (event: FocusEvent) => {
    if (event.relatedTarget instanceof Node && this.card?.contains(event.relatedTarget)) {
      return;
    }
    this.cardFocusInside = false;
    this.scheduleClose();
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
    const trigger = this.activeTrigger;
    this.close();
    trigger?.focus({ preventScroll: true });
  };

  private cardFocusables(): HTMLElement[] {
    return [...(this.card?.querySelectorAll<HTMLElement>("a[href]") ?? [])];
  }

  private get intentHeld(): boolean {
    return this.pointerInside || this.pointerOverCard || this.focusInside || this.cardFocusInside;
  }

  private scheduleClose(): void {
    this.clearCloseTimer();
    if (this.intentHeld) {
      return;
    }
    if (!this.card) {
      this.close();
      return;
    }
    this.closeTimer = window.setTimeout(() => {
      this.closeTimer = null;
      if (!this.intentHeld) {
        this.close();
      }
    }, CLOSE_DELAY_MS);
  }

  private clearCloseTimer(): void {
    if (this.closeTimer !== null) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  private close(): void {
    if (this.openTimer !== null) {
      window.clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    this.clearCloseTimer();
    this.loadGeneration += 1;
    this.activeRowObserver.disconnect();
    this.progressCards?.unwatch(this);
    if (this.activeTrigger) {
      this.activeTrigger.removeAttribute("aria-controls");
      this.activeTrigger.removeAttribute("aria-expanded");
      this.activeTrigger.removeAttribute("aria-haspopup");
    }
    this.card?.remove();
    this.card = null;
    this.activeRow = null;
    this.activeTrigger = null;
    this.activeSessionKey = null;
    this.pointerInside = false;
    this.pointerOverCard = false;
    this.focusInside = false;
    this.cardFocusInside = false;
    this.stopListeningForViewportChanges();
  }

  private readonly handleViewportChange = () => this.positionCard();

  private listenForViewportChanges(): void {
    window.addEventListener("resize", this.handleViewportChange);
    window.addEventListener("scroll", this.handleViewportChange, true);
  }

  private stopListeningForViewportChanges(): void {
    window.removeEventListener("resize", this.handleViewportChange);
    window.removeEventListener("scroll", this.handleViewportChange, true);
  }

  private positionCard(): void {
    const row = this.activeRow;
    const card = this.card;
    if (!row || !card) {
      return;
    }
    const rowRect = row.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const fitsRight = rowRect.right + CARD_GAP + cardRect.width + VIEWPORT_PADDING <= innerWidth;
    const left = fitsRight ? rowRect.right + CARD_GAP : rowRect.left - cardRect.width - CARD_GAP;
    const maxLeft = Math.max(VIEWPORT_PADDING, innerWidth - cardRect.width - VIEWPORT_PADDING);
    const maxTop = Math.max(VIEWPORT_PADDING, innerHeight - cardRect.height - VIEWPORT_PADDING);
    card.dataset.side = fitsRight ? "right" : "left";
    card.style.left = `${Math.min(Math.max(VIEWPORT_PADDING, left), maxLeft)}px`;
    card.style.top = `${Math.min(Math.max(VIEWPORT_PADDING, rowRect.top), maxTop)}px`;
  }
}
