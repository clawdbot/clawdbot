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

// A cron job counts as overdue when its next planned run is this far in the
// past; mirrors the threshold the Overview attention list used.
const CRON_OVERDUE_GRACE_MS = 300_000;
// Reloads are connection-scoped; a visibility change only refetches after the
// snapshot is older than this, so tab switches stay free of request bursts.
const VISIBILITY_REFRESH_MIN_AGE_MS = 60_000;
// Always-visible windows (the macOS app) never fire visibilitychange, so a
// slow lifecycle-owned interval keeps the chips from going permanently stale.
const IDLE_REFRESH_INTERVAL_MS = 10 * 60_000;

export type SidebarAttentionItem = {
  severity: "error" | "warning";
  icon: IconName;
  label: string;
  routeId: NavigationRouteId;
};

export function buildSidebarAttentionItems(params: {
  cronJobs: readonly CronJob[];
  modelAuthStatus: ModelAuthStatusResult | null;
  now: number;
}): SidebarAttentionItem[] {
  const items: SidebarAttentionItem[] = [];

  const failedCron = params.cronJobs.filter(isCronJobActiveFailure).length;
  if (failedCron > 0) {
    items.push({
      severity: "error",
      icon: "clock",
      label: t("attention.cronFailed", { count: String(failedCron) }),
      routeId: "cron",
    });
  }
  const overdueCron = params.cronJobs.filter(
    (job) =>
      job.enabled &&
      job.state?.nextRunAtMs != null &&
      params.now - job.state.nextRunAtMs > CRON_OVERDUE_GRACE_MS,
  ).length;
  if (overdueCron > 0) {
    items.push({
      severity: "warning",
      icon: "clock",
      label: t("attention.cronOverdue", { count: String(overdueCron) }),
      routeId: "cron",
    });
  }

  const monitored = (params.modelAuthStatus?.providers ?? []).filter(isMonitoredAuthProvider);
  const expired = monitored.filter(
    (provider) => provider.status === "expired" || provider.status === "missing",
  );
  if (expired.length > 0) {
    items.push({
      severity: "error",
      icon: "plug",
      label: t("attention.modelAuthExpired", {
        providers: expired.map((provider) => provider.displayName).join(", "),
      }),
      routeId: "model-providers",
    });
  }
  const expiring = monitored.filter((provider) => provider.status === "expiring");
  if (expiring.length > 0) {
    items.push({
      severity: "warning",
      icon: "plug",
      label: t("attention.modelAuthExpiring", {
        providers: expiring
          .map((provider) => `${provider.displayName} (${provider.expiry?.label ?? "soon"})`)
          .join(", "),
      }),
      routeId: "model-providers",
    });
  }
  return items;
}

class SidebarAttention extends OpenClawLightDomContentsElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @state() private cronJobs: CronJob[] = [];
  @state() private modelAuthStatus: ModelAuthStatusResult | null = null;

  @property({ attribute: false }) onNavigate?: (routeId: NavigationRouteId) => void;

  private loadedClient: GatewayBrowserClient | null = null;
  private loadedAtMs = 0;
  private idleRefreshTimer: ReturnType<typeof globalThis.setInterval> | null = null;

  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.gateway,
    (gateway) => {
      this.synchronize(gateway);
      return gateway.subscribe(() => this.synchronize(gateway));
    },
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

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.refreshIfStale);
    this.idleRefreshTimer = globalThis.setInterval(this.refreshIfStale, IDLE_REFRESH_INTERVAL_MS);
  }

  override disconnectedCallback() {
    document.removeEventListener("visibilitychange", this.refreshIfStale);
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
    }
  }

  override render() {
    if (!this.context?.gateway.snapshot.connected) {
      return nothing;
    }
    const items = buildSidebarAttentionItems({
      cronJobs: this.cronJobs,
      modelAuthStatus: this.modelAuthStatus,
      now: Date.now(),
    });
    if (items.length === 0) {
      return nothing;
    }
    return html`
      <div class="sidebar-attention" role="status">
        ${items.map(
          (item) => html`
            <button
              type="button"
              class="sidebar-attention__item sidebar-attention__item--${item.severity}"
              title=${item.label}
              @click=${() => this.onNavigate?.(item.routeId)}
            >
              <span class="sidebar-attention__icon" aria-hidden="true">${icons[item.icon]}</span>
              <span class="sidebar-attention__label">${item.label}</span>
            </button>
          `,
        )}
      </div>
    `;
  }
}

if (!customElements.get("openclaw-sidebar-attention")) {
  customElements.define("openclaw-sidebar-attention", SidebarAttention);
}
