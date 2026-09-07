import { DAY_MS } from "../periods.js";
import type { PersonDay } from "../store.js";
import type { Person } from "../types.js";
import { affiliation, href, type PageContext, sectionHeading, shell } from "./page.js";
import { escapeHtml, renderAvatar } from "./shared.js";

function activityLevel(count: number): number {
  if (count <= 0) {
    return 0;
  }
  if (count < 5) {
    return 1;
  }
  if (count < 15) {
    return 2;
  }
  if (count < 40) {
    return 3;
  }
  return 4;
}

function total(day: PersonDay): number {
  return day.githubTotal + day.discordMessages;
}

function dayTitle(key: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(Date.parse(`${key}T00:00:00Z`));
}

function peopleMetric(label: string, value: number | string): string {
  return `<div class="oc-summary-metric"><span class="oc-summary-metric-copy"><small>${escapeHtml(label)}</small><strong>${escapeHtml(String(value))}</strong></span></div>`;
}

function roleBadge(person: Person): string {
  const role = person.roleLabel ?? person.roleGroup;
  return `${role ? `<span class="oc-badge oc-badge-${person.roleGroup === "readonly" ? "neutral" : "info"}">${escapeHtml(role)}</span>` : ""}${person.status === "archived" ? '<span class="oc-badge oc-badge-neutral">Archived</span>' : ""}`;
}

function rankingStats(days: PersonDay[]) {
  return days.reduce(
    (result, day) => ({
      github: result.github + day.githubTotal,
      discord: result.discord + day.discordMessages,
      active: result.active + (total(day) > 0 ? 1 : 0),
    }),
    { github: 0, discord: 0, active: 0 },
  );
}

export function renderPeoplePage(
  ctx: PageContext,
  people: Person[],
  days: PersonDay[] = [],
  endKey?: string,
): string {
  const last =
    endKey ??
    days
      .map((day) => day.dayKey)
      .toSorted()
      .at(-1) ??
    new Date(ctx.nowMs ?? Date.now()).toISOString().slice(0, 10);
  const end = Date.parse(`${last}T00:00:00Z`);
  const keys = Array.from({ length: 28 }, (_, index) =>
    new Date(end - (27 - index) * DAY_MS).toISOString().slice(0, 10),
  );
  const first = keys[0] ?? last;
  const rankedDays = days.filter((day) => day.dayKey >= first && day.dayKey <= last);
  const dayCount = new Set(rankedDays.map((day) => day.dayKey)).size;
  const byLogin = new Map<string, PersonDay[]>();
  for (const day of rankedDays) {
    const login = day.login.toLowerCase();
    const entries = byLogin.get(login) ?? [];
    entries.push(day);
    byLogin.set(login, entries);
  }
  const ranked = people
    .map((person) => {
      const entries = byLogin.get((person.github[0] ?? "").toLowerCase()) ?? [];
      return { person, entries, stats: rankingStats(entries) };
    })
    .toSorted(
      (a, b) =>
        b.stats.github + b.stats.discord - a.stats.github - a.stats.discord ||
        b.stats.active - a.stats.active ||
        (a.person.display ?? a.person.github[0] ?? "").localeCompare(
          b.person.display ?? b.person.github[0] ?? "",
        ),
    );
  const groups = [
    {
      key: "active",
      label: "Active members",
      rows: ranked.filter(
        ({ person, stats }) =>
          person.status !== "archived" && person.roleGroup !== "readonly" && stats.active > 0,
      ),
    },
    {
      key: "quiet",
      label: "No visible activity in the ranking window",
      rows: ranked.filter(
        ({ person, stats }) =>
          person.status !== "archived" && person.roleGroup !== "readonly" && stats.active === 0,
      ),
    },
    {
      key: "readonly",
      label: "Read-only access",
      rows: ranked.filter(
        ({ person }) => person.status !== "archived" && person.roleGroup === "readonly",
      ),
    },
    {
      key: "archived",
      label: "Former members",
      rows: ranked.filter(({ person }) => person.status === "archived"),
    },
  ];
  const cards = groups
    .filter((group) => group.rows.length)
    .map((group) => {
      const heading = `<div class="people-break${group.key === "archived" ? " is-archived" : group.key === "readonly" ? " is-readonly" : ""}" data-people-group="${group.key}"${group.key === "quiet" ? ' data-inactive="true"' : ""}><span>${group.label}</span><span>${group.rows.length} ${group.key === "quiet" ? "quiet" : group.key === "archived" ? "archived" : "people"}</span></div>`;
      return `${heading}${group.rows
        .map(({ person, entries, stats }) => {
          const login = person.github[0] ?? "";
          const display = person.display ?? login;
          const archived = person.status === "archived";
          const inactive = stats.active === 0;
          const points = new Map(entries.map((day) => [day.dayKey, day]));
          const strip = keys
            .map((key) => {
              const point = points.get(key);
              const count = point ? total(point) : 0;
              const title = `${key}: ${point ? `${count} events` : "No stored report"}`;
              return `<span class="day-dot level-${activityLevel(count)}" title="${escapeHtml(title)}"></span>`;
            })
            .join("");
          return `<a class="person-card oc-card oc-card-interactive${inactive ? " is-inactive" : ""}${archived ? " is-archived" : ""}" href="${escapeHtml(href(ctx.basePath, "people", login))}" data-inactive="${inactive && !archived}"><span class="person-card-head">${renderAvatar(login, display, "sm")}<span class="person-card-identity"><strong>${escapeHtml(display)}</strong><span class="person-handle">@${escapeHtml(login)}</span>${affiliation(person)}</span></span><span class="mini-strip mini-strip-combined" aria-label="Activity over 28 UTC days">${strip}</span><span class="person-card-meta">${roleBadge(person)}<span>${stats.github + stats.discord} events · ${stats.github} GitHub · ${stats.discord} Discord</span><span class="person-card-days">${stats.active} out of ${dayCount} days active</span></span></a>`;
        })
        .join("")}`;
    })
    .join("");
  const archived = people.filter((person) => person.status === "archived").length;
  const quiet = groups.find((group) => group.key === "quiet")?.rows.length ?? 0;
  return shell(
    ctx,
    "People",
    `<header class="people-header"><div><div class="oc-eyebrow">people</div><h1>Member Activity Timelines</h1><p>Current members ranked by the last 28 days, with former members retained in the archive. Darker cells mean heavier GitHub or Discord activity. Open a person to explore their daily reports.</p></div><div class="oc-card oc-summary-metric"><span class="oc-summary-metric-copy"><small>Ranking Window</small><strong>28 days</strong><small>${people.length - archived} current, ${quiet} quiet, ${archived} archived · ${dayCount} report days</small></span></div></header><section class="people-toolbar oc-card" aria-label="Timeline display"><label class="source-toggle js-only"><input class="oc-switch" type="checkbox" data-hide-inactive-toggle aria-label="Hide people with zero activity"><span>Hide quiet</span></label><div class="source-key"><span><i class="source-swatch github" aria-hidden="true"></i>GitHub</span><span><i class="source-swatch discord" aria-hidden="true"></i>Discord</span></div></section><section class="people-grid" aria-label="Member timelines">${cards || '<div class="oc-empty"><p class="oc-empty-description">No member activity yet.</p></div>'}</section>`,
    "people",
  );
}

