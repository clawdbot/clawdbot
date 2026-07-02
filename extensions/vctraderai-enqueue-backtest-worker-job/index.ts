import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: enqueue_backtest_worker_job (PROPOSE).
//
// PROPOSE_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). This
// tool STAGES a proposal; it NEVER executes the action directly. It POSTs to the
// BFF staged-action chokepoint `POST /api/v1/openclaw/stage` with
// `{ tool_name, workspace_id, params, summary }`. The BFF gates the tool against
// the closed-world allowlist, resolves the target_action_kind + confirm tier
// SERVER-SIDE from the allowlist spec, persists a reviewable staged descriptor,
// and returns it; the human reviews + Applies it in the chat.

export const ENQUEUE_BACKTEST_WORKER_JOB_TOOL_NAME = "enqueue_backtest_worker_job";
const STAGE_PATH = "/api/v1/openclaw/stage";

export type EnqueueBacktestWorkerJobDeps = {
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

export type EnqueueBacktestWorkerJobParams = {
  trader_def_id?: string;
  strategy_id?: string;
  instrument?: string;
  timeframe?: string;
  start?: string;
  end?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
};

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai enqueue_backtest_worker_job: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

function buildSummary(params: EnqueueBacktestWorkerJobParams): string {
  return `Backtest ${params.trader_def_id ?? params.strategy_id ?? "job"}`;
}

export async function runEnqueueBacktestWorkerJob(
  params: EnqueueBacktestWorkerJobParams,
  deps: EnqueueBacktestWorkerJobDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const staged = await bffFetch(STAGE_PATH, {
    method: "POST",
    body: {
      tool_name: ENQUEUE_BACKTEST_WORKER_JOB_TOOL_NAME,
      workspace_id: readWorkspaceId(),
      params,
      summary: buildSummary(params),
    },
    signal,
  });
  return {
    staged,
    message: "Staged a enqueue backtest worker job proposal. Review + Apply it in the chat.",
  };
}

export default defineToolPlugin({
  id: "vctraderai-enqueue-backtest-worker-job",
  name: "VC Trader AI Enqueue Backtest Worker Job (Propose)",
  description:
    "Stages a backtest worker-job dispatch proposal for human review; never dispatches it directly.",
  tools: (tool) => [
    tool({
      name: ENQUEUE_BACKTEST_WORKER_JOB_TOOL_NAME,
      label: "Enqueue Backtest Worker Job",
      description:
        "Dispatch a backtest worker job. This STAGES a proposal for the human to review + Apply in the chat - it does NOT execute the action directly. PROPOSE_ONLY per ADR 0078.",
      parameters: Type.Object(
        {
          trader_def_id: Type.Optional(
            Type.String({ description: "Trader definition id to backtest." }),
          ),
          strategy_id: Type.Optional(Type.String({ description: "Strategy id to backtest." })),
          instrument: Type.Optional(
            Type.String({ description: "Instrument symbol (e.g. EUR_USD)." }),
          ),
          timeframe: Type.Optional(Type.String({ description: "Timeframe code (e.g. H1)." })),
          start: Type.Optional(
            Type.String({ description: "Backtest window start (ISO-8601 date)." }),
          ),
          end: Type.Optional(Type.String({ description: "Backtest window end (ISO-8601 date)." })),
          params: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "Strategy parameter overrides keyed by name.",
            }),
          ),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runEnqueueBacktestWorkerJob(
          params as EnqueueBacktestWorkerJobParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
