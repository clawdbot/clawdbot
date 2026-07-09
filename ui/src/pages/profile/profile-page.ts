import { consume } from "@lit/context";
import { html, LitElement, nothing, svg } from "lit";
import { state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CostUsageSummary, SessionsUsageResult } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { icons } from "../../components/icons.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { resolveAgentAvatarUrl, resolveAssistantTextAvatar } from "../../lib/avatar.ts";
import { formatCost } from "../../lib/format.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import { buildSessionUsageDateParams } from "../../lib/sessions/index.ts";
import {
  buildHeatmap,
  buildInsights,
  computeStreaks,
  firstActiveDate,
  formatLongDuration,
  formatTokenScale,
  localDateString,
  peakDay,
  type ProfileHeatmap,
  type ProfileInsights,
} from "./stats.ts";

const HEATMAP_CELL = 11;
const HEATMAP_GAP = 3;
const HEATMAP_PITCH = HEATMAP_CELL + HEATMAP_GAP;
const HEATMAP_LEFT = 30;
const HEATMAP_TOP = 18;

const CACHE_SETTLE_POLL_MS = 5000;
const CACHE_SETTLE_SLOW_POLL_MS = 60_000;
const MAX_FAST_SETTLE_POLLS = 24;

// Fixed reference week (2024-01-01 is a Monday) for localized weekday labels.
const WEEKDAY_LABEL_ROWS = [
  { row: 1, utcDay: Date.UTC(2024, 0, 1) },
  { row: 3, utcDay: Date.UTC(2024, 0, 3) },
  { row: 5, utcDay: Date.UTC(2024, 0, 5) },
];

function integerFormat(): Intl.NumberFormat {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
}

