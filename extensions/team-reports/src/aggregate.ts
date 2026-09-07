import { MAX_REPORT_BYTES } from "./limits.js";
import { periodDayKeys } from "./periods.js";
import { isBotLogin, primaryLogin } from "./roster.js";
import { truncateGraphemes } from "./text.js";
import type {
  DiscordMessage,
  DiscordSourceConfig,
  GithubCounts,
  GithubItem,
  GithubItemKind,
  OtherActor,
  PeriodDescriptor,
  Person,
  PersonReport,
  ReportDocument,
  Roster,
  SourceStatus,
} from "./types.js";

const COUNT_FIELDS = [
  "total",
  "commits",
  "prsOpened",
  "prsMerged",
  "prsClosed",
  "issuesOpened",
  "issuesClosed",
  "issueComments",
  "reviewComments",
  "securityAdvisories",
] as const;
const KIND_COUNTS: Record<GithubItemKind, Exclude<(typeof COUNT_FIELDS)[number], "total">> = {
  commit: "commits",
  pr_opened: "prsOpened",
  pr_merged: "prsMerged",
  pr_closed: "prsClosed",
  issue_opened: "issuesOpened",
  issue_closed: "issuesClosed",
  issue_comment: "issueComments",
  review_comment: "reviewComments",
  security_advisory: "securityAdvisories",
};

function emptyGithub(): GithubCounts {
  return {
    total: 0,
    commits: 0,
    prsOpened: 0,
    prsMerged: 0,
    prsClosed: 0,
    issuesOpened: 0,
    issuesClosed: 0,
    issueComments: 0,
    reviewComments: 0,
    securityAdvisories: 0,
    repos: {},
  };
}

