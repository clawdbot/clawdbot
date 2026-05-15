import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { t } from "../../i18n/index.ts";
import { formatCost, formatTokens, formatRelativeTimestamp } from "../format.ts";
import { isMonitoredAuthProvider } from "../model-auth-helpers.ts";
import { formatNextRun } from "../presenter.ts";
import { resolveSessionDisplayName } from "../session-display.ts";
import type {
  SessionsUsageResult,
  SessionsListResult,
  SkillStatusReport,
  CronJob,
  CronStatus,
  ModelAuthStatusResult,
} from "../types.ts";

export type OverviewCardsProps = {
  usageResult: SessionsUsageResult | null;
  sessionsResult: SessionsListResult | null;
  skillsReport: SkillStatusReport | null;
  cronJobs: CronJob[];
  cronStatus: CronStatus | null;
  modelAuthStatus: ModelAuthStatusResult | null;
  presenceCount: number;
  onNavigate: (tab: string) => void;
};

const DIGIT_RUN = /\d{3,}/g;

function blurDigits(value: string): TemplateResult {
  const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const blurred = escaped.replace(DIGIT_RUN, (m) => `<span class="blur-digits">${m}</span>`);
  return html`${unsafeHTML(blurred)}`;
}

type StatCard = {
  kind: string;
  tab: string;
  label: string;
  value: string | TemplateResult;
  hint: string | TemplateResult;
};

function renderStatCard(card: StatCard, onNavigate: (tab: string) => void) {
  return html`
    <button class="ov-card" data-kind=${card.kind} @click=${() => onNavigate(card.tab)}>
      <span class="ov-card__label">${card.label}</span>
      <span class="ov-card__value">${card.value}</span>
      <span class="ov-card__hint">${card.hint}</span>
    </button>
  `;
}

function renderSkeletonCards() {
  // Render 4 skeletons — matching the always-present cards (cost, sessions,
  // skills, cron). The Model Auth card is conditional on OAuth providers
  // existing, so rendering it in the skeleton would cause a layout shift
  // when real data arrives for a setup without OAuth. Accept a brief empty
  // slot instead for setups that DO have OAuth.
  return html`
    <section class="ov-cards">
      ${[0, 1, 2, 3].map(
        (i) => html`
          <div class="ov-card" style="cursor:default;animation-delay:${i * 50}ms">
            <span class="skeleton skeleton-line" style="width:60px;height:10px"></span>
            <span class="skeleton skeleton-stat"></span>
            <span class="skeleton skeleton-line skeleton-line--medium" style="height:12px"></span>
          </div>
        `,
      )}
    </section>
  `;
}

