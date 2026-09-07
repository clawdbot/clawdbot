import type { PeriodListEntry } from "../store.js";
import type { GithubCounts, PersonReport, ReportDocument, SummaryDocument } from "../types.js";
import { deltaMarkup, sparklineSvg, splitMarkup } from "./charts.js";
import {
  affiliation,
  banner,
  date,
  externalLink,
  formatWindow,
  href,
  isOpen,
  markdownBlocks,
  openPeriodStatus,
  type PageContext,
  periodTitle,
  relativeTime,
  sectionHeading,
  shell,
  sourceBanners,
} from "./page.js";
import { escapeHtml, ITEM_LABELS, memberSummary, renderAvatar } from "./shared.js";

function activitySegments(github: GithubCounts, discord: number) {
  const prs = github.prsOpened + github.prsMerged + github.prsClosed;
  const issues = github.issuesOpened + github.issuesClosed;
  const comments = github.issueComments + github.reviewComments;
  return [
    { label: "Commits", value: github.commits, tone: "primary" },
    { label: "PRs", value: prs, tone: "secondary" },
    { label: "Issues", value: issues, tone: "tertiary" },
    { label: "Comments", value: comments, tone: "quaternary" },
    { label: "GHSAs", value: github.securityAdvisories, tone: "error" },
    {
      label: "Other GitHub",
      value: Math.max(
        0,
        github.total - github.commits - prs - issues - comments - github.securityAdvisories,
      ),
      tone: "neutral",
    },
    { label: "Discord", value: discord, tone: "muted" },
  ].filter((segment) => segment.value > 0);
}

function metric(label: string, value: string | number, detail = "", trend = ""): string {
  return `<div class="oc-summary-metric"><span class="oc-summary-metric-copy"><small>${escapeHtml(label)}</small><strong>${escapeHtml(String(value))}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}${trend}</span></div>`;
}

function distribution(ctx: PageContext, members: PersonReport[]): string {
  const ranked = members
    .filter((member) => member.github.total + member.discord.total > 0)
    .toSorted(
      (a, b) =>
        b.github.total + b.discord.total - a.github.total - a.discord.total ||
        a.login.localeCompare(b.login),
    );
  const total = ranked.reduce((sum, member) => sum + member.github.total + member.discord.total, 0);
  if (total === 0) {
    return '<div class="oc-empty"><p class="oc-empty-description">No member activity recorded in this window.</p></div>';
  }
  const row = (member: PersonReport) => {
    const value = member.github.total + member.discord.total;
    const segments = activitySegments(member.github, member.discord.total);
    let offset = 0;
    const rectangles = segments
      .map((segment) => {
        const width = (segment.value / total) * 100;
        const rect = `<rect class="distribution-segment oc-split-${segment.tone}" x="${offset.toFixed(3)}" y="0" width="${width.toFixed(3)}" height="8"><title>${escapeHtml(segment.label)}: ${segment.value}</title></rect>`;
        offset += width;
        return rect;
      })
      .join("");
    const breakdown = segments
      .map(
        (segment) =>
          `<span class="distribution-breakdown-item"><span class="distribution-breakdown-key oc-split-${segment.tone}" aria-hidden="true"></span>${escapeHtml(segment.label)} ${segment.value}</span>`,
      )
      .join("");
    return `<li><a href="${escapeHtml(href(ctx.basePath, "people", member.login))}" aria-label="${escapeHtml(`@${member.login}: ${value} activities, ${Math.round((value / total) * 100)}%`)}"><span class="distribution-label"><span class="distribution-label-primary">@${escapeHtml(member.login)}</span><span class="distribution-label-detail">${escapeHtml(member.display)}</span></span><svg class="distribution-track" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(`Activity types for @${member.login}`)}">${rectangles}</svg><strong class="distribution-total">${value}</strong><span class="distribution-share">${Math.round((value / total) * 100)}%</span><span class="distribution-breakdown">${breakdown}</span></a></li>`;
  };
  return `<div class="ranked-distribution" aria-label="Activity by Member"><ol class="ranked-distribution-list">${ranked.slice(0, 12).map(row).join("")}</ol>${ranked.length > 12 ? `<details class="distribution-more"><summary>Show remaining ${ranked.length - 12}</summary><ol class="ranked-distribution-list" start="13">${ranked.slice(12).map(row).join("")}</ol></details>` : ""}</div>`;
}

