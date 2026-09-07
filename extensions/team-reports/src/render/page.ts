import type { PeriodDescriptor, Person, ReportDocument, SummaryDocument } from "../types.js";
import { REPORT_SCRIPT } from "./script.js";
import { escapeHtml, safeExternalUrl } from "./shared.js";
import { REPORT_STYLES } from "./styles.js";

export type PageContext = {
  basePath: string;
  nonce: string;
  absoluteUrl: string;
  displayTimezone: string;
  nowMs?: number;
};
type Window = Pick<PeriodDescriptor, "period" | "key" | "sinceMs" | "untilMs">;
type Snapshot = Window & { generatedAtMs: number; status: ReportDocument["status"] };

export function href(basePath: string, ...segments: string[]): string {
  return `${basePath}/${segments.map(encodeURIComponent).join("/")}/`;
}
export function date(value: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(value);
}
export function relativeTime(ctx: PageContext, ms: number): string {
  const exact = escapeHtml(date(ms, ctx.displayTimezone));
  return `<time data-relative-time datetime="${new Date(ms).toISOString()}" title="${exact}">${exact}</time>`;
}
export function periodTitle(entry: Window): string {
  if (entry.period === "week") {
    return `Week ${entry.key.replace(/^\d+-W/, "")}`;
  }
  return new Intl.DateTimeFormat("en-US", {
    month: entry.period === "month" ? "long" : "short",
    ...(entry.period === "day" ? { day: "numeric" } : {}),
    year: "numeric",
    timeZone: "UTC",
  }).format(entry.sinceMs);
}
export function formatWindow(entry: Pick<Window, "sinceMs" | "untilMs">): string {
  const start = new Date(entry.sinceMs);
  const end = new Date(entry.untilMs - 1);
  const day = (value: Date) =>
    new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(value);
  if (start.toISOString().slice(0, 10) === end.toISOString().slice(0, 10)) {
    return day(start);
  }
  if (
    start.getUTCFullYear() === end.getUTCFullYear() &&
    start.getUTCMonth() === end.getUTCMonth()
  ) {
    const monthDay = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(start);
    return `${monthDay}-${end.getUTCDate()}, ${end.getUTCFullYear()}`;
  }
  return `${day(start)}-${day(end)}`;
}
export function isOpen(ctx: PageContext, entry: Pick<Window, "sinceMs" | "untilMs">): boolean {
  const now = ctx.nowMs ?? Date.now();
  return now >= entry.sinceMs && now < entry.untilMs;
}
export function openPeriodStatus(ctx: PageContext, entry: Snapshot): string {
  if (!isOpen(ctx, entry)) {
    return "";
  }
  const minutes = Math.max(1, Math.ceil((entry.untilMs - (ctx.nowMs ?? Date.now())) / 60000));
  const remaining = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  const until = new Date(entry.untilMs).toISOString();
  const asOf = new Date(entry.generatedAtMs).toISOString();
  const label =
    entry.period === "day" ? "Today" : entry.period === "week" ? "Week to date" : "Month to date";
  return `<span class="open-period-status"><span>${label}, as of <time datetime="${asOf}">${asOf.slice(11, 16)} UTC</time> · ${relativeTime(ctx, entry.generatedAtMs)}</span>${entry.period === "day" ? `<span aria-hidden="true">·</span><span data-day-countdown data-until="${until}">closes in ${remaining} (${until.slice(11, 16)} UTC)</span>` : ""}</span>`;
}
export function banner(tone: "warning" | "info" | "neutral", content: string): string {
  return `<section class="oc-banner oc-banner-${tone}"><span class="oc-banner-indicator" aria-hidden="true"></span><div class="oc-banner-content">${content}</div></section>`;
}
export function sourceBanners(report: ReportDocument, summary: SummaryDocument | null): string {
  const banners: string[] = [];
  const source = (title: string, warnings: string[]) =>
    banner(
      "warning",
      `<strong class="oc-banner-title">${title}</strong><p>${warnings.length ? warnings.map(escapeHtml).join(" · ") : "Counts may be lower than actual activity."}</p>`,
    );
  const github = report.sources.github;
  if (!github.ok || github.stale || github.warnings.length) {
    banners.push(
      source(
        !github.ok ? "GitHub sources unavailable" : "GitHub coverage is incomplete",
        github.warnings,
      ),
    );
  }
  const discord = report.sources.discord;
  if (discord && (!discord.ok || discord.stale || discord.warnings.length)) {
    banners.push(source("Discord coverage is incomplete", discord.warnings));
  }
  const warnings = [
    ...(summary?.warnings ?? []),
    ...(report.truncated ? ["Item lists were truncated; aggregate counts are preserved."] : []),
  ];
  if (warnings.length) {
    banners.push(source("Summary and coverage notes", warnings));
  }
  return banners.slice(0, 3).join("");
}
export function sectionHeading(title: string, eyebrow?: string, note?: string): string {
  return `<div class="oc-section-header"><div>${eyebrow ? `<div class="oc-eyebrow">${escapeHtml(eyebrow)}</div>` : ""}<h2>${escapeHtml(title)}</h2></div>${note ? `<span class="section-note">${escapeHtml(note)}</span>` : ""}</div>`;
}
export function affiliation(person: Pick<Person, "affiliation" | "roleGroup">): string {
  const variant =
    person.roleGroup === "readonly"
      ? "is-readonly"
      : person.roleGroup === "volunteer"
        ? "is-na"
        : !person.affiliation || person.affiliation === "Independent"
          ? "is-independent"
          : "";
  return `<span class="affiliation ${variant}">${escapeHtml(person.affiliation || (person.roleGroup === "readonly" ? "Read-only" : person.roleGroup === "volunteer" ? "Volunteer" : "Independent"))}</span>`;
}
export function externalLink(url: string, label: string): string {
  const safe = safeExternalUrl(url);
  return safe
    ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`
    : escapeHtml(label);
}
export function markdownBlocks(value: string): string {
  return value
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.split("\n");
      const inline = (line: string) =>
        escapeHtml(line).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      return lines.every((line) => /^\s*[-*] /.test(line))
        ? `<ul>${lines.map((line) => `<li>${inline(line.replace(/^\s*[-*] /, ""))}</li>`).join("")}</ul>`
        : `<p>${lines.map(inline).join("<br>")}</p>`;
    })
    .join("");
}
export function shell(
  ctx: PageContext,
  title: string,
  body: string,
  page: "home" | "report" | "people" | "person",
): string {
  const active = page === "home" || page === "report" ? "Reports" : "People";
  const links = [
    ["Reports", `${ctx.basePath}/`],
    ["Latest", `${ctx.basePath}/latest/`],
    ["People", `${ctx.basePath}/people/`],
  ]
    .map(
      ([label, url]) =>
        `<a class="oc-segmented-item${label === active ? " is-active" : ""}" href="${escapeHtml(url ?? "")}"${label === active ? ' aria-current="page"' : ""}>${label}</a>`,
    )
    .join("");
  return `<!doctype html><html lang="en" data-report-base-path="${escapeHtml(ctx.basePath)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Team Reports</title><script nonce="${escapeHtml(ctx.nonce)}">${REPORT_SCRIPT}</script><style nonce="${escapeHtml(ctx.nonce)}">${REPORT_STYLES}</style></head><body class="oc-app-surface" data-report-page="${page}"><nav class="site-nav" aria-label="Report navigation"><div class="site-nav-inner"><a class="site-brand" href="${escapeHtml(ctx.basePath)}/"><span class="brand-mark" aria-hidden="true"><img src="${escapeHtml(ctx.basePath)}/assets/icon.png" width="26" height="26" alt=""></span><span>Reports</span></a><div class="site-links oc-segmented">${links}<button class="theme-toggle oc-action oc-action-ghost oc-action-icon" type="button" data-theme-toggle aria-label="Toggle theme" title="Toggle theme"><svg class="theme-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2m-17-7 2 2m12 12 2 2M5 19l2-2M17 7l2-2"/></svg><svg class="theme-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.7 6.7 0 0 0 9.8 9.8Z"/></svg></button><a class="theme-toggle oc-action oc-action-ghost oc-action-icon" href="${escapeHtml(ctx.absoluteUrl)}" target="_blank" rel="noopener" data-report-open-window aria-label="Open in a new window" title="Open in a new window"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7M21 3 10 14M10 3H3v18h18v-7"/></svg></a></div></div></nav><main class="shell">${body}</main><footer>Report windows use UTC. Generation times are shown in ${escapeHtml(ctx.displayTimezone)}. Links may not open inside the Control UI frame.</footer></body></html>`;
}
