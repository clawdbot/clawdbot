import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_model_routes.
//
// Calls the propfirm_manager internal OpenClaw BFF route with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist gates
// the exact tool before running it.

export const GET_MODEL_ROUTES_TOOL_NAME = "get_model_routes";

export type GetModelRoutesDeps = {
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

export type GetModelRoutesParams = Record<string, unknown>;

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai get_model_routes: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

function requireStringParam(params: GetModelRoutesParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai get_model_routes: ${key} is required`);
  }
  return value;
}

function buildQuery(
  params: GetModelRoutesParams,
  keys: string[],
): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {};
  for (const key of keys) {
    const value = params[key];
    query[key] = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  }
  return query;
}

export async function runGetModelRoutes(
  params: GetModelRoutesParams,
  deps: GetModelRoutesDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch("/api/v1/openclaw/model-routes", {
    method: "GET",
    query: buildQuery({ ...params, workspace_id: readWorkspaceId() }, ["workspace_id"]),
    headers: { "X-OpenClaw-Tool": GET_MODEL_ROUTES_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-get-model-routes",
  name: "VC Trader AI Get Model Routes",
  description: "Read the workspace Agent Alpha model-route configuration.",
  tools: (tool) => [
    tool({
      name: GET_MODEL_ROUTES_TOOL_NAME,
      label: "Get Model Routes",
      description: "Read the workspace Agent Alpha model-route configuration.",
      parameters: Type.Object({}, { additionalProperties: true }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetModelRoutes(
          params as GetModelRoutesParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
