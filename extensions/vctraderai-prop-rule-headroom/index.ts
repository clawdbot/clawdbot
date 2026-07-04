import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: prop_rule_headroom (config-side prop-firm rule headroom).
//
// Calls the workspace-scoped risk/prop-headroom endpoint as the workspace owner
// (PFM_AGENT_TOKEN) to compute config-side prop-firm rule headroom
// (profit-target / max-DD / daily-loss room) for a variant + account size. This
// is a POST with a JSON body, mirroring the research/fetch template it is
// derived from.

export const PROP_RULE_HEADROOM_TOOL_NAME = "prop_rule_headroom";

export type PropRuleHeadroomDeps = {
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

export type PropRuleHeadroomParams = {
  variant_id: string;
  account_size: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai prop_rule_headroom: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function runPropRuleHeadroom(
  params: PropRuleHeadroomParams,
  deps: PropRuleHeadroomDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const variantId = nonEmpty(params.variant_id);
  // Required fields; the BFF returns 400 otherwise. Guard here so a malformed
  // call fails fast with a clear message instead of a 400.
  if (variantId === undefined) {
    throw new Error("vctraderai prop_rule_headroom: variant_id is required");
  }
  if (typeof params.account_size !== "number") {
    throw new Error("vctraderai prop_rule_headroom: account_size is required (number)");
  }
  // Build the request body from all declared params that are present.
  const body: Record<string, unknown> = {
    variant_id: variantId,
    account_size: params.account_size,
  };
  return bffFetch(`/api/v1/workspaces/${workspaceId}/risk/prop-headroom`, {
    method: "POST",
    body,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-prop-rule-headroom",
  name: "VC Trader AI Prop Rule Headroom",
  description:
    "Workspace-scoped tool: config-side prop-firm rule headroom (profit-target / max-DD / daily-loss room) for a variant + account size, via the propfirm_manager BFF as the workspace owner (PFM_AGENT_TOKEN).",
  tools: (tool) => [
    tool({
      name: PROP_RULE_HEADROOM_TOOL_NAME,
      label: "Prop Rule Headroom",
      description:
        "Config-side prop-firm rule headroom (profit-target / max-DD / daily-loss room) for a variant + account size. Provide the variant_id and account_size. Returns the room remaining against each prop-firm rule for that variant at the given account size.",
      parameters: Type.Object({
        variant_id: Type.String({
          description: "The prop-firm variant id to evaluate rule headroom for.",
        }),
        account_size: Type.Number({
          description: "The account size (base currency) to compute rule headroom against.",
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runPropRuleHeadroom(
          params as PropRuleHeadroomParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