function roleBadges(member: PersonReport): string {
  const role = member.roleLabel ?? member.roleGroup;
  return `${role ? `<span class="oc-badge oc-badge-${member.roleGroup === "readonly" ? "neutral" : "info"}">${escapeHtml(role)}</span>` : ""}${member.access.map((access) => `<span class="oc-badge oc-badge-neutral">${escapeHtml(access)}</span>`).join("")}`;
}

function searchText(member: PersonReport): string {
  return escapeHtml(
    [member.login, member.display, ...member.aliases, member.affiliation, ...member.areas]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
  );
}

function personRow(ctx: PageContext, member: PersonReport): string {
  const top = (values: Record<string, number>, limit: number) =>
    Object.entries(values)
      .toSorted(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))
      .slice(0, limit);
  const chips = [
    ...top(member.github.repos, 4).map(([repo, count]) => `${repo}: ${count}`),
    ...top(member.discord.channels, 3).map(([channel, count]) => `#${channel}: ${count}`),
    ...member.areas.map((area) => `owns: ${area}`),
  ]
    .map((text) => `<span class="oc-badge oc-badge-neutral">${escapeHtml(text)}</span>`)
    .join("");
  const themes = member.github.items
    .slice(0, 3)
    .map(
      (item) =>
        `<div class="theme"><span class="theme-kind">${ITEM_LABELS[item.kind]}</span> ${externalLink(item.url, item.title)}</div>`,
    )
    .join("");
  const counts: Array<[string, number]> = [
    ["GitHub", member.github.total],
    ["Commits", member.github.commits],
    ["GHSAs", member.github.securityAdvisories],
    ["PRs", member.github.prsOpened + member.github.prsMerged + member.github.prsClosed],
    ["Issues", member.github.issuesOpened + member.github.issuesClosed],
    ["Comments", member.github.issueComments + member.github.reviewComments],
    ["Discord", member.discord.total],
  ];
  const excerpts = member.discord.excerpts.length
    ? `<details><summary>Discord excerpts</summary>${member.discord.excerpts.map((excerpt) => `<blockquote><small>#${escapeHtml(excerpt.channel)} · ${escapeHtml(date(excerpt.atMs, ctx.displayTimezone))}</small><br>${escapeHtml(excerpt.excerpt)}</blockquote>`).join("")}</details>`
    : "";
  const items = member.github.items.length
    ? `<details><summary>${member.github.items.length} GitHub items</summary><ul class="oc-resource-list">${member.github.items.map((item) => `<li class="oc-resource-list-item resource-row"><span class="theme-kind">${ITEM_LABELS[item.kind]} · ${escapeHtml(item.repo)}</span>${externalLink(item.url, item.title)}</li>`).join("")}</ul></details>`
    : "";
  return `<article class="person oc-card" data-maintainer-card data-maintainer-search="${searchText(member)}"><div class="person-title"><div class="person-heading">${renderAvatar(member.login, member.display, "md")}<div><a class="handle" href="${escapeHtml(href(ctx.basePath, "people", member.login))}">@${escapeHtml(member.login)}</a><div class="person-name">${escapeHtml(member.display)}</div>${member.aliases.length ? `<div class="alias-line">${member.aliases.map((alias) => `@${escapeHtml(alias)}`).join(" · ")}</div>` : ""}</div></div>${affiliation(member)}<div class="role-line">${roleBadges(member)}</div></div><div class="person-body"><div class="chips">${chips}</div><p class="focus">${escapeHtml(memberSummary(member))}</p>${themes}${items}${excerpts}</div><div class="person-numbers">${counts.map(([label, count]) => `<div class="number-line"><span>${label}</span><strong>${count}</strong></div>`).join("")}</div></article>`;
}

