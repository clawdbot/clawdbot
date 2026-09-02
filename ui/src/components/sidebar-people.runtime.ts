import { nothing, render } from "lit";
import { presenceUserKey } from "../../../src/shared/presence-user.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { selectApplicationSession } from "../app/agent-selection.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { readPresenceEntries, resolveCurrentSelfUser } from "../app/user-profile.ts";
import { i18n, t } from "../i18n/index.ts";
import { projectOnlinePresenceViewers } from "../lib/presence-users.ts";
import { runSessionNavigationIntent } from "../lib/sessions/navigation-handoff.ts";
import {
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../lib/sessions/route-navigation.ts";
import {
  isUiGlobalScopeConfigured,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
} from "../lib/sessions/session-key.ts";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import {
  hovercardBootstrapIntentActive,
  remainingHovercardOpenDelay,
} from "./lazy-hovercard-registration.ts";
import { renderPersonActivityCard } from "./person-activity-card.ts";
import { personActivityRouting } from "./person-activity-link.ts";
import { createPortaledHovercard, PortaledHovercardController } from "./portaled-hovercard.ts";

let nextCardId = 0;

export class SidebarPeopleRuntime {
  private active: {
    id: string;
    row: HTMLElement;
    trigger: HTMLElement;
    scope: string;
    gateway: ApplicationGateway;
    client: GatewayBrowserClient | null;
  } | null = null;
  private readonly portal = new PortaledHovercardController(() => this.close(), 100);
  private readonly observer = new MutationObserver(() => this.sync());
  private suppressFocus = false;
  private lastOpenAt = -Infinity;
  private readonly stopLocale: () => void;

  constructor(private readonly host: AppSidebarSessionNavigationElement) {
    this.stopLocale = i18n.subscribe(() => this.sync());
  }

  private scope(): string {
    return JSON.stringify([
      this.host.activeRouteId,
      this.host.sessionKey,
      this.host.sessionDataContext?.gateway.connectionRevision,
    ]);
  }

  handleEvent(event: Event, bootstrapStartedAt?: number): void {
    const row =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>(".sidebar-online__row")
        : null;
    if (event.type === "keydown" && event instanceof KeyboardEvent) {
      if (event.key === "Tab" && !event.shiftKey && event.target === this.active?.trigger) {
        const first = this.portal.focusables()[0];
        if (first) {
          event.preventDefault();
          first.focus();
        }
      }
      return;
    }
    if (!row) {
      return;
    }
    // Import completion must not replay a hover or focus that already moved away.
    if (
      bootstrapStartedAt !== undefined &&
      event.type !== "click" &&
      !hovercardBootstrapIntentActive(row, event.type === "focusin" ? "focus" : "pointer", true)
    ) {
      return;
    }
    if (event.type === "click") {
      if (this.active?.row === row && this.portal.explicitHold) {
        this.close();
        return;
      }
      this.activate(row, 0);
      this.portal.explicitHold = true;
      this.show();
    } else if (event.type === "pointerover" && event instanceof PointerEvent) {
      if (event.pointerType === "touch" || !globalThis.matchMedia?.("(hover: hover)").matches) {
        return;
      }
      if (this.portal.explicitHold && this.active?.row !== row) {
        return;
      }
      const delay = this.portal.card || performance.now() - this.lastOpenAt < 300 ? 80 : 450;
      this.activate(
        row,
        remainingHovercardOpenDelay(bootstrapStartedAt ?? performance.now(), delay),
      );
      this.portal.pointerInside = true;
      this.portal.clearClose();
    } else if (
      event.type === "pointerout" &&
      event instanceof PointerEvent &&
      this.active?.row === row
    ) {
      if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) {
        return;
      }
      this.portal.schedulePointerExit();
    } else if (event.type === "focusin" && !this.suppressFocus) {
      this.activate(row, 0);
      this.portal.focusInside = true;
      this.portal.clearClose();
      this.show();
    } else if (
      event.type === "focusout" &&
      event instanceof FocusEvent &&
      this.active?.row === row
    ) {
      if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) {
        return;
      }
      this.portal.focusInside = false;
      this.portal.scheduleClose();
    }
  }

  private activate(row: HTMLElement, delay: number): void {
    const id = row.querySelector<HTMLElement>("[data-online-user-key]")?.dataset.onlineUserKey;
    const trigger = row.querySelector<HTMLElement>(".sidebar-online__person");
    if (!id || !trigger || !this.host.connected) {
      return;
    }
    if (this.active?.id === id && this.active.row === row) {
      return;
    }
    this.close();
    const gateway = this.host.sessionDataContext?.gateway;
    if (!gateway || gateway.snapshot.phase !== "connected") {
      return;
    }
    this.active = {
      id,
      row,
      trigger,
      scope: this.scope(),
      gateway,
      client: gateway.snapshot.client,
    };
    this.portal.markTrigger(trigger);
    this.observer.observe(this.host, { childList: true, subtree: true });
    document.addEventListener("pointerdown", this.outsidePointer, true);
    document.addEventListener("focusin", this.outsideFocus, true);
    document.addEventListener("keydown", this.outsideKey, true);
    this.portal.scheduleOpen(delay, () => {
      if (this.portal.held) {
        this.show();
      }
    });
  }

  private isCurrent(): boolean {
    const active = this.active;
    const gateway = this.host.sessionDataContext?.gateway;
    return Boolean(
      active &&
      this.host.isConnected &&
      this.host.connected &&
      gateway?.snapshot.phase === "connected" &&
      active.gateway === gateway &&
      active.client === gateway.snapshot.client &&
      active.scope === this.scope() &&
      this.host.contains(active.row) &&
      !this.host.collapsedSessionSections.has("online"),
    );
  }

  sync(): void {
    if (!this.isCurrent()) {
      this.close();
    } else if (this.portal.card) {
      this.show();
    }
  }

  private show(): void {
    const active = this.active;
    const context = this.host.sessionDataContext;
    if (!active || !context || !this.isCurrent()) {
      this.close();
      return;
    }
    const data = this.host.sessionData;
    const self = resolveCurrentSelfUser({
      snapshotUser: context.gateway.snapshot.selfUser,
      presenceEntries: readPresenceEntries(data.presencePayload),
      presenceInstanceId: data.presenceInstanceId,
    });
    const user = projectOnlinePresenceViewers(
      data.presencePayload,
      self,
      data.presenceInstanceId,
    ).find((person) => presenceUserKey(person) === active.id);
    if (!user) {
      this.close();
      return;
    }
    const defaults = {
      agentsList: context.agents.state.agentsList,
      hello: context.gateway.snapshot.hello,
    };
    const existing = this.portal.card;
    const card =
      existing ??
      createPortaledHovercard(
        `openclaw-person-activity-${++nextCardId}`,
        "session-progress-hovercard person-activity-hovercard",
      );
    const focused = card.contains(document.activeElement) ? document.activeElement : null;
    card.setAttribute(
      "aria-label",
      t("presence.card.ariaLabel", { name: user.name ?? user.email ?? t("presence.card.person") }),
    );
    render(
      renderPersonActivityCard({
        user,
        sessionData: data,
        watchAgentId: resolveUiDefaultAgentId(defaults),
        mainKey: resolveUiConfiguredMainKey(defaults),
        globalScope: isUiGlobalScopeConfigured(defaults),
        routing: personActivityRouting(
          {
            basePath: this.host.basePath,
            navigate: (route, options) => this.host.onNavigate?.(route, options),
          },
          () => this.close(),
        ),
        openSession: (row, agentId) => {
          const face = resolveSessionPreferredFace(row);
          const target = sessionNavigationTarget({
            face,
            sessionKey: row.key,
            row,
            fallbackAgentId: agentId,
            basePath: this.host.basePath,
            mainKey: resolveUiConfiguredMainKey(defaults),
          });
          this.close();
          runSessionNavigationIntent(this.host, {
            face,
            sessionKey: row.key,
            commit: () => {
              if (
                this.host.sessionDataContext?.gateway !== active.gateway ||
                context.gateway.snapshot.client !== active.client ||
                context.gateway.snapshot.phase !== "connected" ||
                active.scope !== this.scope()
              ) {
                return false;
              }
              this.host.prepareSessionNavigation(row.key, target.options.pathname);
              this.host.onNavigate?.(face, target.options);
              selectApplicationSession({
                selection: context.agentSelection,
                gateway: context.gateway,
                sessionKey: row.key,
                agentId,
              });
              return true;
            },
          });
        },
      }),
      card,
    );
    if (existing) {
      if (focused && !card.contains(document.activeElement)) {
        const replacement =
          focused instanceof HTMLAnchorElement
            ? this.portal
                .focusables()
                .find((link) => link instanceof HTMLAnchorElement && link.href === focused.href)
            : undefined;
        if (replacement) {
          replacement.focus({ preventScroll: true });
        } else {
          this.returnFocus();
        }
      }
      this.portal.position();
      return;
    }
    this.lastOpenAt = performance.now();
    card.addEventListener("pointerenter", () => {
      this.portal.pointerOverCard = true;
      this.portal.clearClose();
    });
    card.addEventListener("pointerleave", () => {
      this.portal.pointerOverCard = false;
      this.portal.scheduleClose();
    });
    card.addEventListener("focusin", () => {
      this.portal.cardFocusInside = true;
      this.portal.clearClose();
    });
    card.addEventListener("focusout", (event) => {
      if (event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) {
        return;
      }
      this.portal.cardFocusInside = false;
      this.portal.scheduleClose();
    });
    card.addEventListener("keydown", (event) => {
      const links = this.portal.focusables();
      if (
        event.key === "Tab" &&
        document.activeElement === (event.shiftKey ? links[0] : links.at(-1))
      ) {
        event.preventDefault();
        this.returnFocus();
        this.close();
      }
    });
    this.portal.mount(active.row, card, "horizontal", true, () => render(nothing, card));
  }

  private returnFocus(): void {
    this.suppressFocus = true;
    this.active?.trigger.focus({ preventScroll: true });
    this.suppressFocus = false;
    this.portal.focusInside = document.activeElement === this.active?.trigger;
  }

  private readonly outsidePointer = (event: Event) => {
    if (
      event.target instanceof Node &&
      !this.active?.row.contains(event.target) &&
      !this.portal.card?.contains(event.target)
    ) {
      this.close();
    }
  };

  private readonly outsideFocus = (event: Event) => {
    if (
      event.target instanceof Node &&
      !this.active?.row.contains(event.target) &&
      !this.portal.card?.contains(event.target)
    ) {
      this.close();
    }
  };

  private readonly outsideKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      // The card owns this Escape, not the modal navigation drawer beneath it.
      event.preventDefault();
      event.stopPropagation();
      if (this.portal.card?.contains(document.activeElement)) {
        this.returnFocus();
      }
      this.close();
    }
  };

  private close(): void {
    if (this.portal.card) {
      this.lastOpenAt = performance.now();
    }
    this.observer.disconnect();
    document.removeEventListener("pointerdown", this.outsidePointer, true);
    document.removeEventListener("focusin", this.outsideFocus, true);
    document.removeEventListener("keydown", this.outsideKey, true);
    this.portal.reset();
    this.active?.trigger.setAttribute("aria-haspopup", "dialog");
    this.active?.trigger.setAttribute("aria-expanded", "false");
    this.active = null;
  }

  dismiss(): boolean {
    const hadCard = this.active !== null;
    this.close();
    return hadCard;
  }

  dispose(): void {
    this.close();
    this.stopLocale();
  }
}
