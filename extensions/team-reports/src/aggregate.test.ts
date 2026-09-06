import { describe, expect, it } from "vitest";
import { aggregateDay, aggregateDays } from "./aggregate.js";
import { describePeriod } from "./periods.js";
import { buildRoster } from "./roster.js";
import type { DiscordMessage, GithubItem, Person, ReportDocument } from "./types.js";

const people: Person[] = [
  { github: ["alpha", "alpha-work"], discordUserId: "11" },
  { github: ["beta"], discordUserId: "22" },
  { github: ["quiet"], discordUserId: "33" },
  { github: ["former"], discordUserId: "44", status: "archived", archivedAt: "2026-08-01" },
];
const period = describePeriod("day", "2026-08-18");

function item(overrides: Partial<GithubItem> = {}): GithubItem {
  return {
    kind: "commit",
    repo: "sample/project",
    title: "Improve request handling",
    url: "https://github.com/sample/project/commit/one",
    atMs: period.sinceMs + 1000,
    actor: "alpha",
    ...overrides,
  };
}

function message(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    channelId: "100",
    parentChannelId: "100",
    channelName: "planning",
    authorId: "11",
    authorIsBot: false,
    atMs: period.sinceMs + 1000,
    content: "Discuss release readiness",
    ...overrides,
  };
}

function day(
  items: GithubItem[] = [],
  messages: DiscordMessage[] = [],
  key = period.key,
): ReportDocument {
  return aggregateDay({
    period: describePeriod("day", key),
    nowMs: Date.parse("2026-08-20T12:00:00Z"),
    orgs: ["sample"],
    roster: buildRoster(people),
    items,
    messages,
    githubStatus: { ok: true, warnings: [], stats: {} },
    discordStatus: { ok: true, warnings: [], stats: {} },
    ignoreCommentPatterns: [/^automation:/],
    discordConfig: {
      channels: [
        { id: "100", excerpts: true },
        { id: "200", excerpts: false },
      ],
      excerptMaxChars: 20,
    },
  });
}

function member(report: ReportDocument, login: string) {
  const result = report.members.find((person) => person.login === login);
  if (!result) {
    throw new Error(`Missing report member ${login}`);
  }
  return result;
}

