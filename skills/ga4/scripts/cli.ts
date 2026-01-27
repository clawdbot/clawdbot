#!/usr/bin/env bun
/**
 * GA4 Analytics CLI - Speakmac analytics at your fingertips
 * Usage: bun skills/ga4/cli.ts <command> [options]
 */

import { BetaAnalyticsDataClient } from "@google-analytics/data";

const CREDENTIALS_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const PROPERTY_ID = process.env.GA4_PROPERTY_ID || "510572418";

if (!CREDENTIALS_PATH) {
  console.error("Error: GOOGLE_APPLICATION_CREDENTIALS environment variable required");
  console.error("Point it to your service account JSON file");
  process.exit(1);
}

let client: BetaAnalyticsDataClient | null = null;

function getClient() {
  if (!client) {
    client = new BetaAnalyticsDataClient();
  }
  return client;
}

type DateRange = { startDate: string; endDate: string };

function getDateRange(period: string): DateRange {
  const ranges: Record<string, DateRange> = {
    today: { startDate: "today", endDate: "today" },
    yesterday: { startDate: "yesterday", endDate: "yesterday" },
    "7d": { startDate: "7daysAgo", endDate: "today" },
    "14d": { startDate: "14daysAgo", endDate: "today" },
    "28d": { startDate: "28daysAgo", endDate: "today" },
    "30d": { startDate: "30daysAgo", endDate: "today" },
    "90d": { startDate: "90daysAgo", endDate: "today" },
  };
  return ranges[period] || ranges["30d"];
}

async function runReport(
  dimensions: string[],
  metrics: string[],
  dateRange: DateRange,
  filter?: any,
  limit = 100
) {
  const c = getClient();
  const request: any = {
    property: `properties/${PROPERTY_ID}`,
    dateRanges: [dateRange],
    dimensions: dimensions.map((d) => ({ name: d })),
    metrics: metrics.map((m) => ({ name: m })),
    limit,
  };
  if (filter) request.dimensionFilter = filter;

  const [response] = await c.runReport(request);

  const results: Record<string, any>[] = [];
  if (response.rows) {
    for (const row of response.rows) {
      const result: Record<string, any> = {};
      dimensions.forEach((dim, i) => {
        result[dim] = row.dimensionValues?.[i]?.value || "(not set)";
      });
      metrics.forEach((metric, i) => {
        result[metric] = row.metricValues?.[i]?.value || "0";
      });
      results.push(result);
    }
  }

  return {
    rowCount: response.rowCount || 0,
    results,
    totals:
      response.totals?.[0]?.metricValues?.map((m, i) => ({
        metric: metrics[i],
        value: m.value,
      })) || [],
  };
}

// Commands
async function overview(period: string) {
  const dateRange = getDateRange(period);
  const data = await runReport(
    ["date"],
    [
      "activeUsers",
      "newUsers",
      "sessions",
      "eventCount",
      "engagementRate",
      "averageSessionDuration",
    ],
    dateRange,
    null,
    50
  );

  // Aggregate totals
  let users = 0,
    newU = 0,
    sessions = 0,
    events = 0;
  for (const row of data.results) {
    users += parseInt(row.activeUsers);
    newU += parseInt(row.newUsers);
    sessions += parseInt(row.sessions);
    events += parseInt(row.eventCount);
  }

  console.log(`📊 GA4 Overview (${period})\n`);
  console.log(`Active Users:  ${users}`);
  console.log(`New Users:     ${newU}`);
  console.log(`Sessions:      ${sessions}`);
  console.log(`Total Events:  ${events}`);

  if (data.totals.length > 0) {
    const engRate = data.totals.find((t) => t.metric === "engagementRate");
    const avgDur = data.totals.find(
      (t) => t.metric === "averageSessionDuration"
    );
    if (engRate)
      console.log(
        `Engagement:    ${(parseFloat(engRate.value || "0") * 100).toFixed(1)}%`
      );
    if (avgDur)
      console.log(
        `Avg Session:   ${Math.round(parseFloat(avgDur.value || "0"))}s`
      );
  }
}

async function realtime() {
  const c = getClient();
  const [response] = await c.runRealtimeReport({
    property: `properties/${PROPERTY_ID}`,
    dimensions: [{ name: "unifiedScreenName" }],
    metrics: [{ name: "activeUsers" }, { name: "eventCount" }],
  });

  const totalUsers =
    response.totals?.[0]?.metricValues?.[0]?.value || "0";

  console.log(`⚡ Real-time (last 30 min)\n`);
  console.log(`Active Users: ${totalUsers}\n`);

  if (response.rows && response.rows.length > 0) {
    console.log("By Screen:");
    for (const row of response.rows.slice(0, 10)) {
      const screen = row.dimensionValues?.[0]?.value || "(unknown)";
      const users = row.metricValues?.[0]?.value || "0";
      console.log(`  ${users.padStart(3)} | ${screen}`);
    }
  }
}