function personActivityChart(login: string, days: PersonDay[]): string {
  const latest = days.at(-1);
  if (!latest) {
    return `<section class="archive-panel person-activity-panel oc-section">${sectionHeading("Last 30 Days", "activity")}<p>No daily report data is available.</p></section>`;
  }
  const end = Date.parse(`${latest.dayKey}T00:00:00Z`);
  const start = end - 29 * DAY_MS;
  const points = days.filter((day) => Date.parse(`${day.dayKey}T00:00:00Z`) >= start);
  const maximum = (field: "githubTotal" | "discordMessages") => {
    const value = Math.max(0, ...points.map((day) => day[field]));
    if (value <= 4) {
      return 4;
    }
    const magnitude = 10 ** Math.floor(Math.log10(value / 4));
    const normalized = value / 4 / magnitude;
    const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
    return Math.ceil(value / step) * step;
  };
  const githubMax = maximum("githubTotal");
  const discordMax = maximum("discordMessages");
  const x = (day: PersonDay) =>
    78 + ((Date.parse(`${day.dayKey}T00:00:00Z`) - start) / (29 * DAY_MS)) * 782;
  const y = (value: number, max: number) => 298 - (value / max) * 234;
  const fixed = (value: number) => value.toFixed(1);
  const series = (field: "githubTotal" | "discordMessages", source: string, max: number) => {
    const path = points
      .map((day, index) => {
        const previous = points[index - 1];
        const connected =
          previous &&
          Date.parse(`${day.dayKey}T00:00:00Z`) - Date.parse(`${previous.dayKey}T00:00:00Z`) ===
            DAY_MS;
        return connected
          ? `H${fixed(x(day))} V${fixed(y(day[field], max))}`
          : `M${fixed(x(day))} ${fixed(y(day[field], max))}`;
      })
      .join(" ");
    return `<path class="person-activity-line person-activity-line-${source}" d="${path}"/>${points.map((day) => `<circle class="person-activity-point person-activity-point-${source}" cx="${fixed(x(day))}" cy="${fixed(y(day[field], max))}" r="2.5"><title>${escapeHtml(`${day.dayKey}: ${day[field]} ${source === "github" ? "GitHub events" : "Discord messages"}`)}</title></circle>`).join("")}`;
  };
  const ticks = Array.from({ length: 5 }, (_, index) => {
    const fraction = index / 4;
    const yy = fixed(y(fraction, 1));
    return `<line class="person-activity-gridline" x1="78" y1="${yy}" x2="860" y2="${yy}"/><text class="person-activity-axis-tick person-activity-axis-tick-left" x="66" y="${fixed(Number(yy) + 4)}">${Math.round(githubMax * fraction)}</text><text class="person-activity-axis-tick person-activity-axis-tick-right" x="872" y="${fixed(Number(yy) + 4)}">${Math.round(discordMax * fraction)}</text>`;
  }).join("");
  const dateTicks = [0, 7, 14, 21, 29]
    .map((offset) => {
      const time = start + offset * DAY_MS;
      const label = new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }).format(time);
      return `<text class="person-activity-axis-tick" x="${fixed(78 + (offset / 29) * 782)}" y="342" text-anchor="${offset === 0 ? "start" : offset === 29 ? "end" : "middle"}">${escapeHtml(label)}</text>`;
    })
    .join("");
  const svg = `<svg class="person-activity-svg" viewBox="0 0 960 360" role="img" aria-label="${escapeHtml(`Daily activity for @${login}: GitHub events on the left axis, Discord messages on the right axis`)}"><title>${escapeHtml(`Last 30 Days for @${login}`)}</title><desc>Only stored daily values are plotted. Gaps indicate missing reports, not zero activity.</desc>${ticks}<path class="person-activity-axis" d="M78 64V298H860V64"/><text class="person-activity-axis-title person-activity-axis-title-github" x="78" y="26">GitHub events · left axis</text><text class="person-activity-axis-title person-activity-axis-title-discord" x="860" y="26" text-anchor="end">Discord messages · right axis</text>${series("githubTotal", "github", githubMax)}${series("discordMessages", "discord", discordMax)}${dateTicks}</svg>`;
  return `<section class="archive-panel person-activity-panel oc-section">${sectionHeading("Last 30 Days", "activity", "Daily GitHub events and report-scoped Discord messages. UTC.")}<ul class="person-activity-legend" aria-label="Chart series and axes"><li><span class="person-activity-swatch is-github" aria-hidden="true"></span>GitHub events · left axis</li><li><span class="person-activity-swatch is-discord" aria-hidden="true"></span>Discord messages · right axis</li></ul><div class="person-activity-chart">${svg}</div><p class="person-activity-quality-note">Only stored days are shown. Missing days are not counted as zero activity.</p><details class="person-activity-values"><summary>Exact daily values</summary><div class="person-activity-table-wrap"><table class="person-activity-table"><thead><tr><th scope="col">UTC day</th><th scope="col">GitHub events</th><th scope="col">Discord messages</th></tr></thead><tbody>${points.map((day) => `<tr><th scope="row"><time datetime="${escapeHtml(day.dayKey)}">${escapeHtml(day.dayKey)}</time></th><td>${day.githubTotal}</td><td>${day.discordMessages}</td></tr>`).join("")}</tbody></table></div></details></section>`;
}

