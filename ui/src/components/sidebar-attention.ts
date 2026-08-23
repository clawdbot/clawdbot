// One footer bell owns the sidebar's canonical operational conditions.
import { consume } from "@lit/context";
import { initialState, Task } from "@lit/task";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { CronJob, ModelAuthStatusResult } from "../api/types.ts";
import type { NavigationRouteId } from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import type { ExecApprovalDecision, ExecApprovalRequest } from "../app/exec-approval.ts";
import type { UpdateProgress } from "../app/update-confirmation.ts";
import { t } from "../i18n/index.ts";
import { createInitialCronState, loadCronJobsPage } from "../lib/cron/index.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { loadModelAuthStatus } from "../lib/model-auth.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { renderSidebarApprovalRow } from "./exec-approval-card.ts";
import { icons } from "./icons.ts";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import {
  addDismissal,
  dismissalStoreKey,
  loadDismissals,
  pruneDismissals,
  saveDismissals,
  type SidebarAttentionDismissals,
} from "./sidebar-attention-dismissals.ts";
import {
  buildSidebarAttentionItems,
  type SidebarAttentionItem,
} from "./sidebar-attention-items.ts";
import "./tooltip.ts";
import "./menu-surface.ts";
import { ISSUE_TABS, issueTabLabel, nextIssueTab, type IssueTab } from "./sidebar-issues-tabs.ts";
import "./sidebar-update-card.ts";

