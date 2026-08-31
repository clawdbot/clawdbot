import { consume } from "@lit/context";
import { initialState, Task } from "@lit/task";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { CronJob, ModelAuthStatusResult } from "../api/types.ts";
import type { NavigationRouteId } from "../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import type { ExecApprovalDecision } from "../app/exec-approval.ts";
import {
  NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT,
  NATIVE_UPDATE_DECLINED_EVENT,
} from "../app/native-link-routing.ts";
import type { UpdateProgress } from "../app/update-confirmation.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import { createInitialCronState, loadCronJobsPage, loadCronStatus } from "../lib/cron/index.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { loadModelAuthStatus } from "../lib/model-auth.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import "../styles/sidebar-attention-floating.css";
import { icons } from "./icons.ts";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import {
  clearSidebarAttentionDismissal,
  dismissSidebarAttention,
  dismissalStoreKey,
  isSidebarAttentionDismissed,
  loadDismissals,
  reconcileSidebarAttentionDismissals,
  type SidebarAttentionDismissals,
} from "./sidebar-attention-dismissals.ts";
import {
  buildScopeUpgradeInboxEntry,
  buildSidebarInboxEntries,
  buildUpdateInboxEntry,
  sidebarInboxTabCounts,
  type SidebarAttentionDismissal,
  type SidebarAttentionItem,
  type SidebarInboxEntry,
} from "./sidebar-attention-entries.ts";
import {
  buildSidebarAttentionEntries,
  compareSidebarAttentionEntries,
} from "./sidebar-attention-items.ts";
import type { SidebarAttentionPanelPosition } from "./sidebar-attention-panel.runtime.ts";
import { resolveSidebarUpdateAttention } from "./sidebar-attention-update.ts";
import type { IssueTab } from "./sidebar-issues-tabs.ts";
import "./tooltip.ts";

type SidebarAttentionPanelRenderer =
  typeof import("./sidebar-attention-panel.runtime.ts").renderSidebarAttentionPanel;
type SidebarAttentionPanelRuntime = typeof import("./sidebar-attention-panel.runtime.ts");
type UpdateProgressWatcher = (listener: (progress: UpdateProgress) => void) => () => void;
type SidebarAttentionAgentScope = { selectedId: string | null; scopeId: string | null };

