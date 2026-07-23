// Ambient health chips in the sidebar footer: failing/overdue cron jobs and
// expiring model auth. This replaces the removed Overview page's attention
// list — alerts surface where the user already is instead of on a dashboard
// they have to visit.
import { consume } from "@lit/context";
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
  private loadGeneration = 0;
  private loadedAtMs = 0;
  private dismissedScope: string | null = null;
  private idleRefreshTimer: ReturnType<typeof globalThis.setInterval> | null = null;

  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.gateway,
      (gateway) => {
        this.synchronize(gateway);
        return gateway.subscribe(() => this.synchronize(gateway));
      },
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
    this.loadGeneration += 1;
    this.loadedClient = null;
    super.disconnectedCallback();
  }

  private synchronize(gateway: ApplicationContext["gateway"]) {
    const snapshot = gateway.snapshot;
    const gatewayUrl = gateway.connection.gatewayUrl;
    if (gatewayUrl && gatewayUrl !== this.dismissedScope) {
      this.dismissedScope = gatewayUrl;
      this.dismissed = loadDismissals(gatewayUrl);
    }
    if (!snapshot.connected || !snapshot.client) {
      this.loadGeneration += 1;
      this.loadedClient = null;
      this.cronJobs = [];
      this.modelAuthStatus = null;
      return;
    }
    if (snapshot.client === this.loadedClient) {
      return;
    }
    this.loadedClient = snapshot.client;
    // Stale refreshes reuse the same client, so identity alone cannot retire
    // an older completion once the replacement load starts.
    const generation = ++this.loadGeneration;
    void this.load(gateway, snapshot.client, generation);
  }

  private async load(
    gateway: ApplicationContext["gateway"],
    client: GatewayBrowserClient,
    generation: number,
  ) {
    const isCurrent = () =>
      this.isConnected &&
      this.loadGeneration === generation &&
      this.loadedClient === client &&
      gateway.snapshot.client === client &&
      gateway.snapshot.connected;
    const cron = createInitialCronState({ client, connected: true });
    await Promise.allSettled([
      loadCronJobsPage(cron).then(() => {
        if (isCurrent()) {
          this.cronJobs = cron.cronJobs;
        }
      }),
      loadModelAuthStatus(client, {})
        .catch(() => null)
        .then((result) => {
          if (isCurrent()) {
            this.modelAuthStatus = result;
          }
        }),
    ]);
    if (isCurrent()) {
      this.loadedAtMs = Date.now();
      this.pruneAfterRefresh();
    }
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
    if (!this.context?.gateway.snapshot.connected) {
      return nothing;
    }
    const items = buildSidebarAttentionItems({
      cronJobs: this.cronJobs,
      modelAuthStatus: this.modelAuthStatus,
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
              <openclaw-tooltip .content=${item.label}>
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
