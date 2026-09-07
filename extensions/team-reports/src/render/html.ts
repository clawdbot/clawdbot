import { DAY_MS } from "../periods.js";
import type { PersonDay, PeriodListEntry } from "../store.js";
import type { Period, Person, ReportDocument, SummaryDocument } from "../types.js";
import {
  countDescription,
  escapeHtml,
  ITEM_LABELS,
  memberSummary,
  renderAvatar,
  safeExternalUrl,
} from "./shared.js";
import { REPORT_STYLES } from "./styles.js";

export type PageContext = {
  basePath: string;
  nonce: string;
  absoluteUrl: string;
  displayTimezone: string;
};
export type PeriodIndex = Record<Period, PeriodListEntry[]>;
type TrendDay = { key: string; github: number; discord: number };

function href(basePath: string, ...segments: string[]): string {
  return `${basePath}/${segments.map(encodeURIComponent).join("/")}/`;
}

function date(value: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(value);
}

function externalLink(url: string, label: string): string {
  const safe = safeExternalUrl(url);
  return safe
    ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`
    : escapeHtml(label);
}

function markdownBlocks(value: string): string {
  return value
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.split("\n");
      const inline = (line: string) =>
        escapeHtml(line).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      if (lines.every((line) => /^\s*[-*] /.test(line))) {
        return `<ul>${lines.map((line) => `<li>${inline(line.replace(/^\s*[-*] /, ""))}</li>`).join("")}</ul>`;
      }
      return `<p>${lines.map(inline).join("<br>")}</p>`;
    })
    .join("");
}

function shell(ctx: PageContext, title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Team Reports</title><style nonce="${escapeHtml(ctx.nonce)}">${REPORT_STYLES}</style></head><body class="oc-app-surface"><header class="oc-app-surface report-toolbar"><div class="report-toolbar-inner"><nav aria-label="Main"><a class="brand" href="${escapeHtml(ctx.basePath)}/">Team Reports</a><a class="oc-action oc-action-ghost" href="${escapeHtml(ctx.basePath)}/people/">People</a><a class="oc-action oc-action-ghost" href="${escapeHtml(ctx.basePath)}/latest/">Latest closed day</a></nav><a class="oc-action oc-action-ghost" href="${escapeHtml(ctx.absoluteUrl)}" target="_blank" rel="noopener">Open in a new window</a></div></header><main>${body}</main><footer>Report windows use UTC. Generation times are shown in ${escapeHtml(ctx.displayTimezone)}. Links may not open inside the Control UI frame.</footer></body></html>`;
}

function renderTrend(days: TrendDay[]): string {
  if (days.length === 0) {
    return '<p class="muted">No stored daily activity yet.</p>';
  }
  const maximum = Math.max(1, ...days.flatMap((day) => [day.github, day.discord]));
  const timestamps = days.map((day) => Date.parse(`${day.key}T00:00:00Z`));
  const startMs = timestamps[0] ?? 0;
  const spanMs = Math.max(DAY_MS, (timestamps.at(-1) ?? startMs) - startMs);
  const x = (index: number) => 42 + (((timestamps[index] ?? startMs) - startMs) / spanMs) * 696;
  const y = (value: number) => 152 - (value / maximum) * 128;
  const line = (kind: "github" | "discord") => {
    const path = days
      .map((day, index) => {
        const previous = timestamps[index - 1];
        const connected = previous !== undefined && (timestamps[index] ?? 0) - previous === DAY_MS;
        return `${connected ? "L" : "M"}${x(index).toFixed(1)},${y(day[kind]).toFixed(1)}`;
      })
      .join(" ");
    return `<path class="oc-sparkline-line ${kind}-line" d="${path}"/>${days.map((day, index) => `<circle class="oc-sparkline-line ${kind}-line" cx="${x(index).toFixed(1)}" cy="${y(day[kind]).toFixed(1)}" r="2"/>`).join("")}`;
  };
  return `<div class="chart"><svg class="oc-sparkline" viewBox="0 0 780 185" role="img" aria-label="Daily GitHub events and Discord messages; shared scale zero to ${maximum}"><title>GitHub events and Discord messages per stored day</title><line class="chart-axis" x1="42" y1="152" x2="738" y2="152"/><text class="chart-label" x="4" y="28">${maximum}</text><text class="chart-label" x="20" y="156">0</text>${line("github")}${line("discord")}<text class="chart-label" x="42" y="178">${escapeHtml(days[0]?.key ?? "")}</text><text class="chart-label" x="738" y="178" text-anchor="end">${escapeHtml(days.at(-1)?.key ?? "")}</text></svg><div class="legend"><span class="github-key">GitHub events</span><span class="discord-key">Discord messages</span></div></div>`;
}

