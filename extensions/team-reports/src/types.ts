// Domain contract shared by the report core and the activity sources.

export type Period = "day" | "week" | "month";

/** Report window. Day windows are UTC [00:00, 24:00); weeks are ISO weeks (Monday start); months are calendar months. */
export type PeriodDescriptor = {
  period: Period;
  /** "2026-08-20" | "2026-W34" | "2026-08" */
  key: string;
  sinceMs: number;
  untilMs: number;
  title: string;
};

export type ActivityWindow = { sinceMs: number; untilMs: number };

/** Identity map entry supplied by the operator (config `people` or `peopleFile`) or derived from a GitHub team roster. */
export type Person = {
  /** GitHub logins; the first entry is the primary/display login. */
  github: string[];
  display?: string;
  /** Public company/affiliation label. */
  affiliation?: string;
  roleGroup?: "core" | "volunteer" | "readonly" | (string & {});
  roleLabel?: string;
  /** Free-form access flags, e.g. ["security", "release", "moderation"]. */
  access?: string[];
  /** Ownership/steward areas. */
  areas?: string[];
  discordUserId?: string;
  discordUsername?: string;
  status?: "active" | "archived";
  /** YYYY-MM-DD */
  archivedAt?: string;
};

export type Roster = {
  /** Current (non-archived) members. */
  members: Person[];
  /** Lower-cased GitHub login -> person (all aliases). */
  byLogin: Map<string, Person>;
  /** Discord user id -> person. */
  byDiscordId: Map<string, Person>;
};

export type GithubItemKind =
  | "commit"
  | "pr_opened"
  | "pr_merged"
  | "pr_closed"
  | "issue_opened"
  | "issue_closed"
  | "issue_comment"
  | "review_comment"
  | "security_advisory";

export type GithubItem = {
  kind: GithubItemKind;
  /** "owner/name" */
  repo: string;
  number?: number;
  title: string;
  url: string;
  atMs: number;
  /** GitHub login credited for this item (merged_by for pr_merged, comment author for comments, commit author for commits). */
  actor: string;
  /** Logins from Co-authored-by trailers (commits only). */
  coauthors?: string[];
  /** Raw comment body, used only for duplicate collapsing and ignore patterns; never rendered. */
  body?: string;
};

export type GithubCounts = {
  total: number;
  commits: number;
  prsOpened: number;
  prsMerged: number;
  prsClosed: number;
  issuesOpened: number;
  issuesClosed: number;
  issueComments: number;
  reviewComments: number;
  securityAdvisories: number;
  /** "owner/name" -> count */
  repos: Record<string, number>;
};

export type DiscordMessage = {
  channelId: string;
  /** Resolved display name; for threads, "parent/thread". */
  channelName: string;
  /** Configured parent channel id this message counts under (thread messages roll up to their parent). */
  parentChannelId: string;
  authorId: string;
  authorIsBot: boolean;
  atMs: number;
  content: string;
};

type DiscordExcerpt = { channel: string; atMs: number; excerpt: string };

type DiscordCounts = {
  total: number;
  /** channel name -> count */
  channels: Record<string, number>;
  excerpts: DiscordExcerpt[];
};

type PersonSummary = {
  text: string;
  confidence: "high" | "medium" | "low";
  source: "model" | "fallback";
};

export type PersonReport = {
  login: string;
  display: string;
  affiliation?: string;
  roleGroup?: string;
  roleLabel?: string;
  access: string[];
  areas: string[];
  /** Other GitHub logins mapped to this person. */
  aliases: string[];
  github: GithubCounts & { items: GithubItem[] };
  discord: DiscordCounts;
  summary?: PersonSummary;
};

/** Non-member GitHub actor (external contributor or unmapped account): counts only, never excerpts. */
export type OtherActor = { login: string; github: GithubCounts };

export type SourceStatus = {
  ok: boolean;
  warnings: string[];
  /** True when the source could not cover the whole window (e.g. archive/API stops early). */
  stale?: boolean;
  /** Diagnostic counters, e.g. apiCalls, rateLimitRemaining, reposScanned, searchSplits. */
  stats: Record<string, number | string>;
};

export type ReportDocument = {
  version: 1;
  period: PeriodDescriptor;
  generatedAtMs: number;
  status: "partial" | "closed";
  orgs: string[];
  memberCount: number;
  activeMembers: number;
  totals: {
    github: GithubCounts;
    discord: { messages: number; channels: Record<string, number> };
  };
  /** Sorted by activity descending; quiet members last. */
  members: PersonReport[];
  otherActors: OtherActor[];
  /** Discord authors that produced messages but map to no member (id + count only). */
  unmatchedDiscord: Array<{ authorId: string; messages: number }>;
  sources: { github: SourceStatus; discord?: SourceStatus };
  truncated?: boolean;
};

export type SummaryDocument = {
  source: "model" | "fallback";
  model?: string;
  generatedAtMs: number;
  /** Markdown: 2-3 sentence overview followed by 4-6 "- **Workstream:** ..." bullets. */
  globalSummary: string;
  /** 4-7 one-line bullets naming concrete work streams. */
  highlights: string[];
  /** sha256 of the evidence digest; regeneration is skipped while unchanged. */
  fingerprint: string;
};

// ---------------------------------------------------------------------------
// Source contracts (implemented under src/sources/github and src/sources/discord)
// ---------------------------------------------------------------------------

type SourceLogger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Per-run context handed to sources. Sources must honor `signal` and never log credentials. */
export type SourceRuntime = {
  logger: SourceLogger;
  signal?: AbortSignal;
  /** Test seam; production uses the SDK guarded fetch. */
  fetchImpl?: FetchLike;
};

/** Resolved (secret already materialized) GitHub source configuration. */
export type GithubSourceConfig = {
  token: string;
  orgs: string[];
  teams: Array<{ org: string; slug: string }>;
  includeDirectCollaborators: boolean;
  /** "owner/name" entries to skip. */
  excludeRepos: string[];
  apiBaseUrl: string;
  /** Compiled from config `github.ignoreCommentPatterns`. */
  ignoreCommentPatterns: RegExp[];
};

/** Resolved (secret already materialized) Discord source configuration. */
export type DiscordSourceConfig = {
  token: string;
  guildId: string;
  channels: Array<{ id: string; excerpts: boolean }>;
  excerptMaxChars: number;
  apiBaseUrl: string;
};

export interface GithubSource {
  /** Roster from configured org teams (and direct collaborators when enabled). Returns people with `github: [login]`. */
  loadRoster(config: GithubSourceConfig): Promise<{ people: Person[]; status: SourceStatus }>;
  /** All GitHub items in the window across configured orgs; attribution rules live in aggregate, not here, except merged_by lookup. */
  collect(
    config: GithubSourceConfig,
    window: ActivityWindow,
    roster: Roster,
  ): Promise<{ items: GithubItem[]; status: SourceStatus }>;
}

export interface DiscordSource {
  /** Messages in the window from configured channels and their threads. */
  collect(
    config: DiscordSourceConfig,
    window: ActivityWindow,
    roster: Roster,
  ): Promise<{ messages: DiscordMessage[]; status: SourceStatus }>;
}