async function events(period: string, limit: number) {
  const dateRange = getDateRange(period);
  const data = await runReport(
    ["eventName"],
    ["eventCount", "eventCountPerUser"],
    dateRange,
    null,
    limit
  );

  console.log(`📈 Events (${period})\n`);
  console.log("Event".padEnd(45) + "Count".padStart(10) + "Per User".padStart(10));
  console.log("-".repeat(65));

  for (const row of data.results) {
    const name = row.eventName.substring(0, 44);
    const count = row.eventCount;
    const perUser = parseFloat(row.eventCountPerUser).toFixed(2);
    console.log(
      name.padEnd(45) + count.toString().padStart(10) + perUser.padStart(10)
    );
  }
}

async function funnel(funnelType: string, period: string) {
  const funnels: Record<string, string[]> = {
    onboarding: [
      "onboarding_started",
      "onboarding_step_completed",
      "permission_prompt_shown",
      "permission_result",
      "demo_transcription_started",
      "demo_transcription_completed",
      "onboarding_completed",
    ],
    transcription: [
      "transcription_started",
      "transcription_completed",
      "transcription_failed",
    ],
    permissions: ["permission_prompt_shown", "permission_result"],
  };

  const events = funnels[funnelType];
  if (!events) {
    console.error(`Unknown funnel: ${funnelType}`);
    console.error(`Available: ${Object.keys(funnels).join(", ")}`);
    process.exit(1);
  }

  const dateRange = getDateRange(period);
  console.log(`🔄 ${funnelType} Funnel (${period})\n`);

  let firstCount = 0;
  for (const event of events) {
    const filter = {
      filter: {
        fieldName: "eventName",
        stringFilter: { value: event, matchType: "EXACT" },
      },
    };
    const data = await runReport(
      ["eventName"],
      ["eventCount", "totalUsers"],
      dateRange,
      filter,
      1
    );

    const count = parseInt(data.results[0]?.eventCount || "0");
    const users = parseInt(data.results[0]?.totalUsers || "0");

    if (firstCount === 0) firstCount = count;
    const pct = firstCount > 0 ? ((count / firstCount) * 100).toFixed(0) : "0";

    console.log(
      `${event.padEnd(35)} ${count.toString().padStart(6)} events (${pct}%)`
    );
  }
}

async function errors(errorType: string, period: string) {
  const dateRange = getDateRange(period);

  let filter: any;
  if (errorType === "transcription") {
    filter = {
      filter: {
        fieldName: "eventName",
        stringFilter: { value: "transcription_failed", matchType: "EXACT" },
      },
    };
  } else if (errorType === "license") {
    filter = {
      filter: {
        fieldName: "eventName",
        stringFilter: {
          value: "license_validation_error",
          matchType: "EXACT",
        },
      },
    };
  } else {
    filter = {
      orGroup: {
        expressions: [
          {
            filter: {
              fieldName: "eventName",
              stringFilter: { value: "transcription_failed", matchType: "EXACT" },
            },
          },
          {
            filter: {
              fieldName: "eventName",
              stringFilter: {
                value: "license_validation_error",
                matchType: "EXACT",
              },
            },
          },
        ],
      },
    };
  }

  const data = await runReport(
    ["eventName"],
    ["eventCount"],
    dateRange,
    filter,
    100
  );

  console.log(`❌ Errors (${period})\n`);

  if (data.results.length === 0) {
    console.log("No errors found! 🎉");
    return;
  }

  for (const row of data.results) {
    console.log(`${row.eventName}: ${row.eventCount}`);
  }
}

