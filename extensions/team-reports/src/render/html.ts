import { DAY_MS } from "../periods.js";
import type { TeamReportsHealth } from "../scheduler.js";
import type { PeriodListEntry } from "../store.js";
import type { Period, ReportDocument, SummaryDocument } from "../types.js";
import { deltaMarkup, sparklineSvg } from "./charts.js";
import {
  banner,
  formatWindow,
  href,
  isOpen,
  openPeriodStatus,
  periodTitle,
  relativeTime,
  shell,
  sourceBanners,
  type PageContext,
} from "./page.js";
import { escapeHtml } from "./shared.js";

export { renderPeoplePage, renderPersonPage } from "./people.js";
export { renderReportPage } from "./report.js";
export type { PageContext } from "./page.js";
export type PeriodIndex = Record<Period, PeriodListEntry[]>;
type OverviewOptions = {
  orgs: string[];
  latest?: { report: ReportDocument; summary: SummaryDocument | null };
  health: TeamReportsHealth;
};
const PERIODS: Period[] = ["day", "week", "month"];
const SERIES_LENGTH = { day: 28, week: 12, month: 6 };
const combined = (entry: PeriodListEntry) => entry.githubTotal + entry.discordMessages;
const number = (value: number) => value.toLocaleString("en-US");

function completenessBadge(ctx: PageContext, entry: PeriodListEntry): string {
  if (entry.status !== "partial") {
    return "";
  }
  if ((ctx.nowMs ?? Date.now()) >= entry.untilMs) {
    return '<span class="oc-badge oc-badge-warning partial-report-badge">Incomplete</span>';
  }
  return entry.period === "day" && isOpen(ctx, entry) && entry.generatedAtMs < entry.untilMs
    ? '<span class="oc-badge oc-badge-info partial-report-badge">Intraday</span>'
    : "";
}

