import type { ProgressCard, ProgressCardGetParams } from "@openclaw/gateway-protocol";
import { nothing, ReactiveElement, render } from "lit";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import { resolveControlUiAuthCandidates } from "../app/control-ui-auth.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { t } from "../i18n/index.ts";
import {
  sessionProgressCardsForGateway,
  type SessionProgressCardStore,
} from "../lib/session-progress-cards.ts";
import {
  sessionPullRequestsForGateway,
  type SessionPullRequestSnapshotStore,
} from "../lib/session-pull-requests.ts";
import { parseAgentSessionKey, scopedSessionArtifactKey } from "../lib/sessions/session-key.ts";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import { personActivityRouting, type PersonActivityRouting } from "./person-activity-link.ts";
import { createPortaledHovercard, PortaledHovercardController } from "./portaled-hovercard.ts";
import { renderSessionHovercard } from "./session-hovercard.ts";
import { SessionLinkTitler } from "./session-link-titling.ts";
import {
  SESSION_MENU_OPEN_EVENT,
  sessionProgressHoverPlacementForTarget,
  sessionProgressHoverTargetFromEvent,
} from "./session-progress-hovercard-target.ts";

const OPEN_DELAY_MS = 450;
const SWEEP_OPEN_DELAY_MS = 80;
const SKIP_DELAY_MS = 300;
const CLOSE_DELAY_MS = 100;
const EXIT_DURATION_MS = 100;
let nextHovercardId = 0;

function sessionHovercardMenuOpen(owner: ParentNode): boolean {
  return (
    owner.querySelector(
      '[data-session-menu][aria-expanded="true"], [data-catalog-session-menu][aria-expanded="true"]',
    ) !== null
  );
}

export class SessionProgressHovercardProvider extends ReactiveElement {
  // Let Lit replay dependencies assigned before the lazy element upgrades.
  static override properties = {
    client: { attribute: false, noAccessor: true },
    context: { attribute: false, noAccessor: true },
    gateway: { attribute: false, noAccessor: true },
  };

  private applicationClient: GatewayBrowserClient | null = null;
  private applicationContext: ApplicationContext | null = null;
  private applicationGateway: ApplicationGateway | null = null;
  private progressCards: SessionProgressCardStore | null = null;
  private stopProgressCardUpdates: (() => void) | null = null;
  private stopContextUpdates: (() => void) | null = null;
  private pullRequests: SessionPullRequestSnapshotStore | null = null;
  private stopPullRequestUpdates: (() => void) | null = null;
  private activeTarget: HTMLElement | null = null;
  private activeTrigger: HTMLElement | null = null;
  private activeSession: ProgressCardGetParams | null = null;