function statusBadge(status: ReportDocument["status"]): string {
  return `<span class="oc-badge oc-badge-${status === "closed" ? "success" : "warning"}">${escapeHtml(status)}</span>`;
}

function pills(person: Pick<Person, "affiliation" | "roleLabel" | "roleGroup">): string {
  return [person.affiliation, person.roleLabel ?? person.roleGroup]
    .filter((value): value is string => Boolean(value))
    .map((value) => `<span class="oc-pill">${escapeHtml(value)}</span>`)
    .join("");
}

function banner(tone: "warning" | "info" | "neutral", content: string): string {
  return `<div class="oc-banner oc-banner-${tone}"><span class="oc-banner-indicator" aria-hidden="true"></span><div class="oc-banner-content">${content}</div></div>`;
}

function sectionHeading(title: string): string {
  return `<div class="oc-section-header"><h2 class="oc-section-title">${escapeHtml(title)}</h2></div>`;
}

function history(ctx: PageContext, entries: PeriodListEntry[]): string {
  if (entries.length === 0) {
    return '<p class="muted">No reports generated yet.</p>';
  }
  return `<ul class="oc-resource-list">${entries.map((entry) => `<li class="oc-resource-list-item"><a class="oc-resource-list-link" href="${escapeHtml(href(ctx.basePath, entry.period, entry.key))}"><span class="oc-resource-list-title">${escapeHtml(entry.key)}</span>${statusBadge(entry.status)}</a></li>`).join("")}</ul>`;
}

export function renderIndexPage(
  ctx: PageContext,
  index: PeriodIndex,
  days: ReportDocument[],
): string {
  const periods: Period[] = ["day", "week", "month"];
  const cards = periods
    .map((period) => {
      const entry = index[period][0];
      return `<div class="oc-card"><div class="stat-heading"><h3>Latest ${period}</h3>${entry ? statusBadge(entry.status) : ""}</div>${entry ? `<a class="stat-date" href="${escapeHtml(href(ctx.basePath, period, entry.key))}">${escapeHtml(entry.key)}</a><p class="details">Generated ${escapeHtml(date(entry.generatedAtMs, ctx.displayTimezone))}</p>` : '<p class="muted">No reports yet.</p>'}</div>`;
    })
    .join("");
  return shell(
    ctx,
    "Overview",
    `<section class="oc-section"><div class="oc-section-header"><div class="oc-section-heading"><p class="oc-eyebrow">Team activity</p><h1 class="oc-section-title">Overview</h1><p class="oc-section-copy">GitHub contributions and Discord discussion, by day, week, and month.</p></div></div><div class="stats">${cards}</div></section><section class="oc-section">${sectionHeading("Daily activity · last 28 days")}${renderTrend(days.map((day) => ({ key: day.period.key, github: day.totals.github.total, discord: day.totals.discord.messages })))}<p class="details">Only stored days are shown. Missing days are not counted as zero activity.</p></section><section class="oc-section">${sectionHeading("Report history")}<div class="history-columns">${periods.map((period) => `<div><h3>${period === "day" ? "Days" : period === "week" ? "Weeks" : "Months"}</h3>${history(ctx, index[period])}</div>`).join("")}</div></section><div class="actions"><a class="oc-action oc-action-ghost" href="${escapeHtml(ctx.basePath)}/index.json">Machine-readable index</a><a class="oc-action oc-action-ghost" href="${escapeHtml(ctx.basePath)}/status">Generation status</a></div>`,
  );
}