function quickTrend(ctx: PageContext, index: PeriodIndex, entry: PeriodListEntry): string {
  const ascending = index[entry.period]
    .filter((candidate) => candidate.key <= entry.key)
    .toSorted((a, b) => a.key.localeCompare(b.key));
  const values = ascending.slice(-SERIES_LENGTH[entry.period]).map(combined);
  const previous = ascending.at(-2);
  let comparison = previous ? combined(previous) : undefined;
  let label = `prev ${entry.period}`;
  if (
    previous &&
    entry.period !== "day" &&
    isOpen(ctx, entry) &&
    entry.generatedAtMs < entry.untilMs
  ) {
    // Compare an aggregate's own snapshot against equally many prior stored days.
    const elapsedDays = Math.max(1, Math.ceil((entry.generatedAtMs - entry.sinceMs) / DAY_MS));
    const priorDays = index.day
      .filter((day) => day.sinceMs >= previous.sinceMs && day.sinceMs < previous.untilMs)
      .toSorted((a, b) => a.key.localeCompare(b.key))
      .slice(0, elapsedDays);
    if (priorDays.length === elapsedDays) {
      comparison = priorDays.reduce((sum, day) => sum + combined(day), 0);
      label += " to date";
    }
  }
  return `<span class="quick-trend">${deltaMarkup(combined(entry), comparison, label)}${sparklineSvg(values, `Combined activity, last ${values.length} ${entry.period}s`)}</span>`;
}
function quickCard(ctx: PageContext, index: PeriodIndex, period: Period): string {
  const entry = index[period][0];
  if (!entry) {
    return `<section class="quick-card oc-card"><span class="oc-eyebrow">${period}</span><span class="quick-title">No ${period} reports yet</span><p class="oc-empty">Generate a report to see activity.</p></section>`;
  }
  const open = isOpen(ctx, entry);
  return `<a class="quick-card oc-card oc-card-interactive${entry.status === "partial" ? " partial" : ""}" href="${escapeHtml(href(ctx.basePath, period, entry.key))}"><span class="oc-eyebrow">${open && period === "day" ? "today" : period}</span><span class="quick-title">${escapeHtml(periodTitle(entry))} ${completenessBadge(ctx, entry)}</span><span class="quick-meta">${escapeHtml(formatWindow(entry))}<br>${entry.activeMembers}/${entry.memberCount} active · ${number(entry.githubTotal)} GitHub · ${number(entry.discordMessages)} Discord</span>${openPeriodStatus(ctx, entry)}${quickTrend(ctx, index, entry)}</a>`;
}
function history(ctx: PageContext, entries: PeriodListEntry[], period: Period): string {
  const visible = period === "day" ? 7 : 12;
  const slots = period === "month" ? 6 : 12;
  const ascending = entries.toSorted((a, b) => a.key.localeCompare(b.key));
  const rows = entries
    .map((entry, index) => {
      const position = ascending.findIndex((candidate) => candidate.key === entry.key);
      const window = ascending.slice(Math.max(0, position - slots + 1), position + 1);
      const values = [...Array<number>(slots - window.length).fill(0), ...window.map(combined)];
      const trend =
        window.length >= 2 ? sparklineSvg(values, `Combined activity through ${entry.key}`) : "";
      const subline =
        period === "day"
          ? new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(
              entry.sinceMs,
            )
          : formatWindow(entry);
      return `<a class="row" href="${escapeHtml(href(ctx.basePath, period, entry.key))}"${index >= visible ? " data-extra hidden" : ""}><span><span class="row-title-line"><span class="title">${escapeHtml(periodTitle(entry))}</span>${completenessBadge(ctx, entry)}</span><br><span class="date">${escapeHtml(subline)}</span></span><span class="row-trend" aria-hidden="true">${trend}</span><span class="stats"><strong>${entry.activeMembers}/${entry.memberCount}</strong> active<br>${number(entry.githubTotal)} GitHub / ${number(entry.discordMessages)} Discord</span></a>`;
    })
    .join("");
  return `<section class="oc-section" id="${period}"><div class="oc-section-header"><div><div class="oc-eyebrow">${period}</div><h2>${period[0]?.toUpperCase()}${period.slice(1)} History</h2></div>${entries.length > visible ? `<button class="toggle oc-action oc-action-ghost js-only" type="button" data-toggle="${period}" aria-expanded="false">Show all ${entries.length}</button>` : ""}</div><div class="list" data-list="${period}">${rows || `<p class="oc-empty">No ${period} reports yet.</p>`}</div></section>`;
}
function homeMetric(label: string, value: string | number): string {
  return `<div class="oc-summary-metric"><div class="oc-summary-metric-copy"><small>${escapeHtml(label)}</small><strong>${value}</strong></div></div>`;
}
export function renderIndexPage(
  ctx: PageContext,
  index: PeriodIndex,
  options: OverviewOptions,
): string {
  const days = index.day.toSorted((a, b) => a.key.localeCompare(b.key));
  const latestDay = index.day[0];
  const generated = Math.max(
    0,
    ...PERIODS.flatMap((period) => index[period].map((entry) => entry.generatedAtMs)),
  );
  const orgs = options.orgs.join(", ");
  const dateline =
    days.length >= 2
      ? `<section class="home-dateline" aria-label="Activity dateline"><div class="oc-eyebrow">dateline</div>${sparklineSvg(days.map(combined), `Combined GitHub and Discord activity across ${days.length} report days`, true)}<div class="home-dateline-scale"><span>${escapeHtml(days[0]?.key ?? "")}</span><span>${days.length} report days</span><span>${escapeHtml(days.at(-1)?.key ?? "")}</span></div></section>`
      : "";
  const open = PERIODS.filter((period) => index[period][0] && isOpen(ctx, index[period][0]));
  const openBanner = open.length
    ? banner(
        "info",
        `<strong class="oc-banner-title">Open reporting windows</strong><p>The current UTC ${open.join(", ")} ${open.length === 1 ? "remains" : "remain"} open. ${open.length === 1 ? "Its total is a snapshot" : "Their totals are snapshots"} and update as new activity arrives.</p>`,
      )
    : "";
  const health = options.health;
  const lastRun = health.lastRun
    ? `<span class="oc-badge oc-badge-${health.lastRun.status === "ok" ? "success" : "warning"}">${health.lastRun.status}</span> ${relativeTime(ctx, health.lastRun.finishedAtMs)}`
    : "—";
  return shell(
    ctx,
    "Overview",
    `<div class="home-grid" aria-label="Report overview"><section class="oc-brand-banner home-banner" data-asset="crab" data-anchor="top" data-effect="fade" data-size="hero"><div class="oc-brand-banner-art" aria-hidden="true"><img src="${escapeHtml(ctx.basePath)}/assets/crab.avif" alt="" draggable="false"></div><div class="oc-brand-banner-content"><p class="oc-eyebrow">${escapeHtml(orgs)} · team</p><h1>Team Reports</h1><p>Daily, weekly, and monthly GitHub and Discord activity for ${escapeHtml(orgs)}. Access is enforced by the Gateway; history is stored by the plugin.</p></div><div class="home-banner-stamp">generated ${generated ? relativeTime(ctx, generated) : "—"}</div></section>${dateline}${openBanner}${options.latest ? sourceBanners(options.latest.report, options.latest.summary) : ""}${PERIODS.map((period) => quickCard(ctx, index, period)).join("")}<section class="home-card people-teaser oc-card"><div class="home-card-top"><div><div class="oc-eyebrow">people</div><h2>People Archive</h2><p>Activity timelines and repository history by team member.</p></div><div class="home-actions-row"><a class="panel-link oc-action" href="${escapeHtml(ctx.basePath)}/people/">Open people archive <span aria-hidden="true">→</span></a></div></div><div class="oc-summary-strip">${homeMetric("People", latestDay?.memberCount ?? 0)}${homeMetric("Active today", latestDay?.activeMembers ?? 0)}${homeMetric("Report days", days.length)}</div></section><section class="home-card generation-panel oc-card"><div class="home-card-top"><div><div class="oc-eyebrow">runs</div><h2>Generation Status</h2><p>Scheduler and source health.</p></div><div class="home-actions-row"><a class="panel-link oc-action" href="${escapeHtml(ctx.basePath)}/status">Open status JSON <span aria-hidden="true">→</span></a></div></div><div class="oc-summary-strip">${homeMetric("Last run", lastRun)}${homeMetric("Next due", health.nextDueMs === undefined ? "—" : relativeTime(ctx, health.nextDueMs))}${homeMetric("Source warnings", health.warnings)}</div></section></div><div class="grid">${PERIODS.map((period) => history(ctx, index[period], period)).join("")}</div>`,
    "home",
  );
}
