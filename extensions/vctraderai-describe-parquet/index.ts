import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: describe_parquet.
//
// READ_ONLY per ADR 0078. Calls the BFF `/api/v1/openclaw/data/parquet/describe`
// endpoint and returns the raw envelope produced by the propfirm_manager
// `engine.tools.market_data_tools.describe_parquet` function (path, schema,
// num_row_groups, row_count_estimate, modified_time).

export const DESCRIBE_PARQUET_TOOL_NAME = "describe_parquet";

export type DescribeParquetDeps = {
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

export type DescribeParquetParams = {
  path: string;
};

export async function runDescribeParquet(
  params: DescribeParquetParams,
  deps: DescribeParquetDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/openclaw/data/parquet/describe`, {
    query: {
      path: params.path,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-describe-parquet",
  name: "VC Trader AI Describe Parquet",
  description: "Read-only parquet schema + row-group describe by path.",
  tools: (tool) => [
    tool({
      name: DESCRIBE_PARQUET_TOOL_NAME,
      label: "Describe Parquet",
      description:
        "Describe a parquet file (schema, row-group count, row count estimate, modified time) by path under the configured data root. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        path: Type.String({
          description: "Parquet path relative to data root, or s3:// URI.",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runDescribeParquet(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
