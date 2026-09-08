import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  configureSqliteConnectionPragmas,
  migrateSqliteSchemaToStrict,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  openNodeSqliteDatabase,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { MAX_REPORT_BYTES } from "./limits.js";
import { DAY_MS } from "./periods.js";
import {
  reportDocumentSchema,
  runPeriodsSchema,
  runStatsSchema,
  summaryDocumentSchema,
  TEAM_REPORTS_SCHEMA_SQL,
} from "./store-schema.js";
import type { Period, ReportDocument, SummaryDocument } from "./types.js";

type StoredPeriod = {
  report: ReportDocument;
  summary: SummaryDocument | null;
  markdown: string;
};
export type PeriodListEntry = {
  period: Period;
  key: string;
  sinceMs: number;
  untilMs: number;
  status: "partial" | "closed";
  generatedAtMs: number;
  activeMembers: number;
  memberCount: number;
  githubTotal: number;
  discordMessages: number;
  commits: number;
  prsOpened: number;
  prsMerged: number;
  securityAdvisories: number;
};
export type PersonDay = {
  dayKey: string;
  login: string;
  githubTotal: number;
  commits: number;
  prsOpened: number;
  prsMerged: number;
  prsClosed: number;
  issuesOpened: number;
  issuesClosed: number;
  issueComments: number;
  reviewComments: number;
  discordMessages: number;
};
type RunPeriod = { period: Period; key: string };
type ReportRun = {
  id: string;
  kind: "closed-day" | "intraday" | "manual";
  startedAtMs: number;
  finishedAtMs: number | null;
  status: "running" | "ok" | "error";
  periods: RunPeriod[];
  stats: Record<string, unknown> | null;
  error: string | null;
};

type PeriodRow = {
  period: Period;
  period_key: string;
  since_ms: number;
  until_ms: number;
  status: "partial" | "closed";
  generated_at_ms: number;
  data_json: string;
  summary_json: string | null;
  markdown: string;
};
type PersonDayRow = {
  day_key: string;
  login: string;
  github_total: number;
  commits: number;
  prs_opened: number;
  prs_merged: number;
  prs_closed: number;
  issues_opened: number;
  issues_closed: number;
  issue_comments: number;
  review_comments: number;
  discord_messages: number;
};
type RunRow = {
  id: string;
  kind: ReportRun["kind"];
  started_at_ms: number;
  finished_at_ms: number | null;
  status: ReportRun["status"];
  periods_json: string;
  stats_json: string | null;
  error: string | null;
};
type ReportsDatabase = {
  team_reports_schema_migrations: { id: string; applied_at: number };
  team_reports_periods: PeriodRow;
  team_reports_person_days: PersonDayRow;
  team_reports_runs: RunRow;
};

function readPeriod(row: PeriodRow): StoredPeriod {
  return {
    report: reportDocumentSchema.parse(JSON.parse(row.data_json)),
    summary:
      row.summary_json === null ? null : summaryDocumentSchema.parse(JSON.parse(row.summary_json)),
    markdown: row.markdown,
  };
}

