import { consume } from "@lit/context";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { NavigationRouteId } from "../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import type { ExecApprovalDecision } from "../app/exec-approval.ts";
import type { MentionsCapability } from "../app/mentions.ts";
import type { UpdateProgress } from "../app/update-confirmation.ts";
import { t } from "../i18n/index.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import "../styles/sidebar-attention-floating.css";
import { icons } from "./icons.ts";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import type { SidebarAttentionDismissal } from "./sidebar-attention-dismissals.ts";
import {
  sidebarInboxTabCounts,
  type SidebarAttentionItem,
  type SidebarInboxEntry,
} from "./sidebar-attention-entries.ts";
import type { SidebarAttentionPanelPosition } from "./sidebar-attention-panel.runtime.ts";
import { SidebarAttentionStoreController } from "./sidebar-attention-store.ts";
import type { IssueTab } from "./sidebar-issues-tabs.ts";
import "./tooltip.ts";

type SidebarAttentionPanelRenderer =
  typeof import("./sidebar-attention-panel.runtime.ts").renderSidebarAttentionPanel;
type SidebarAttentionPanelRuntime = typeof import("./sidebar-attention-panel.runtime.ts");
type UpdateProgressWatcher = (listener: (progress: UpdateProgress) => void) => () => void;
// Display is stylesheet-owned (layout.css `display: contents` in the footer,
// flex when floating): the LightDomContents base's inline display would defeat
// the floating override, re-piling the collapsed-nav cluster at the origin.
class SidebarAttention extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @state() private panelOpen = false;
  @state() private panelPosition: SidebarAttentionPanelPosition = {
    left: 8,
    anchor: "bottom",
    bottom: 8,
  };
  @state() private selectedTab: IssueTab = "all";
  @state() private overflowAbove = false;
  @state() private overflowBelow = false;

  @property({ attribute: false }) activeRouteId?: NavigationRouteId;
  @property({ attribute: false }) onNavigate?: (routeId: NavigationRouteId) => void;
  @property({ attribute: false }) watchUpdateProgress?: UpdateProgressWatcher;

  private panelTrigger: HTMLElement | null = null;
  private mentions: MentionsCapability | null = null;
  private panelRenderer: SidebarAttentionPanelRenderer | null = null;
  private panelLoad: Promise<SidebarAttentionPanelRuntime> | null = null;
  private panelGeneration = 0;

  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.sidebarAttention,
      (attention, notify) => attention.subscribe(notify),
    )
    .watch(
      () => this.context?.sessions,
      (sessions, notify) => sessions.subscribe(notify),
    )
    .watch(
      () => this.context?.agents,
      (agents, notify) => agents.subscribe(notify),
    )
    .watch(
      () => this.context?.agentIdentity,
      (agentIdentity, notify) => agentIdentity.subscribe(notify),
    );

  override connectedCallback() {
    super.connectedCallback();
    this.mentions =
      this.context?.sidebarAttention.activate(SidebarAttentionStoreController) ?? null;
    // Dismissal belongs to the connected Inbox, including while its panel imports.
    document.addEventListener("pointerdown", this.handleOutsideInteraction, true);
    document.addEventListener("keydown", this.handleOutsideInteraction, true);
  }

  override disconnectedCallback() {
    document.removeEventListener("pointerdown", this.handleOutsideInteraction, true);
    document.removeEventListener("keydown", this.handleOutsideInteraction, true);
    this.closePanel(false);
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("activeRouteId") && changed.get("activeRouteId") !== undefined) {
      this.closePanel(false);
    }
  }

  protected override updated(changed: PropertyValues<this>) {
    super.updated(changed);
    if (this.panelOpen) {
      this.syncOverflowCue();
    }
  }

  private dismiss(dismissal: SidebarAttentionDismissal) {
    this.context?.sidebarAttention.dismiss(dismissal);
  }

  private currentInboxEntries(): SidebarInboxEntry[] {
    return [...(this.context?.sidebarAttention.entries ?? [])];
  }

  private readonly handleOutsideInteraction = (event: PointerEvent | KeyboardEvent) => {
    const dismiss =
      event instanceof KeyboardEvent
        ? event.key === "Escape" && !this.panelOpen && !event.defaultPrevented
        : !event.composedPath().includes(this);
    if (dismiss) {
      if (event instanceof KeyboardEvent && this.panelTrigger) {
        event.preventDefault();
        event.stopPropagation();
      }
      this.closePanel(false);
    }
  };

  private async openPanel(trigger: HTMLElement) {
    const generation = ++this.panelGeneration;
    // The pending open owns Escape before its lazy panel can handle keyboard events.
    this.panelTrigger = trigger;
    this.panelLoad ??= import("./sidebar-attention-panel.runtime.ts");
    const panelRuntime = await this.panelLoad;
    if (!this.isConnected || generation !== this.panelGeneration) {
      return;
    }
    this.context?.scopeUpgrade.activate(panelRuntime.ScopeUpgradeController);
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(390, globalThis.innerWidth - 16);
    const preferredLeft = rect.left + rect.width / 2 - width / 2;
    const left = Math.max(8, Math.min(preferredLeft, globalThis.innerWidth - width - 8));
    this.panelRenderer = panelRuntime.renderSidebarAttentionPanel;
    this.panelPosition =
      rect.top < globalThis.innerHeight / 2
        ? { left, anchor: "top", top: Math.max(8, rect.bottom + 8) }
        : { left, anchor: "bottom", bottom: Math.max(8, globalThis.innerHeight - rect.top + 8) };
    this.selectedTab = "all";
    this.panelOpen = true;
    await this.updateComplete;
    if (generation === this.panelGeneration) {
      this.querySelector<HTMLElement>(".sidebar-issues-panel__list")?.focus();
    }
  }

  private closePanel(restoreFocus: boolean) {
    // Closing also cancels an open that is still waiting for its runtime or render.
    const generation = ++this.panelGeneration;
    const trigger = restoreFocus && this.panelOpen ? this.panelTrigger : null;
    this.panelOpen = false;
    this.overflowAbove = false;
    this.overflowBelow = false;
    this.panelTrigger = null;
    if (trigger) {
      void this.updateComplete.then(() => {
        if (generation === this.panelGeneration) {
          trigger.focus();
        }
      });
    }
  }

  dismissPanel(): boolean {
    const wasOpen = this.panelOpen;
    this.closePanel(false);
    return wasOpen;
  }

  private readonly syncOverflowCue = () => {
    const list = this.querySelector<HTMLElement>(".sidebar-issues-panel__list");
    const above = Boolean(list && list.scrollTop > 2);
    const below = Boolean(list && list.scrollHeight - list.scrollTop - list.clientHeight > 2);
    if (above !== this.overflowAbove) {
      this.overflowAbove = above;
    }
    if (below !== this.overflowBelow) {
      this.overflowBelow = below;
    }
  };

  private selectTab(tab: IssueTab) {
    this.selectedTab = tab;
    void this.updateComplete.then(() => {
      if (!this.panelOpen || this.selectedTab !== tab) {
        return;
      }
      const list = this.querySelector<HTMLElement>(".sidebar-issues-panel__list");
      if (list) {
        list.scrollTop = 0;
      }
      this.syncOverflowCue();
    });
  }

  private async open(item: SidebarAttentionItem) {
    this.closePanel(false);
    if (item.action.kind === "navigate") {
      this.onNavigate?.(item.action.routeId);
      return;
    }
    const { custodianAlertStore } = await import("../pages/custodian/custodian-alert-store.ts");
    custodianAlertStore.present(item.action.alert);
    const snapshot = this.context?.gateway.snapshot;
    if (canCallGatewayMethod(snapshot, "openclaw.chat", "operator.admin")) {
      window.dispatchEvent(
        new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT, { detail: { open: true } }),
      );
    } else {
      (this.onNavigate ?? ((routeId) => this.context?.navigate(routeId)))("custodian");
    }
  }

  private readonly handlePanelKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      this.closePanel(true);
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const panel = event.currentTarget;
    if (!(panel instanceof HTMLElement)) {
      return;
    }
    const rows = Array.from(
      panel.querySelectorAll<HTMLElement>(
        "summary, button, a[href], [tabindex]:not([tabindex='-1'])",
      ),
    ).filter((element) => {
      const closedDetails = element.closest("details:not([open])");
      const insideSummary =
        element.tagName === "SUMMARY" || Boolean(element.parentElement?.closest("summary"));
      return (
        !element.hasAttribute("disabled") &&
        !element.closest("[hidden]") &&
        (!closedDetails || insideSummary)
      );
    });
    const first = rows[0];
    const last = rows.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  private async decideApproval(event: Event, approvalId: string, decision: ExecApprovalDecision) {
    const context = this.context;
    if (!context) {
      return;
    }
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const focusOrder = Array.from(this.querySelectorAll<HTMLElement>("[data-issue-row-focus]"));
    const row = target.closest<HTMLElement>("[data-approval-id]");
    const rowFocus = row?.querySelector<HTMLElement>("[data-issue-row-focus]") ?? null;
    const rowIndex = rowFocus ? focusOrder.indexOf(rowFocus) : 0;
    const generation = this.panelGeneration;
    await context.overlays.decideApproval(decision, approvalId);
    await this.updateComplete;
    if (generation !== this.panelGeneration || target.isConnected) {
      return;
    }
    const remaining = Array.from(this.querySelectorAll<HTMLElement>("[data-issue-row-focus]"));
    remaining[Math.min(Math.max(rowIndex, 0), remaining.length - 1)]?.focus();
  }

  override render() {
    if (this.context?.gateway.snapshot.phase !== "connected") {
      return nothing;
    }
    const entries = this.currentInboxEntries();
    const count = sidebarInboxTabCounts(entries).all;
    const label = t(count === 1 ? "attention.issueCount" : "attention.issueCountPlural", {
      count: String(count),
    });
    return html`
      <span class="sr-only" role="status" aria-live="polite">${label}</span>
      <button
        type="button"
        class="sidebar-issues-button"
        aria-expanded=${String(this.panelOpen)}
        aria-haspopup="dialog"
        aria-controls="sidebar-issues-panel"
        aria-label=${label}
        @click=${(event: MouseEvent) => {
          const trigger = event.currentTarget;
          if (!(trigger instanceof HTMLElement)) {
            return;
          }
          if (this.panelOpen) {
            this.closePanel(true);
          } else {
            void this.openPanel(trigger);
          }
        }}
      >
        <span class="sidebar-issues-button__icon" aria-hidden="true">${icons.inbox}</span>
        ${
          count > 0
            ? html`<span class="sidebar-issues-button__count" aria-hidden="true"
                >${count > 9 ? "9+" : count}</span
              >`
            : nothing
        }
      </button>
      ${
        this.panelOpen && this.panelRenderer && this.mentions
          ? this.panelRenderer({
              context: this.context,
              mentions: this.mentions,
              entries,
              onApprovalDecision: (event, approvalId, decision) =>
                void this.decideApproval(event, approvalId, decision),
              onClose: (restoreFocus) => this.closePanel(restoreFocus),
              onDismiss: (dismissal) => this.dismiss(dismissal),
              onKeydown: this.handlePanelKeydown,
              onNavigate: (routeId) => {
                this.closePanel(false);
                (this.onNavigate ?? ((nextRoute) => this.context?.navigate(nextRoute)))(routeId);
              },
              onOpen: (item) => void this.open(item),
              onScroll: this.syncOverflowCue,
              onSelectTab: (tab) => this.selectTab(tab),
              overflowAbove: this.overflowAbove,
              overflowBelow: this.overflowBelow,
              panelPosition: this.panelPosition,
              selectedTab: this.selectedTab,
              watchUpdateProgress: this.watchUpdateProgress,
            })
          : nothing
      }
    `;
  }
}

if (!customElements.get("openclaw-sidebar-attention")) {
  customElements.define("openclaw-sidebar-attention", SidebarAttention);
}
