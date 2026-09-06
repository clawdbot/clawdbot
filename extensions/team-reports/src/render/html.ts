import type { PersonDay, PeriodListEntry } from "../store.js";
import type { Period, Person, ReportDocument, SummaryDocument } from "../types.js";
import {
  countDescription,
  escapeHtml,
  ITEM_LABELS,
  memberSummary,
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Team Reports</title><style nonce="${escapeHtml(ctx.nonce)}">${REPORT_STYLES}</style></head><body><header><nav aria-label="Main"><a class="brand" href="${escapeHtml(ctx.basePath)}/">Team Reports</a><a href="${escapeHtml(ctx.basePath)}/people/">People</a><a href="${escapeHtml(ctx.basePath)}/latest/">Latest closed day</a></nav><a href="${escapeHtml(ctx.absoluteUrl)}" target="_blank" rel="noopener">Open in a new window</a></header><main>${body}</main><footer>Report windows use UTC. Generation times are shown in ${escapeHtml(ctx.displayTimezone)}. Links may not open inside the Control UI frame.</footer></body></html>`;
}

function renderTrend(days: TrendDay[]): string {
  if (days.length === 0) {
    return '<p class="muted">No stored daily activity yet.</p>';
  }
  const maximum = Math.max(1, ...days.flatMap((day) => [day.github, day.discord]));
  const timestamps = days.map((day) => Date.parse(`${day.key}T00:00:00Z`));
  const startMs = timestamps[0] ?? 0;
  const spanMs = Math.max(86_400_000, (timestamps.at(-1) ?? startMs) - startMs);
  const x = (index: number) => 42 + (((timestamps[index] ?? startMs) - startMs) / spanMs) * 696;
  const y = (value: number) => 152 - (value / maximum) * 128;
  const line = (kind: "github" | "discord") => {
    const path = days
      .map((day, index) => {
        const previous = timestamps[index - 1];
        const connected =
          previous !== undefined && (timestamps[index] ?? 0) - previous === 86_400_000;
        return `${connected ? "L" : "M"}${x(index).toFixed(1)},${y(day[kind]).toFixed(1)}`;
      })
      .join(" ");
    return `<path class="${kind}-line" d="${path}"/>${days.map((day, index) => `<circle class="${kind}-line" cx="${x(index).toFixed(1)}" cy="${y(day[kind]).toFixed(1)}" r="2"/>`).join("")}`;
  };
  return `<div class="chart"><svg viewBox="0 0 780 185" role="img" aria-label="Daily GitHub events and Discord messages; shared scale zero to ${maximum}"><title>GitHub events and Discord messages per stored day</title><line class="chart-axis" x1="42" y1="152" x2="738" y2="152"/><text class="chart-label" x="4" y="28">${maximum}</text><text class="chart-label" x="20" y="156">0</text>${line("github")}${line("discord")}<text class="chart-label" x="42" y="178">${escapeHtml(days[0]?.key ?? "")}</text><text class="chart-label" x="738" y="178" text-anchor="end">${escapeHtml(days.at(-1)?.key ?? "")}</text></svg><div class="legend"><span class="github-key">GitHub events</span><span class="discord-key">Discord messages</span></div></div>`;
}

function history(ctx: PageContext, entries: PeriodListEntry[]): string {
  if (entries.length === 0) {
    return '<p class="muted">No reports generated yet.</p>';
  }
  return `<ul>${entries.map((entry) => `<li><a href="${escapeHtml(href(ctx.basePath, entry.period, entry.key))}">${escapeHtml(entry.key)}</a> <span class="badge">${entry.status}</span></li>`).join("")}</ul>`;
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
      return `<section class="card"><h3>Latest ${period}</h3>${entry ? `<a href="${escapeHtml(href(ctx.basePath, period, entry.key))}">${escapeHtml(entry.key)}</a> <span class="badge">${entry.status}</span><p class="muted">Generated ${escapeHtml(date(entry.generatedAtMs, ctx.displayTimezone))}</p>` : "<p>No reports yet.</p>"}</section>`;
    })
    .join("");
  return shell(
    ctx,
    "Overview",
    `<h1>Team activity</h1><p class="muted">GitHub contributions and Discord discussion, by day, week, and month.</p><div class="cards">${cards}</div><h2>Daily activity · last 28 days</h2>${renderTrend(days.map((day) => ({ key: day.period.key, github: day.totals.github.total, discord: day.totals.discord.messages })))}<p class="muted">Only stored days are shown. Missing days are not counted as zero activity.</p><h2>Report history</h2><div class="cards">${periods.map((period) => `<section class="card"><h3>${period === "day" ? "Days" : period === "week" ? "Weeks" : "Months"}</h3>${history(ctx, index[period])}</section>`).join("")}</div><p><a href="${escapeHtml(ctx.basePath)}/index.json">Machine-readable index</a> · <a href="${escapeHtml(ctx.basePath)}/status">Generation status</a></p>`,
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
  const notices = `${report.status === "partial" ? '<p class="notice">This period is still open. Activity and summaries may change as new reports are generated.</p>' : ""}${!summary || summary.source === "fallback" ? '<p class="notice">Deterministic summary: model summaries are disabled, pending, or unavailable.</p>' : ""}${warnings.length ? `<section class="notice"><h2>Coverage notes</h2><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></section>` : ""}`;
  const members = report.members
    .map(
      (member) =>
        `<article><h3><a href="${escapeHtml(href(ctx.basePath, "people", member.login))}">${escapeHtml(member.display)}</a> <small>@${escapeHtml(member.login)}</small></h3>${
          [member.affiliation, member.roleLabel ?? member.roleGroup].filter(Boolean).length
            ? `<p class="muted">${[member.affiliation, member.roleLabel ?? member.roleGroup]
                .filter((value): value is string => Boolean(value))
                .map(escapeHtml)
                .join(" · ")}</p>`
            : ""
        }<p>${escapeHtml(memberSummary(member))}</p><p class="details">${escapeHtml(countDescription(member.github))} · ${member.discord.total} Discord messages</p>${member.areas.length ? `<p class="details">Areas: ${member.areas.map(escapeHtml).join(", ")}</p>` : ""}${member.access.length ? `<p class="details">Access: ${member.access.map(escapeHtml).join(", ")}</p>` : ""}${member.github.items.length ? `<details><summary>${member.github.items.length} GitHub items</summary><ul>${member.github.items.map((item) => `<li><span class="muted">${ITEM_LABELS[item.kind]} · ${escapeHtml(item.repo)}</span> — ${externalLink(item.url, item.title)}</li>`).join("")}</ul></details>` : ""}${member.discord.excerpts.length ? `<details><summary>Discord excerpts</summary>${member.discord.excerpts.map((excerpt) => `<blockquote><small>#${escapeHtml(excerpt.channel)} · ${escapeHtml(date(excerpt.atMs, ctx.displayTimezone))}</small><br>${escapeHtml(excerpt.excerpt)}</blockquote>`).join("")}</details>` : ""}</article>`,
    )
    .join("");
  const other = report.otherActors.length
    ? `<h2>Other GitHub actors</h2><p class="muted">Activity by accounts outside the current roster.</p><ul>${report.otherActors.map((actor) => `<li>${escapeHtml(actor.login)}: ${actor.github.total} GitHub events</li>`).join("")}</ul>`
    : "";
  const unmatched = report.unmatchedDiscord.length
    ? `<h2>Unmatched Discord authors</h2><p class="muted">These messages count toward Discord totals. No message content is included.</p><ul>${report.unmatchedDiscord.map((actor) => `<li>${escapeHtml(actor.authorId)}: ${actor.messages} messages</li>`).join("")}</ul>`
    : "";
  return shell(
    ctx,
    report.period.title,
    `<h1>${escapeHtml(report.period.title)} <span class="badge">${report.status}</span></h1><p class="muted">${escapeHtml(report.orgs.join(", "))} · Generated ${escapeHtml(date(report.generatedAtMs, ctx.displayTimezone))}</p><p class="details">UTC window: ${escapeHtml(new Date(report.period.sinceMs).toISOString())} – ${escapeHtml(new Date(report.period.untilMs).toISOString())} (exclusive)</p><p><a href="${escapeHtml(path)}report.md">Markdown</a> · <a href="${escapeHtml(path)}data.json">JSON</a></p>${notices}<div class="cards"><div class="card"><strong>${report.totals.github.total}</strong>GitHub events</div><div class="card"><strong>${report.totals.discord.messages}</strong>Discord messages</div><div class="card"><strong>${report.activeMembers} / ${report.memberCount}</strong>Active members</div></div>${summary ? `<section><h2>Summary</h2>${markdownBlocks(summary.globalSummary)}<h2>Highlights</h2><ul>${summary.highlights.map((highlight) => `<li>${escapeHtml(highlight)}</li>`).join("")}</ul></section>` : ""}<h2>Members</h2>${members || "<p>No members are configured for this period.</p>"}${other}${unmatched}`,
  );
}