// A visibility change only refetches a connection-scoped stale snapshot.
const VISIBILITY_REFRESH_MIN_AGE_MS = 60_000;
// Always-visible native windows need a slow lifecycle-owned refresh too.
const IDLE_REFRESH_INTERVAL_MS = 10 * 60_000;
const ITEM_PRIORITY: Record<SidebarAttentionItem["kind"], number> = {
  pendingApproval: 0,
  modelAuthExpired: 1,
  cronFailed: 2,
  cronOverdue: 3,
  updateAvailable: 4,
};
class SidebarAttention extends OpenClawLightDomContentsElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @state() private cronJobs: CronJob[] = [];
  @state() private modelAuthStatus: ModelAuthStatusResult | null = null;
  @state() private dismissed: SidebarAttentionDismissals = {};
  @state() private panelOpen = false;
  @state() private panelPosition = { left: 8, bottom: 8 };
  @state() private selectedTab: IssueTab = "all";
  @state() private overflowAbove = false;
  @state() private overflowBelow = false;

  @property({ attribute: false }) activeRouteId?: NavigationRouteId;
  @property({ attribute: false }) onNavigate?: (routeId: NavigationRouteId) => void;
  @property({ attribute: false }) watchUpdateProgress:
    | ((listener: (progress: UpdateProgress) => void) => () => void)
    | undefined = undefined;
  @property({ attribute: false }) onRefresh?: () => void;

  private loadedClient: GatewayBrowserClient | null = null;
  private loadedGateway: ApplicationContext["gateway"] | null = null;
  private loadedAgentId: string | null = null;
  // Cron events may restart the combined task; retain the committed auth owner so an
  // interrupted agent switch reissues auth instead of displaying the prior agent's alert.
  private modelAuthAgentId: string | null = null;
  private loadedAtMs = 0;
  private dismissedScope: string | null = null;
  private idleRefreshTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private panelTrigger: HTMLElement | null = null;

  private readonly loadTask = new Task(this, {
    autoRun: false,
    // Gateway identity matters when a replacement source reuses the same client object.
    args: () =>
      [
        null as ApplicationContext["gateway"] | null,
        null as GatewayBrowserClient | null,
        null as string | null,
        true as boolean,
      ] as const,
    task: async ([gateway, client, agentId, refreshModelAuth], { signal }) => {
      if (!gateway || !client) {
        return initialState;
      }
      const cron = createInitialCronState({ client, connected: true });
      const loads: Promise<unknown>[] = [
        loadCronJobsPage(cron).then(() => {
          if (!signal.aborted) {
            this.cronJobs = cron.cronJobs;
          }
        }),
      ];
      if (refreshModelAuth && agentId) {
        loads.push(
          loadModelAuthStatus(client, {
            agentId,
            signal,
          })
            .catch(() => null)
            .then((modelAuthStatus) => {
              if (!signal.aborted) {
                this.modelAuthStatus = modelAuthStatus;
                this.modelAuthAgentId = agentId;
              }
            }),
        );
      } else if (!agentId) {
        this.modelAuthStatus = null;
        this.modelAuthAgentId = null;
      }
      await Promise.allSettled(loads);
      return true;
    },
    onComplete: () => {
      this.loadedAtMs = Date.now();
      this.pruneAfterRefresh();
    },
  });

  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.gateway,
      (gateway) => {
        this.synchronize(gateway);
        return gateway.subscribe(() => this.synchronize(gateway));
      },
    )
    .watch(
      () => this.context?.agentSelection,
      (selection, notify) => selection.subscribe(notify),
      () => {
        const gateway = this.context?.gateway;
        if (gateway) {
          this.synchronize(gateway);
        }
      },
    )
    .effect(
      () => this.context?.gateway,
      (gateway) =>
        gateway.subscribeEvents((event) => {
          if (this.context?.gateway !== gateway || event.event !== "cron") {
            return;
          }
          // The Automations page refreshes from the same event. Refresh this
          // independent snapshot too so its ambient alert cannot contradict it.
          this.loadedClient = null;
          this.synchronize(gateway, { refreshModelAuth: false });
        }),
    )
    .watch(
      () => this.context?.overlays,
      (overlays, notify) => overlays.subscribe(() => notify()),
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

  // Cross-tab sync: another tab's dismiss/prune fires "storage" here, so this
  // tab re-reads instead of rendering (or later writing) a stale snapshot.
  private readonly syncDismissalsFromStorage = (event: StorageEvent) => {
    if (!this.dismissedScope) {
      return;
    }
    if (event.key === null || event.key === dismissalStoreKey(this.dismissedScope)) {
      this.dismissed = loadDismissals(this.dismissedScope);
    }
  };

  private readonly refreshIfStale = () => {
    if (document.visibilityState !== "visible") {
      return;
    }
    const gateway = this.context?.gateway;
    if (gateway && Date.now() - this.loadedAtMs >= VISIBILITY_REFRESH_MIN_AGE_MS) {
      this.loadedClient = null;
      this.synchronize(gateway);
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.refreshIfStale);
    globalThis.addEventListener("storage", this.syncDismissalsFromStorage);
    this.idleRefreshTimer = globalThis.setInterval(this.refreshIfStale, IDLE_REFRESH_INTERVAL_MS);
  }

  override disconnectedCallback() {
    document.removeEventListener("visibilitychange", this.refreshIfStale);
    globalThis.removeEventListener("storage", this.syncDismissalsFromStorage);
    document.removeEventListener("pointerdown", this.closeOnOutsidePointer, true);
    if (this.idleRefreshTimer !== null) {
      globalThis.clearInterval(this.idleRefreshTimer);
      this.idleRefreshTimer = null;
    }
    this.subscriptions.clear();
    void this.loadTask.run([null, null, null, false]);
    this.loadedClient = null;
    this.loadedGateway = null;
    this.loadedAgentId = null;
    this.modelAuthAgentId = null;
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("activeRouteId") && changed.get("activeRouteId") !== undefined) {
      this.closePanel(false);
    }
    if (this.panelOpen && this.currentItems().length === 0 && !this.updateSurfaceVisible()) {
      this.closePanel(false);
    }
  }

  protected override updated(changed: PropertyValues<this>) {
    super.updated(changed);
    if (this.panelOpen) {
      this.syncOverflowCue();
    }
  }

  private synchronize(
    gateway: ApplicationContext["gateway"],
    options: { refreshModelAuth?: boolean } = {},
  ) {
    const snapshot = gateway.snapshot;
    const gatewayUrl = gateway.connection.gatewayUrl;
    if (gatewayUrl && gatewayUrl !== this.dismissedScope) {
      this.dismissedScope = gatewayUrl;
      this.dismissed = loadDismissals(gatewayUrl);
    }
    if (snapshot.phase !== "connected" || !snapshot.client) {
      void this.loadTask.run([null, null, null, false]);
      this.loadedClient = null;
      this.loadedGateway = null;
      this.loadedAgentId = null;
      this.modelAuthAgentId = null;
      this.cronJobs = [];
      this.modelAuthStatus = null;
      return;
    }
    const agentId = this.context?.agentSelection.state.selectedId ?? null;
    if (
      gateway === this.loadedGateway &&
      snapshot.client === this.loadedClient &&
      agentId === this.loadedAgentId
    ) {
      return;
    }
    this.loadedGateway = gateway;
    this.loadedClient = snapshot.client;
    this.loadedAgentId = agentId;
    void this.loadTask.run([
      gateway,
      snapshot.client,
      agentId,
      options.refreshModelAuth !== false || agentId !== this.modelAuthAgentId,
    ]);
  }

  // Only fresh data can re-arm snoozes. Use the persisted map so a stale tab
  // cannot clobber another tab's dismissal; failed fetches fail safe by re-nagging.
  private pruneAfterRefresh() {
    if (!this.dismissedScope) {
      return;
    }
    const items = this.buildItems();
    const updateSurfaceSignature = this.updateSurfaceSignature();
    const dismissableItems = updateSurfaceSignature
      ? [...items, { kind: "updateAvailable" as const, signature: updateSurfaceSignature }]
      : items;
    const stored = loadDismissals(this.dismissedScope);
    const pruned = pruneDismissals(stored, dismissableItems);
    if (pruned !== stored) {
      saveDismissals(this.dismissedScope, pruned);
    }
    this.dismissed = pruned;
  }

  private dismiss(item: SidebarAttentionItem) {
    if (!this.dismissedScope) {
      return;
    }
    this.dismissed = addDismissal(this.dismissedScope, item.kind, item.signature);
  }

  private buildItems(): SidebarAttentionItem[] {
    const overlays = this.context?.overlays.snapshot;
    return buildSidebarAttentionItems({
      cronJobs: this.cronJobs,
      modelAuthStatus: this.modelAuthStatus,
      modelAuthAgentId: this.modelAuthAgentId,
      approvalQueue: overlays?.approvalQueue ?? [],
      updateAvailable: overlays?.updateAvailable ?? null,
      updateSchedule: overlays?.updateSchedule ?? null,
      updateStatusBanner: overlays?.updateStatusBanner ?? null,
      now: Date.now(),
    });
  }

  private currentItems(): SidebarAttentionItem[] {
    return this.context?.gateway.snapshot.phase === "connected"
      ? this.buildItems().filter(
          (item) =>
            item.kind === "pendingApproval" || !this.dismissed[item.kind]?.includes(item.signature),
        )
      : [];
  }

  private hasUpdateSurface(): boolean {
    const snapshot = this.context?.overlays.snapshot;
    return Boolean(
      snapshot?.controlUiRefreshRequired ||
      snapshot?.updateRunning ||
      snapshot?.updateStatusBanner ||
      snapshot?.updateSchedule?.campaign,
    );
  }

  private updateSurfaceSignature(): string | null {
    if (!this.hasUpdateSurface()) {
      return null;
    }
    const snapshot = this.context?.overlays.snapshot;
    const campaign = snapshot?.updateSchedule?.campaign;
    return [
      snapshot?.controlUiRefreshRequired ? "refresh" : "",
      snapshot?.updateRunning ? "running" : "",
      campaign?.id ?? "",
      campaign?.state ?? "",
      campaign?.updatedAtMs ?? "",
      snapshot?.updateAvailable?.upstreamSha ?? snapshot?.updateAvailable?.latestVersion ?? "",
      snapshot?.updateStatusBanner?.tone ?? "",
      snapshot?.updateStatusBanner?.text ?? "",
    ].join("\n");
  }

  private updateSurfaceVisible(): boolean {
    const signature = this.updateSurfaceSignature();
    return Boolean(signature && !this.dismissed.updateAvailable?.includes(signature));
  }

  private dismissUpdateSurface() {
    const signature = this.updateSurfaceSignature();
    if (!this.dismissedScope || !signature) {
      return;
    }
    this.dismissed = addDismissal(this.dismissedScope, "updateAvailable", signature);
  }

  private readonly closeOnOutsidePointer = (event: PointerEvent) => {
    if (!this.panelOpen || event.composedPath().includes(this)) {
      return;
    }
    this.closePanel(false);
  };

  private openPanel(trigger: HTMLElement) {
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(390, globalThis.innerWidth - 16);
    const preferredLeft = rect.left + rect.width / 2 - width / 2;
    this.panelTrigger = trigger;
    this.panelPosition = {
      left: Math.max(8, Math.min(preferredLeft, globalThis.innerWidth - width - 8)),
      bottom: Math.max(8, globalThis.innerHeight - rect.top + 8),
    };
    this.selectedTab = "all";
    this.panelOpen = true;
    document.addEventListener("pointerdown", this.closeOnOutsidePointer, true);
    void this.updateComplete.then(() => {
      this.querySelector<HTMLElement>(".sidebar-issues-panel__list")?.focus();
    });
  }

  private closePanel(restoreFocus: boolean) {
    if (!this.panelOpen) {
      return;
    }
    const trigger = this.panelTrigger;
    this.panelOpen = false;
    this.overflowAbove = false;
    this.overflowBelow = false;
    this.panelTrigger = null;
    document.removeEventListener("pointerdown", this.closeOnOutsidePointer, true);
    if (restoreFocus) {
      void this.updateComplete.then(() => trigger?.focus());
    }
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

  private selectTab(tab: IssueTab, focusTab = false) {
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
      if (focusTab) {
        this.querySelector<HTMLElement>(`#sidebar-issues-tab-${tab}`)?.focus();
      }
    });
  }

  private handleTabKeydown(event: KeyboardEvent, tab: IssueTab) {
    const nextTab = nextIssueTab(tab, event.key);
    if (!nextTab) {
      return;
    }
    event.preventDefault();
    this.selectTab(nextTab, true);
  }

  private renderTab(tab: IssueTab, count: number) {
    const selected = this.selectedTab === tab;
    const label = issueTabLabel(tab);
    const countLabel = t(count === 1 ? "attention.issueCount" : "attention.issueCountPlural", {
      count: String(count),
    });
    return html`<button
      type="button"
      id=${`sidebar-issues-tab-${tab}`}
      class="sidebar-issues-panel__tab"
      role="tab"
      aria-selected=${String(selected)}
      aria-label=${`${label}, ${countLabel}`}
      aria-controls="sidebar-issues-tabpanel"
      tabindex=${selected ? 0 : -1}
      @click=${() => this.selectTab(tab)}
      @keydown=${(event: KeyboardEvent) => this.handleTabKeydown(event, tab)}
    >
      <span>${label}</span>
      <span class="sidebar-issues-panel__tab-count" aria-hidden="true">${count}</span>
    </button>`;
  }

  private async open(item: SidebarAttentionItem) {
    this.closePanel(false);
    if (item.action.kind === "openApprovals") {
      return;
    }
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
    const rows = Array.from(
      (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
        "summary, button, a[href], [tabindex]:not([tabindex='-1'])",
      ),
    ).filter((element) => {
      const closedDetails = element.closest("details:not([open])");
      return (
        !element.hasAttribute("disabled") &&
        !element.closest("[hidden]") &&
        (!closedDetails || element.matches("summary") || Boolean(element.closest("summary")))
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

  private renderAskOpenClawButton(count: number, severity: "error" | "warning" | null) {
    const snapshot = this.context?.gateway.snapshot;
    if (!canCallGatewayMethod(snapshot, "openclaw.chat", "operator.admin")) {
      return nothing;
    }
    const custodianLabel = count
      ? t(count === 1 ? "attention.custodianAlertAria" : "attention.custodianAlertsAria", {
          count: String(count),
        })
      : t("nav.askOpenClaw");
    return html`<openclaw-tooltip .content=${custodianLabel}>
      <button
        type="button"
        class="sidebar-brand__icon sidebar-footer-bar__custodian sidebar-issues-panel__ask"
        aria-label=${custodianLabel}
        @click=${() => window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT))}
      >
        <span class="sidebar-footer-bar__custodian-glyph">
          ${icons.lobster}
          ${count
            ? html`<span
                class="session-glyph__badge sidebar-footer-bar__custodian-badge sidebar-footer-bar__custodian-badge--${severity ??
                "warning"}"
                aria-hidden="true"
              ></span>`
            : nothing}
        </span>
      </button>
    </openclaw-tooltip>`;
  }

  private renderUpdateSurface() {
    if (!this.updateSurfaceVisible()) {
      return nothing;
    }
    const context = this.context;
    if (!context) {
      return nothing;
    }
    const snapshot = context.overlays.snapshot;
    const gateway = context.gateway.snapshot;
    return html`<openclaw-sidebar-update-card
      class="sidebar-issues-panel__update"
      data-attention-kind="updateAvailable"
      .compact=${true}
      .updateAvailable=${snapshot.updateAvailable}
      .updateSchedule=${snapshot.updateSchedule}
      .heldUpdateCampaignId=${snapshot.heldUpdateCampaignId}
      .updateBusy=${snapshot.updateRunning}
      .statusBanner=${snapshot.updateStatusBanner}
      .watchUpdateProgress=${this.watchUpdateProgress}
      .canUpdate=${canCallGatewayMethod(gateway, "update.run", "operator.admin")}
      .canHoldUpdate=${canCallGatewayMethod(gateway, "update.hold", "operator.admin")}
      .onUpdate=${() => void context.overlays.runUpdate()}
      .refreshRequired=${snapshot.controlUiRefreshRequired}
      .onRefresh=${this.onRefresh ?? (() => undefined)}
      .onHoldUpdate=${() => context.overlays.holdUpdate()}
      .onReviewUpdate=${() => this.onNavigate?.("updates")}
      .onDismiss=${() => this.dismissUpdateSurface()}
    ></openclaw-sidebar-update-card>`;
  }

  private async decideApproval(event: Event, approvalId: string, decision: ExecApprovalDecision) {
    const context = this.context;
    if (!context) {
      return;
    }
    const target = event.currentTarget as HTMLElement;
    const focusOrder = Array.from(this.querySelectorAll<HTMLElement>("[data-issue-row-focus]"));
    const row = target.closest<HTMLElement>("[data-approval-id]");
    const rowFocus = row?.querySelector<HTMLElement>("[data-issue-row-focus]") ?? null;
    const rowIndex = rowFocus ? focusOrder.indexOf(rowFocus) : 0;
    await context.overlays.decideApproval(decision, approvalId);
    await this.updateComplete;
    if (!this.panelOpen || target.isConnected) {
      return;
    }
    const remaining = Array.from(this.querySelectorAll<HTMLElement>("[data-issue-row-focus]"));
    remaining[Math.min(Math.max(rowIndex, 0), remaining.length - 1)]?.focus();
  }

  private renderApprovalItem(approval: ExecApprovalRequest) {
    const context = this.context;
    const snapshot = context?.overlays.snapshot;
    if (!context || !snapshot) {
      return nothing;
    }
    const sessionKey = approval.request.sessionKey?.trim();
    const session = sessionKey
      ? context.sessions.state.result?.sessions.find((candidate) =>
          areUiSessionKeysEquivalent(candidate.key, sessionKey),
        )
      : undefined;
    const sessionTarget = sessionKey
      ? sessionNavigationTarget({ context, face: "chat", sessionKey })
      : null;
    return renderSidebarApprovalRow({
      approval,
      busy: snapshot.approvalBusy,
      canGrant: snapshot.approvalCanGrant,
      error: snapshot.approvalErrors.get(approval.id) ?? null,
      nowMs: snapshot.approvalNowMs,
      openSessionHref: sessionTarget?.href,
      sessionTitle: session?.displayName?.trim() || session?.label?.trim(),
      onDecision: (event, approvalId, decision) =>
        void this.decideApproval(event, approvalId, decision),
      onOpenSession: sessionTarget
        ? (event) => {
            if (!shouldHandleNavigationClick(event)) {
              return;
            }
            event.preventDefault();
            this.closePanel(false);
            context.navigate("chat", sessionTarget.options);
          }
        : undefined,
    });
  }

  private renderItemMeta(item: SidebarAttentionItem) {
    if (!item.meta) {
      return html`<span class="sidebar-issues-panel__state" title=${item.detail}
        >${item.detail}</span
      >`;
    }
    return html`<span class="sidebar-issues-panel__state-row" title=${item.detail}>
      ${item.meta.context
        ? html`<span class="sidebar-issues-panel__meta-context">${item.meta.context}</span>
            <span aria-hidden="true">·</span>`
        : nothing}
      <span class="sidebar-issues-panel__meta-status">${item.meta.status}</span>
      <span aria-hidden="true">·</span>
      <span class="sidebar-issues-panel__meta-time">${item.meta.time}</span>
    </span>`;
  }

  private renderNavigationItem(item: SidebarAttentionItem) {
    if (item.action.kind !== "navigate") {
      return nothing;
    }
    const routeId = item.action.routeId;
    return html`<div
      class="sidebar-issues-panel__details sidebar-issues-panel__details--${item.severity}"
      data-attention-kind=${item.kind}
    >
      <div class="sidebar-issues-panel__summary sidebar-issues-panel__summary--navigation">
        <a
          class="sidebar-issues-panel__navigation-link"
          href=${pathForRoute(routeId, this.context?.basePath ?? "")}
          data-issue-row-focus
          @click=${(event: MouseEvent) => {
            if (!shouldHandleNavigationClick(event)) {
              return;
            }
            event.preventDefault();
            this.closePanel(false);
            (this.onNavigate ?? ((nextRoute) => this.context?.navigate(nextRoute)))(routeId);
          }}
        >
          <span class="sidebar-issues-panel__icon" aria-hidden="true">${icons[item.icon]}</span>
          <span class="sidebar-issues-panel__content">
            <span class="sidebar-issues-panel__entity" title=${item.label}>${item.label}</span>
            ${this.renderItemMeta(item)}
          </span>
        </a>
        <button
          type="button"
          class="sidebar-issues-panel__dismiss"
          aria-label=${t("attention.dismissItem", { item: item.label })}
          title=${t("attention.dismissItem", { item: item.label })}
          @click=${() => this.dismiss(item)}
        >
          ${icons.x}
        </button>
        <span class="sidebar-issues-panel__chevron" aria-hidden="true">${icons.chevronRight}</span>
      </div>
    </div>`;
  }

  private renderItem(item: SidebarAttentionItem) {
    if (item.approvalQueue?.length) {
      return item.approvalQueue.map((approval) => this.renderApprovalItem(approval));
    }
    if (item.action.kind === "navigate") {
      return this.renderNavigationItem(item);
    }
    const facts = item.action.kind === "askCustodian" ? item.action.alert.facts : [];
    const visibleFacts = facts.filter((fact) => fact !== item.label);
    const actionLabel = item.action.kind === "askCustodian" ? t("nav.askOpenClaw") : item.label;
    const inlineAction = item.inlineAction;
    return html`<details
      class="sidebar-issues-panel__details sidebar-issues-panel__details--${item.severity}"
      data-attention-kind=${item.kind}
    >
      <summary class="sidebar-issues-panel__summary" data-issue-row-focus>
        <span
          class="sidebar-issues-panel__icon ${item.kind === "modelAuthExpired"
            ? "sidebar-issues-panel__icon--critical"
            : ""}"
          aria-hidden="true"
          >${icons[item.icon]}</span
        >
        <span class="sidebar-issues-panel__content">
          <span class="sidebar-issues-panel__entity" title=${item.label}>${item.label}</span>
          ${this.renderItemMeta(item)}
        </span>
        <button
          type="button"
          class="sidebar-issues-panel__dismiss"
          aria-label=${t("attention.dismissItem", { item: item.label })}
          title=${t("attention.dismissItem", { item: item.label })}
          @click=${(event: Event) => {
            event.preventDefault();
            event.stopPropagation();
            this.dismiss(item);
          }}
        >
          ${icons.x}
        </button>
        <span class="sidebar-issues-panel__chevron" aria-hidden="true">${icons.chevronRight}</span>
      </summary>
      <div class="sidebar-issues-panel__body">
        ${visibleFacts.length
          ? html`<ul class="sidebar-issues-panel__facts">
              ${visibleFacts.map((fact) => html`<li>${fact}</li>`)}
            </ul>`
          : nothing}
        <div class="sidebar-issues-panel__actions">
          ${inlineAction
            ? html`<button
                type="button"
                class="sidebar-issues-panel__action sidebar-issues-panel__action--primary"
                @click=${() => {
                  this.closePanel(false);
                  (this.onNavigate ?? ((routeId) => this.context?.navigate(routeId)))(
                    inlineAction.routeId,
                  );
                }}
              >
                ${inlineAction.label}
              </button>`
            : nothing}
          <button
            type="button"
            class="sidebar-issues-panel__action ${inlineAction
              ? ""
              : "sidebar-issues-panel__action--primary"}"
            @click=${() => void this.open(item)}
          >
            ${actionLabel}
          </button>
        </div>
      </div>
    </details>`;
  }

  override render() {
    if (this.context?.gateway.snapshot.phase !== "connected") {
      return nothing;
    }
    const updateSurface = this.updateSurfaceVisible();
    const allItems = this.currentItems();
    const approvalQueue = allItems.flatMap((item) => item.approvalQueue ?? []);
    const items = allItems
      .filter(
        (item) =>
          !item.approvalQueue?.length && (!updateSurface || item.kind !== "updateAvailable"),
      )
      .toSorted((left, right) => ITEM_PRIORITY[left.kind] - ITEM_PRIORITY[right.kind]);
    const count = approvalQueue.length + items.length + (updateSurface ? 1 : 0);
    const label = t(count === 1 ? "attention.issueCount" : "attention.issueCountPlural", {
      count: String(count),
    });
    const updateError = this.context.overlays.snapshot.updateStatusBanner?.tone === "danger";
    const automationItems = items.filter(
      (item) => item.kind === "cronFailed" || item.kind === "cronOverdue",
    );
    const systemItems = items.filter(
      (item) => item.kind === "modelAuthExpired" || item.kind === "updateAvailable",
    );
    const visibleItems =
      this.selectedTab === "automations"
        ? automationItems
        : this.selectedTab === "system"
          ? systemItems
          : this.selectedTab === "approvals"
            ? []
            : items;
    const showApprovals = this.selectedTab === "all" || this.selectedTab === "approvals";
    const showUpdate = updateSurface && ["all", "system"].includes(this.selectedTab);
    const visibleCount =
      (showApprovals ? approvalQueue.length : 0) + visibleItems.length + (showUpdate ? 1 : 0);
    const errorItems = visibleItems.filter((item) => item.severity === "error");
    const warningItems = visibleItems.filter((item) => item.severity === "warning");
    const tabCounts: Record<IssueTab, number> = {
      all: count,
      approvals: approvalQueue.length,
      automations: automationItems.length,
      system: systemItems.length + (updateSurface ? 1 : 0),
    };
    const custodianItems = items.filter((item) => item.action.kind === "askCustodian");
    const custodianSeverity = custodianItems.some((item) => item.severity === "error")
      ? "error"
      : custodianItems.length
        ? "warning"
        : null;
    return html`
      <span class="sr-only" role="status" aria-live="polite">${label}</span>
      <button
        type="button"
        class="sidebar-issues-button"
        aria-expanded=${String(this.panelOpen)}
        aria-haspopup="dialog"
        aria-controls="sidebar-issues-panel"
        aria-label=${label}
        @click=${(event: MouseEvent) =>
          this.panelOpen
            ? this.closePanel(true)
            : this.openPanel(event.currentTarget as HTMLElement)}
      >
        <span class="sidebar-issues-button__icon" aria-hidden="true">${icons.inbox}</span>
        ${count > 0
          ? html`<span class="sidebar-issues-button__count" aria-hidden="true"
              >${count > 9 ? "9+" : count}</span
            >`
          : nothing}
      </button>
      ${this.panelOpen
        ? html`<button
              type="button"
              class="sidebar-issues-panel__backdrop"
              aria-label=${t("common.close")}
              @click=${() => this.closePanel(true)}
            ></button>
            <openclaw-menu-surface>
              <section
                id="sidebar-issues-panel"
                class="sidebar-issues-panel"
                role="dialog"
                aria-labelledby="sidebar-issues-panel-heading"
                style=${`left:${this.panelPosition.left}px;bottom:${this.panelPosition.bottom}px;--sidebar-issues-panel-bottom:${this.panelPosition.bottom}px`}
                @keydown=${this.handlePanelKeydown}
              >
                <div class="sidebar-issues-panel__grabber" aria-hidden="true"></div>
                <header class="sidebar-issues-panel__header">
                  <h2 id="sidebar-issues-panel-heading" class="sidebar-issues-panel__heading">
                    <span class="sidebar-issues-panel__heading-icon" aria-hidden="true"
                      >${icons.inbox}</span
                    >
                    ${t("attention.issues")}
                  </h2>
                  ${this.renderAskOpenClawButton(custodianItems.length, custodianSeverity)}
                  <button
                    type="button"
                    class="sidebar-brand__icon sidebar-issues-panel__mobile-close"
                    aria-label=${t("common.close")}
                    @click=${() => this.closePanel(true)}
                  >
                    ${icons.x}
                  </button>
                </header>
                <div
                  class="sidebar-issues-panel__tabs"
                  role="tablist"
                  aria-label=${t("attention.tabs.label")}
                >
                  ${ISSUE_TABS.map((tab) => this.renderTab(tab, tabCounts[tab]))}
                </div>
                <div class="sidebar-issues-panel__list-wrap">
                  <div
                    id="sidebar-issues-tabpanel"
                    class="sidebar-issues-panel__list"
                    role="tabpanel"
                    aria-labelledby=${`sidebar-issues-tab-${this.selectedTab}`}
                    tabindex="0"
                    @scroll=${this.syncOverflowCue}
                  >
                    ${visibleCount === 0
                      ? html`<div class="sidebar-issues-panel__empty">
                          <span class="sidebar-issues-panel__empty-icon" aria-hidden="true"
                            >${icons.inbox}</span
                          >
                          <strong>${t("attention.emptyTitle")}</strong>
                          <span>${t("attention.emptyBody")}</span>
                        </div>`
                      : nothing}
                    ${showApprovals
                      ? approvalQueue.map((approval) => this.renderApprovalItem(approval))
                      : nothing}
                    ${showUpdate && updateError ? this.renderUpdateSurface() : nothing}
                    ${errorItems.map((item) => this.renderItem(item))}
                    ${showUpdate && !updateError ? this.renderUpdateSurface() : nothing}
                    ${warningItems.map((item) => this.renderItem(item))}
                  </div>
                  <div
                    class="sidebar-issues-panel__overflow-cue sidebar-issues-panel__overflow-cue--top"
                    ?hidden=${!this.overflowAbove}
                    aria-hidden="true"
                  ></div>
                  <div
                    class="sidebar-issues-panel__overflow-cue sidebar-issues-panel__overflow-cue--bottom"
                    ?hidden=${!this.overflowBelow}
                    aria-hidden="true"
                  ></div>
                </div>
              </section>
            </openclaw-menu-surface>`
        : nothing}
    `;
  }
}

if (!customElements.get("openclaw-sidebar-attention")) {
  customElements.define("openclaw-sidebar-attention", SidebarAttention);
}
