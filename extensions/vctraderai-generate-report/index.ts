import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: generate_report (PROPOSE).
//
// PROPOSE_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). This
// tool STAGES a proposal; it NEVER executes the action directly. It POSTs to the
// BFF staged-action chokepoint `POST /api/v1/openclaw/stage` with
// `{ tool_name, workspace_id, params, summary }`. The BFF gates the tool against
// the closed-world allowlist, resolves the target_action_kind + confirm tier
// SERVER-SIDE from the allowlist spec, persists a reviewable staged descriptor,
// and returns it; the human reviews + Applies it in the chat.

export const GENERATE_REPORT_TOOL_NAME = "generate_report";
const STAGE_PATH = "/api/v1/openclaw/stage";

export type GenerateReportDeps = {
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

export type GenerateReportParams = {
  report_type?: string;
  period?: string;
  [key: string]: unknown;
};

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai generate_report: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

function buildSummary(params: GenerateReportParams): string {
  const reportType = typeof params.report_type === "string" ? params.report_type : "";
  return `Generate ${reportType} report`.replace(/\s+/g, " ").trim();
}

export async function runGenerateReport(
  params: GenerateReportParams,
  deps: GenerateReportDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const staged = await bffFetch(STAGE_PATH, {
    method: "POST",
    body: {
      tool_name: GENERATE_REPORT_TOOL_NAME,
      workspace_id: readWorkspaceId(),
      params,
      summary: buildSummary(params),
    },
    signal,
  });
  return {
    staged,
    message: "Staged a generate report proposal. Review + Apply it in the chat.",
  };
}

export default defineToolPlugin({
  id: "vctraderai-generate-report",
  name: "VC Trader AI Generate Report (Propose)",
  description:
    "Stages a workspace-report generation proposal for human review; never generates it directly.",
  tools: (tool) => [
    tool({
      name: GENERATE_REPORT_TOOL_NAME,
      label: "Generate Report",
      description:
        "Generate a workspace report. This STAGES a proposal for the human to review + Apply in the chat - it does NOT execute the action directly. PROPOSE_ONLY per ADR 0078.",
      parameters: Type.Object(
        {
          report_type: Type.Optional(
            Type.String({ description: "Report type (e.g. daily, weekly, performance)." }),
          ),
          period: Type.Optional(
            Type.String({
              description: "Report period (e.g. an ISO date for daily, ISO week for weekly).",
            }),
          ),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGenerateReport(
          params as GenerateReportParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
