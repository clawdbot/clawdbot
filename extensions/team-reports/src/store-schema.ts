import { z } from "zod";
import { periodSchema } from "./periods.js";

export const TEAM_REPORTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS team_reports_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS team_reports_periods (
  period TEXT NOT NULL,
  period_key TEXT NOT NULL,
  since_ms INTEGER NOT NULL,
  until_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  generated_at_ms INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  summary_json TEXT,
  markdown TEXT NOT NULL,
  PRIMARY KEY (period, period_key)
) STRICT;

CREATE TABLE IF NOT EXISTS team_reports_person_days (
  day_key TEXT NOT NULL,
  login TEXT NOT NULL,
  github_total INTEGER NOT NULL,
  commits INTEGER NOT NULL,
  prs_opened INTEGER NOT NULL,
  prs_merged INTEGER NOT NULL,
  prs_closed INTEGER NOT NULL,
  issues_opened INTEGER NOT NULL,
  issues_closed INTEGER NOT NULL,
  issue_comments INTEGER NOT NULL,
  review_comments INTEGER NOT NULL,
  discord_messages INTEGER NOT NULL,
  PRIMARY KEY (day_key, login)
) STRICT;

CREATE TABLE IF NOT EXISTS team_reports_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  status TEXT NOT NULL,
  periods_json TEXT NOT NULL,
  stats_json TEXT,
  error TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_team_reports_runs_started
  ON team_reports_runs(started_at_ms DESC);
`;

const countsSchema = z.object({
  total: z.number(),
  commits: z.number(),
  prsOpened: z.number(),
  prsMerged: z.number(),
  prsClosed: z.number(),
  issuesOpened: z.number(),
  issuesClosed: z.number(),
  issueComments: z.number(),
  reviewComments: z.number(),
  securityAdvisories: z.number(),
  /** "owner/name" -> count */
  repos: z.record(z.string(), z.number()),
});
const sourceStatusSchema = z.object({
  ok: z.boolean(),
  warnings: z.array(z.string()),
  /** True when the source could not cover the whole window (e.g. archive/API stops early). */
  stale: z.boolean().optional(),
  /** Diagnostic counters, e.g. apiCalls, rateLimitRemaining, reposScanned, searchSplits. */
  stats: z.record(z.string(), z.union([z.number(), z.string()])),
});
const summarySourceSchema = z.enum(["model", "fallback"]);

// Stored JSON is an external data boundary, including after restores and upgrades.
export const reportDocumentSchema = z.object({
  version: z.literal(1),
  period: z.object({
    period: periodSchema,
    /** "2026-08-20" | "2026-W34" | "2026-08" */
    key: z.string(),
    sinceMs: z.number(),
    untilMs: z.number(),
    title: z.string(),
  }),
  generatedAtMs: z.number(),
  status: z.enum(["partial", "closed"]),
  orgs: z.array(z.string()),
  memberCount: z.number(),
  activeMembers: z.number(),
  totals: z.object({
    github: countsSchema,
    discord: z.object({ messages: z.number(), channels: z.record(z.string(), z.number()) }),
  }),
  /** Sorted by activity descending; quiet members last. */
  members: z.array(
    z.object({
      login: z.string(),
      display: z.string(),
      affiliation: z.string().optional(),
      roleGroup: z.string().optional(),
      roleLabel: z.string().optional(),
      access: z.array(z.string()),
      areas: z.array(z.string()),
      /** Other GitHub logins mapped to this person. */
      aliases: z.array(z.string()),
      github: countsSchema.extend({
        items: z.array(
          z.object({
            kind: z.enum([
              "commit",
              "pr_opened",
              "pr_merged",
              "pr_closed",
              "issue_opened",
              "issue_closed",
              "issue_comment",
              "review_comment",
              "security_advisory",
            ]),
            /** "owner/name" */
            repo: z.string(),
            number: z.number().optional(),
            title: z.string(),
            url: z.string(),
            atMs: z.number(),
            /** GitHub login credited for this item (merged_by for pr_merged, comment author for comments, commit author for commits). */
            actor: z.string(),
            /** Logins from Co-authored-by trailers (commits only). */
            coauthors: z.array(z.string()).optional(),
            /** Raw comment body, used only for duplicate collapsing and ignore patterns; never rendered. */
            body: z.string().optional(),
          }),
        ),
      }),
      discord: z.object({
        total: z.number(),
        /** channel name -> count */
        channels: z.record(z.string(), z.number()),
        excerpts: z.array(z.object({ channel: z.string(), atMs: z.number(), excerpt: z.string() })),
      }),
      summary: z
        .object({
          text: z.string(),
          confidence: z.enum(["high", "medium", "low"]),
          source: summarySourceSchema,
        })
        .optional(),
    }),
  ),
  otherActors: z.array(z.object({ login: z.string(), github: countsSchema })),
  /** Discord authors that produced messages but map to no member (id + count only). */
  unmatchedDiscord: z.array(z.object({ authorId: z.string(), messages: z.number() })),
  sources: z.object({ github: sourceStatusSchema, discord: sourceStatusSchema.optional() }),
  truncated: z.boolean().optional(),
});

export const summaryDocumentSchema = z.object({
  source: summarySourceSchema,
  warnings: z.array(z.string().max(300)).max(3).optional(),
  model: z.string().optional(),
  generatedAtMs: z.number(),
  /** Markdown: 2-3 sentence overview followed by 4-6 "- **Workstream:** ..." bullets. */
  globalSummary: z.string(),
  /** 4-7 one-line bullets naming concrete work streams. */
  highlights: z.array(z.string()),
  /** sha256 of the evidence digest; regeneration is skipped while unchanged. */
  fingerprint: z.string(),
});
export const runPeriodsSchema = z.array(z.object({ period: periodSchema, key: z.string() }));
export const runStatsSchema = z.record(z.string(), z.unknown());
