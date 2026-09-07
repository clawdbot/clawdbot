import { describe, expect, it } from "vitest";
import { DAY_MS, describePeriod } from "../periods.js";
import { githubCounts } from "../reports.fixtures.js";
import type { PeriodListEntry, PersonDay } from "../store.js";
import type { Period, Person, ReportDocument } from "../types.js";
import {
  renderIndexPage,
  renderPeoplePage,
  renderPersonPage,
  renderReportPage,
  type PageContext,
  type PeriodIndex,
} from "./html.js";

const ctx: PageContext = {
  basePath: "/reports",
  nonce: "fixture",
  absoluteUrl: "https://example.test/reports/",
  displayTimezone: "America/Los_Angeles",
  nowMs: Date.parse("2026-09-07T16:44:00Z"),
};
function entry(period: Period, key: string, total = 10): PeriodListEntry {
  const window = describePeriod(period, key);
  return {
    ...window,
    status: window.untilMs > (ctx.nowMs ?? 0) ? "partial" : "closed",
    generatedAtMs: Math.min(window.untilMs, ctx.nowMs ?? 0),
    activeMembers: 1,
    memberCount: 2,
    githubTotal: total,
    discordMessages: total,
    commits: total,
    prsOpened: 0,
    prsMerged: 0,
    securityAdvisories: 0,
  };
}
function document(period: Period = "day", key = "2026-09-07"): ReportDocument {
  const row = entry(period, key);
  return {
    version: 1,
    period: describePeriod(period, key),
    status: row.status,
    generatedAtMs: row.generatedAtMs,
    orgs: ["example"],
    memberCount: 2,
    activeMembers: 1,
    totals: { github: githubCounts(10), discord: { messages: 10, channels: { general: 10 } } },
    members: [
      {
        login: "alice",
        display: "Alice",
        aliases: [],
        access: [],
        areas: [],
        github: { ...githubCounts(10), items: [] },
        discord: { total: 10, channels: { general: 10 }, excerpts: [] },
      },
    ],
    otherActors: [],
    unmatchedDiscord: [],
    sources: { github: { ok: true, warnings: [], stats: { reposScanned: 1 } } },
  };
}
function home(index: Partial<PeriodIndex>): string {
  return renderIndexPage(
    ctx,
    { day: [], week: [], month: [], ...index },
    { orgs: ["example"], health: { running: true, warnings: 0 } },
  );
}
function personDay(login: string, dayKey: string, total: number): PersonDay {
  return {
    login,
    dayKey,
    githubTotal: total,
    discordMessages: total,
    commits: total,
    prsOpened: 0,
    prsMerged: 0,
    prsClosed: 0,
    issuesOpened: 0,
    issuesClosed: 0,
    issueComments: 0,
    reviewComments: 0,
  };
}