async function transcriptions(period: string, breakdownBy: string) {
  const dateRange = getDateRange(period);
  const filter = {
    orGroup: {
      expressions: [
        {
          filter: {
            fieldName: "eventName",
            stringFilter: { value: "transcription_started", matchType: "EXACT" },
          },
        },
        {
          filter: {
            fieldName: "eventName",
            stringFilter: { value: "transcription_completed", matchType: "EXACT" },
          },
        },
        {
          filter: {
            fieldName: "eventName",
            stringFilter: { value: "transcription_failed", matchType: "EXACT" },
          },
        },
      ],
    },
  };

  console.log(`🎤 Transcriptions (${period})\n`);

  if (breakdownBy === "day") {
    // Group by date
    const data = await runReport(
      ["date", "eventName"],
      ["eventCount"],
      dateRange,
      filter,
      500
    );

    const byDate: Record<string, Record<string, number>> = {};
    for (const row of data.results) {
      const date = row.date;
      const event = row.eventName.replace("transcription_", "");
      if (!byDate[date]) byDate[date] = {};
      byDate[date][event] = parseInt(row.eventCount);
    }

    console.log("Date".padEnd(12) + "Started".padStart(10) + "Completed".padStart(12) + "Failed".padStart(10) + "Success".padStart(10));
    console.log("-".repeat(54));

    const dates = Object.entries(byDate).sort(([a], [b]) => b.localeCompare(a));
    for (const [date, events] of dates) {
      const started = events.started || 0;
      const completed = events.completed || 0;
      const failed = events.failed || 0;
      const successRate = started > 0 ? `${((completed / started) * 100).toFixed(0)}%` : "N/A";
      console.log(
        date.padEnd(12) +
          started.toString().padStart(10) +
          completed.toString().padStart(12) +
          failed.toString().padStart(10) +
          successRate.padStart(10)
      );
    }
  } else {
    // Summary totals
    const data = await runReport(
      ["eventName"],
      ["eventCount", "totalUsers"],
      dateRange,
      filter,
      100
    );

    let started = 0, completed = 0, failed = 0;
    for (const row of data.results) {
      if (row.eventName === "transcription_started") started = parseInt(row.eventCount);
      if (row.eventName === "transcription_completed") completed = parseInt(row.eventCount);
      if (row.eventName === "transcription_failed") failed = parseInt(row.eventCount);
    }

    const successRate = started > 0 ? ((completed / started) * 100).toFixed(1) : "N/A";
    console.log(`Started:      ${started}`);
    console.log(`Completed:    ${completed}`);
    console.log(`Failed:       ${failed}`);
    console.log(`Success Rate: ${successRate}%`);
  }
}

async function versions(period: string) {
  const dateRange = getDateRange(period);
  const data = await runReport(
    ["appVersion"],
    ["activeUsers", "newUsers", "sessions"],
    dateRange,
    null,
    20
  );

  console.log(`📱 Version Adoption (${period})\n`);
  console.log(
    "Version".padEnd(20) +
      "Users".padStart(8) +
      "New".padStart(8) +
      "Sessions".padStart(10)
  );
  console.log("-".repeat(46));

  for (const row of data.results) {
    const ver = row.appVersion || "(unknown)";
    console.log(
      ver.padEnd(20) +
        row.activeUsers.padStart(8) +
        row.newUsers.padStart(8) +
        row.sessions.padStart(10)
    );
  }
}

async function growth(period: string) {
  const dateRange = getDateRange(period);
  const data = await runReport(
    ["date"],
    ["activeUsers", "newUsers", "totalUsers", "sessions"],
    dateRange,
    null,
    100
  );

  // Get latest vs earliest for comparison
  const sorted = data.results.sort((a, b) => a.date.localeCompare(b.date));

  let totalNew = 0,
    totalActive = 0;
  for (const row of sorted) {
    totalNew += parseInt(row.newUsers);
    totalActive += parseInt(row.activeUsers);
  }

  console.log(`📈 Growth Metrics (${period})\n`);
  console.log(`Total New Users:    ${totalNew}`);
  console.log(`Total Active Users: ${totalActive}`);
  console.log(`Days Tracked:       ${sorted.length}`);

  if (sorted.length >= 2) {
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    console.log(`\nFirst Day (${first.date}): ${first.activeUsers} active`);
    console.log(`Last Day (${last.date}): ${last.activeUsers} active`);
  }
}

async function query(
  dimensions: string[],
  metrics: string[],
  period: string,
  from?: string,
  to?: string
) {
  let dateRange: DateRange;
  if (from && to) {
    dateRange = { startDate: from, endDate: to };
  } else {
    dateRange = getDateRange(period);
  }

  const data = await runReport(dimensions, metrics, dateRange, null, 500);

  console.log(`📊 Custom Query (${from || period}${to ? ` to ${to}` : ""})\n`);
  console.log(`Rows: ${data.rowCount}\n`);

  // Print header
  const header = [...dimensions, ...metrics].map((h) => h.padEnd(15)).join(" | ");
  console.log(header);
  console.log("-".repeat(header.length));

  // Print rows
  for (const row of data.results) {
    const values = [...dimensions, ...metrics]
      .map((key) => String(row[key] || "").padEnd(15))
      .join(" | ");
    console.log(values);
  }

  // Print totals if available
  if (data.totals.length > 0) {
    console.log("\nTotals:");
    for (const t of data.totals) {
      console.log(`  ${t.metric}: ${t.value}`);
    }
  }
}