function chmodIfExists(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

export class TeamReportsStore {
  private closed = false;
  private readonly query;

  constructor(
    private readonly db: DatabaseSync,
    private readonly maintenance: ReturnType<typeof configureSqliteConnectionPragmas>,
  ) {
    this.query = getNodeSqliteKysely<ReportsDatabase>(db);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Team Reports store is closed.");
    }
  }

  upsertPeriod(value: Omit<StoredPeriod, "summary"> & { summary?: SummaryDocument | null }): void {
    this.assertOpen();
    const { report } = value;
    const dataJson = JSON.stringify(report);
    if (Buffer.byteLength(dataJson, "utf8") > MAX_REPORT_BYTES) {
      throw new Error("Team Reports document exceeds the 2 MiB storage limit.");
    }
    const row: PeriodRow = {
      period: report.period.period,
      period_key: report.period.key,
      since_ms: report.period.sinceMs,
      until_ms: report.period.untilMs,
      status: report.status,
      generated_at_ms: report.generatedAtMs,
      data_json: dataJson,
      summary_json: value.summary ? JSON.stringify(value.summary) : null,
      markdown: value.markdown,
    };
    const people: PersonDayRow[] = report.members.map((member) => ({
      day_key: report.period.key,
      login: member.login.toLowerCase(),
      github_total: member.github.total,
      commits: member.github.commits,
      prs_opened: member.github.prsOpened,
      prs_merged: member.github.prsMerged,
      prs_closed: member.github.prsClosed,
      issues_opened: member.github.issuesOpened,
      issues_closed: member.github.issuesClosed,
      issue_comments: member.github.issueComments,
      review_comments: member.github.reviewComments,
      discord_messages: member.discord.total,
    }));
    runSqliteImmediateTransactionSync(this.db, () => {
      executeSqliteQuerySync(
        this.db,
        this.query
          .insertInto("team_reports_periods")
          .values(row)
          .onConflict((conflict) => conflict.columns(["period", "period_key"]).doUpdateSet(row)),
      );
      if (report.period.period === "day") {
        // Replacing the whole day also removes people excluded by a refreshed roster.
        executeSqliteQuerySync(
          this.db,
          this.query
            .deleteFrom("team_reports_person_days")
            .where("day_key", "=", report.period.key),
        );
        for (const person of people) {
          executeSqliteQuerySync(
            this.db,
            this.query.insertInto("team_reports_person_days").values(person),
          );
        }
      }
    });
  }

  getPeriod(period: Period, key: string): StoredPeriod | undefined {
    this.assertOpen();
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("team_reports_periods")
        .selectAll()
        .where("period", "=", period)
        .where("period_key", "=", key),
    );
    return row ? readPeriod(row) : undefined;
  }

  listPeriods(
    options: {
      period?: Period;
      status?: "partial" | "closed";
      limit?: number;
    } = {},
  ): PeriodListEntry[] {
    this.assertOpen();
    let query = this.query
      .selectFrom("team_reports_periods")
      .select([
        "period",
        "period_key as key",
        "since_ms as sinceMs",
        "until_ms as untilMs",
        "status",
        "generated_at_ms as generatedAtMs",
      ])
      // SQLite extracts only the chart totals instead of materializing every report in JavaScript.
      .select((eb) => [
        eb.fn<number>("json_extract", ["data_json", eb.val("$.activeMembers")]).as("activeMembers"),
        eb.fn<number>("json_extract", ["data_json", eb.val("$.memberCount")]).as("memberCount"),
        eb
          .fn<number>("json_extract", ["data_json", eb.val("$.totals.github.total")])
          .as("githubTotal"),
        eb
          .fn<number>("json_extract", ["data_json", eb.val("$.totals.discord.messages")])
          .as("discordMessages"),
        eb
          .fn<number>("json_extract", ["data_json", eb.val("$.totals.github.commits")])
          .as("commits"),
        eb
          .fn<number>("json_extract", ["data_json", eb.val("$.totals.github.prsOpened")])
          .as("prsOpened"),
        eb
          .fn<number>("json_extract", ["data_json", eb.val("$.totals.github.prsMerged")])
          .as("prsMerged"),
        eb
          .fn<number>("json_extract", ["data_json", eb.val("$.totals.github.securityAdvisories")])
          .as("securityAdvisories"),
      ])
      .orderBy("since_ms", "desc")
      .orderBy("period", "asc");
    if (options.period) {
      query = query.where("period", "=", options.period);
    }
    if (options.status) {
      query = query.where("status", "=", options.status);
    }
    return executeSqliteQuerySync(this.db, query.limit(options.limit ?? 180)).rows;
  }

  getDayReports(sinceMs: number, untilMs: number): ReportDocument[] {
    this.assertOpen();
    return executeSqliteQuerySync(
      this.db,
      this.query
        .selectFrom("team_reports_periods")
        .select("data_json")
        .where("period", "=", "day")
        .where("since_ms", ">=", sinceMs)
        .where("since_ms", "<", untilMs)
        .orderBy("since_ms", "asc"),
    ).rows.map((row) => reportDocumentSchema.parse(JSON.parse(row.data_json)));
  }

  listPersonDays(
    login: string,
    options: { since?: string; until?: string; limit?: number } = {},
  ): PersonDay[] {
    this.assertOpen();
    let query = this.selectPersonDays()
      .where("login", "=", login.toLowerCase())
      .orderBy("day_key", "desc");
    if (options.since) {
      query = query.where("day_key", ">=", options.since);
    }
    if (options.until) {
      query = query.where("day_key", "<", options.until);
    }
    return executeSqliteQuerySync(this.db, query.limit(options.limit ?? 28)).rows;
  }

  listPersonDaysSince(since: string): PersonDay[] {
    this.assertOpen();
    return executeSqliteQuerySync(
      this.db,
      this.selectPersonDays()
        .where("day_key", ">=", since)
        .orderBy("day_key", "desc")
        .orderBy("login", "asc"),
    ).rows;
  }

  private selectPersonDays() {
    return this.query
      .selectFrom("team_reports_person_days")
      .select([
        "day_key as dayKey",
        "login",
        "github_total as githubTotal",
        "commits",
        "prs_opened as prsOpened",
        "prs_merged as prsMerged",
        "prs_closed as prsClosed",
        "issues_opened as issuesOpened",
        "issues_closed as issuesClosed",
        "issue_comments as issueComments",
        "review_comments as reviewComments",
        "discord_messages as discordMessages",
      ]);
  }

  startRun(run: {
    id: string;
    kind: ReportRun["kind"];
    startedAtMs: number;
    periods: RunPeriod[];
  }): void {
    this.assertOpen();
    executeSqliteQuerySync(
      this.db,
      this.query.insertInto("team_reports_runs").values({
        id: run.id,
        kind: run.kind,
        started_at_ms: run.startedAtMs,
        finished_at_ms: null,
        status: "running",
        periods_json: JSON.stringify(run.periods),
        stats_json: null,
        error: null,
      }),
    );
  }

  finishRun(
    id: string,
    result: {
      finishedAtMs: number;
      status: "ok" | "error";
      stats?: Record<string, unknown>;
      error?: string;
    },
  ): void {
    this.assertOpen();
    const updated = executeSqliteQuerySync(
      this.db,
      this.query
        .updateTable("team_reports_runs")
        .set({
          finished_at_ms: result.finishedAtMs,
          status: result.status,
          stats_json: result.stats ? JSON.stringify(result.stats) : null,
          error: result.error?.slice(0, 2000) ?? null,
        })
        .where("id", "=", id)
        .where("status", "=", "running"),
    );
    if (updated.numAffectedRows !== 1n) {
      throw new Error(`Team Reports run ${id} is not running.`);
    }
  }

  listRuns(
    limit = 20,
    filter: { kind?: ReportRun["kind"]; status?: ReportRun["status"] } = {},
  ): ReportRun[] {
    this.assertOpen();
    let query = this.query.selectFrom("team_reports_runs").selectAll();
    if (filter.kind) {
      query = query.where("kind", "=", filter.kind);
    }
    if (filter.status) {
      query = query.where("status", "=", filter.status);
    }
    return executeSqliteQuerySync(
      this.db,
      query.orderBy("started_at_ms", "desc").orderBy("id", "asc").limit(limit),
    ).rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      startedAtMs: row.started_at_ms,
      finishedAtMs: row.finished_at_ms,
      status: row.status,
      periods: runPeriodsSchema.parse(JSON.parse(row.periods_json)),
      stats: row.stats_json === null ? null : runStatsSchema.parse(JSON.parse(row.stats_json)),
      error: row.error,
    }));
  }

  prune(
    retentionDays: number,
    nowMs = Date.now(),
  ): { periods: number; personDays: number; runs: number } {
    this.assertOpen();
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 0) {
      throw new Error("Team Reports retention days must be a nonnegative integer.");
    }
    if (retentionDays === 0) {
      return { periods: 0, personDays: 0, runs: 0 };
    }
    const cutoffMs = Math.floor(nowMs / DAY_MS) * DAY_MS - retentionDays * DAY_MS;
    const cutoffDay = new Date(cutoffMs).toISOString().slice(0, 10);
    return runSqliteImmediateTransactionSync(this.db, () => ({
      // Preserve week/month reports that overlap the retained window.
      periods: Number(
        executeSqliteQuerySync(
          this.db,
          this.query.deleteFrom("team_reports_periods").where("until_ms", "<=", cutoffMs),
        ).numAffectedRows ?? 0n,
      ),
      personDays: Number(
        executeSqliteQuerySync(
          this.db,
          this.query.deleteFrom("team_reports_person_days").where("day_key", "<", cutoffDay),
        ).numAffectedRows ?? 0n,
      ),
      runs: Number(
        executeSqliteQuerySync(
          this.db,
          this.query
            .deleteFrom("team_reports_runs")
            .where("started_at_ms", "<", cutoffMs)
            .where("status", "!=", "running"),
        ).numAffectedRows ?? 0n,
      ),
    }));
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.maintenance.close();
    } finally {
      this.db.close();
    }
  }
}

