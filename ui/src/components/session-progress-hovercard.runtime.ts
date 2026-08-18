import { ReactiveElement, render } from "lit";
import type { ApplicationGateway } from "../app/gateway.ts";
import { t } from "../i18n/index.ts";
import {
  sessionProgressCardsForGateway,
  type SessionProgressCardStore,
} from "../lib/session-progress-cards.ts";
import {
  scopedSessionPullRequestKey,
  sessionPullRequestsForGateway,
  type SessionPullRequestSnapshotStore,
} from "../lib/session-pull-requests.ts";
import { parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import { createPortaledHovercard, PortaledHovercardController } from "./portaled-hovercard.ts";
import { renderSessionHovercard } from "./session-hovercard.ts";
import { getSidebarSessionRow } from "./sidebar-session-row-registry.ts";

const OPEN_DELAY_MS = 350;
let nextHovercardId = 0;

function sessionRowFromEvent(event: Event): HTMLElement | null {
  for (const target of event.composedPath()) {
    if (
      target instanceof HTMLElement &&
      target.matches(".sidebar-recent-session[data-session-key]")
    ) {
      return target;
    }
  }
  return null;
}

export class SessionProgressHovercardProvider extends ReactiveElement {
  private applicationGateway: ApplicationGateway | null = null;
  private progressCards: SessionProgressCardStore | null = null;
  private stopProgressCardUpdates: (() => void) | null = null;
  private pullRequests: SessionPullRequestSnapshotStore | null = null;
  private stopPullRequestUpdates: (() => void) | null = null;
  private activeRow: HTMLElement | null = null;
  private activeTrigger: HTMLElement | null = null;
  private activeSessionKey: string | null = null;
  private activePullRequestKey: string | null = null;
  private open = false;
  private readonly hovercard = new PortaledHovercardController(() => this.close());
  private loadGeneration = 0;
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
    this.releasePullRequestStore();
  }

  private readonly handleProgressCardUpdate = () => {
    if (!this.open || !this.hovercard.held) {
      return;
    }
    this.showCurrent();
  };

  private readonly handlePullRequestUpdate = () => {
    if (this.open && this.hovercard.held) {
      this.showCurrent();
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
    this.hovercard.pointerInside = true;
  };

  private readonly handlePointerOut = (event: PointerEvent) => {
    const row = sessionRowFromEvent(event);
    if (!row || row !== this.activeRow) {
      return;
    }
    if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) {
      return;
    }
    this.hovercard.pointerInside = false;
    this.hovercard.scheduleClose();
  };

  private readonly handleFocusIn = (event: FocusEvent) => {
    const row = sessionRowFromEvent(event);
    const trigger = event.target instanceof HTMLElement ? event.target : row;
    if (!row || !trigger) {
      return;
    }
    this.activate(row, trigger, 0);
    this.hovercard.focusInside = true;
  };

  private readonly handleFocusOut = (event: FocusEvent) => {
    if (!this.activeRow) {
      return;
    }
    if (event.relatedTarget instanceof Node && this.activeRow.contains(event.relatedTarget)) {
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
    this.open = false;
    this.progressCards?.watch(this, [sessionKey]);
    this.hovercard.markTrigger(trigger);
    this.activeRowObserver.observe(this, { childList: true, subtree: true });
    const generation = ++this.loadGeneration;
    this.hovercard.scheduleOpen(delay, () => void this.loadAndShow(sessionKey, generation));
  }

  private async loadAndShow(sessionKey: string, generation: number): Promise<void> {
    if (
      generation !== this.loadGeneration ||
      this.activeSessionKey !== sessionKey ||
      !this.hovercard.held
    ) {
      return;
    }
    this.open = true;
    this.watchPullRequests(sessionKey);
    this.showCurrent();
    try {
      await this.progressCards?.load(sessionKey);
    } catch {
      // Row and pull-request facts remain useful when progress is unavailable.
    }
    if (
      generation === this.loadGeneration &&
      this.activeSessionKey === sessionKey &&
      this.hovercard.held
    ) {
      this.showCurrent();
    }
  }

  private watchPullRequests(sessionKey: string): void {
    const gateway = this.applicationGateway;
    if (!gateway) {
      return;
    }
    this.releasePullRequestStore();
    const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? gateway.snapshot.assistantAgentId;
    this.activePullRequestKey = scopedSessionPullRequestKey(sessionKey, agentId ?? undefined);
    this.pullRequests = sessionPullRequestsForGateway(gateway);
    this.stopPullRequestUpdates = this.pullRequests.subscribe(this.handlePullRequestUpdate);
    this.pullRequests.watch(this, [this.activePullRequestKey], { foreground: true });
  }

  private releasePullRequestStore(): void {
    this.pullRequests?.unwatch(this);
    this.stopPullRequestUpdates?.();
    this.stopPullRequestUpdates = null;
    this.pullRequests = null;
    this.activePullRequestKey = null;
  }

  private showCurrent(): void {
    const row = this.activeRow;
    const trigger = this.activeTrigger;
    const sessionKey = this.activeSessionKey;
    const gateway = this.applicationGateway;
    if (!row || !trigger || !sessionKey || !gateway || !this.open) {
      return;
    }
    const sidebarRow = getSidebarSessionRow(gateway, sessionKey);
    const pullRequests = this.activePullRequestKey
      ? this.pullRequests?.get(this.activePullRequestKey)
      : undefined;
    const progressCard = this.progressCards?.get(sessionKey);
    const revision = JSON.stringify({
      progress: progressCard?.revision ?? null,
      pullRequests: pullRequests
        ? { branch: pullRequests.branch, pullRequests: pullRequests.pullRequests }
        : null,
      row: sidebarRow
        ? {
            label: sidebarRow.label,
            owner: sidebarRow.owner?.actor ?? sidebarRow.createdActor,
            startedAt: sidebarRow.startedAt,
            subtitle: sidebarRow.subtitle,
            updatedAt: sidebarRow.updatedAt,
          }
        : null,
    });
    if (this.hovercard.card?.dataset.revision === revision) {
      return;
    }
    nextHovercardId += 1;
    const card = createPortaledHovercard(
      `openclaw-session-progress-hovercard-${nextHovercardId}`,
      "session-progress-hovercard",
    );
    card.dataset.revision = revision;
    card.setAttribute("aria-label", t("sessionHovercard.ariaLabel"));
    render(
      renderSessionHovercard({
        row: sidebarRow,
        pullRequests,
        progressCard,
      }),
      card,
    );
    if (!card.firstElementChild) {
      this.hovercard.clearCard();
      this.hovercard.pointerOverCard = false;
      this.hovercard.cardFocusInside = false;
      return;
    }
    card.addEventListener("pointerenter", this.handleCardPointerEnter);
    card.addEventListener("pointerleave", this.handleCardPointerLeave);
    card.addEventListener("focusin", this.handleCardFocusIn);
    card.addEventListener("focusout", this.handleCardFocusOut);
    card.addEventListener("keydown", this.handleCardKeyDown);
    this.hovercard.mount(row, card, "horizontal", false);
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
    const trigger = this.activeTrigger;
    this.close();
    trigger?.focus({ preventScroll: true });
  };

  private cardFocusables(): HTMLElement[] {
    return [...(this.hovercard.card?.querySelectorAll<HTMLElement>("a[href]") ?? [])];
  }

  private close(): void {
    this.hovercard.reset();
    this.loadGeneration += 1;
    this.open = false;
    this.activeRowObserver.disconnect();
    this.progressCards?.unwatch(this);
    this.releasePullRequestStore();
    this.activeRow = null;
    this.activeTrigger = null;
    this.activeSessionKey = null;
  }
}
