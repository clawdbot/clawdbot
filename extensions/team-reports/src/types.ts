import type { z } from "zod";
import type { reportDocumentSchema, summaryDocumentSchema } from "./store-schema.js";

export type { Period, PeriodDescriptor } from "./periods.js";

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

export type GithubItemKind = GithubItem["kind"];

export type GithubItem = PersonReport["github"]["items"][number];

export type GithubCounts = ReportDocument["totals"]["github"];

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

export type PersonReport = ReportDocument["members"][number];

/** Non-member GitHub actor (external contributor or unmapped account): counts only, never excerpts. */
export type OtherActor = ReportDocument["otherActors"][number];

export type SourceStatus = ReportDocument["sources"]["github"];

export type ReportDocument = z.infer<typeof reportDocumentSchema>;

export type SummaryDocument = z.infer<typeof summaryDocumentSchema>;

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