export function renderReportPage(
  ctx: PageContext,
  report: ReportDocument,
  summary: SummaryDocument | null,
  history: PeriodListEntry[] = [],
): string {
  const entry = { ...report.period, status: report.status, generatedAtMs: report.generatedAtMs };
  const open = isOpen(ctx, entry);
  const period = report.period.period;
  const path = href(ctx.basePath, period, report.period.key);
  const incomplete =
    open || (report.status === "partial" && report.generatedAtMs < report.period.untilMs);
  const partialBanner = incomplete
    ? banner(
        "info",
        `<strong class="oc-banner-title">Partial report</strong><span class="oc-badge oc-badge-info partial-report-badge">Incomplete snapshot</span><p>${open ? `This UTC ${period} is still in progress.` : `This UTC ${period} was still in progress when this snapshot was generated.`} Totals include activity collected through ${relativeTime(ctx, report.generatedAtMs)}. ${open ? "Activity may increase before the window closes." : "The window has since closed, so these totals remain incomplete."}</p>`,
      )
    : "";
  const github = report.totals.github;
  const prior = history
    .filter((row) => row.period === period && row.sinceMs < report.period.sinceMs)
    .toSorted((a, b) => a.sinceMs - b.sinceMs)
    .slice(-({ day: 28, week: 12, month: 6 }[period] - 1));
  const trend = (
    field: "activeMembers" | "githubTotal" | "discordMessages" | "prsOpened" | "securityAdvisories",
    value: number,
    label: string,
    badUp = false,
  ) => {
    const values = [...prior.map((row) => row[field]), value];
    return `<small>${deltaMarkup(value, prior.at(-1)?.[field], `prev ${period}${open ? " (in progress)" : ""}`, badUp)}</small>${sparklineSvg(values, `${label} by ${period}`)}`;
  };
  const active = report.members.filter((member) => member.github.total + member.discord.total > 0);
  const quiet = report.members.filter((member) => member.github.total + member.discord.total === 0);
  const roleCounts = ["core", "volunteer", "readonly"].map(
    (role) => active.filter((member) => member.roleGroup === role).length,
  );
  const repositories =
    Number(report.sources.github.stats.reposScanned) || Object.keys(github.repos).length;
  const channels =
    Number(report.sources.discord?.stats.channelsScanned) ||
    Object.keys(report.totals.discord.channels).length;
  const totals = [
    metric(
      "Active",
      `${report.activeMembers}/${report.memberCount}`,
      roleCounts.some((count) => count > 0)
        ? `${roleCounts[0]} Core / ${roleCounts[1]} Community / ${roleCounts[2]} Read-only`
        : "members with activity",
      trend("activeMembers", report.activeMembers, "Active members"),
    ),
    metric("GitHub", github.total, "events", trend("githubTotal", github.total, "GitHub events")),
    metric(
      "Discord",
      report.totals.discord.messages,
      "messages",
      trend("discordMessages", report.totals.discord.messages, "Discord messages"),
    ),
    metric(
      "PRs Opened",
      github.prsOpened,
      `${github.prsMerged} merged`,
      trend("prsOpened", github.prsOpened, "PRs opened"),
    ),
    metric(
      "Security",
      github.securityAdvisories,
      "advisories",
      trend("securityAdvisories", github.securityAdvisories, "Security advisories", true),
    ),
    metric(
      "Repos",
      Object.entries(github.repos).filter(([, count]) => count > 0).length,
      "active repositories",
    ),
  ].join("");
  const mix = [
    metric("Commits", github.commits),
    metric("GHSAs", github.securityAdvisories),
    metric("Issue/PR comments", github.issueComments),
    metric("PR review comments", github.reviewComments),
    metric("Discord messages", report.totals.discord.messages),
  ].join("");
  const quietBlock = quiet.length
    ? `<div class="quiet-maintainers"><div class="quiet-title"><h3>No visible activity</h3><span class="small">${quiet.length} members</span></div><ul class="quiet-list">${quiet.map((member) => `<li data-maintainer-quiet data-maintainer-search="${searchText(member)}"><a href="${escapeHtml(href(ctx.basePath, "people", member.login))}">@${escapeHtml(member.login)} — ${escapeHtml(member.display)}${member.affiliation ? ` — ${escapeHtml(member.affiliation)}` : ""}</a></li>`).join("")}</ul></div>`
    : "";
  const other = report.otherActors.length
    ? `<section class="oc-section">${sectionHeading("Other GitHub actors", "Outside the roster")}<ul class="oc-resource-list">${report.otherActors.map((actor) => `<li class="oc-resource-list-item resource-row"><span class="person-identity">${renderAvatar(actor.login, actor.login, "xs")}<span>@${escapeHtml(actor.login)}</span></span><span>${actor.github.total} GitHub events</span></li>`).join("")}</ul></section>`
    : "";
  const unmatched = report.unmatchedDiscord.length
    ? `<section class="oc-section">${sectionHeading("Unmatched Discord authors", "Coverage")}<p class="section-note">These messages count toward Discord totals. No message content is included.</p><ul class="oc-resource-list">${report.unmatchedDiscord.map((actor) => `<li class="oc-resource-list-item resource-row"><span>${escapeHtml(actor.authorId)}</span><span>${actor.messages} messages</span></li>`).join("")}</ul></section>`
    : "";
  // Fallback summaries restate their bullets as highlights; only list what the overview text lacks.
  const highlights =
    summary?.highlights.filter((highlight) => !summary.globalSummary.includes(highlight)) ?? [];
  return shell(
    ctx,
    periodTitle(report.period),
    `<header><div><h1>${escapeHtml(periodTitle(report.period))}</h1><p class="subtitle">Evidence report across ${repositories} GitHub repositories and ${channels} Discord channels for ${escapeHtml(report.orgs.join(", "))}. Roster: ${report.memberCount} people.</p><div class="actions"><a class="oc-action oc-action-ghost" href="${escapeHtml(path)}report.md">Markdown</a><a class="oc-action oc-action-ghost" href="${escapeHtml(path)}data.json">JSON</a></div></div><div class="oc-card oc-summary-metric"><span class="oc-summary-metric-copy"><small>Window</small><strong>${escapeHtml(formatWindow(report.period))}</strong><small>${open ? openPeriodStatus(ctx, entry) : `As of ${relativeTime(ctx, report.generatedAtMs)}`}</small></span></div></header>${partialBanner}${sourceBanners(report, summary)}<section class="oc-summary-strip" aria-label="Report totals">${totals}</section><section class="oc-section">${sectionHeading("Global Summary", "Overview", summary?.source === "model" ? "Model summary" : "Deterministic summary")}<div class="summary-markdown">${summary ? `${markdownBlocks(summary.globalSummary)}${highlights.length ? `<ul>${highlights.map((highlight) => `<li>${escapeHtml(highlight)}</li>`).join("")}</ul>` : ""}` : `<p>${report.activeMembers} of ${report.memberCount} members recorded ${github.total} GitHub events and ${report.totals.discord.messages} Discord messages in this window.</p>`}</div></section><section class="oc-section">${sectionHeading("Activity Mix", "Hard Numbers")}<div class="oc-summary-strip">${mix}</div><div class="mix-split">${splitMarkup(activitySegments(github, report.totals.discord.messages))}</div><div class="maintainer-distribution"><div class="distribution-heading"><div><div class="oc-eyebrow">Mapped activity</div><h3>Activity by Member</h3></div><p class="section-note">Bar length shows share; colors show activity type</p></div>${distribution(ctx, report.members)}</div></section><section class="oc-section collection-section" data-maintainer-filter-root><div class="oc-section-header people-head"><div><div class="oc-eyebrow">Members</div><h2>Members</h2></div><div class="people-tools js-only"><input class="person-filter oc-input" type="search" autocomplete="off" placeholder="Filter by name or handle" aria-label="Filter members by name, handle, or alias" data-maintainer-filter><div class="filter-status" data-maintainer-filter-status aria-live="polite">showing ${active.length} of ${active.length} active</div></div></div><div class="people">${active.map((member) => personRow(ctx, member)).join("") || '<div class="oc-empty"><p class="oc-empty-description">No visible GitHub or Discord activity in this window.</p></div>'}</div><div class="oc-empty" hidden data-maintainer-filter-empty><p class="oc-empty-description">No matching member in this report.</p></div>${quietBlock}</section>${other}${unmatched}`,
    "report",
  );
}
