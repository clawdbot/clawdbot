import { consume } from "@lit/context";
import { initialState, Task } from "@lit/task";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { CronJob, ModelAuthStatusResult } from "../api/types.ts";
import type { NavigationRouteId } from "../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { createInitialCronState, loadCronJobsPage } from "../lib/cron/index.ts";
import { loadModelAuthStatus } from "../lib/model-auth.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { icons } from "./icons.ts";
import "./menu-surface.ts";
import {
  buildSidebarIssuesSnapshot,
  type SidebarAutomationAttention,
  type SidebarIssueAction,
  type SidebarIssueCondition,
} from "./sidebar-attention-items.ts";

const VISIBILITY_REFRESH_MIN_AGE_MS = 60_000;
const IDLE_REFRESH_INTERVAL_MS = 10 * 60_000;
// One page-zero recovery can produce a coherent inventory. A second revision
// change means active churn, so stop instead of amplifying cron.list traffic.
const MAX_CRON_SNAPSHOT_RESTARTS = 1;

const SIDEBAR_ISSUES_CHANGE_EVENT = "sidebar-issues-change";

export type SidebarIssuesChangeDetail = {
  automationAttention: SidebarAutomationAttention;
};

class SidebarAttention extends OpenClawLightDomContentsElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @state() private cronJobs: CronJob[] = [];
  @state() private modelAuthStatus: ModelAuthStatusResult | null = null;
  @state() private panelOpen = false;
  @state() private panelPosition = { left: 8, bottom: 8 };

  @property({ attribute: false }) activeRouteId?: NavigationRouteId;
  @property({ attribute: false }) onNavigate?: (routeId: NavigationRouteId) => void;
  @property({ attribute: false }) onOpenApprovals?: () => void;

  private loadedClient: GatewayBrowserClient | null = null;
  private loadedGateway: ApplicationContext["gateway"] | null = null;
  private loadedAgentId: string | null = null;
  // A cron event can restart the task mid-switch; retain the committed auth
  // owner so the next task cannot display the prior agent's status.
  private modelAuthAgentId: string | null = null;
  private loadedAtMs = 0;
  private idleRefreshTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private panelTrigger: HTMLElement | null = null;
  private lastAutomationAttention: SidebarAutomationAttention | null = null;

  private readonly loadTask = new Task(this, {
    autoRun: false,
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
      const cronLoad = async () => {
        await loadCronJobsPage(cron, { signal });
        let snapshotRevision = cron.cronJobsSnapshotRevision;
        let snapshotRestarts = 0;
        while (cron.cronJobsHasMore && !cron.cronError && !signal.aborted) {
          await loadCronJobsPage(cron, { append: true, signal });
          if (signal.aborted) {
            return;
          }
          if (cron.cronJobsSnapshotRevision !== snapshotRevision) {
            snapshotRevision = cron.cronJobsSnapshotRevision;
            snapshotRestarts += 1;
            if (snapshotRestarts > MAX_CRON_SNAPSHOT_RESTARTS) {
              return;
            }
          }
        }
        if (!signal.aborted) {
          this.cronJobs = cron.cronJobs;
        }
      };
      const loads: Promise<unknown>[] = [cronLoad()];
      if (refreshModelAuth && agentId) {
        loads.push(
          loadModelAuthStatus(client, { agentId, signal })
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
          this.loadedClient = null;
          this.synchronize(gateway, { refreshModelAuth: false });
        }),
    )
    .watch(
      () => this.context?.overlays,
      (overlays, notify) => overlays.subscribe(() => notify()),
    );

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

  private readonly closeOnOutsidePointer = (event: PointerEvent) => {
    if (!this.panelOpen || event.composedPath().includes(this)) {
      return;
    }
    this.closePanel(false);
  };

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.refreshIfStale);
    this.idleRefreshTimer = globalThis.setInterval(this.refreshIfStale, IDLE_REFRESH_INTERVAL_MS);
  }

  override disconnectedCallback() {
    document.removeEventListener("visibilitychange", this.refreshIfStale);
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
    if (this.panelOpen && this.currentSnapshot().conditions.length === 0) {
      this.closePanel(false);
    }
  }

  protected override updated(changed: PropertyValues<this>) {
    super.updated(changed);
    const snapshot = this.currentSnapshot();
    const attention = snapshot.automationAttention;
    if (
      attention.count !== this.lastAutomationAttention?.count ||
      attention.severity !== this.lastAutomationAttention?.severity
    ) {
      this.lastAutomationAttention = attention;
      this.dispatchEvent(
        new CustomEvent<SidebarIssuesChangeDetail>(SIDEBAR_ISSUES_CHANGE_EVENT, {
          bubbles: true,
          composed: true,
          detail: { automationAttention: attention },
        }),
      );
    }
  }

  private synchronize(
    gateway: ApplicationContext["gateway"],
    options: { refreshModelAuth?: boolean } = {},
  ) {
    const snapshot = gateway.snapshot;
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

  private currentSnapshot() {
    return buildSidebarIssuesSnapshot({
      cronJobs: this.cronJobs,
      modelAuthStatus: this.modelAuthAgentId === this.loadedAgentId ? this.modelAuthStatus : null,
      approvalQueue: this.context?.overlays.snapshot.approvalQueue ?? [],
      now: Date.now(),
    });
  }

  private openPanel(trigger: HTMLElement) {
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(304, globalThis.innerWidth - 16);
    this.panelTrigger = trigger;
    this.panelPosition = {
      left: Math.max(8, Math.min(rect.left, globalThis.innerWidth - width - 8)),
      bottom: Math.max(8, globalThis.innerHeight - rect.top + 6),
    };
    this.panelOpen = true;
    document.addEventListener("pointerdown", this.closeOnOutsidePointer, true);
    void this.updateComplete.then(() => {
      this.querySelector<HTMLElement>(".sidebar-issues-panel [data-autofocus]")?.focus();
    });
  }

  private closePanel(restoreFocus: boolean) {
    if (!this.panelOpen) {
      return;
    }
    const trigger = this.panelTrigger;
    this.panelOpen = false;
    this.panelTrigger = null;
    document.removeEventListener("pointerdown", this.closeOnOutsidePointer, true);
    if (restoreFocus) {
      void this.updateComplete.then(() => trigger?.focus());
    }
  }

  private runAction(action: SidebarIssueAction) {
    this.closePanel(false);
    if (action.kind === "openApprovals") {
      this.onOpenApprovals?.();
      return;
    }
    this.onNavigate?.(action.routeId);
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
    const panel = event.currentTarget as HTMLElement;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]'),
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  private renderCondition(condition: SidebarIssueCondition, autofocus: boolean) {
    const actionLabel = condition.sourceKind === "provider" ? t("attention.reconnect") : undefined;
    return html`
      <button
        type="button"
        class="sidebar-issues-panel__row sidebar-issues-panel__row--${condition.severity}"
        data-sidebar-issue-id=${condition.id}
        data-autofocus=${autofocus ? "true" : nothing}
        aria-label=${`${condition.entityLabel}: ${condition.stateLabel}${
          actionLabel ? `, ${actionLabel}` : ""
        }`}
        @click=${() => this.runAction(condition.action)}
      >
        <span class="sidebar-issues-panel__icon" aria-hidden="true">${icons[condition.icon]}</span>
        <span class="sidebar-issues-panel__content">
          <span class="sidebar-issues-panel__entity" title=${condition.entityLabel}
            >${condition.entityLabel}</span
          >
          <span class="sidebar-issues-panel__state">${condition.stateLabel}</span>
        </span>
        ${actionLabel
          ? html`<span class="sidebar-issues-panel__action">${actionLabel}</span>`
          : nothing}
        <span class="sidebar-issues-panel__chevron" aria-hidden="true">${icons.chevronRight}</span>
      </button>
    `;
  }


  override render() {
    if (this.context?.gateway.snapshot.phase !== "connected") {
      return nothing;
    }
    const conditions = this.currentSnapshot().conditions;
    const count = conditions.length;
    const blocking = conditions.filter((condition) => condition.severity === "blocking").length;
    const issueLabel = t(count === 1 ? "attention.issue" : "attention.issues", {
      count: String(count),
    });
    const ariaLabel = t("attention.issuesAria", {
      issues: issueLabel,
      blocking: String(blocking),
    });
    return html`
      ${count > 0
        ? html`
            <span class="sr-only" role="status" aria-live="polite">${ariaLabel}</span>
            <button
              type="button"
              class="sidebar-issues-button"
              aria-expanded=${String(this.panelOpen)}
              aria-haspopup="dialog"
              aria-label=${ariaLabel}
              @click=${(event: MouseEvent) =>
                this.panelOpen
                  ? this.closePanel(true)
                  : this.openPanel(event.currentTarget as HTMLElement)}
            >
              <span class="sidebar-issues-button__icon" aria-hidden="true">${icons.bell}</span>
              <span class="sidebar-issues-button__count" aria-hidden="true"
                >${count > 9 ? "9+" : count}</span
              >
            </button>
          `
        : nothing}
      ${this.panelOpen
        ? html`
            <openclaw-menu-surface>
              <section
                class="sidebar-issues-panel"
                role="dialog"
                aria-label=${t("attention.issuesTitle")}
                style=${`left:${this.panelPosition.left}px;bottom:${this.panelPosition.bottom}px`}
                @keydown=${this.handlePanelKeydown}
              >
                <header class="sidebar-issues-panel__header">
                  <h2 class="sidebar-issues-panel__heading">${t("attention.issuesTitle")}</h2>
                </header>
                <div class="sidebar-issues-panel__list">
                  ${conditions.map((condition, index) =>
                    this.renderCondition(condition, index === 0),
                  )}
                </div>
              </section>
            </openclaw-menu-surface>
          `
        : nothing}
    `;
  }
}

if (!customElements.get("openclaw-sidebar-attention")) {
  customElements.define("openclaw-sidebar-attention", SidebarAttention);
}