export function renderReportPage(
  ctx: PageContext,
  report: ReportDocument,
  summary: SummaryDocument | null,
): string {
  const path = href(ctx.basePath, report.period.period, report.period.key);
  const warnings = [...report.sources.github.warnings, ...(report.sources.discord?.warnings ?? [])];
  if (!report.sources.github.ok || report.sources.github.stale) {
    warnings.unshift("GitHub coverage is incomplete. Counts may be lower than actual activity.");
  }
  if (report.sources.discord && (!report.sources.discord.ok || report.sources.discord.stale)) {
    warnings.push("Discord coverage is incomplete. Counts may be lower than actual activity.");
  }
  if (report.truncated) {
    warnings.push("Item lists were truncated; aggregate counts are preserved.");
  }
  const summaryNotices = (summary?.warnings ?? [])
    .map((warning) => banner("warning", `<p>${escapeHtml(warning)}</p>`))
    .join("");
  const notices = [
    report.status === "partial"
      ? banner(
          "warning",
          "<p>This period is still open. Activity and summaries may change as new reports are generated.</p>",
        )
      : "",
    !summary || summary.source === "fallback"
      ? banner(
          "info",
          "<p>Deterministic summary: model summaries are disabled, pending, or unavailable.</p>",
        )
      : "",
    warnings.length
      ? banner(
          "warning",
          `<h2 class="oc-banner-title">Coverage notes</h2><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`,
        )
      : "",
  ].join("");
  const members = report.members
    .map(
      (member) =>
        `<li class="member">${renderAvatar(member.login, member.display, "md")}<article class="member-content"><div class="identity-line"><h3><a href="${escapeHtml(href(ctx.basePath, "people", member.login))}">${escapeHtml(member.display)}</a></h3><span class="muted">@${escapeHtml(member.login)}</span>${pills(member)}</div><p class="details">${escapeHtml(countDescription(member.github))} · ${member.discord.total} Discord messages</p><p>${escapeHtml(memberSummary(member))}</p>${member.areas.length ? `<p class="details">Areas: ${member.areas.map(escapeHtml).join(", ")}</p>` : ""}${member.access.length ? `<p class="details">Access: ${member.access.map(escapeHtml).join(", ")}</p>` : ""}${member.github.items.length ? `<details><summary>${member.github.items.length} GitHub items</summary><ul class="oc-resource-list member-items">${member.github.items.map((item) => `<li class="oc-resource-list-item resource-row"><span class="oc-resource-list-meta">${ITEM_LABELS[item.kind]} · ${escapeHtml(item.repo)}</span> — ${externalLink(item.url, item.title)}</li>`).join("")}</ul></details>` : ""}${member.discord.excerpts.length ? `<details><summary>Discord excerpts</summary>${member.discord.excerpts.map((excerpt) => `<blockquote><small>#${escapeHtml(excerpt.channel)} · ${escapeHtml(date(excerpt.atMs, ctx.displayTimezone))}</small><br>${escapeHtml(excerpt.excerpt)}</blockquote>`).join("")}</details>` : ""}</article></li>`,
    )
    .join("");
  const other = report.otherActors.length
    ? `<section class="oc-section">${sectionHeading("Other GitHub actors")}<p class="details">Activity by accounts outside the current roster.</p><ul class="oc-resource-list">${report.otherActors.map((actor) => `<li class="oc-resource-list-item resource-row"><span class="person-identity">${renderAvatar(actor.login, actor.login, "xs")}<span class="oc-resource-list-title">@${escapeHtml(actor.login)}</span></span><span class="oc-resource-list-meta">${actor.github.total} GitHub events</span></li>`).join("")}</ul></section>`
    : "";
  const unmatched = report.unmatchedDiscord.length
    ? `<section class="oc-section">${sectionHeading("Unmatched Discord authors")}<p class="muted">These messages count toward Discord totals. No message content is included.</p><ul class="muted">${report.unmatchedDiscord.map((actor) => `<li>${escapeHtml(actor.authorId)}: ${actor.messages} messages</li>`).join("")}</ul></section>`
    : "";
  const periodLabel = { day: "Day", week: "Week", month: "Month" }[report.period.period];
  return shell(
    ctx,
    report.period.title,
    `<section class="oc-section"><div class="oc-section-header"><div class="oc-section-heading"><p class="oc-eyebrow">${periodLabel} · ${escapeHtml(report.orgs.join(", "))}</p><div class="identity-line"><h1 class="oc-section-title">${escapeHtml(report.period.title)}</h1>${statusBadge(report.status)}</div><p class="details">Generated ${escapeHtml(date(report.generatedAtMs, ctx.displayTimezone))}</p><p class="details">UTC window: ${escapeHtml(new Date(report.period.sinceMs).toISOString())} – ${escapeHtml(new Date(report.period.untilMs).toISOString())} (exclusive)</p></div><div class="actions"><a class="oc-action oc-action-ghost" href="${escapeHtml(path)}report.md">Markdown</a><a class="oc-action oc-action-ghost" href="${escapeHtml(path)}data.json">JSON</a></div></div><div class="stats"><div class="oc-card"><strong class="stat-value">${report.totals.github.total}</strong><span class="details">GitHub events</span></div><div class="oc-card"><strong class="stat-value">${report.totals.discord.messages}</strong><span class="details">Discord messages</span></div><div class="oc-card"><strong class="stat-value">${report.activeMembers} / ${report.memberCount}</strong><span class="details">Active members</span></div></div></section>${notices ? `<div class="notices">${notices}</div>` : ""}${summary ? `<section class="oc-section prose">${sectionHeading("Summary")}${summaryNotices ? `<div class="notices">${summaryNotices}</div>` : ""}${markdownBlocks(summary.globalSummary)}<h3>Highlights</h3><ul>${summary.highlights.map((highlight) => `<li>${escapeHtml(highlight)}</li>`).join("")}</ul></section>` : ""}<section class="oc-section">${sectionHeading("Members")}${members ? `<ul class="member-list">${members}</ul>` : "<p>No members are configured for this period.</p>"}</section>${other}${unmatched}`,
  );
}