describe("team report attribution", () => {
  it("credits the merger and each mapped commit coauthor once, keeping external authors outside the roster", () => {
    const report = day([
      item({
        kind: "pr_opened",
        actor: "outside",
        url: "https://github.com/sample/project/pull/1",
      }),
      item({ kind: "pr_merged", actor: "beta", url: "https://github.com/sample/project/pull/1" }),
      item({
        actor: "alpha-work",
        coauthors: ["alpha", "alpha-work", "42+beta@users.noreply.github.com", "beta", "outsider"],
      }),
      item({ actor: "alpha", coauthors: ["beta"] }),
      item({
        kind: "security_advisory",
        actor: "beta",
        url: "https://github.com/sample/project/security/advisories/GHSA-example",
      }),
    ]);
    expect(member(report, "alpha").github).toMatchObject({ total: 1, commits: 1, prsMerged: 0 });
    expect(member(report, "beta").github).toMatchObject({
      total: 3,
      commits: 1,
      prsMerged: 1,
      securityAdvisories: 1,
    });
    expect(report.otherActors).toMatchObject([
      { login: "outside", github: { total: 1, prsOpened: 1 } },
    ]);
    expect(report.totals.github).toMatchObject({
      total: 5,
      commits: 2,
      prsOpened: 1,
      prsMerged: 1,
      securityAdvisories: 1,
      repos: { "sample/project": 5 },
    });
    expect(report.activeMembers).toBe(2);
    expect(report.members.at(-1)).toMatchObject({
      login: "quiet",
      summary: { confidence: "low", source: "fallback" },
    });
  });

  it("collapses exact comment bodies by actor and kind, ignores patterns, and removes bodies from stored evidence", () => {
    const comments = [
      item({
        kind: "issue_comment",
        body: "Ready for review",
        url: "https://github.com/sample/project/issues/1#issuecomment-1",
      }),
      item({
        kind: "issue_comment",
        body: "Ready for review",
        url: "https://github.com/sample/project/issues/2#issuecomment-2",
        atMs: period.sinceMs + 2000,
      }),
      item({
        kind: "review_comment",
        body: "Ready for review",
        url: "https://github.com/sample/project/pull/3#discussion_r3",
      }),
      item({
        kind: "issue_comment",
        body: "Ready for review",
        actor: "beta",
        url: "https://github.com/sample/project/issues/1#issuecomment-4",
      }),
      item({
        kind: "issue_comment",
        body: "automation: label backfill",
        url: "https://github.com/sample/project/issues/1#issuecomment-5",
      }),
    ];
    const report = day(comments);
    expect(report.totals.github).toMatchObject({ total: 3, issueComments: 2, reviewComments: 1 });
    expect(member(report, "alpha").github.items.map((entry) => entry.url)).toContain(
      "https://github.com/sample/project/issues/2#issuecomment-2",
    );
    expect(
      member(report, "alpha").github.items.every((entry) => !Object.hasOwn(entry, "body")),
    ).toBe(true);
    expect(comments[0]).toMatchObject({ body: "Ready for review" });
  });

  it("excludes bot logins and out-of-window activity without dropping quiet members", () => {
    const report = day([
      ...["release[bot]", "buildbot", "copilot", "CODEX"].map((actor) =>
        item({ actor, url: `https://github.com/sample/project/commit/${actor}` }),
      ),
      item({ atMs: period.sinceMs - 1 }),
      item({ atMs: period.untilMs }),
      item({ actor: "former", url: "https://github.com/sample/project/commit/former" }),
    ]);
    expect(report.memberCount).toBe(3);
    expect(report.activeMembers).toBe(0);
    expect(report.totals.github.total).toBe(1);
    expect(report.otherActors).toMatchObject([{ login: "former", github: { commits: 1 } }]);
  });

  it("counts permitted threads and unmatched authors, but only excerpts channels explicitly enabled", () => {
    const report = day(
      [],
      [
        message({
          channelId: "101",
          channelName: "planning/release",
          content: "  Ready\n  for a release with tests  ",
        }),
        message({
          channelId: "200",
          parentChannelId: "200",
          channelName: "private-discussion",
          content: "Not excerpted",
        }),
        message({ authorId: "unmapped", content: "Unmatched content must never enter the report" }),
        message({ authorId: "44", content: "Archived content must never enter the report" }),
        message({ parentChannelId: "unconfigured" }),
        message({ authorIsBot: true }),
        message({ content: "  " }),
      ],
    );
    expect(report.totals.discord).toEqual({
      messages: 4,
      channels: { planning: 3, "private-discussion": 1 },
    });
    expect(member(report, "alpha").discord).toEqual({
      total: 2,
      channels: { planning: 1, "private-discussion": 1 },
      excerpts: [
        {
          channel: "planning/release",
          atMs: period.sinceMs + 1000,
          excerpt: "Ready for a release…",
        },
      ],
    });
    expect(report.unmatchedDiscord).toEqual([
      { authorId: "44", messages: 1 },
      { authorId: "unmapped", messages: 1 },
    ]);
    expect(JSON.stringify(report)).not.toContain("Unmatched content");
    expect(JSON.stringify(report)).not.toContain("Archived content");
  });

  it("marks an open UTC day partial and excludes future activity", () => {
    const nowMs = period.sinceMs + 2000;
    const report = aggregateDay({
      period,
      nowMs,
      orgs: ["sample"],
      roster: buildRoster(people),
      items: [item(), item({ atMs: nowMs + 1, url: "future" })],
      messages: [],
      githubStatus: { ok: true, warnings: [], stats: {} },
    });
    expect(report.status).toBe("partial");
    expect(report.totals.github.total).toBe(1);
    expect(day().status).toBe("closed");
  });
});