export function renderOverviewCards(props: OverviewCardsProps) {
  const dataLoaded =
    props.usageResult != null || props.sessionsResult != null || props.skillsReport != null;
  if (!dataLoaded) {
    return renderSkeletonCards();
  }

  const totals = props.usageResult?.totals;
  const totalCost = formatCost(totals?.totalCost);
  const totalTokens = formatTokens(totals?.totalTokens);
  const totalMessages = totals ? String(props.usageResult?.aggregates?.messages?.total ?? 0) : "0";
  const sessionCount = props.sessionsResult?.count ?? null;

  const skills = props.skillsReport?.skills ?? [];
  const enabledSkills = skills.filter((s) => !s.disabled).length;
  const blockedSkills = skills.filter((s) => s.blockedByAllowlist).length;
  const totalSkills = skills.length;

  const cronEnabled = props.cronStatus?.enabled ?? null;
  const cronNext = props.cronStatus?.nextWakeAtMs ?? null;
  const cronJobCount = props.cronJobs.length;
  const failedCronCount = props.cronJobs.filter((j) => j.state?.lastStatus === "error").length;

  const cronValue =
    cronEnabled == null
      ? t("common.na")
      : cronEnabled
        ? `${cronJobCount} jobs`
        : t("common.disabled");

  const cronHint =
    failedCronCount > 0
      ? html`<span class="danger">${failedCronCount} failed</span>`
      : cronNext
        ? t("overview.stats.cronNext", { time: formatNextRun(cronNext) })
        : "";

  const cards: StatCard[] = [
    {
      kind: "cost",
      tab: "usage",
      label: t("overview.cards.cost"),
      value: totalCost,
      hint: `${totalTokens} tokens · ${totalMessages} msgs`,
    },
    {
      kind: "sessions",
      tab: "sessions",
      label: t("overview.stats.sessions"),
      value: String(sessionCount ?? t("common.na")),
      hint: t("overview.stats.sessionsHint"),
    },
    {
      kind: "skills",
      tab: "skills",
      label: t("overview.cards.skills"),
      value: `${enabledSkills}/${totalSkills}`,
      hint: blockedSkills > 0 ? `${blockedSkills} blocked` : `${enabledSkills} active`,
    },
    {
      kind: "cron",
      tab: "cron",
      label: t("overview.stats.cron"),
      value: cronValue,
      hint: cronHint,
    },
  ];

  // Model auth card — show providers whose auth needs monitoring.
  // See isMonitoredAuthProvider for the exact predicate.
  //
  // Rendered while loading (modelAuthStatus === null) so the card slot stays
  // in the grid instead of snapping in on data arrival, matching the cron
  // card's N/A-placeholder pattern. Still hidden entirely for api-key-only
  // setups post-load (nothing to monitor), which accepts a one-time hide
  // rather than the recurring load-time layout shift.
  const authLoading = props.modelAuthStatus === null;
  const authProviders = props.modelAuthStatus?.providers ?? [];
  const monitoredProviders = authProviders.filter(isMonitoredAuthProvider);
  if (authLoading) {
    cards.push({
      kind: "auth",
      tab: "overview",
      label: t("overview.cards.modelAuth"),
      value: t("common.na"),
      hint: "",
    });
  } else if (monitoredProviders.length > 0) {
    const expired = monitoredProviders.filter(
      (p) => p.status === "expired" || p.status === "missing",
    ).length;
    const expiring = monitoredProviders.filter((p) => p.status === "expiring").length;
    const authValue =
      expired > 0
        ? html`<span class="danger"
            >${t("overview.cards.modelAuthExpired", { count: String(expired) })}</span
          >`
        : expiring > 0
          ? html`<span class="warn"
              >${t("overview.cards.modelAuthExpiring", { count: String(expiring) })}</span
            >`
          : t("overview.cards.modelAuthOk", { count: String(monitoredProviders.length) });

    // Format a window reset time compactly (e.g. "2:43 PM", "Apr 16").
    // Hidden for windows with plenty of headroom to keep the hint readable;
    // shown when a window is below 25% to signal urgency.
    const formatReset = (resetAt: number | undefined, pctLeft: number): string | null => {
      if (!resetAt || !Number.isFinite(resetAt) || pctLeft >= 25) {
        return null;
      }
      const d = new Date(resetAt);
      if (Number.isNaN(d.getTime())) {
        return null;
      }
      const withinADay = resetAt - Date.now() < 24 * 60 * 60 * 1000;
      return withinADay
        ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
        : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    };

    const hintParts = monitoredProviders
      .map((p) => {
        const bits: string[] = [];
        for (const w of p.usage?.windows ?? []) {
          // Clamp to [0, 100] — providers can report usedPercent > 100 when
          // fully exhausted, which would render as "-5% left" without this.
          const pctLeft = Math.max(0, Math.min(100, Math.round(100 - w.usedPercent)));
          const label = (w.label || "").trim();
          const prefix = label ? `${label} ` : "";
          const pctStr = t("overview.cards.modelAuthUsageLeft", { pct: String(pctLeft) });
          const resetStr = formatReset(w.resetAt, pctLeft);
          bits.push(resetStr ? `${prefix}${pctStr} (${resetStr})` : `${prefix}${pctStr}`);
        }
        if (
          p.expiry &&
          Number.isFinite(p.expiry.at) &&
          p.status !== "static" &&
          p.expiry.label &&
          p.expiry.label !== "unknown"
        ) {
          bits.push(t("overview.cards.modelAuthExpiresIn", { when: p.expiry.label }));
        }
        return bits.length > 0 ? `${p.displayName}: ${bits.join(", ")}` : null;
      })
      .filter((s): s is string => s !== null)
      .slice(0, 2);
    const authHint =
      hintParts.join(" · ") ||
      t("overview.cards.modelAuthProviders", { count: String(monitoredProviders.length) });

    cards.push({
      kind: "auth",
      tab: "overview",
      label: t("overview.cards.modelAuth"),
      value: authValue,
      hint: authHint,
    });
  }

  const sessions = props.sessionsResult?.sessions.slice(0, 5) ?? [];

  return html`
    <section class="ov-cards">${cards.map((c) => renderStatCard(c, props.onNavigate))}</section>

    ${sessions.length > 0
      ? html`
          <section class="ov-recent">
            <h3 class="ov-recent__title">${t("overview.cards.recentSessions")}</h3>
            <ul class="ov-recent__list">
              ${sessions.map(
                (s) => html`
                  <li class="ov-recent__row">
                    <span class="ov-recent__key"
                      >${blurDigits(resolveSessionDisplayName(s.key, s))}</span
                    >
                    <span class="ov-recent__model">${s.model ?? ""}</span>
                    <span class="ov-recent__time"
                      >${s.updatedAt ? formatRelativeTimestamp(s.updatedAt) : ""}</span
                    >
                  </li>
                `,
              )}
            </ul>
          </section>
        `
      : nothing}
  `;
}
