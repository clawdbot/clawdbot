// Ambient health chips in the sidebar footer: failing/overdue cron jobs and
// expiring model auth. This replaces the removed Overview page's attention
// list — alerts surface where the user already is instead of on a dashboard
// they have to visit.
import { consume } from "@lit/context";
import { initialState, Task } from "@lit/task";
import { html, nothing } from "lit";
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

// Reloads are connection-scoped; a visibility change only refetches after the
// snapshot is older than this, so tab switches stay free of request bursts.
const VISIBILITY_REFRESH_MIN_AGE_MS = 60_000;
// Always-visible windows (the macOS app) never fire visibilitychange, so a
// slow lifecycle-owned interval keeps the chips from going permanently stale.
const IDLE_REFRESH_INTERVAL_MS = 10 * 60_000;

class SidebarAttention extends OpenClawLightDomContentsElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @state() private cronJobs: CronJob[] = [];
  @state() private modelAuthStatus: ModelAuthStatusResult | null = null;
  @state() private dismissed: SidebarAttentionDismissals = {};

  @property({ attribute: false }) onNavigate?: (routeId: NavigationRouteId) => void;
  @property({ attribute: false }) onOpenApprovals?: () => void;

  private loadedClient: GatewayBrowserClient | null = null;
  private loadedGateway: ApplicationContext["gateway"] | null = null;
  private loadedAgentId: string | null = null;
  // Cron events may restart the combined task; retain the committed auth owner so an
  // interrupted agent switch reissues auth instead of displaying the prior agent's alert.
  private modelAuthAgentId: string | null = null;
  private loadedAtMs = 0;
  private dismissedScope: string | null = null;
  private idleRefreshTimer: ReturnType<typeof globalThis.setInterval> | null = null;

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

  // Re-arm stale snoozes only right after this tab's own data refresh: fresh
  // data is the only safe basis for deciding a chip is gone. Pruning from
  // render/update hooks would let a hidden tab with stale data clobber a
  // dismissal another tab just wrote (its storage event triggers an update
  // here). Against the persisted map, not the in-memory snapshot, for the
  // same lost-update reason as addDismissal. A failed fetch (empty cron list,
  // null auth status) prunes those kinds, which fails safe — re-nag, never
  // stay hidden.
  private pruneAfterRefresh() {
    if (!this.dismissedScope) {
      return;
    }
    const items = buildSidebarAttentionItems({
      cronJobs: this.cronJobs,
      modelAuthStatus: this.modelAuthStatus,
      modelAuthAgentId: this.modelAuthAgentId,
      approvalQueue: this.context?.overlays.snapshot.approvalQueue ?? [],
      now: Date.now(),
    });
    const stored = loadDismissals(this.dismissedScope);
    const pruned = pruneDismissals(stored, items);
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

  private open(item: SidebarAttentionItem) {
    if (item.action.kind === "openApprovals") {
      this.onOpenApprovals?.();
      return;
    }
    this.onNavigate?.(item.action.routeId);
  }

  override render() {
    if (this.context?.gateway.snapshot.phase !== "connected") {
      return nothing;
    }
    const items = buildSidebarAttentionItems({
      cronJobs: this.cronJobs,
      modelAuthStatus: this.modelAuthStatus,
      modelAuthAgentId: this.modelAuthAgentId,
      approvalQueue: this.context.overlays.snapshot.approvalQueue,
      now: Date.now(),
    }).filter((item) => this.dismissed[item.kind] !== item.signature);
    if (items.length === 0) {
      return nothing;
    }
    return html`
      <div class="sidebar-attention" role="status">
        ${items.map(
          (item) => html`
            <div class="sidebar-attention__item sidebar-attention__item--${item.severity}">
              <openclaw-tooltip .content=${item.detail ?? item.label}>
                <button
                  type="button"
                  class="sidebar-attention__open"
                  @click=${() => this.open(item)}
                >
                  <span class="sidebar-attention__icon" aria-hidden="true"
                    >${icons[item.icon]}</span
                  >
                  <span class="sidebar-attention__label">${item.label}</span>
                </button>
              </openclaw-tooltip>
              <openclaw-tooltip .content=${t("common.dismiss")}>
                <button
                  type="button"
                  class="sidebar-attention__dismiss"
                  aria-label=${t("common.dismiss")}
                  @click=${() => this.dismiss(item)}
                >
                  ${icons.x}
                </button>
              </openclaw-tooltip>
            </div>
          `,
        )}
      </div>
    `;
  }
}

if (!customElements.get("openclaw-sidebar-attention")) {
  customElements.define("openclaw-sidebar-attention", SidebarAttention);
}