export function renderPeoplePage(ctx: PageContext, people: Person[]): string {
  const rows = people
    .map((person) => {
      const login = person.github[0] ?? "";
      const display = person.display ?? login;
      const path = escapeHtml(href(ctx.basePath, "people", login));
      return `<tr><td><a class="person-identity" href="${path}">${renderAvatar(login, display, "md")}<span>${escapeHtml(display)}</span></a></td><td>@${escapeHtml(login)}</td><td>${escapeHtml(person.affiliation ?? "—")}</td><td>${escapeHtml(person.roleLabel ?? person.roleGroup ?? "—")}</td><td><span class="oc-badge oc-badge-${person.status === "archived" ? "neutral" : "success"}">${person.status === "archived" ? "Archived" : "Active"}</span></td><td><a href="${path}" aria-label="History for ${escapeHtml(display)}">History</a></td></tr>`;
    })
    .join("");
  return shell(
    ctx,
    "People",
    `<section class="oc-section"><div class="oc-section-header"><div class="oc-section-heading"><p class="oc-eyebrow">Team activity</p><h1 class="oc-section-title">People</h1><p class="oc-section-copy">Current roster and archived members with retained history.</p></div></div><div class="oc-table-wrap" tabindex="0" role="region" aria-label="People"><table class="oc-table"><thead><tr><th scope="col">Person</th><th scope="col">Login</th><th scope="col">Affiliation</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">History</th></tr></thead><tbody>${rows}</tbody></table></div></section>`,
  );
}

export function renderPersonPage(ctx: PageContext, person: Person, days: PersonDay[]): string {
  const login = person.github[0] ?? "";
  const trend = days
    .toSorted((a, b) => a.dayKey.localeCompare(b.dayKey))
    .map((day) => ({ key: day.dayKey, github: day.githubTotal, discord: day.discordMessages }));
  return shell(
    ctx,
    person.display ?? login,
    `<section class="oc-section"><div class="oc-section-header"><div class="person-identity">${renderAvatar(login, person.display ?? login, "xl")}<div class="person-heading"><h1 class="oc-section-title">${escapeHtml(person.display ?? login)}</h1><span class="muted">@${escapeHtml(login)}</span><div class="pills">${pills(person)}</div></div></div></div>${person.github.length > 1 ? `<p class="details">Aliases: ${person.github.slice(1).map(escapeHtml).join(", ")}</p>` : ""}</section>${person.status === "archived" ? banner("neutral", `<p>Archived${person.archivedAt ? ` on ${escapeHtml(person.archivedAt)}` : ""}. Historical reports remain available.</p>`) : ""}<section class="oc-section">${sectionHeading("Daily activity")}${renderTrend(trend)}</section><section class="oc-section">${sectionHeading("Last 28 days with retained history")}${days.length ? `<div class="oc-table-wrap" tabindex="0" role="region" aria-label="Daily activity history"><table class="oc-table"><thead><tr><th scope="col">UTC day</th><th scope="col" class="number">GitHub events</th><th scope="col" class="number">Commits</th><th scope="col" class="number">PRs merged</th><th scope="col" class="number">Discord messages</th></tr></thead><tbody>${days.map((day) => `<tr><td><a href="${escapeHtml(href(ctx.basePath, "day", day.dayKey))}">${escapeHtml(day.dayKey)}</a></td><td class="number">${day.githubTotal}</td><td class="number">${day.commits}</td><td class="number">${day.prsMerged}</td><td class="number">${day.discordMessages}</td></tr>`).join("")}</tbody></table></div>` : "<p>No stored daily reports for this person yet.</p>"}</section>`,
  );
}
