import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: build_prop_spec.
//
// READ_ONLY per ADR 0078. Calls the BFF
// `GET /api/v1/openclaw/catalogue/prop-spec?challenge_id=<id>` endpoint, which
// forwards `challenge_id` to the propfirm_manager engine function
// `engine.agent.tools.backtest_tools.build_prop_spec(challenge_id)` and returns
// the composed prop-spec envelope (per-stage rules, profit targets, drawdown
// limits, fee, refund policy, sources) for one prop-firm challenge template. No
// mutation - the spec is rebuilt on each call from core.prop_firm_challenges +
// core.prop_firm_rule_sets.
//
// The challenge_id comes from list_prop_firm_challenges (the catalogue). NOTE
// the engine signature is build_prop_spec(challenge_id) - a single challenge id
// - NOT (prop_firm_id, account_size); GET /catalogue/prop-spec is the matching
// BFF surface (the workspace-agnostic openclaw read-only-tool family), and the
// only one the per-plugin egress allowlist admits (the openclaw segment after
// /openclaw/ must be [a-z]+, so the legacy /openclaw/prop-spec/build path was
// rejected before a socket opened).

export const BUILD_PROP_SPEC_TOOL_NAME = "build_prop_spec";

export type BuildPropSpecDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
};

export type BuildPropSpecParams = {
  challenge_id: string;
};

export async function runBuildPropSpec(
  params: BuildPropSpecParams,
  deps: BuildPropSpecDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch = deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl });
  return bffFetch("/api/v1/openclaw/catalogue/prop-spec", {
    query: { challenge_id: params.challenge_id },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-build-prop-spec",
  name: "VC Trader AI Build Prop Spec",
  description: "Read-only builder for a prop-firm challenge spec envelope.",
  tools: (tool) => [
    tool({
      name: BUILD_PROP_SPEC_TOOL_NAME,
      label: "Build Prop Spec",
      description:
        "Compose and return the prop-firm challenge spec envelope (per-stage rules, profit target, max drawdown, fee, refund policy) for one challenge template. Pass the challenge_id from list_prop_firm_challenges. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        challenge_id: Type.String({
          description:
            "Prop-firm challenge template identifier - must match a challenge_id returned by list_prop_firm_challenges.",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runBuildPropSpec(params, {}, context.signal);
      },
    }),
  ],
});
