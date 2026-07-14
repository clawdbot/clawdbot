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
import { isCronJobActiveFailure } from "../lib/cron-status.ts";
import { createInitialCronState, loadCronJobsPage } from "../lib/cron/index.ts";
import { isMonitoredAuthProvider, loadModelAuthStatus } from "../lib/model-auth.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { icons, type IconName } from "./icons.ts";
import {
  addDismissal,
  dismissalStoreKey,
  loadDismissals,
  pruneDismissals,
  saveDismissals,
  type SidebarAttentionDismissals,
  type SidebarAttentionKind,
} from "./sidebar-attention-dismissals.ts";

// A cron job counts as overdue when its next planned run is this far in the
// past; mirrors the threshold the Overview attention list used.
const CRON_OVERDUE_GRACE_MS = 300_000;
// Reloads are connection-scoped; a visibility change only refetches after the
// snapshot is older than this, so tab switches stay free of request bursts.
const VISIBILITY_REFRESH_MIN_AGE_MS = 60_000;
// Always-visible windows (the macOS app) never fire visibilitychange, so a
// slow lifecycle-owned interval keeps the chips from going permanently stale.
const IDLE_REFRESH_INTERVAL_MS = 10 * 60_000;

type SidebarAttentionItem = {
  kind: SidebarAttentionKind;
  severity: "error" | "warning";
  icon: IconName;
  label: string;
  routeId: NavigationRouteId;
  // Sorted identities of the entities behind the chip. A dismissal stores
  // this signature so the chip stays hidden only while the same incident set
  // is affected; any change (new job/provider, new overdue run) resurfaces
  // it. Failed-cron and auth chips key on entity ids alone on purpose: a
  // persistently failing job gets a new lastRunAtMs every schedule tick, and
  // short-lived OAuth tokens (e.g. Copilot) roll expiry continuously — either
  // in the signature would resurface a dismissed chip within minutes. The
  // cost is that a recover-then-recur cycle nobody observed stays snoozed;
  // pruneAfterRefresh re-arms as soon as any tab sees the cleared state.
  signature: string;
};

function buildSidebarAttentionItems(params: {
  cronJobs: readonly CronJob[];
  modelAuthStatus: ModelAuthStatusResult | null;
  now: number;
}): SidebarAttentionItem[] {
  const items: SidebarAttentionItem[] = [];
  const signatureOf = (ids: readonly string[]) => ids.toSorted().join("\n");

  const failedCron = params.cronJobs.filter(isCronJobActiveFailure);
  if (failedCron.length > 0) {
    items.push({
      kind: "cronFailed",
      severity: "error",
      icon: "clock",
      label: t("attention.cronFailed", { count: String(failedCron.length) }),
      routeId: "cron",
      signature: signatureOf(failedCron.map((job) => job.id)),
    });
  }
  const overdueCron = params.cronJobs.filter(
    (job) =>
      job.enabled &&
      job.state?.nextRunAtMs != null &&
      params.now - job.state.nextRunAtMs > CRON_OVERDUE_GRACE_MS,
  );
  if (overdueCron.length > 0) {
    items.push({
      kind: "cronOverdue",
      severity: "warning",
      icon: "clock",
      label: t("attention.cronOverdue", { count: String(overdueCron.length) }),
      routeId: "cron",
      // nextRunAtMs is the incident identity: stable while a job stays stuck,
      // new once it runs again and later goes overdue anew — so a fresh
      // overdue episode resurfaces even if no tab observed the recovery.
      signature: signatureOf(overdueCron.map((job) => `${job.id}@${job.state?.nextRunAtMs}`)),
    });
  }

  const monitored = (params.modelAuthStatus?.providers ?? []).filter(isMonitoredAuthProvider);
  const expired = monitored.filter(
    (provider) => provider.status === "expired" || provider.status === "missing",
  );
  if (expired.length > 0) {
    items.push({
      kind: "modelAuthExpired",
      severity: "error",
      icon: "plug",
      label: t("attention.modelAuthExpired", {
        providers: expired.map((provider) => provider.displayName).join(", "),
      }),
      routeId: "model-providers",
      signature: signatureOf(expired.map((provider) => provider.provider)),
    });
  }
  const expiring = monitored.filter((provider) => provider.status === "expiring");
  if (expiring.length > 0) {
    items.push({
      kind: "modelAuthExpiring",
      severity: "warning",
      icon: "plug",
      label: t("attention.modelAuthExpiring", {
        providers: expiring
          .map((provider) => `${provider.displayName} (${provider.expiry?.label ?? "soon"})`)
          .join(", "),
      }),
      routeId: "model-providers",
      signature: signatureOf(expiring.map((provider) => provider.provider)),
    });
  }
  return items;
}

class SidebarAttention extends OpenClawLightDomContentsElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @state() private cronJobs: CronJob[] = [];
  @state() private modelAuthStatus: ModelAuthStatusResult | null = null;
  @state() private dismissed: SidebarAttentionDismissals = {};

  @property({ attribute: false }) onNavigate?: (routeId: NavigationRouteId) => void;

  private loadedClient: GatewayBrowserClient | null = null;
  private loadedAtMs = 0;
  private dismissedScope: string | null = null;
  private idleRefreshTimer: ReturnType<typeof globalThis.setInterval> | null = null;

  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.gateway,
    (gateway) => {
      this.synchronize(gateway);
      return gateway.subscribe(() => this.synchronize(gateway));
    },
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
      this.loadedClient = null;
      this.cronJobs = [];
      this.modelAuthStatus = null;
      return;
    }
    if (snapshot.client === this.loadedClient) {
      return;
    }
    this.loadedClient = snapshot.client;
    void this.load(gateway, snapshot.client);
  }

  private async load(gateway: ApplicationContext["gateway"], client: GatewayBrowserClient) {
    const isCurrent = () =>
      this.isConnected &&
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

  override render() {
    if (!this.context?.gateway.snapshot.connected) {
      return nothing;
    }
    const items = buildSidebarAttentionItems({
      cronJobs: this.cronJobs,
      modelAuthStatus: this.modelAuthStatus,
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
              <button
                type="button"
                class="sidebar-attention__open"
                title=${item.label}
                @click=${() => this.onNavigate?.(item.routeId)}
              >
                <span class="sidebar-attention__icon" aria-hidden="true">${icons[item.icon]}</span>
                <span class="sidebar-attention__label">${item.label}</span>
              </button>
              <button
                type="button"
                class="sidebar-attention__dismiss"
                title=${t("common.dismiss")}
                aria-label=${t("common.dismiss")}
                @click=${() => this.dismiss(item)}
              >
                ${icons.x}
              </button>
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
