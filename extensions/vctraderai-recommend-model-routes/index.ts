import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: recommend_model_routes.
//
// Calls the propfirm_manager internal OpenClaw BFF route with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist gates
// the exact tool before running it.

export const RECOMMEND_MODEL_ROUTES_TOOL_NAME = "recommend_model_routes";

export type RecommendModelRoutesDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
};

export type RecommendModelRoutesParams = Record<string, unknown>;

function requireStringParam(params: RecommendModelRoutesParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai recommend_model_routes: ${key} is required`);
  }
  return value;
}

function buildQuery(
  params: RecommendModelRoutesParams,
  keys: string[],
): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {};
  for (const key of keys) {
    const value = params[key];
    query[key] = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  }
  return query;
}

export async function runRecommendModelRoutes(
  params: RecommendModelRoutesParams,
  deps: RecommendModelRoutesDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch = deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl });
  return bffFetch("/api/v1/openclaw/model-routes/recommendations", {
    method: "GET",
    query: buildQuery(params, ["workspace_id"]),
    headers: { "X-OpenClaw-Tool": RECOMMEND_MODEL_ROUTES_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-recommend-model-routes",
  name: "VC Trader AI Recommend Model Routes",
  description: "Recommend safe Agent Alpha model-route assignments for the workspace.",
  tools: (tool) => [
    tool({
      name: RECOMMEND_MODEL_ROUTES_TOOL_NAME,
      label: "Recommend Model Routes",
      description: "Recommend safe Agent Alpha model-route assignments for the workspace.",
      parameters: Type.Object(
        {
          workspace_id: Type.String({ description: "Workspace id.", minLength: 1 }),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runRecommendModelRoutes(params as RecommendModelRoutesParams, {}, context.signal);
      },
    }),
  ],
});