function formatMonthYear(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

function formatFullDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

function streakLabel(days: number): string {
  return t(days === 1 ? "profilePage.streakDay" : "profilePage.streakDays", {
    count: integerFormat().format(days),
  });
}

function toErrorMessage(error: unknown): string {
  if (isMissingOperatorReadScopeError(error)) {
    return formatMissingOperatorReadScopeMessage("usage");
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return typeof error === "string" ? error : "request failed";
}

class ProfilePage extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @consume({ context: applicationContext, subscribe: false })
  private context!: ApplicationContext;

  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private costSummary: CostUsageSummary | null = null;
  @state() private sessionsResult: SessionsUsageResult | null = null;

  private client: GatewayBrowserClient | null = null;
  private connected = false;
  private requestId = 0;
  private refreshTimer: number | null = null;
  private refreshAttempts = 0;
  private subscriptions: Array<() => void> = [];

  override connectedCallback() {
    super.connectedCallback();
    this.subscriptions = [
      this.context.gateway.subscribe((snapshot) => this.applyGatewaySnapshot(snapshot)),
      this.context.agents.subscribe(() => this.requestUpdate()),
      this.context.agentIdentity.subscribe(() => this.requestUpdate()),
    ];
    this.applyGatewaySnapshot(this.context.gateway.snapshot);
  }

  override disconnectedCallback() {
    for (const unsubscribe of this.subscriptions) {
      unsubscribe();
    }
    this.subscriptions = [];
    this.requestId += 1;
    this.clearRefreshTimer();
    this.refreshAttempts = 0;
    this.client = null;
    this.connected = false;
    super.disconnectedCallback();
  }

  private applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const clientChanged = snapshot.client !== this.client;
    const becameConnected = snapshot.connected && !this.connected;
    this.client = snapshot.client;
    this.connected = snapshot.connected;
    if (clientChanged) {
      // Never keep one gateway's stats on screen while another gateway loads
      // (or fails to load); the render branches key off costSummary presence.
      this.clearRefreshTimer();
      this.refreshAttempts = 0;
      this.costSummary = null;
      this.sessionsResult = null;
      this.error = null;
    }
    if (!snapshot.connected || !snapshot.client) {
      this.requestId += 1;
      this.clearRefreshTimer();
      this.loading = false;
      return;
    }
    void this.context.agents.ensureList().then((list) => {
      if (list) {
        void this.context.agentIdentity.ensure([list.defaultId]);
      }
    });
    if (clientChanged || becameConnected || (!this.costSummary && !this.loading && !this.error)) {
      void this.loadProfile();
    }
  }

  private async loadProfile() {
    const client = this.client;
    if (!client || !this.connected) {
      return;
    }
    const requestId = ++this.requestId;
    this.loading = true;
    this.error = null;
    // Day buckets use the browser's current fixed UTC offset — the same "local"
    // semantics as the Usage page. Midnight-adjacent history from the opposite
    // DST season can land on a neighboring day; DST-aware bucketing needs an
    // IANA-timezone protocol parameter (tracked as a usage-wide follow-up).
    const dateParams = buildSessionUsageDateParams("local");
    try {
      const [costSummary, sessionsResult] = await Promise.all([
        // agentScope "all" keeps token stats consistent with the all-agent insights.
        client.request<CostUsageSummary>("usage.cost", {
          range: "all",
          agentScope: "all",
          ...dateParams,
        }),
        client
          .request<SessionsUsageResult>("sessions.usage", {
            range: "all",
            agentScope: "all",
            // Instance rows keep durations per transcript; family rollups would
            // merge resets and inflate "Longest session" to the family lifespan.
            groupBy: "instance",
            limit: 1000,
            ...dateParams,
          })
          .catch(() => null),
      ]);
      if (requestId !== this.requestId) {
        return;
      }
      this.costSummary = costSummary;
      this.sessionsResult = sessionsResult;
      this.scheduleCacheSettleRefresh();
    } catch (error) {
      if (requestId !== this.requestId) {
        return;
      }
      this.error = toErrorMessage(error);
    } finally {
      if (requestId === this.requestId) {
        this.loading = false;
      }
    }
  }

  /**
   * usage.cost/sessions.usage answer immediately from the persisted cache and
   * rebuild in the background ("refreshing"/"partial"). Poll until the cache
   * settles so a cold start converges instead of freezing first-load numbers.
   */
  private isCacheSettling(): boolean {
    return [this.costSummary?.cacheStatus?.status, this.sessionsResult?.cacheStatus?.status].some(
      (status) => status === "refreshing" || status === "partial",
    );
  }

  private scheduleCacheSettleRefresh() {
    this.clearRefreshTimer();
    if (!this.isCacheSettling()) {
      this.refreshAttempts = 0;
      return;
    }
    // Large cold rebuilds can take many minutes; back off to a slow poll
    // instead of stopping, so the page converges rather than freezing a
    // partial snapshot as final.
    const interval =
      this.refreshAttempts < MAX_FAST_SETTLE_POLLS
        ? CACHE_SETTLE_POLL_MS
        : CACHE_SETTLE_SLOW_POLL_MS;
    this.refreshAttempts += 1;
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.loadProfile();
    }, interval);
  }

  private clearRefreshTimer() {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private featuredAgent() {
    const list = this.context.agents.state.agentsList;
    const agentId = list?.defaultId ?? "main";
    const row = list?.agents.find((agent) => agent.id === agentId) ?? { id: agentId };
    const identity = this.context.agentIdentity.get(agentId);
    const avatarUrl = resolveAgentAvatarUrl(row, identity);
    const textAvatar =
      resolveAssistantTextAvatar(identity?.avatar) ??
      resolveAssistantTextAvatar(row.identity?.emoji) ??
      resolveAssistantTextAvatar(row.identity?.avatar);
    const name =
      identity?.name?.trim() || row.identity?.name?.trim() || row.name?.trim() || agentId;
    return { agentId, name, avatarUrl, textAvatar };
  }

  private renderAvatar(avatarUrl: string | null, textAvatar: string | null, name: string) {
    if (avatarUrl) {
      return html`<img class="profile-hero__avatar-image" src=${avatarUrl} alt=${name} />`;
    }
    if (textAvatar) {
      return html`<span class="profile-hero__avatar-text">${textAvatar}</span>`;
    }
    return html`<span class="profile-hero__avatar-mascot" aria-hidden="true"
      >${icons.lobster}</span
    >`;
  }

  private renderHero(insights: ProfileInsights | null) {
    const { agentId, name, avatarUrl, textAvatar } = this.featuredAgent();
    const since = this.costSummary ? firstActiveDate(this.costSummary.daily) : null;
    const channels = insights?.topChannels ?? [];
    return html`
      <section class="profile-hero card">
        <div class="profile-hero__avatar">${this.renderAvatar(avatarUrl, textAvatar, name)}</div>
        <div class="profile-hero__name">${name}</div>
        <div class="profile-hero__handle">
          <span>@${agentId}</span>
          <span class="profile-hero__badge">OpenClaw</span>
        </div>
        <div class="profile-hero__chips">
          ${since
            ? html`<span class="profile-hero__chip">
                ${t("profilePage.sinceChip", { date: formatMonthYear(since) })}
              </span>`
            : nothing}
          ${channels.map(
            (entry) => html`
              <span
                class="profile-hero__chip profile-hero__chip--channel"
                title=${t("profilePage.channelChipTitle", {
                  tokens: formatTokenScale(entry.tokens),
                })}
              >
                ${entry.channel}
              </span>
            `,
          )}
        </div>
      </section>
    `;
  }

  private renderStats(insights: ProfileInsights | null) {
    const summary = this.costSummary;
    if (!summary) {
      return nothing;
    }
    const today = localDateString();
    const streaks = computeStreaks(summary.daily, today);
    const peak = peakDay(summary.daily);
    const cells: Array<{ label: string; value: string; sub?: string }> = [
      {
        label: t("profilePage.statLifetimeTokens"),
        value: formatTokenScale(summary.totals.totalTokens),
        sub: summary.totals.totalCost > 0 ? `≈ ${formatCost(summary.totals.totalCost)}` : undefined,
      },
      {
        label: t("profilePage.statPeakDay"),
        value: formatTokenScale(peak?.totalTokens ?? 0),
        sub: peak ? formatFullDate(peak.date) : undefined,
      },
      {
        label: t("profilePage.statLongestSession"),
        value:
          insights?.longestSessionMs != null ? formatLongDuration(insights.longestSessionMs) : "—",
      },
      { label: t("profilePage.statCurrentStreak"), value: streakLabel(streaks.current) },
      { label: t("profilePage.statLongestStreak"), value: streakLabel(streaks.longest) },
    ];
    return html`
      <section class="profile-stats">
        ${cells.map(
          (cell) => html`
            <div class="stat profile-stats__cell">
              <div class="stat-value">${cell.value}</div>
              <div class="stat-label">${cell.label}</div>
              ${cell.sub ? html`<div class="profile-stats__sub">${cell.sub}</div>` : nothing}
            </div>
          `,
        )}
      </section>
    `;
  }

  private renderHeatmapSvg(heatmap: ProfileHeatmap) {
    const weekCount = heatmap.weeks.length;
    const width = HEATMAP_LEFT + weekCount * HEATMAP_PITCH;
    const height = HEATMAP_TOP + 7 * HEATMAP_PITCH;
    const numberFormat = integerFormat();
    const weekdayFormat = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      timeZone: "UTC",
    });
    return html`
      <div class="profile-heatmap__scroll">
        <svg
          class="profile-heatmap__svg"
          width=${width}
          height=${height}
          viewBox="0 0 ${width} ${height}"
          role="img"
          aria-label=${t("profilePage.heatmapTitle")}
        >
          ${heatmap.monthLabels.map((label, index) =>
            label
              ? svg`<text class="profile-heatmap__month" x=${HEATMAP_LEFT + index * HEATMAP_PITCH} y="10">${label}</text>`
              : nothing,
          )}
          ${WEEKDAY_LABEL_ROWS.map(
            ({ row, utcDay }) =>
              svg`<text class="profile-heatmap__weekday" x=${HEATMAP_LEFT - 6} y=${HEATMAP_TOP + row * HEATMAP_PITCH + HEATMAP_CELL - 2}>${weekdayFormat.format(new Date(utcDay))}</text>`,
          )}
          ${heatmap.weeks.map((week, weekIndex) =>
            week.days.map((day, dayIndex) => {
              if (!day) {
                return nothing;
              }
              const tooltip = `${formatFullDate(day.date)} · ${t("profilePage.heatmapCellTokens", {
                tokens: numberFormat.format(day.tokens),
              })}`;
              return svg`
                <rect
                  class="profile-heatmap__cell profile-heatmap__cell--l${day.level}"
                  x=${HEATMAP_LEFT + weekIndex * HEATMAP_PITCH}
                  y=${HEATMAP_TOP + dayIndex * HEATMAP_PITCH}
                  width=${HEATMAP_CELL}
                  height=${HEATMAP_CELL}
                  rx="2.5"
                ><title>${tooltip}</title></rect>
              `;
            }),
          )}
        </svg>
      </div>
    `;
  }

  private renderHeatmap() {
    const summary = this.costSummary;
    if (!summary) {
      return nothing;
    }
    const heatmap = buildHeatmap(summary.daily, localDateString());
    return html`
      <section class="card profile-heatmap">
        <div class="profile-heatmap__header">
          <div>
            <div class="card-title">${t("profilePage.heatmapTitle")}</div>
            <div class="card-sub">${t("profilePage.heatmapSub")}</div>
          </div>
          <div class="profile-heatmap__legend" aria-hidden="true">
            <span>${t("profilePage.legendLess")}</span>
            ${[0, 1, 2, 3, 4].map(
              (level) =>
                html`<span
                  class="profile-heatmap__swatch profile-heatmap__cell--l${level}"
                ></span>`,
            )}
            <span>${t("profilePage.legendMore")}</span>
          </div>
        </div>
        ${this.renderHeatmapSvg(heatmap)}
      </section>
    `;
  }

  private renderInsights(insights: ProfileInsights | null) {
    if (!insights) {
      return nothing;
    }
    const numberFormat = integerFormat();
    const rows: Array<{ label: string; value: string }> = [
      { label: t("profilePage.insightModel"), value: insights.topModel ?? "—" },
      { label: t("profilePage.insightMessages"), value: numberFormat.format(insights.messages) },
      { label: t("profilePage.insightToolCalls"), value: numberFormat.format(insights.toolCalls) },
      {
        label: t("profilePage.insightUniqueTools"),
        value: numberFormat.format(insights.uniqueTools),
      },
      { label: t("profilePage.insightAgents"), value: numberFormat.format(insights.agents) },
      {
        label: t("profilePage.insightSessions"),
        value: insights.sessionsCapped
          ? t("profilePage.sessionsCapped", { count: numberFormat.format(insights.sessions) })
          : numberFormat.format(insights.sessions),
      },
    ];
    const maxToolCount = insights.topTools[0]?.count ?? 0;
    return html`
      <section class="profile-columns">
        <div class="card profile-insights">
          <div class="card-title">${t("profilePage.insightsTitle")}</div>
          <div class="profile-insights__rows">
            ${rows.map(
              (row) => html`
                <div class="profile-insights__row">
                  <span class="profile-insights__label">${row.label}</span>
                  <span class="profile-insights__value">${row.value}</span>
                </div>
              `,
            )}
          </div>
        </div>
        <div class="card profile-tools">
          <div class="card-title">${t("profilePage.toolsTitle")}</div>
          ${insights.topTools.length === 0
            ? html`<div class="profile-tools__empty">${t("profilePage.toolsEmpty")}</div>`
            : html`
                <div class="profile-tools__rows">
                  ${insights.topTools.map(
                    (tool) => html`
                      <div class="profile-tools__row">
                        <span class="profile-tools__name">${tool.name}</span>
                        <span class="profile-tools__bar" aria-hidden="true">
                          <span
                            class="profile-tools__bar-fill"
                            style="width: ${maxToolCount > 0
                              ? Math.max(4, Math.round((tool.count / maxToolCount) * 100))
                              : 0}%"
                          ></span>
                        </span>
                        <span class="profile-tools__count">
                          ${t(tool.count === 1 ? "profilePage.toolRun" : "profilePage.toolRuns", {
                            count: integerFormat().format(tool.count),
                          })}
                        </span>
                      </div>
                    `,
                  )}
                </div>
              `}
        </div>
      </section>
    `;
  }

  private renderBody() {
    if (!this.connected || !this.client) {
      return html`<div class="card profile-note">${t("profilePage.offline")}</div>`;
    }
    if (this.loading && !this.costSummary) {
      return html`<div class="card profile-note">${t("profilePage.loading")}</div>`;
    }
    if (this.error && !this.costSummary) {
      return html`<div class="card profile-note profile-note--error">${this.error}</div>`;
    }
    const insights = this.sessionsResult ? buildInsights(this.sessionsResult) : null;
    const hasActivity = (this.costSummary?.totals.totalTokens ?? 0) > 0;
    // A cold usage cache legitimately reports zero while it rebuilds; the
    // settle poll keeps retrying, so the loading note stays truthful until
    // real data or a genuinely fresh shell arrives.
    const emptyState = this.isCacheSettling()
      ? html`<div class="card profile-note">${t("profilePage.loading")}</div>`
      : html`
          <div class="card profile-note">
            <div class="card-title">${t("profilePage.emptyTitle")}</div>
            <div class="card-sub">${t("profilePage.emptyBody")}</div>
          </div>
        `;
    return html`
      <div class="profile-page">
        ${this.renderHero(insights)}
        ${hasActivity
          ? html`${this.renderStats(insights)} ${this.renderHeatmap()}
            ${this.renderInsights(insights)}`
          : emptyState}
      </div>
    `;
  }

  override render() {
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("profile")}</div>
          <div class="page-sub">${subtitleForRoute("profile")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(this.renderBody())}
    `;
  }
}

customElements.define("openclaw-profile-page", ProfilePage);
