import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: generate_day_ahead_forecast.
//
// Calls the propfirm_manager internal OpenClaw BFF route with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist gates
// the exact tool before running it.

export const GENERATE_DAY_AHEAD_FORECAST_TOOL_NAME = "generate_day_ahead_forecast";

export type GenerateDayAheadForecastDeps = {
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

export type GenerateDayAheadForecastParams = Record<string, unknown>;

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai generate_day_ahead_forecast: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

function requireStringParam(params: GenerateDayAheadForecastParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai generate_day_ahead_forecast: ${key} is required`);
  }
  return value;
}

function buildQuery(
  params: GenerateDayAheadForecastParams,
  keys: string[],
): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {};
  for (const key of keys) {
    const value = params[key];
    query[key] = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  }
  return query;
}

export async function runGenerateDayAheadForecast(
  params: GenerateDayAheadForecastParams,
  deps: GenerateDayAheadForecastDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch("/api/v1/openclaw/briefings/day-ahead", {
    method: "GET",
    query: buildQuery({ ...params, workspace_id: readWorkspaceId() }, [
      "workspace_id",
      "instrument",
    ]),
    headers: { "X-OpenClaw-Tool": GENERATE_DAY_AHEAD_FORECAST_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-generate-day-ahead-forecast",
  name: "VC Trader AI Generate Day-Ahead Forecast",
  description: "Generate an offline day-ahead structured prior, not a prediction.",
  tools: (tool) => [
    tool({
      name: GENERATE_DAY_AHEAD_FORECAST_TOOL_NAME,
      label: "Generate Day-Ahead Forecast",
      description: "Generate an offline day-ahead structured prior, not a prediction.",
      parameters: Type.Object(
        {
          instrument: Type.Optional(Type.String({ description: "Instrument, e.g. XAUUSD." })),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGenerateDayAheadForecast(
          params as GenerateDayAheadForecastParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