describe("stored day aggregation", () => {
  it.each(["week", "month"] as const)(
    "sums %s counts and reports missing elapsed days without recollection",
    (kind) => {
      const first = day([item()], [message()]);
      const second = day(
        [
          item({
            kind: "issue_closed",
            actor: "beta",
            atMs: Date.parse("2026-08-19T12:00:00Z"),
            url: "https://github.com/sample/project/issues/2",
          }),
        ],
        [],
        "2026-08-19",
      );
      second.sources.github.warnings.push("One repository was unavailable");
      const report = aggregateDays({
        period: describePeriod(kind, "2026-08-19"),
        nowMs: Date.parse("2026-08-19T18:00:00Z"),
        days: [second, first, first],
        roster: buildRoster(people),
      });
      expect(report.status).toBe("partial");
      expect(report.totals.github).toMatchObject({ total: 2, commits: 1, issuesClosed: 1 });
      expect(report.totals.discord.messages).toBe(1);
      expect(report.sources.github.warnings).toContain("One repository was unavailable");
      expect(
        report.sources.github.warnings.some(
          (warning) => warning.startsWith("Missing day reports:") && warning.includes("2026-08-17"),
        ),
      ).toBe(true);
      expect(report.sources.github.warnings.join(" ")).not.toContain("2026-08-20");
      expect(first.totals.github.total).toBe(1);
    },
  );

  it("preserves historical member identity while excluding archived people from current reports", () => {
    const stored = day([item()]);
    const roster = buildRoster([{ github: ["alpha"], status: "archived", discordUserId: "11" }]);
    const week = describePeriod("week", "2026-W34");
    const current = aggregateDays({
      period: week,
      nowMs: Date.parse("2026-08-20T12:00:00Z"),
      days: [stored],
      roster,
    });
    expect(current.members.some((entry) => entry.login === "alpha")).toBe(false);
    expect(current.otherActors).toMatchObject([{ login: "alpha", github: { commits: 1 } }]);
    const history = aggregateDays({ period: week, nowMs: week.untilMs, days: [stored], roster });
    expect(member(history, "alpha").github.commits).toBe(1);
    expect(stored.members.some((entry) => entry.login === "alpha")).toBe(true);
  });
});

describe("report evidence bounds", () => {
  it.each(["🇦🇹", "e\u0301"])("bounds excerpts without splitting %s graphemes", (grapheme) => {
    for (const [content, excerpt] of [
      [grapheme.repeat(20), grapheme.repeat(20)],
      [grapheme.repeat(21), `${grapheme.repeat(19)}…`],
    ]) {
      const report = day([], [message({ content })]);
      expect(member(report, "alpha").discord.excerpts).toEqual([
        { channel: "planning", atMs: period.sinceMs + 1000, excerpt },
      ]);
    }
  });

  it("keeps newest evidence without changing totals", () => {
    const report = day(
      Array.from({ length: 205 }, (_, index) =>
        item({
          atMs: period.sinceMs + index + 1,
          url: `https://github.com/sample/project/commit/${index}`,
        }),
      ),
      Array.from({ length: 12 }, (_, index) => message({ atMs: period.sinceMs + index + 1 })),
    );
    expect(report.truncated).toBe(true);
    expect(member(report, "alpha").github.total).toBe(205);
    expect(member(report, "alpha").github.items).toHaveLength(200);
    expect(member(report, "alpha").github.items.at(-1)?.url).toBe(
      "https://github.com/sample/project/commit/5",
    );
    expect(member(report, "alpha").discord.total).toBe(12);
    expect(member(report, "alpha").discord.excerpts).toHaveLength(8);
    expect(member(report, "alpha").discord.excerpts.at(-1)?.atMs).toBe(period.sinceMs + 5);
  });

  it("bounds UTF-8 serialized data by dropping oldest evidence, preserving exact counts", () => {
    const report = day([
      item({ title: "あ".repeat(750_000) }),
      item({
        title: "Newest small event",
        atMs: period.sinceMs + 2000,
        url: "https://github.com/sample/project/commit/new",
      }),
    ]);
    expect(report.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(member(report, "alpha").github.total).toBe(2);
    expect(member(report, "alpha").github.items.map((entry) => entry.title)).toEqual([
      "Newest small event",
    ]);
  });
});
