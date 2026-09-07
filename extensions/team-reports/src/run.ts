import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { aggregateDay, aggregateDays, boundReportDocument } from "./aggregate.js";
import type { TeamReportsConfig, resolveTeamReportsConfig } from "./config.js";
import { describePeriod } from "./periods.js";
import { renderMarkdown } from "./render/markdown.js";
import { buildRoster } from "./roster.js";
import { createDiscordSource, createGithubSource } from "./sources/index.js";
import type { TeamReportsStore } from "./store.js";
import { generateSummaries } from "./summaries.js";
import type {
  DiscordSource,
  GithubSource,
  Person,
  PeriodDescriptor,
  SourceRuntime,
  SourceStatus,
} from "./types.js";

export type ResolvedTeamReportsConfig = Awaited<ReturnType<typeof resolveTeamReportsConfig>>;
export type ReportSourceFactory = (runtime: SourceRuntime) => {
  github: GithubSource;
  discord?: DiscordSource;
};

export function createReportSources(runtime: SourceRuntime, discordEnabled: boolean) {
  return {
    github: createGithubSource(runtime),
    discord: discordEnabled ? createDiscordSource(runtime) : undefined,
  };
}

export function runPeriods(
  config: TeamReportsConfig,
  days: PeriodDescriptor[],
): PeriodDescriptor[] {
  const periods = new Map(days.map((day) => [`day/${day.key}`, day]));
  // Also close the week/month containing yesterday when the calendar rolls over.
  for (const day of days) {
    for (const period of ["week", "month"] as const) {
      if (period === "week" ? config.schedule.weekly : config.schedule.monthly) {
        const descriptor = describePeriod(period, day.sinceMs);
        periods.set(`${period}/${descriptor.key}`, descriptor);
      }
    }
  }
  return [...periods.values()];
}

export async function generateReportPeriods(params: {
  config: TeamReportsConfig;
  resolved: ResolvedTeamReportsConfig;
  store: TeamReportsStore;
  llm: OpenClawPluginApi["runtime"]["llm"];
  periods: PeriodDescriptor[];
  runtime: SourceRuntime & { signal: AbortSignal };
  sources: ReportSourceFactory;
  onRoster: (people: Person[]) => void;
}): Promise<Record<string, SourceStatus>> {
  const { config, resolved, store, runtime } = params;
  const sources = params.sources(runtime);
  const loaded = await sources.github.loadRoster(resolved.github);
  runtime.signal.throwIfAborted();
  if (!loaded.status.ok) {
    throw new Error("GitHub roster unavailable; check token access and configured teams");
  }
  const roster = buildRoster(resolved.people, loaded.people);
  params.onRoster([...new Set(roster.byLogin.values())]);
  const statuses: Record<string, SourceStatus> = {};
  for (const period of params.periods) {
    runtime.signal.throwIfAborted();
    const previous = store.getPeriod(period.period, period.key);
    let report;
    if (period.period === "day") {
      const cutoffMs = Date.now();
      const window = { sinceMs: period.sinceMs, untilMs: Math.min(cutoffMs, period.untilMs) };
      const github = await sources.github.collect(resolved.github, window, roster);
      runtime.signal.throwIfAborted();
      const discord =
        resolved.discord && sources.discord
          ? await sources.discord.collect(resolved.discord, window, roster)
          : undefined;
      runtime.signal.throwIfAborted();
      const githubStatus: SourceStatus = {
        ...github.status,
        warnings: [...new Set([...loaded.status.warnings, ...github.status.warnings])],
        stale: loaded.status.stale || github.status.stale,
      };
      report = aggregateDay({
        period,
        nowMs: cutoffMs,
        orgs: resolved.github.orgs,
        roster,
        items: github.items,
        messages: discord?.messages ?? [],
        githubStatus,
        discordStatus: discord?.status,
        ignoreCommentPatterns: resolved.github.ignoreCommentPatterns,
        discordConfig: resolved.discord,
      });
      report.generatedAtMs = Date.now();
    } else {
      report = aggregateDays({
        period,
        nowMs: Date.now(),
        days: store.getDayReports(period.sinceMs, period.untilMs),
        roster,
        orgs: resolved.github.orgs,
      });
    }
    statuses[`${period.period}/${period.key}/github`] = report.sources.github;
    if (report.sources.discord) {
      statuses[`${period.period}/${period.key}/discord`] = report.sources.discord;
    }
    // Commit collected evidence before the model call, including deterministic text for readers.
    const fallback = await generateSummaries({
      report,
      options: { enabled: false },
      llm: params.llm,
      signal: runtime.signal,
    });
    runtime.signal.throwIfAborted();
    const boundedFallback = boundReportDocument(fallback.report);
    store.upsertPeriod({
      report: boundedFallback,
      summary: fallback.summary,
      markdown: renderMarkdown(boundedFallback, fallback.summary),
    });
    if (config.summaries.enabled) {
      const summarized = await generateSummaries({
        report,
        options: config.summaries,
        llm: params.llm,
        logger: runtime.logger,
        previous: previous?.summary
          ? { report: previous.report, summary: previous.summary }
          : undefined,
        signal: runtime.signal,
      });
      runtime.signal.throwIfAborted();
      const bounded = boundReportDocument(summarized.report);
      store.upsertPeriod({
        report: bounded,
        summary: summarized.summary,
        markdown: renderMarkdown(bounded, summarized.summary),
      });
    }
  }
  return statuses;
}
