import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: lint_strategy (validate strategy source against the runtime contract).
//
// Calls the workspace-scoped strategy-authoring lint endpoint as the workspace
// owner (PFM_AGENT_TOKEN) to lint arbitrary strategy Python source against the
// SIX-KEY runtime contract (run(data,params,context) returning long/short
// entries+exits + positive sl_stop/tp_stop) via core.strategy_lint. Returns
// { passed, errors: [{ code, message, fix_hint }] } so the agent can validate +
// repair source BEFORE calling create_strategy. Stateless / read-only (no
// persistence). This is a POST with a JSON body (source can be large).

export const LINT_STRATEGY_TOOL_NAME = "lint_strategy";

export type LintStrategyDeps = {
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

export type LintStrategyParams = {
  source: string;
  entry_function?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai lint_strategy: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function runLintStrategy(
  params: LintStrategyParams,
  deps: LintStrategyDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const source = nonEmpty(params.source);
  // `source` is required; the BFF returns 400 (invalid_source) otherwise. Guard
  // here so a malformed call fails fast with a clear message.
  if (source === undefined) {
    throw new Error("vctraderai lint_strategy: source is required (the strategy Python source)");
  }
  const body: { source: string; entry_function?: string } = { source };
  const entryFunction = nonEmpty(params.entry_function);
  if (entryFunction !== undefined) {
    body.entry_function = entryFunction;
  }
  return bffFetch(`/api/v1/workspaces/${workspaceId}/strategy-authoring/lint`, {
    method: "POST",
    body,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-lint-strategy",
  name: "VC Trader AI Lint Strategy",
  description:
    "Workspace-scoped tool: lint strategy Python source against the six-key runtime contract via the propfirm_manager BFF as the workspace owner (PFM_AGENT_TOKEN). Stateless / read-only; persists nothing.",
  tools: (tool) => [
    tool({
      name: LINT_STRATEGY_TOOL_NAME,
      label: "Lint Strategy",
      description:
        "Lint strategy Python source against the six-key runtime contract: run(data, params, context) must return { long_entries, short_entries, long_exits, short_exits, sl_stop, tp_stop } with positive-finite sl_stop/tp_stop, using only the allowed imports/helpers. Returns { passed, errors: [{ code, message, fix_hint }] }. Use it to VALIDATE and REPAIR source BEFORE calling create_strategy. A lint that finds problems returns passed=false with actionable errors (it is not an error to call). Persists nothing.",
      parameters: Type.Object({
        source: Type.String({
          description: "The strategy Python source to lint (the full module text).",
        }),
        entry_function: Type.Optional(
          Type.String({
            description: "Entry function name the contract requires (default 'run').",
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runLintStrategy(
          params as LintStrategyParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