export function renderPeoplePage(ctx: PageContext, people: Person[]): string {
  return shell(
    ctx,
    "People",
    `<h1>People</h1><p class="muted">Current roster and archived members with retained history.</p><div class="table-wrap"><table><thead><tr><th>Person</th><th>Role</th><th>Status</th></tr></thead><tbody>${people.map((person) => `<tr><td><a href="${escapeHtml(href(ctx.basePath, "people", person.github[0] ?? ""))}">${escapeHtml(person.display ?? person.github[0] ?? "")}</a>${person.affiliation ? `<br><small>${escapeHtml(person.affiliation)}</small>` : ""}</td><td>${escapeHtml(person.roleLabel ?? person.roleGroup ?? "—")}</td><td>${person.status === "archived" ? "Archived" : "Active"}</td></tr>`).join("")}</tbody></table></div>`,
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
    `<h1>${escapeHtml(person.display ?? login)} <small>@${escapeHtml(login)}</small></h1>${person.status === "archived" ? `<p class="notice">Archived${person.archivedAt ? ` on ${escapeHtml(person.archivedAt)}` : ""}. Historical reports remain available.</p>` : ""}${person.affiliation ? `<p>${escapeHtml(person.affiliation)}</p>` : ""}${person.github.length > 1 ? `<p class="muted">Aliases: ${person.github.slice(1).map(escapeHtml).join(", ")}</p>` : ""}<h2>Daily activity</h2>${renderTrend(trend)}<h2>Last 28 days with retained history</h2>${days.length ? `<div class="table-wrap"><table><thead><tr><th>UTC day</th><th class="number">GitHub events</th><th class="number">Commits</th><th class="number">PRs merged</th><th class="number">Discord messages</th></tr></thead><tbody>${days.map((day) => `<tr><td><a href="${escapeHtml(href(ctx.basePath, "day", day.dayKey))}">${escapeHtml(day.dayKey)}</a></td><td class="number">${day.githubTotal}</td><td class="number">${day.commits}</td><td class="number">${day.prsMerged}</td><td class="number">${day.discordMessages}</td></tr>`).join("")}</tbody></table></div>` : "<p>No stored daily reports for this person yet.</p>"}`,
  );
}
