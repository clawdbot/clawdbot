import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: generate_weekly_report.
//
// READ_ONLY per ADR 0078. Calls the BFF
// `POST /api/v1/openclaw/reports/weekly` endpoint which computes a weekly
// trading-report envelope from existing decision-ledger / trade-fill data
// and returns it verbatim. No mutation - the BFF persists nothing on this
// path; the report is rebuilt on each call.

export const GENERATE_WEEKLY_REPORT_TOOL_NAME = "generate_weekly_report";

export type GenerateWeeklyReportDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /**
   * Per-turn BFF thread id for the CURRENT turn. Forwarded to the BFF as the
   * `X-OpenClaw-Thread` header so it can identify which sub-agent (specialist)
   * is calling and enforce its granted authority. Sourced from the plugin
   * execute context (`context.threadId`).
   */
  threadId?: string;
};

export type GenerateWeeklyReportParams = {
  workspace_id: string;
  week_ending?: string;
};

export async function runGenerateWeeklyReport(
  params: GenerateWeeklyReportParams,
  deps: GenerateWeeklyReportDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const body: Record<string, unknown> = { workspace_id: params.workspace_id };
  if (typeof params.week_ending === "string" && params.week_ending.length > 0) {
    body.week_ending = params.week_ending;
  }
  return bffFetch("/api/v1/openclaw/reports/weekly", {
    method: "POST",
    body,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-generate-weekly-report",
  name: "VC Trader AI Generate Weekly Report",
  description: "Read-only generator for the workspace weekly trading report.",
  tools: (tool) => [
    tool({
      name: GENERATE_WEEKLY_REPORT_TOOL_NAME,
      label: "Generate Weekly Report",
      description:
        "Compute and return the weekly trading report envelope for a workspace. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        workspace_id: Type.String({
          description: "Workspace UUID (lowercase hex with dashes).",
          minLength: 1,
        }),
        week_ending: Type.Optional(
          Type.String({
            description:
              "Optional week-ending date in ISO-8601 form (YYYY-MM-DD). Defaults to BFF-side latest closed week.",
            minLength: 1,
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGenerateWeeklyReport(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