describe("Team Reports site behavior", () => {
  it("shows a dateline only with multiple stored days and keeps the whole retained range", () => {
    expect(home({ day: [entry("day", "2026-09-07")] })).not.toContain(
      'aria-label="Activity dateline"',
    );
    const days = Array.from({ length: 400 }, (_, index) =>
      entry(
        "day",
        new Date(Date.parse("2026-09-07T00:00:00Z") - index * DAY_MS).toISOString().slice(0, 10),
      ),
    );
    const html = home({ day: days });
    expect(html).toContain('aria-label="Activity dateline"');
    expect(html).toContain("400 report days");
    expect(html).toContain(days.at(-1)?.key);
    expect(html).toContain('href="/reports/day/2026-09-07/"');
  });

  it("uses UTC windows for open guidance, countdowns and intraday badges", () => {
    const closed = entry("day", "2026-09-06");
    const today = entry("day", "2026-09-07");
    const html = home({ day: [today, closed] });
    expect(html).toContain("Open reporting windows");
    expect(html).toContain("Today, as of");
    expect(html).toContain("16:44 UTC");
    expect(html).toContain("closes in 7h 16m (00:00 UTC)");
    expect(html).toContain(">Intraday</span>");
    expect(home({ day: [closed] })).not.toContain("Open reporting windows");
    expect(home({ day: [{ ...today, generatedAtMs: today.untilMs }] })).not.toContain(
      ">Intraday</span>",
    );
    expect(
      home({ day: [{ ...closed, status: "partial", generatedAtMs: closed.untilMs - 1000 }] }),
    ).not.toContain(">Intraday</span>");
    const closedToday = home({ day: [{ ...today, status: "closed" }] });
    expect(closedToday).not.toContain(">Intraday</span>");
    expect(closedToday).not.toContain('class="quick-card oc-card oc-card-interactive partial"');
  });

  it.each<{ period: Period; key: string }>([
    { period: "day", key: "2026-09-06" },
    { period: "week", key: "2026-W36" },
    { period: "month", key: "2026-08" },
  ])("preserves stored $period completeness in overview cards and history", ({ period, key }) => {
    const closed = entry(period, key);
    const incomplete = home({ [period]: [{ ...closed, status: "partial" }] });
    expect(incomplete.match(/oc-badge-warning[^>]*>Incomplete<\/span>/g)).toHaveLength(2);
    expect(incomplete).toContain('class="quick-card oc-card oc-card-interactive partial"');
    expect(incomplete).not.toContain(">Intraday</span>");
    expect(incomplete).not.toContain("Open reporting windows");
    const complete = home({ [period]: [closed] });
    expect(complete).not.toContain(">Incomplete</span>");
    expect(complete).not.toContain(">Intraday</span>");
    expect(complete).not.toContain('class="quick-card oc-card oc-card-interactive partial"');
  });

  it("compares an open aggregate snapshot to elapsed prior days instead of the full period", () => {
    const previous = entry("week", "2026-W36", 100);
    const current = entry("week", "2026-W37", 15);
    const html = home({ day: [entry("day", "2026-08-31", 10)], week: [current, previous] });
    expect(html).toContain("+50% vs prev week to date");
    const monthDays = Array.from({ length: 7 }, (_, index) =>
      entry("day", `2026-08-${String(index + 1).padStart(2, "0")}`, 1),
    );
    expect(
      home({
        day: monthDays,
        month: [entry("month", "2026-09", 14), entry("month", "2026-08", 100)],
      }),
    ).toContain("+100% vs prev month to date");
    expect(home({ week: [current, previous] })).toContain("-85% vs prev week");
    expect(
      home({ day: [entry("day", "2026-09-07", 20), entry("day", "2026-09-06", 10)] }),
    ).toContain("+100% vs prev day");
  });

  it.each<Period>(["day", "week", "month"])(
    "offers Show all only above the visible %s history limit",
    (period) => {
      const count = period === "day" ? 7 : 12;
      const entries = Array.from({ length: count + 1 }, (_, index) =>
        entry(
          period,
          period === "day"
            ? `2026-08-${String(31 - index).padStart(2, "0")}`
            : period === "week"
              ? `2026-W${String(34 - index).padStart(2, "0")}`
              : `${2026 - Math.floor(index / 12)}-${String(12 - (index % 12)).padStart(2, "0")}`,
        ),
      );
      expect(home({ [period]: entries.slice(0, count) })).not.toContain(`data-toggle="${period}"`);
      const html = home({ [period]: entries });
      expect(html).toContain(`Show all ${count + 1}`);
      expect(html).toContain(" data-extra hidden");
      expect(html).toContain(`href="/reports/${period}/${entries.at(-1)?.key}/"`);
    },
  );

  it("renders metric deltas only against preceding periods and labels in-progress totals", () => {
    const report = document();
    const html = renderReportPage(ctx, report, null, [
      entry("day", "2026-09-08", 100),
      entry("day", "2026-09-07", 10),
      entry("day", "2026-09-06", 5),
    ]);
    expect(html).toContain("+100% vs prev day (in progress)");
    const closed = renderReportPage(ctx, document("day", "2026-09-06"), null, [
      entry("day", "2026-09-06", 10),
      entry("day", "2026-09-05", 5),
    ]);
    expect(closed).toContain("+100% vs prev day");
    expect(closed).not.toContain("(in progress)");
  });

  it("ranks member distribution by activity and exposes members after the first twelve", () => {
    const report = document();
    const member = report.members[0]!;
    report.members = Array.from({ length: 14 }, (_, index) => ({
      ...member,
      login: `member-${index}`,
      display: `Member ${index}`,
      github: { ...githubCounts(index + 1), items: [] },
      discord: { total: 0, channels: {}, excerpts: [] },
    }));
    const html = renderReportPage(ctx, report, null, []);
    const distribution = html.slice(
      html.indexOf("Activity by Member"),
      html.indexOf("data-maintainer-filter-root"),
    );
    expect(distribution.indexOf("member-13")).toBeLessThan(distribution.indexOf("member-12"));
    expect(distribution).toContain("Show remaining 2");
  });

  it("keeps every retained GitHub item accessible beyond the three-item preview", () => {
    const report = document();
    const member = report.members[0]!;
    member.github.items = ["First change", "Second change", "Third change", "Fourth <change>"].map(
      (title, index) => ({
        kind: "pr_opened",
        repo: `example/repo-${index}`,
        title,
        url: `https://github.com/example/repo-${index}/pull/1`,
        atMs: report.generatedAtMs,
        actor: member.login,
      }),
    );
    member.github.items[3]!.repo = "example/<hostile-repo>";
    member.github.items[3]!.url = "javascript:alert(1)";
    const html = renderReportPage(ctx, report, null, []);
    expect(html.match(/class="theme"/g)).toHaveLength(3);
    const details = html.match(/<details><summary>4 GitHub items<\/summary>(.*?)<\/details>/s)?.[1];
    expect(details).toBeDefined();
    for (const title of [
      "First change",
      "Second change",
      "Third change",
      "Fourth &lt;change&gt;",
    ]) {
      expect(details).toContain(title);
    }
    expect(details?.match(/PR opened/g)).toHaveLength(4);
    expect(details).toContain("example/repo-0");
    expect(details).toContain("example/&lt;hostile-repo&gt;");
    expect(details).toContain(
      'href="https://github.com/example/repo-0/pull/1" target="_blank" rel="noopener"',
    );
    expect(details).not.toContain("javascript:");
    expect(details).not.toContain("<hostile-repo>");
    expect(details).not.toContain("Fourth <change>");
  });

  it("keeps source warning banners bounded and escapes hostile data on every page", () => {
    const hostile = 'bad"><img src=x onerror=alert(1)>';
    const report = document();
    report.orgs = [hostile];
    report.sources.github = { ok: false, warnings: [hostile], stats: {} };
    report.sources.discord = { ok: true, stale: true, warnings: [hostile], stats: {} };
    const member = report.members[0]!;
    member.login = hostile;
    member.display = hostile;
    member.affiliation = hostile;
    member.areas = [hostile];
    member.github.repos = { [hostile]: 10 };
    member.discord.channels = { [hostile]: 10 };
    const summary = {
      source: "fallback" as const,
      generatedAtMs: report.generatedAtMs,
      globalSummary: hostile,
      highlights: [hostile],
      fingerprint: "fixture",
      warnings: [hostile, hostile],
    };
    const person: Person = { github: [hostile], display: hostile, affiliation: hostile };
    const days = [personDay(hostile, "2026-09-07", 10), personDay(hostile, "2026-09-05", 5)];
    const overview = renderIndexPage(
      ctx,
      { day: [entry("day", "2026-09-07")], week: [], month: [] },
      { orgs: [hostile], latest: { report, summary }, health: { running: true, warnings: 3 } },
    );
    const reportHtml = renderReportPage(ctx, report, summary, []);
    for (const html of [
      overview,
      reportHtml,
      renderPeoplePage(ctx, [person], days, "2026-09-07"),
      renderPersonPage(ctx, person, days),
    ]) {
      expect(html).not.toContain(hostile);
      expect(html).not.toContain("<img src=x");
      expect(html).toContain("bad&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
      expect(html.match(/<script\b/g)).toHaveLength(1);
    }
    expect(overview.match(/<section class="oc-banner oc-banner-warning"/g)).toHaveLength(3);
    expect(reportHtml).toContain('data-maintainer-search="bad&quot;');
  });

  it("groups active, quiet, read-only and archived people with ranked activity buckets", () => {
    const people: Person[] = [
      { github: ["quiet"] },
      { github: ["reader"], roleGroup: "readonly" },
      { github: ["archived"], status: "archived" },
      { github: ["active"] },
    ];
    const days = [
      personDay("active", "2026-09-07", 20),
      personDay("quiet", "2026-09-07", 0),
      personDay("reader", "2026-09-07", 3),
      personDay("archived", "2026-09-07", 50),
    ];
    const html = renderPeoplePage(ctx, people, days, "2026-09-07");
    const grid = html.slice(html.indexOf('class="people-grid"'));
    expect(grid.indexOf("/people/active/")).toBeLessThan(grid.indexOf("/people/quiet/"));
    expect(grid.indexOf("/people/quiet/")).toBeLessThan(grid.indexOf("/people/reader/"));
    expect(grid.indexOf("/people/reader/")).toBeLessThan(grid.indexOf("/people/archived/"));
    expect(grid).toContain("level-0");
    expect(grid).toContain("level-4");
    expect(grid).toContain("is-archived");
    expect(html).toContain("28 days");
  });

  it("keeps closed intraday snapshots visibly incomplete", () => {
    const report = document("day", "2026-09-06");
    report.status = "partial";
    report.generatedAtMs = report.period.untilMs - 3_600_000;
    const html = renderReportPage(ctx, report, null, []);
    expect(html).toContain("Incomplete snapshot");
    expect(html).toContain("The window has since closed, so these totals remain incomplete.");
    expect(html).not.toContain("data-day-countdown data-until=");
  });

  it("shades activity at the site bucket boundaries within the ranking window", () => {
    const totals = [0, 1, 4, 5, 14, 15, 39, 40];
    const levels = [0, 1, 1, 2, 2, 3, 3, 4];
    const days = totals.map((total, index) => ({
      ...personDay("alice", `2026-09-${String(index + 1).padStart(2, "0")}`, 0),
      githubTotal: total,
    }));
    days.push({ ...personDay("alice", "2026-07-01", 1000) });
    const html = renderPeoplePage(ctx, [{ github: ["alice"] }], days, "2026-09-08");
    for (const [index, level] of levels.entries()) {
      const key = `2026-09-${String(index + 1).padStart(2, "0")}`;
      expect(html).toContain(
        `class="day-dot level-${level}" title="${key}: ${totals[index]} events"`,
      );
    }
    expect(html).toContain("118 events · 118 GitHub · 0 Discord");
    expect(html).toContain("7 out of 8 days active");
  });

  it("links retained calendar cells to daily reports and leaves missing chart days as gaps", () => {
    const html = renderPersonPage(ctx, { github: ["alice"], display: "Alice" }, [
      personDay("alice", "2026-09-07", 12),
      personDay("alice", "2026-09-05", 6),
    ]);
    expect(html).toMatch(/class="day-cell[^"\n]*"[^>]*href="\/reports\/day\/2026-09-07\//);
    expect(html).not.toContain('href="/reports/day/2026-09-06/');
    expect(html).toContain("GitHub events · left axis");
    expect(html).toContain("Discord messages · right axis");
    const paths = [...html.matchAll(/class="person-activity-line[^"]*" d="([^"]*)"/g)];
    expect(paths).toHaveLength(2);
    for (const path of paths) {
      expect(path[1]?.match(/M/g)).toHaveLength(2);
    }
    expect(html).toContain("Exact daily values");
  });
});
