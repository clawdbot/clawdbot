import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: build_prop_spec.
//
// READ_ONLY per ADR 0078. Calls the BFF
// `POST /api/v1/openclaw/prop-spec/build` endpoint which composes a
// challenge-spec envelope (rules, profit targets, drawdown limits, etc.)
// for a given prop firm and account size by reading the catalogue of
// existing prop-firm challenge templates. No mutation - the BFF persists
// nothing on this path; the spec is rebuilt on each call.

export const BUILD_PROP_SPEC_TOOL_NAME = "build_prop_spec";

export type BuildPropSpecDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
};

export type BuildPropSpecParams = {
  prop_firm_id: string;
  account_size: number;
};

export async function runBuildPropSpec(
  params: BuildPropSpecParams,
  deps: BuildPropSpecDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch = deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl });
  const body: Record<string, unknown> = {
    prop_firm_id: params.prop_firm_id,
    account_size: params.account_size,
  };
  return bffFetch("/api/v1/openclaw/prop-spec/build", {
    method: "POST",
    body,
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
        "Compose and return a prop-firm challenge spec envelope for the given firm + account size. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        prop_firm_id: Type.String({
          description:
            "Prop firm identifier (e.g. the5ers, ftmo) - must match the prop-firm catalogue returned by list_prop_firm_challenges.",
          minLength: 1,
        }),
        account_size: Type.Integer({
          description: "Target account size in USD (e.g. 100000, 200000).",
          minimum: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runBuildPropSpec(params, {}, context.signal);
      },
    }),
  ],
});
