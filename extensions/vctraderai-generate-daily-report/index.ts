import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: generate_daily_report.
//
// READ_ONLY per ADR 0078. Calls the BFF
// `POST /api/v1/openclaw/reports/daily` endpoint which computes a daily
// trading-report envelope from existing decision-ledger / trade-fill data
// and returns it verbatim. No mutation - the BFF persists nothing on this
// path; the report is rebuilt on each call.

export const GENERATE_DAILY_REPORT_TOOL_NAME = "generate_daily_report";

export type GenerateDailyReportDeps = {
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

export type GenerateDailyReportParams = {
  workspace_id: string;
  day?: string;
};

export async function runGenerateDailyReport(
  params: GenerateDailyReportParams,
  deps: GenerateDailyReportDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const body: Record<string, unknown> = { workspace_id: params.workspace_id };
  if (typeof params.day === "string" && params.day.length > 0) {
    body.day = params.day;
  }
  return bffFetch("/api/v1/openclaw/reports/daily", {
    method: "POST",
    body,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-generate-daily-report",
  name: "VC Trader AI Generate Daily Report",
  description: "Read-only generator for the workspace daily trading report.",
  tools: (tool) => [
    tool({
      name: GENERATE_DAILY_REPORT_TOOL_NAME,
      label: "Generate Daily Report",
      description:
        "Compute and return the daily trading report envelope for a workspace. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        workspace_id: Type.String({
          description: "Workspace UUID (lowercase hex with dashes).",
          minLength: 1,
        }),
        day: Type.Optional(
          Type.String({
            description:
              "Optional report day in ISO-8601 date form (YYYY-MM-DD). Defaults to BFF-side latest closed session.",
            minLength: 1,
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGenerateDailyReport(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