export function createTeamReportsStore(
  options: { stateDir?: string; dbPath?: string } = {},
): TeamReportsStore {
  const dbPath =
    options.dbPath ??
    path.join(
      options.stateDir ?? resolveStateDir(),
      "plugins",
      "team-reports",
      "team-reports.sqlite",
    );
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(dbPath), 0o700);
  if (!fs.existsSync(dbPath)) {
    fs.closeSync(fs.openSync(dbPath, "a", 0o600));
  }
  const db = openNodeSqliteDatabase(dbPath);
  let maintenance: ReturnType<typeof configureSqliteConnectionPragmas> | undefined;
  try {
    maintenance = configureSqliteConnectionPragmas(db, {
      busyTimeoutMs: 5000,
      checkpointIntervalMs: 0,
      databaseLabel: "team-reports database",
      databasePath: dbPath,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    db.exec(TEAM_REPORTS_SCHEMA_SQL);
    const query = getNodeSqliteKysely<ReportsDatabase>(db);
    const migration = executeSqliteQueryTakeFirstSync(
      db,
      query.selectFrom("team_reports_schema_migrations").select("id").where("id", "=", "schema-1"),
    );
    if (!migration) {
      migrateSqliteSchemaToStrict(db, TEAM_REPORTS_SCHEMA_SQL, {
        databaseLabel: "team-reports database",
      });
      executeSqliteQuerySync(
        db,
        query
          .insertInto("team_reports_schema_migrations")
          .values({ id: "schema-1", applied_at: Date.now() })
          .onConflict((conflict) => conflict.column("id").doNothing()),
      );
    }
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
      chmodIfExists(file);
    }
    return new TeamReportsStore(db, maintenance);
  } catch (error) {
    try {
      maintenance?.close();
    } finally {
      db.close();
    }
    throw error;
  }
}
