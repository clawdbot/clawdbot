import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_venues.
//
// READ_ONLY per ADR 0078. Calls the BFF `/api/v1/openclaw/catalogue/venues` endpoint and
// returns the raw envelope produced by the propfirm_manager
// `engine.agent.tools.data_tools.list_venues` function.

export const LIST_VENUES_TOOL_NAME = "list_venues";

export type ListVenuesDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
};

export async function runListVenues(
  deps: ListVenuesDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch = deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl });
  return bffFetch(`/api/v1/openclaw/catalogue/venues`, {
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-venues",
  name: "VC Trader AI List Venues",
  description: "Read-only catalogue listing of trading venues.",
  tools: (tool) => [
    tool({
      name: LIST_VENUES_TOOL_NAME,
      label: "List Venues",
      description:
        "List trading venues from the propfirm_manager core.venues catalogue (venue_id, name). READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({}),
      async execute(_params, _config, context) {
        context.signal?.throwIfAborted();
        return runListVenues({}, context.signal);
      },
    }),
  ],
});