function increment(counts: Record<string, number>, key: string, value = 1): void {
  // Channel names come from external data and can collide with Object.prototype keys.
  Object.defineProperty(counts, key, {
    value: (Object.hasOwn(counts, key) ? (counts[key] ?? 0) : 0) + value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function sumMap(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) {
    increment(target, key, value);
  }
}

function sumGithub(target: GithubCounts, source: GithubCounts): void {
  for (const field of COUNT_FIELDS) {
    target[field] += source[field];
  }
  sumMap(target.repos, source.repos);
}

function countItem(counts: GithubCounts, item: GithubItem): void {
  counts.total++;
  counts[KIND_COUNTS[item.kind]]++;
  increment(counts.repos, item.repo);
}

function emptyMember(person: Person): PersonReport {
  return {
    login: primaryLogin(person),
    display: person.display || primaryLogin(person),
    affiliation: person.affiliation,
    roleGroup: person.roleGroup,
    roleLabel: person.roleLabel,
    access: [...(person.access ?? [])],
    areas: [...(person.areas ?? [])],
    aliases: person.github.slice(1),
    github: { ...emptyGithub(), items: [] },
    discord: { total: 0, channels: {}, excerpts: [] },
  };
}

function otherBucket(others: Map<string, OtherActor>, login: string): OtherActor {
  let bucket = others.get(login);
  if (!bucket) {
    bucket = { login, github: emptyGithub() };
    others.set(login, bucket);
  }
  return bucket;
}

function emptyReport(
  period: PeriodDescriptor,
  nowMs: number,
  orgs: string[],
  sources: ReportDocument["sources"],
): ReportDocument {
  return {
    version: 1,
    period: { ...period },
    generatedAtMs: nowMs,
    status: nowMs < period.untilMs ? "partial" : "closed",
    orgs: [...new Set(orgs)].toSorted(),
    memberCount: 0,
    activeMembers: 0,
    totals: { github: emptyGithub(), discord: { messages: 0, channels: {} } },
    members: [],
    otherActors: [],
    unmatchedDiscord: [],
    sources: structuredClone(sources),
  };
}

function itemKey(item: GithubItem): string {
  return JSON.stringify([item.kind, item.repo, item.url || [item.atMs, item.title]]);
}

function newestFirst(a: GithubItem, b: GithubItem): number {
  return b.atMs - a.atMs || itemKey(a).localeCompare(itemKey(b)) || a.actor.localeCompare(b.actor);
}

function evidenceItem(item: GithubItem): GithubItem {
  const { body: _body, ...evidence } = item;
  return structuredClone(evidence);
}

function finishReport(report: ReportDocument): ReportDocument {
  report.members = report.members.toSorted(
    (a, b) =>
      b.github.total + b.discord.total - (a.github.total + a.discord.total) ||
      a.login.localeCompare(b.login),
  );
  report.memberCount = report.members.length;
  report.activeMembers = report.members.filter(
    (member) => member.github.total + member.discord.total > 0,
  ).length;
  for (const member of report.members) {
    if (member.github.total + member.discord.total === 0) {
      member.summary = {
        text: "No visible GitHub or Discord activity in this report window.",
        confidence: "low",
        source: "fallback",
      };
    }
  }
  report.otherActors = report.otherActors.toSorted(
    (a, b) => b.github.total - a.github.total || a.login.localeCompare(b.login),
  );
  report.unmatchedDiscord = report.unmatchedDiscord.toSorted(
    (a, b) => b.messages - a.messages || a.authorId.localeCompare(b.authorId),
  );
  return boundReportDocument(report);
}

type AggregateDayOptions = {
  period: PeriodDescriptor;
  nowMs: number;
  orgs: string[];
  roster: Roster;
  items: GithubItem[];
  messages: DiscordMessage[];
  githubStatus: SourceStatus;
  discordStatus?: SourceStatus;
  ignoreCommentPatterns?: RegExp[];
  discordConfig?: Pick<DiscordSourceConfig, "channels" | "excerptMaxChars">;
};

export function aggregateDay(options: AggregateDayOptions): ReportDocument {
  const { period, nowMs, roster, discordConfig } = options;
  if (period.period !== "day") {
    throw new Error("Source activity must be aggregated into a UTC day report");
  }
  const report = emptyReport(period, nowMs, options.orgs, {
    github: options.githubStatus,
    ...(options.discordStatus ? { discord: options.discordStatus } : {}),
  });
  const members = new Map(
    roster.members.map((person) => [primaryLogin(person), emptyMember(person)]),
  );
  const others = new Map<string, OtherActor>();
  const commentBodies = new Set<string>();
  const credits = new Set<string>();
  const patterns = (options.ignoreCommentPatterns ?? []).map(
    (pattern) => new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")),
  );
  for (const item of options.items.toSorted(newestFirst)) {
    if (item.atMs < period.sinceMs || item.atMs >= Math.min(period.untilMs, nowMs)) {
      continue;
    }
    const actor = item.actor.trim().toLowerCase();
    const comment = item.kind === "issue_comment" || item.kind === "review_comment";
    const body = item.body;
    if (comment && body !== undefined) {
      const key = JSON.stringify([actor, item.kind, body]);
      if (commentBodies.has(key) || patterns.some((pattern) => pattern.test(body))) {
        continue;
      }
      commentBodies.add(key);
    }
    const people = new Set<string>();
    if (actor && !isBotLogin(actor)) {
      const person = roster.byLogin.get(actor);
      people.add(person ? primaryLogin(person) : actor);
    }
    if (item.kind === "commit") {
      for (const value of item.coauthors ?? []) {
        const login =
          value
            .trim()
            .toLowerCase()
            .match(/(?:\d+\+)?([a-z\d-]+)@users\.noreply\.github\.com(?:>|$)/i)?.[1] ??
          value.trim().toLowerCase();
        const person = roster.byLogin.get(login);
        if (person && !isBotLogin(login)) {
          people.add(primaryLogin(person));
        }
      }
    }
    for (const login of people) {
      const key = JSON.stringify([login, itemKey(item)]);
      if (credits.has(key)) {
        continue;
      }
      credits.add(key);
      const member = members.get(login);
      countItem(member?.github ?? otherBucket(others, login).github, item);
      countItem(report.totals.github, item);
      if (member) {
        member.github.items.push(evidenceItem(item));
      }
    }
  }
  const channels = new Map(discordConfig?.channels.map((channel) => [channel.id, channel]));
  const unmatched = new Map<string, number>();
  for (const message of options.messages.toSorted(
    (a, b) =>
      b.atMs - a.atMs ||
      a.channelId.localeCompare(b.channelId) ||
      a.authorId.localeCompare(b.authorId),
  )) {
    const channel = channels.get(message.parentChannelId);
    if (
      !channel ||
      message.authorIsBot ||
      !message.content.trim() ||
      message.atMs < period.sinceMs ||
      message.atMs >= Math.min(period.untilMs, nowMs)
    ) {
      continue;
    }
    const separator = message.channelName.indexOf("/");
    const channelName =
      message.channelId === message.parentChannelId || separator < 0
        ? message.channelName
        : message.channelName.slice(0, separator);
    const person = roster.byDiscordId.get(message.authorId);
    const member = person ? members.get(primaryLogin(person)) : undefined;
    report.totals.discord.messages++;
    increment(report.totals.discord.channels, channelName);
    if (!member) {
      unmatched.set(message.authorId, (unmatched.get(message.authorId) ?? 0) + 1);
      continue;
    }
    member.discord.total++;
    increment(member.discord.channels, channelName);
    if (channel.excerpts) {
      const collapsed = message.content.replace(/\s+/g, " ").trim();
      member.discord.excerpts.push({
        channel: message.channelName,
        atMs: message.atMs,
        excerpt: truncateGraphemes(collapsed, discordConfig?.excerptMaxChars ?? 260),
      });
    }
  }
  report.members = [...members.values()];
  report.otherActors = [...others.values()];
  report.unmatchedDiscord = [...unmatched].map(([authorId, messages]) => ({ authorId, messages }));
  return finishReport(report);
}

function mergeStatus(statuses: SourceStatus[]): SourceStatus {
  const result: SourceStatus = {
    ok: statuses.every((source) => source.ok),
    warnings: [...new Set(statuses.flatMap((source) => source.warnings))],
    stats: { daysAggregated: statuses.length },
  };
  if (statuses.some((source) => source.stale)) {
    result.stale = true;
  }
  return result;
}

export function aggregateDays(options: {
  period: PeriodDescriptor;
  nowMs: number;
  days: ReportDocument[];
  roster?: Roster;
  orgs?: string[];
}): ReportDocument {
  const { period, nowMs, roster } = options;
  if (period.period === "day") {
    throw new Error("Stored days can only be aggregated into a week or month");
  }
  const byDay = new Map<string, ReportDocument>();
  for (const day of options.days) {
    if (
      day.period.period === "day" &&
      day.period.sinceMs >= period.sinceMs &&
      day.period.untilMs <= period.untilMs &&
      day.period.sinceMs < nowMs
    ) {
      const previous = byDay.get(day.period.key);
      if (!previous || previous.generatedAtMs < day.generatedAtMs) {
        byDay.set(day.period.key, day);
      }
    }
  }
  const days = [...byDay.values()].toSorted((a, b) => a.period.sinceMs - b.period.sinceMs);
  const scopes = new Set(
    days.map((day) =>
      day.orgs
        .map((org) => org.toLowerCase())
        .toSorted()
        .join(","),
    ),
  );
  if (scopes.size > 1) {
    throw new Error("Cannot aggregate day reports from different GitHub organization scopes");
  }
  const github = mergeStatus(days.map((day) => day.sources.github));
  const missing = periodDayKeys(period, nowMs).filter((key) => !byDay.has(key));
  if (missing.length) {
    github.warnings.push(`Missing day reports: ${missing.join(", ")}`);
    github.stale = true;
  }
  const discordStatuses = days.flatMap((day) => (day.sources.discord ? [day.sources.discord] : []));
  const report = emptyReport(period, nowMs, options.orgs ?? days[0]?.orgs ?? [], {
    github,
    ...(discordStatuses.length ? { discord: mergeStatus(discordStatuses) } : {}),
  });
  const currentRoster = nowMs < period.untilMs ? roster : undefined;
  const members = new Map(
    (currentRoster?.members ?? []).map((person) => [primaryLogin(person), emptyMember(person)]),
  );
  const others = new Map<string, OtherActor>();
  const unmatched = new Map<string, number>();
  for (const day of days) {
    sumGithub(report.totals.github, day.totals.github);
    report.totals.discord.messages += day.totals.discord.messages;
    sumMap(report.totals.discord.channels, day.totals.discord.channels);
    for (const source of day.members) {
      const identity = currentRoster?.byLogin.get(source.login);
      if (identity?.status === "archived") {
        sumGithub(otherBucket(others, primaryLogin(identity)).github, source.github);
        if (identity.discordUserId && source.discord.total) {
          unmatched.set(
            identity.discordUserId,
            (unmatched.get(identity.discordUserId) ?? 0) + source.discord.total,
          );
        }
        continue;
      }
      const login = identity ? primaryLogin(identity) : source.login;
      let member = members.get(login);
      if (!member) {
        member = {
          ...structuredClone(source),
          login,
          github: { ...emptyGithub(), items: [] },
          discord: { total: 0, channels: {}, excerpts: [] },
          summary: undefined,
        };
        members.set(login, member);
      }
      sumGithub(member.github, source.github);
      member.github.items.push(...source.github.items.map(evidenceItem));
      member.discord.total += source.discord.total;
      sumMap(member.discord.channels, source.discord.channels);
      member.discord.excerpts.push(...structuredClone(source.discord.excerpts));
    }
    for (const actor of day.otherActors) {
      sumGithub(otherBucket(others, actor.login).github, actor.github);
    }
    for (const entry of day.unmatchedDiscord) {
      unmatched.set(entry.authorId, (unmatched.get(entry.authorId) ?? 0) + entry.messages);
    }
  }
  if (days.some((day) => day.truncated)) {
    report.truncated = true;
  }
  report.members = [...members.values()];
  report.otherActors = [...others.values()];
  report.unmatchedDiscord = [...unmatched].map(([authorId, messages]) => ({ authorId, messages }));
  return finishReport(report);
}

export function boundReportDocument(input: ReportDocument): ReportDocument {
  const report = structuredClone(input);
  for (const member of report.members) {
    if (member.github.items.length > 200 || member.discord.excerpts.length > 8) {
      report.truncated = true;
    }
    member.github.items = member.github.items.map(evidenceItem).toSorted(newestFirst).slice(0, 200);
    member.discord.excerpts = member.discord.excerpts
      .toSorted(
        (a, b) =>
          b.atMs - a.atMs ||
          a.channel.localeCompare(b.channel) ||
          a.excerpt.localeCompare(b.excerpt),
      )
      .slice(0, 8);
  }
  if (Buffer.byteLength(JSON.stringify(report)) <= MAX_REPORT_BYTES) {
    return report;
  }
  report.truncated = true;
  let size = Buffer.byteLength(JSON.stringify(report));
  const evidence = report.members
    .flatMap((member) => [
      ...member.github.items.map((item) => ({
        atMs: item.atMs,
        value: item,
        list: member.github.items,
      })),
      ...member.discord.excerpts.map((excerpt) => ({
        atMs: excerpt.atMs,
        value: excerpt,
        list: member.discord.excerpts,
      })),
    ])
    .toSorted((a, b) => a.atMs - b.atMs);
  for (const entry of evidence) {
    if (size <= MAX_REPORT_BYTES) {
      break;
    }
    // Every list is newest-first, so the oldest evidence can be removed without recounting activity.
    const removed = entry.list.pop();
    if (removed) {
      size -= Buffer.byteLength(JSON.stringify(removed)) + (entry.list.length ? 1 : 0);
    }
  }
  if (Buffer.byteLength(JSON.stringify(report)) > MAX_REPORT_BYTES) {
    throw new Error(
      "Team report metadata exceeds the 2 MiB limit after removing all item evidence; reduce the configured roster or organization scope",
    );
  }
  return report;
}
