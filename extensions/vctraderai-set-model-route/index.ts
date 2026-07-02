import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: set_model_route.
//
// Calls the propfirm_manager internal OpenClaw BFF route with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist gates
// the exact tool before running it.

export const SET_MODEL_ROUTE_TOOL_NAME = "set_model_route";

export type SetModelRouteDeps = {
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

export type SetModelRouteParams = Record<string, unknown>;

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai set_model_route: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

function requireStringParam(params: SetModelRouteParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai set_model_route: ${key} is required`);
  }
  return value;
}

function buildQuery(
  params: SetModelRouteParams,
  keys: string[],
): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {};
  for (const key of keys) {
    const value = params[key];
    query[key] = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  }
  return query;
}

export async function runSetModelRoute(
  params: SetModelRouteParams,
  deps: SetModelRouteDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch("/api/v1/openclaw/model-routes/set", {
    method: "POST",
    body: { ...params, workspace_id: readWorkspaceId() },
    headers: { "X-OpenClaw-Tool": SET_MODEL_ROUTE_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-set-model-route",
  name: "VC Trader AI Set Model Route",
  description: "Set one workspace Agent Alpha model route within the server-side safe allowlist.",
  tools: (tool) => [
    tool({
      name: SET_MODEL_ROUTE_TOOL_NAME,
      label: "Set Model Route",
      description:
        "Set one workspace Agent Alpha model route within the server-side safe allowlist.",
      parameters: Type.Object(
        {
          route_key: Type.String({ description: "Route key to update.", minLength: 1 }),
          model_id: Type.String({ description: "Allowed model id.", minLength: 1 }),
          fallback_models: Type.Optional(Type.Array(Type.String())),
          enabled: Type.Optional(Type.Boolean({ description: "Whether the route is enabled." })),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runSetModelRoute(
          params as SetModelRouteParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