async function weekly(from: string, to: string) {
  const dateRange = { startDate: from, endDate: to };
  const data = await runReport(
    ["week", "date"],
    ["activeUsers", "newUsers", "sessions"],
    dateRange,
    null,
    500
  );

  // Group by week
  const byWeek: Record<string, { users: number; newUsers: number; sessions: number; dates: string[] }> = {};

  for (const row of data.results) {
    const week = row.week;
    if (!byWeek[week]) {
      byWeek[week] = { users: 0, newUsers: 0, sessions: 0, dates: [] };
    }
    byWeek[week].users += parseInt(row.activeUsers);
    byWeek[week].newUsers += parseInt(row.newUsers);
    byWeek[week].sessions += parseInt(row.sessions);
    byWeek[week].dates.push(row.date);
  }

  console.log(`📊 Weekly Traffic (${from} to ${to})\n`);
  console.log("Week".padEnd(6) + "Users".padStart(8) + "New".padStart(8) + "Sessions".padStart(10));
  console.log("-".repeat(32));

  const weeks = Object.entries(byWeek).sort(([a], [b]) => a.localeCompare(b));
  for (const [week, stats] of weeks) {
    console.log(
      week.padEnd(6) +
        stats.users.toString().padStart(8) +
        stats.newUsers.toString().padStart(8) +
        stats.sessions.toString().padStart(10)
    );
  }
}

// Help
function help() {
  console.log(`
GA4 Analytics CLI (Speakmac)

Usage: ga4 <command> [options]

Commands:
  overview [--period 30d]           Key metrics overview
  realtime                          Active users right now
  events [--period 30d] [--limit N] Event counts
  funnel <type> [--period 30d]      Funnel analysis
    Types: onboarding, transcription, permissions
  errors [--type all] [--period 7d] Error analysis
    Types: all, transcription, license
  transcriptions [--period 7d]      Transcription stats
    --by day                        Daily breakdown
  versions [--period 14d]           App version adoption
  growth [--period 30d]             Growth metrics
  weekly --from YYYY-MM-DD --to YYYY-MM-DD
                                    Week-by-week traffic breakdown
  query --dimensions d1,d2 --metrics m1,m2 [--from DATE --to DATE]
                                    Custom query (like MCP ga4_custom_query)

Periods: today, yesterday, 7d, 14d, 28d, 30d, 90d

Environment:
  GOOGLE_APPLICATION_CREDENTIALS   Path to service account JSON
  GA4_PROPERTY_ID                  GA4 property ID (default: 510572418)

Examples:
  ga4 overview
  ga4 realtime
  ga4 events --limit 20
  ga4 funnel onboarding
  ga4 transcriptions --by day
  ga4 versions --period 7d
  ga4 weekly --from 2025-11-01 --to 2026-01-20
  ga4 query --dimensions week --metrics activeUsers,sessions --from 2025-11-01 --to 2026-01-20
`);
}

// Main
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  // Parse flags
  const flags: Record<string, string> = {};
  let positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      flags[key] = args[i + 1] || "true";
      i++;
    } else {
      positional.push(args[i]);
    }
  }

  const period = flags.period || "30d";

  try {
    switch (cmd) {
      case "overview":
        await overview(period);
        break;
      case "realtime":
        await realtime();
        break;
      case "events":
        await events(period, parseInt(flags.limit) || 50);
        break;
      case "funnel":
        const funnelType = positional[0];
        if (!funnelType) {
          console.error("Usage: ga4 funnel <type>");
          console.error("Types: onboarding, transcription, permissions");
          process.exit(1);
        }
        await funnel(funnelType, period);
        break;
      case "errors":
        await errors(flags.type || "all", flags.period || "7d");
        break;
      case "transcriptions":
        await transcriptions(flags.period || "7d", flags.by || "summary");
        break;
      case "versions":
        await versions(flags.period || "14d");
        break;
      case "growth":
        await growth(period);
        break;
      case "weekly":
        if (!flags.from || !flags.to) {
          console.error("Usage: ga4 weekly --from YYYY-MM-DD --to YYYY-MM-DD");
          process.exit(1);
        }
        await weekly(flags.from, flags.to);
        break;
      case "query":
        if (!flags.dimensions || !flags.metrics) {
          console.error("Usage: ga4 query --dimensions d1,d2 --metrics m1,m2 [--from DATE --to DATE]");
          process.exit(1);
        }
        await query(
          flags.dimensions.split(","),
          flags.metrics.split(","),
          period,
          flags.from,
          flags.to
        );
        break;
      case "help":
      case "--help":
      case "-h":
      case undefined:
        help();
        break;
      default:
        console.error(`Unknown command: ${cmd}`);
        help();
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

main();
