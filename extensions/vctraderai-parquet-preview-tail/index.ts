import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: parquet_preview_tail.
//
// READ_ONLY per ADR 0078. Calls the BFF
// `/api/v1/openclaw/data/parquet/preview-tail` endpoint and returns the raw
// envelope produced by the propfirm_manager
// `engine.tools.market_data_tools.parquet_preview_tail` function (path, rows,
// schema, row_group, sources, filters).

export const PARQUET_PREVIEW_TAIL_TOOL_NAME = "parquet_preview_tail";

export type ParquetPreviewTailDeps = {
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

export type ParquetPreviewTailParams = {
  path: string;
  n: number;
};

export async function runParquetPreviewTail(
  params: ParquetPreviewTailParams,
  deps: ParquetPreviewTailDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/openclaw/data/parquet/preview-tail`, {
    query: {
      path: params.path,
      n: String(params.n),
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-parquet-preview-tail",
  name: "VC Trader AI Parquet Preview Tail",
  description: "Read-only preview of the last N rows of a parquet file.",
  tools: (tool) => [
    tool({
      name: PARQUET_PREVIEW_TAIL_TOOL_NAME,
      label: "Parquet Preview Tail",
      description:
        "Return the last N rows of a parquet file by path (under the configured data root, or s3:// URI), with schema. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        path: Type.String({
          description: "Parquet path relative to data root, or s3:// URI.",
          minLength: 1,
        }),
        n: Type.Integer({
          description: "Number of tail rows to return (bounded server-side).",
          minimum: 1,
          maximum: 500,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runParquetPreviewTail(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