function reportHref(ctx: PageContext, login: string, key: string): string {
  return escapeHtml(`${href(ctx.basePath, "day", key)}?person=${encodeURIComponent(login)}`);
}

function archiveTimeline(ctx: PageContext, login: string, days: PersonDay[]): string {
  const months = new Map<string, PersonDay[]>();
  for (const day of days) {
    const month = day.dayKey.slice(0, 7);
    const entries = months.get(month) ?? [];
    entries.push(day);
    months.set(month, entries);
  }
  return [...months.entries()]
    .toReversed()
    .map(([month, entries]) => {
      const first = new Date(`${month}-01T00:00:00Z`);
      const offset = (first.getUTCDay() + 6) % 7;
      const monthEnd = new Date(first);
      monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
      const length = (monthEnd.getTime() - first.getTime()) / DAY_MS;
      const points = new Map(entries.map((day) => [day.dayKey, day]));
      const cells = Array.from({ length }, (_, index) => {
        const key = `${month}-${String(index + 1).padStart(2, "0")}`;
        const point = points.get(key);
        if (!point) {
          return `<span class="day-cell is-missing" title="${escapeHtml(`${key}: No stored report`)}">${index + 1}</span>`;
        }
        const label = `${key}: ${total(point)} events for @${login}`;
        return `<a class="day-cell level-${activityLevel(total(point))}" href="${reportHref(ctx, login, key)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${index + 1}</a>`;
      }).join("");
      const label = new Intl.DateTimeFormat("en-US", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(first);
      return `<div class="month-row"><div class="month-label">${escapeHtml(label)}</div><div class="calendar"><div class="weekday-row" aria-hidden="true"><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span><span>Su</span></div><div class="day-grid">${Array.from({ length: offset }, () => '<span class="day-spacer" aria-hidden="true"></span>').join("")}${cells}</div></div></div>`;
    })
    .join("");
}

export function renderPersonPage(ctx: PageContext, person: Person, days: PersonDay[]): string {
  const login = person.github[0] ?? "";
  const display = person.display ?? login;
  const ordered = days.toSorted((a, b) => a.dayKey.localeCompare(b.dayKey));
  const active = ordered.filter((day) => total(day) > 0);
  const latest = active.at(-1);
  const sum = (value: (day: PersonDay) => number) =>
    days.reduce((result, day) => result + value(day), 0);
  const totals = [
    peopleMetric(
      "GitHub",
      sum((day) => day.githubTotal),
    ),
    peopleMetric(
      "Comments",
      sum((day) => day.issueComments + day.reviewComments),
    ),
    peopleMetric(
      "Discord",
      sum((day) => day.discordMessages),
    ),
    peopleMetric(
      "Commits",
      sum((day) => day.commits),
    ),
    peopleMetric(
      "PRs",
      sum((day) => day.prsOpened + day.prsMerged + day.prsClosed),
    ),
    peopleMetric(
      "Issues",
      sum((day) => day.issuesOpened + day.issuesClosed),
    ),
  ].join("");
  const lifecycle =
    person.status === "archived"
      ? `<p class="person-lifecycle">Archived${person.archivedAt ? ` on ${escapeHtml(person.archivedAt)}` : ""}. Historical reports remain available.</p>`
      : "";
  const rows = active
    .toReversed()
    .map(
      (day) =>
        `<a class="activity-row" href="${reportHref(ctx, login, day.dayKey)}"><span class="activity-date">${escapeHtml(dayTitle(day.dayKey))}</span><span><strong>${total(day)} events</strong><span>${day.githubTotal} GitHub · ${day.issueComments + day.reviewComments} comments · ${day.discordMessages} Discord · ${day.commits} commits · ${day.prsOpened + day.prsMerged + day.prsClosed} PRs</span></span></a>`,
    )
    .join("");
  return shell(
    ctx,
    display,
    `<header class="people-header"><div class="person-hero">${renderAvatar(login, display, "xl")}<div><div class="breadcrumbs"><a href="${escapeHtml(href(ctx.basePath, "people"))}">People</a><span>/</span><span>@${escapeHtml(login)}</span></div><h1>${escapeHtml(display)}</h1><div class="person-company-line">${affiliation(person)}<span class="person-handle">@${escapeHtml(login)}</span>${roleBadge(person)}</div>${lifecycle}${
      person.github.length > 1
        ? `<p class="alias-line">Aliases: ${person.github
            .slice(1)
            .map((alias) => `@${escapeHtml(alias)}`)
            .join(" · ")}</p>`
        : ""
    }</div></div><div class="oc-card oc-summary-metric"><span class="oc-summary-metric-copy"><small>Active Days</small><strong>${active.length}/${days.length}</strong><small>${latest ? `Latest activity ${escapeHtml(dayTitle(latest.dayKey))}` : "No active days"}</small></span></div></header><section class="oc-summary-strip" aria-label="Member totals over retained days">${totals}</section>${personActivityChart(login, ordered)}<section class="archive-panel oc-section">${sectionHeading("Daily Archive", "timeline")}<div class="legend" aria-label="Activity intensity, low to high"><span class="level-0"></span><span class="level-1"></span><span class="level-2"></span><span class="level-3"></span><span class="level-4"></span></div>${archiveTimeline(ctx, login, ordered) || '<div class="oc-empty"><p class="oc-empty-description">No stored daily reports for this person yet.</p></div>'}</section><section class="archive-panel oc-section">${sectionHeading("Active Days", "history")}<div class="activity-list">${rows || '<p class="muted">No active days recorded.</p>'}</div></section>`,
    "person",
  );
}