// A visibility change only refetches a connection-scoped stale snapshot.
const VISIBILITY_REFRESH_MIN_AGE_MS = 60_000;
// Always-visible native windows need a slow lifecycle-owned refresh too.
const IDLE_REFRESH_INTERVAL_MS = 10 * 60_000;
// Display is stylesheet-owned (layout.css `display: contents` in the footer,
// flex when floating): the LightDomContents base's inline display would defeat
// the floating override, re-piling the collapsed-nav cluster at the origin.
class SidebarAttention extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @state() private cronJobs: CronJob[] = [];
  @state() private cronSchedulerEnabled: boolean | null = null;
  @state() private modelAuthStatus: ModelAuthStatusResult | null = null;
  @state() private dismissed: SidebarAttentionDismissals = {};
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

  private loadedClient: GatewayBrowserClient | null = null;
  private loadedGateway: ApplicationContext["gateway"] | null = null;
  private loadedAgentScope: SidebarAttentionAgentScope | null = null;
  // Cron events may restart the combined task; retain the committed auth owner so an
  // interrupted agent switch reissues auth instead of displaying the prior agent's alert.
  private modelAuthAgentId: string | null = null;
  private loadedAtMs = 0;
  private dismissedScope: string | null = null;
  private idleRefreshTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private panelTrigger: HTMLElement | null = null;
  private panelRenderer: SidebarAttentionPanelRenderer | null = null;
  private panelLoad: Promise<SidebarAttentionPanelRuntime> | null = null;
  private panelGeneration = 0;
  private nativeUpdateDeclined = false;

  private readonly loadTask = new Task(this, {
    autoRun: false,
    // Gateway identity matters when a replacement source reuses the same client object.
    args: () =>
      [
        null as ApplicationContext["gateway"] | null,
        null as GatewayBrowserClient | null,
        null as SidebarAttentionAgentScope | null,
        true as boolean,
      ] as const,
    task: async ([gateway, client, agentScope, refreshModelAuth], { signal }) => {
      if (!gateway || !client || !agentScope) {
        return initialState;
      }
      const cron = createInitialCronState({ client, connected: true });
      cron.cronAgentId = agentScope.scopeId;
      const loads: Promise<unknown>[] = [
        Promise.all([loadCronJobsPage(cron), loadCronStatus(cron)]).then(() => {
          if (!signal.aborted) {
            this.cronJobs = cron.cronJobs;
            this.cronSchedulerEnabled = cron.cronStatus?.enabled ?? null;
          }
        }),
      ];
      if (refreshModelAuth && agentScope.selectedId) {
        loads.push(
          loadModelAuthStatus(client, {
            agentId: agentScope.selectedId,
            signal,
          })
            .catch(() => null)
            .then((modelAuthStatus) => {
              if (!signal.aborted) {
                this.modelAuthStatus = modelAuthStatus;
                this.modelAuthAgentId = agentScope.selectedId;
              }
            }),
        );
      } else if (!agentScope.selectedId) {
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
          this.synchronize(gateway, { refreshModelAuth: false });
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
      () => this.context?.scopeUpgrade,
      (scopeUpgrade, notify) =>
        scopeUpgrade.subscribe(() => {
          this.reconcileScopeUpgradeDismissal();
          notify();
        }),
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
    this.nativeUpdateDeclined = false;
    // Dismissal belongs to the connected Inbox, including while its panel imports.
    document.addEventListener("pointerdown", this.handleOutsideInteraction, true);
    document.addEventListener("keydown", this.handleOutsideInteraction, true);
    document.addEventListener("visibilitychange", this.refreshIfStale);
    globalThis.addEventListener("storage", this.syncDismissalsFromStorage);
    window.addEventListener(
      NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT,
      this.handleNativeUpdateAvailabilityChanged,
    );
    window.addEventListener(NATIVE_UPDATE_DECLINED_EVENT, this.handleNativeUpdateDeclined);
    this.idleRefreshTimer = globalThis.setInterval(this.refreshIfStale, IDLE_REFRESH_INTERVAL_MS);
  }

  override disconnectedCallback() {
    document.removeEventListener("pointerdown", this.handleOutsideInteraction, true);
    document.removeEventListener("keydown", this.handleOutsideInteraction, true);
    document.removeEventListener("visibilitychange", this.refreshIfStale);
    globalThis.removeEventListener("storage", this.syncDismissalsFromStorage);
    window.removeEventListener(
      NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT,
      this.handleNativeUpdateAvailabilityChanged,
    );
    window.removeEventListener(NATIVE_UPDATE_DECLINED_EVENT, this.handleNativeUpdateDeclined);
    this.closePanel(false);
    if (this.idleRefreshTimer !== null) {
      globalThis.clearInterval(this.idleRefreshTimer);
      this.idleRefreshTimer = null;
    }
    this.subscriptions.clear();
    void this.loadTask.run([null, null, null, false]);
    this.loadedClient = null;
    this.loadedGateway = null;
    this.loadedAgentScope = null;
    this.modelAuthAgentId = null;
    super.disconnectedCallback();
  }

  private readonly handleNativeUpdateAvailabilityChanged = () => {
    this.nativeUpdateDeclined = false;
    this.requestUpdate();
  };

  // This element outlives the lazy panel, so a confirmed native handoff can
  // always continue through the Gateway when the host declines it.
  private readonly handleNativeUpdateDeclined = () => {
    if (this.nativeUpdateDeclined) {
      return;
    }
    this.nativeUpdateDeclined = true;
    const snapshot = this.context?.overlays.snapshot;
    const campaign = snapshot?.updateSchedule?.campaign;
    const busy =
      snapshot?.updateRunning ||
      snapshot?.updateReconciliationPending ||
      campaign?.state === "applying";
    if (
      snapshot &&
      (snapshot.updateAvailable || campaign) &&
      !busy &&
      !snapshot.controlUiRefreshRequired &&
      canCallGatewayMethod(this.context?.gateway.snapshot, "update.run", "operator.admin")
    ) {
      void this.context?.overlays.runUpdate();
    }
  };

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

  private synchronize(
    gateway: ApplicationContext["gateway"],
    options: { refreshModelAuth?: boolean } = {},
  ) {
    const snapshot = gateway.snapshot;
    const gatewayUrl = gateway.connection.gatewayUrl;
    if (gatewayUrl && gatewayUrl !== this.dismissedScope) {
      this.dismissedScope = gatewayUrl;
      this.dismissed = loadDismissals(gatewayUrl);
      this.reconcileScopeUpgradeDismissal();
    }
    if (snapshot.phase !== "connected" || !snapshot.client) {
      void this.loadTask.run([null, null, null, false]);
      this.loadedClient = null;
      this.loadedGateway = null;
      this.loadedAgentScope = null;
      this.modelAuthAgentId = null;
      this.cronJobs = [];
      this.cronSchedulerEnabled = null;
      this.modelAuthStatus = null;
      return;
    }
    const agentScope: SidebarAttentionAgentScope = {
      selectedId: this.context?.agentSelection.state.selectedId ?? null,
      scopeId: this.context?.agentSelection.state.scopeId ?? null,
    };
    const loadedAgentScope = this.loadedAgentScope;
    if (
      gateway === this.loadedGateway &&
      snapshot.client === this.loadedClient &&
      loadedAgentScope &&
      agentScope.selectedId === loadedAgentScope.selectedId &&
      agentScope.scopeId === loadedAgentScope.scopeId
    ) {
      return;
    }
    if (loadedAgentScope && agentScope.selectedId !== loadedAgentScope.selectedId) {
      this.modelAuthStatus = null;
      this.modelAuthAgentId = null;
    }
    if (loadedAgentScope && agentScope.scopeId !== loadedAgentScope.scopeId) {
      this.cronJobs = [];
    }
    this.loadedGateway = gateway;
    this.loadedClient = snapshot.client;
    this.loadedAgentScope = agentScope;
    void this.loadTask.run([
      gateway,
      snapshot.client,
      agentScope,
      options.refreshModelAuth !== false || agentScope.selectedId !== this.modelAuthAgentId,
    ]);
  }

  // Only fresh data can re-arm snoozes. Use the persisted map so a stale tab
  // cannot clobber another tab's dismissal; failed fetches fail safe by re-nagging.
  private pruneAfterRefresh() {
    if (!this.dismissedScope) {
      return;
    }
    this.dismissed = reconcileSidebarAttentionDismissals({
      active: this.buildInboxEntries().flatMap((entry) =>
        entry.dismissal ? [entry.dismissal] : [],
      ),
      gatewayUrl: this.dismissedScope,
      scope: {
        cronInventoryComplete: this.loadedAgentScope?.scopeId === null,
        modelAuthAgentId: this.modelAuthAgentId,
      },
    });
  }

  private reconcileScopeUpgradeDismissal() {
    if (!this.dismissedScope || !this.context) {
      return;
    }
    const snapshot = this.context.gateway.snapshot;
    const scopes = snapshot.hello?.auth?.scopes;
    const entry = buildScopeUpgradeInboxEntry({
      scopes,
      state: this.context.scopeUpgrade.state,
    });
    // A disconnect makes access unresolved, not resolved. Keep the snooze until
    // connected scope facts or an active request lifecycle authoritatively retire it.
    if (snapshot.phase === "connected" && scopes !== undefined && !entry?.dismissal) {
      this.dismissed = clearSidebarAttentionDismissal(this.dismissedScope, "scopeUpgrade");
    }
  }

  private dismiss(dismissal: SidebarAttentionDismissal) {
    if (!this.dismissedScope) {
      return;
    }
    this.dismissed = dismissSidebarAttention(this.dismissedScope, dismissal);
  }

  private buildAttentionEntries() {
    return buildSidebarAttentionEntries({
      cronJobs: this.cronJobs,
      cronSchedulerEnabled: this.cronSchedulerEnabled,
      cronOwnerByJobId: this.cronOwnerByJobId(),
      modelAuthStatus: this.modelAuthStatus,
      modelAuthAgentId: this.modelAuthAgentId,
      now: Date.now(),
    });
  }

  private cronOwnerByJobId(): ReadonlyMap<string, string> | undefined {
    const selection = this.context?.agentSelection.state;
    const roster = this.context?.agents?.state.agentsList;
    if (!selection || selection.scopeId !== null || !roster) {
      return undefined;
    }
    const namesByAgentId = new Map(
      roster.agents.map((agent) => [normalizeAgentId(agent.id), normalizeAgentLabel(agent)]),
    );
    const defaultId = normalizeAgentId(roster.defaultId);
    return new Map(
      this.cronJobs.map((job) => {
        const ownerId = normalizeAgentId(job.agentId ?? defaultId);
        return [job.id, namesByAgentId.get(ownerId) ?? ownerId];
      }),
    );
  }

  private buildInboxEntries(): SidebarInboxEntry[] {
    const context = this.context;
    if (!context || context.gateway.snapshot.phase !== "connected") {
      return [];
    }
    const overlaySnapshot = context.overlays.snapshot;
    const updateState = resolveSidebarUpdateAttention(context);
    const update = buildUpdateInboxEntry({
      canDismiss: updateState.canUpdate,
      dismissal: updateState.dismissal,
      forced: updateState.forced,
      requiresAction: updateState.forced || (updateState.canUpdate && updateState.actionable),
      severity: overlaySnapshot.updateStatusBanner?.tone === "danger" ? "error" : "warning",
      visible: updateState.present,
    });
    const scopeUpgrade = buildScopeUpgradeInboxEntry({
      scopes: context.gateway.snapshot.hello?.auth?.scopes,
      state: context.scopeUpgrade.state,
    });
    return buildSidebarInboxEntries({
      approvals: overlaySnapshot.approvalQueue,
      attention: this.buildAttentionEntries().toSorted(compareSidebarAttentionEntries),
      scopeUpgrade,
      update,
    });
  }

  private currentInboxEntries(): SidebarInboxEntry[] {
    return this.buildInboxEntries().filter(
      (entry) => !entry.dismissal || !isSidebarAttentionDismissed(this.dismissed, entry.dismissal),
    );
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
        ${count > 0
          ? html`<span class="sidebar-issues-button__count" aria-hidden="true"
              >${count > 9 ? "9+" : count}</span
            >`
          : nothing}
      </button>
      ${this.panelOpen && this.panelRenderer
        ? this.panelRenderer({
            context: this.context,
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
        : nothing}
    `;
  }
}

if (!customElements.get("openclaw-sidebar-attention")) {
  customElements.define("openclaw-sidebar-attention", SidebarAttention);
}