  private get activeArtifactKey(): string | null {
    return this.activeSession
      ? scopedSessionArtifactKey(this.activeSession.sessionKey, this.activeSession.agentId)
      : null;
  }
  private suppressFocusOpen = false;
  private open = false;
  private delayed = true;
  private animateNextOpen = true;
  private skipDelayTimer: number | null = null;
  private lastProgressCard: ProgressCard | null = null;
  private readonly hovercard = new PortaledHovercardController(
    () => this.close(true),
    CLOSE_DELAY_MS,
  );
  private readonly sessionLinkTitler = new SessionLinkTitler(this);
  private loadGeneration = 0;
  private readonly activeTargetObserver = new MutationObserver(() => {
    if (
      this.activeTarget &&
      (!this.contains(this.activeTarget) || sessionHovercardMenuOpen(this))
    ) {
      this.close();
      return;
    }
    if (this.open) {
      this.showCurrent();
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
    this.stopContextUpdates?.();
    this.stopContextUpdates = null;
    this.applicationContext = value;
    this.sessionLinkTitler.context = value;
    if (this.isConnected) {
      this.sessionLinkTitler.refresh();
      this.connectStore();
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
    this.addEventListener("click", this.handleClick);
    this.addEventListener(SESSION_MENU_OPEN_EVENT, this.handleSessionMenuOpen);
    this.sessionLinkTitler.connect();
    this.connectStore();
  }

  override disconnectedCallback(): void {
    this.removeEventListener("pointerover", this.handlePointerOver);
    this.removeEventListener("pointerout", this.handlePointerOut);
    this.removeEventListener("focusin", this.handleFocusIn);
    this.removeEventListener("focusout", this.handleFocusOut);
    this.removeEventListener("keydown", this.handleKeyDown);
    this.removeEventListener("click", this.handleClick);
    this.removeEventListener(SESSION_MENU_OPEN_EVENT, this.handleSessionMenuOpen);
    this.sessionLinkTitler.disconnect();
    this.disconnectStore();
    this.close();
    this.clearSkipDelayTimer();
    super.disconnectedCallback();
  }

  private connectStore(): void {
    if (this.applicationContext && !this.stopContextUpdates) {
      const stopSessions = this.applicationContext.sessions.subscribe(this.handleSessionUpdate);
      // A retained global row can keep the same DOM/key while its selected owner changes.
      const stopSelection = this.applicationContext.agentSelection.subscribe(() => this.close());
      this.stopContextUpdates = () => {
        stopSessions();
        stopSelection();
      };
    }
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
    this.stopContextUpdates?.();
    this.stopContextUpdates = null;
    this.progressCards = null;
    this.releasePullRequestStore();
  }

  private readonly handleProgressCardUpdate = () => {
    const session = this.activeSession;
    if (!session || !this.open || !this.hovercard.held) {
      return;
    }
    const card = this.progressCards?.get(session);
    if (card !== undefined) {
      this.lastProgressCard = card;
    }
    this.showCurrent();
  };

  private readonly handleSessionUpdate = () => {
    this.sessionLinkTitler.refresh();
    if (this.open && this.hovercard.held) {
      this.showCurrent();
    }
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
    const target = sessionProgressHoverTargetFromEvent(event);
    if (!target || sessionHovercardMenuOpen(this)) {
      return;
    }
    const delayed = this.delayed;
    this.activate(target, target, delayed ? OPEN_DELAY_MS : SWEEP_OPEN_DELAY_MS, delayed);
    this.hovercard.pointerInside = true;
  };

  private readonly handlePointerOut = (event: PointerEvent) => {
    const target = sessionProgressHoverTargetFromEvent(event);
    if (!target || target !== this.activeTarget) {
      return;
    }
    if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) {
      return;
    }
    this.hovercard.schedulePointerExit();
  };

  private readonly handleFocusIn = (event: FocusEvent) => {
    if (this.suppressFocusOpen) {
      return;
    }
    const target = sessionProgressHoverTargetFromEvent(event);
    const focused = event.target instanceof HTMLElement ? event.target : null;
    const trigger = target?.matches(".sidebar-recent-session")
      ? focused?.closest<HTMLElement>("a.sidebar-recent-session__link")
      : focused;
    if (!target || !trigger || sessionHovercardMenuOpen(this)) {
      return;
    }
    this.activate(target, trigger, 0, false);
    this.hovercard.focusInside = true;
  };

  private readonly handleFocusOut = (event: FocusEvent) => {
    if (!this.activeTarget) {
      return;
    }
    if (event.relatedTarget instanceof Node && this.activeTarget.contains(event.relatedTarget)) {
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

  private readonly handleClick = (event: Event) => {
    if (sessionProgressHoverTargetFromEvent(event)) {
      this.close();
    }
  };

  private readonly handleSessionMenuOpen = () => {
    this.close();
  };

  private activate(
    target: HTMLElement,
    trigger: HTMLElement,
    delay: number,
    animateEntry: boolean,
  ): void {
    const sessionKey = target.dataset.sessionKey;
    if (!sessionKey) {
      return;
    }
    const agentId =
      parseAgentSessionKey(sessionKey)?.agentId ??
      target.closest<AppSidebarSessionNavigationElement>("openclaw-app-sidebar")?.expandedAgentId();
    if (!agentId) {
      return;
    }
    const artifactKey = scopedSessionArtifactKey(sessionKey, agentId);
    if (
      target === this.activeTarget &&
      sessionKey === this.activeSession?.sessionKey &&
      artifactKey === this.activeArtifactKey
    ) {
      if (trigger !== this.activeTrigger) {
        this.hovercard.reset();
        this.activeTrigger = trigger;
        this.hovercard.markTrigger(trigger);
        if (this.open) {
          this.showCurrent();
        } else {
          this.animateNextOpen = animateEntry;
          const generation = ++this.loadGeneration;
          this.hovercard.scheduleOpen(delay, () => void this.loadAndShow(sessionKey, generation));
        }
      }
      return;
    }
    this.close(delay > 0);
    this.activeTarget = target;
    this.activeTrigger = trigger;
    this.activeSession = { sessionKey, agentId };
    this.open = false;
    this.animateNextOpen = animateEntry;
    this.lastProgressCard = null;
    this.progressCards?.watch(this, [this.activeSession]);
    this.hovercard.markTrigger(trigger);
    this.activeTargetObserver.observe(this, {
      attributes: true,
      attributeFilter: ["aria-expanded"],
      childList: true,
      subtree: true,
    });
    const generation = ++this.loadGeneration;
    this.hovercard.scheduleOpen(delay, () => void this.loadAndShow(sessionKey, generation));
  }

  private async loadAndShow(sessionKey: string, generation: number): Promise<void> {
    const target = this.activeTarget;
    const artifactKey = this.activeArtifactKey;
    const session = this.activeSession;
    if (target instanceof HTMLAnchorElement && target.dataset.sessionKey === sessionKey) {
      void this.sessionLinkTitler.decorate(target, true);
    }
    if (
      generation !== this.loadGeneration ||
      session?.sessionKey !== sessionKey ||
      !artifactKey ||
      !session ||
      !target ||
      sessionHovercardMenuOpen(this) ||
      !this.hovercard.held
    ) {
      return;
    }
    this.open = true;
    this.delayed = false;
    this.clearSkipDelayTimer();
    this.watchPullRequests(artifactKey);
    this.showCurrent();
    try {
      await this.progressCards?.load(session);
    } catch {
      // Session facts and the last successful card remain useful when refresh fails.
    }
    if (
      generation === this.loadGeneration &&
      this.activeSession?.sessionKey === sessionKey &&
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
    this.pullRequests = sessionPullRequestsForGateway(gateway);
    this.stopPullRequestUpdates = this.pullRequests.subscribe(this.handlePullRequestUpdate);
    this.pullRequests.watch(this, [sessionKey], { foreground: true });
  }

  private releasePullRequestStore(): void {
    this.pullRequests?.unwatch(this);
    this.stopPullRequestUpdates?.();
    this.stopPullRequestUpdates = null;
    this.pullRequests = null;
  }

  private showCurrent(): void {
    const target = this.activeTarget;
    const session = this.activeSession;
    const sessionKey = session?.sessionKey;
    const artifactKey = this.activeArtifactKey;
    if (!target || !session || !sessionKey || !artifactKey || !this.open) {
      return;
    }
    const sidebarRow =
      this.querySelector<AppSidebarSessionNavigationElement>(
        "openclaw-app-sidebar",
      )?.findSidebarHovercardRowByKey(sessionKey);
    const pullRequests = this.pullRequests?.get(artifactKey);
    const currentProgressCard = this.progressCards?.get(session);
    if (currentProgressCard !== undefined) {
      this.lastProgressCard = currentProgressCard;
    }
    const gateway = this.applicationGateway;
    const channelAvatarAuth = {
      authTokens: gateway
        ? resolveControlUiAuthCandidates({
            hello: gateway.snapshot.hello,
            settings: { token: gateway.connection.token },
            password: gateway.connection.password,
          })
        : [],
      authReady: Boolean(
        gateway &&
        (gateway.snapshot.hello ||
          gateway.connection.token.trim() ||
          gateway.connection.password.trim()),
      ),
    };
    const revision = JSON.stringify({
      progress: this.lastProgressCard?.revision ?? null,
      pullRequests: pullRequests
        ? { branch: pullRequests.branch, pullRequests: pullRequests.pullRequests }
        : null,
      row: sidebarRow
        ? {
            label: sidebarRow.label,
            boardFace: sidebarRow.boardFace,
            hasAutomation: sidebarRow.hasAutomation,
            hasActiveRun: sidebarRow.hasActiveRun,
            channelAvatarUrl: sidebarRow.channelAvatarUrl,
            lastMessagePreview: sidebarRow.lastMessagePreview,
            createdActor: sidebarRow.createdActor,
            participants: sidebarRow.participants,
            expandedParticipants: sidebarRow.expandedParticipants,
            participantCount: sidebarRow.participantCount,
            workContext: sidebarRow.workContext,
            createdAt: sidebarRow.createdAt,
            startedAt: sidebarRow.startedAt,
            updatedAt: sidebarRow.updatedAt,
            status: sidebarRow.status,
            endedAt: sidebarRow.endedAt,
          }
        : null,
    });
    if (this.hovercard.card?.dataset.revision === revision) {
      return;
    }
    const mountedCard = this.hovercard.card;
    const focusedCardElement =
      mountedCard?.contains(document.activeElement) && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusedCardIndex = focusedCardElement
      ? this.cardFocusables().indexOf(focusedCardElement)
      : -1;
    const focusedHref =
      focusedCardElement instanceof HTMLAnchorElement ? focusedCardElement.href : null;
    const animateEntry = !mountedCard && this.animateNextOpen;
    let card = mountedCard;
    if (!card) {
      nextHovercardId += 1;
      card = createPortaledHovercard(
        `openclaw-session-progress-hovercard-${nextHovercardId}`,
        "session-progress-hovercard",
      );
      this.animateNextOpen = false;
      if (animateEntry) {
        card.dataset.open = "false";
      } else {
        card.dataset.instant = "true";
      }
    }
    card.dataset.revision = revision;
    card.setAttribute("aria-label", t("sessionHovercard.ariaLabel"));
    render(
      renderSessionHovercard({
        row: sidebarRow,
        selfUserId: this.applicationContext?.gateway.snapshot.selfUser?.id,
        avatarAuth: channelAvatarAuth,
        personActivity: this.personActivity(),
        pullRequests,
        progressCard: this.lastProgressCard,
      }),
      card,
    );
    if (!card.firstElementChild) {
      this.hovercard.clearCard();
      this.hovercard.pointerOverCard = false;
      this.hovercard.cardFocusInside = false;
      return;
    }
    if (mountedCard) {
      if (focusedCardElement && !card.contains(document.activeElement)) {
        const focusables = this.cardFocusables();
        const nextFocused =
          (focusedHref
            ? focusables.find(
                (element) => element instanceof HTMLAnchorElement && element.href === focusedHref,
              )
            : undefined) ?? focusables[focusedCardIndex];
        if (nextFocused) {
          nextFocused.focus({ preventScroll: true });
        } else {
          this.hovercard.cardFocusInside = false;
          this.suppressFocusOpen = true;
          this.activeTrigger?.focus({ preventScroll: true });
          this.suppressFocusOpen = false;
          this.hovercard.focusInside = document.activeElement === this.activeTrigger;
        }
      }
      this.hovercard.position();
      return;
    }
    card.addEventListener("pointerenter", this.handleCardPointerEnter);
    card.addEventListener("pointerleave", this.handleCardPointerLeave);
    card.addEventListener("focusin", this.handleCardFocusIn);
    card.addEventListener("focusout", this.handleCardFocusOut);
    card.addEventListener("keydown", this.handleCardKeyDown);
    this.hovercard.mount(target, card, sessionProgressHoverPlacementForTarget(target), false, () =>
      render(nothing, card),
    );
    if (animateEntry) {
      void card.offsetWidth;
      window.setTimeout(() => {
        if (this.hovercard.card === card && this.open) {
          card.dataset.open = "true";
        }
      }, 0);
    }
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
    this.suppressFocusOpen = true;
    trigger?.focus({ preventScroll: true });
    this.suppressFocusOpen = false;
  };

  private cardFocusables(): HTMLElement[] {
    return this.hovercard.focusables();
  }

  private personActivity(): PersonActivityRouting | undefined {
    const context = this.applicationContext;
    // The card outlives its trigger row after navigation, so close it on the way out.
    return context ? personActivityRouting(context, () => this.close()) : undefined;
  }

  private close(animateExit = false): void {
    const wasOpen = this.open;
    this.hovercard.reset(animateExit ? EXIT_DURATION_MS : 0);
    this.loadGeneration += 1;
    this.open = false;
    this.animateNextOpen = true;
    this.lastProgressCard = null;
    this.activeTargetObserver.disconnect();
    this.progressCards?.unwatch(this);
    this.releasePullRequestStore();
    this.activeTarget = null;
    this.activeTrigger = null;
    this.activeSession = null;
    if (wasOpen) {
      this.clearSkipDelayTimer();
      this.skipDelayTimer = window.setTimeout(() => {
        this.skipDelayTimer = null;
        this.delayed = true;
      }, SKIP_DELAY_MS);
    }
  }

  private clearSkipDelayTimer(): void {
    if (this.skipDelayTimer !== null) {
      window.clearTimeout(this.skipDelayTimer);
      this.skipDelayTimer = null;
    }
  }
}
