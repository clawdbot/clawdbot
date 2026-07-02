import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: research_fetch_page (deep web-research page fetch).
//
// Calls the workspace-scoped research/fetch endpoint as the workspace owner
// (PFM_AGENT_TOKEN) to fetch and extract the main readable text of a PUBLIC web
// page. The BFF enforces an SSRF guard (internal / link-local / cloud-metadata
// addresses blocked, only ports 80/443) and returns
// { title, text, url, final_url, truncated }. This is a POST with a JSON body,
// unlike the GET-only get-order-outcome template it is derived from.

export const RESEARCH_FETCH_PAGE_TOOL_NAME = "research_fetch_page";

export type ResearchFetchPageDeps = {
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

export type ResearchFetchPageParams = {
  url: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai research_fetch_page: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function runResearchFetchPage(
  params: ResearchFetchPageParams,
  deps: ResearchFetchPageDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const url = nonEmpty(params.url);
  // `url` is required; the BFF returns 400 otherwise. Guard here so a malformed
  // call fails fast with a clear message instead of a 400.
  if (url === undefined) {
    throw new Error("vctraderai research_fetch_page: url is required (an absolute http(s) URL)");
  }
  return bffFetch(`/api/v1/workspaces/${workspaceId}/research/fetch`, {
    method: "POST",
    body: { url },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-research-fetch",
  name: "VC Trader AI Research Fetch",
  description:
    "Workspace-scoped tool: fetch and extract the main readable text of a PUBLIC web page via the propfirm_manager BFF as the workspace owner (PFM_AGENT_TOKEN). SSRF-guarded (only ports 80/443, no internal addresses).",
  tools: (tool) => [
    tool({
      name: RESEARCH_FETCH_PAGE_TOOL_NAME,
      label: "Research Fetch Page",
      description:
        "Fetch and extract the main readable text of a PUBLIC web page. Provide an absolute http(s) URL. Internal/link-local/cloud-metadata addresses are blocked by an SSRF guard, and only ports 80/443 are allowed. Returns { title, text, url, final_url, truncated }. Use this for deep web research when web_search snippets are not enough; cite the source URL in your answer.",
      parameters: Type.Object({
        url: Type.String({
          description: "The absolute http(s) URL of a PUBLIC web page to fetch.",
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runResearchFetchPage(
          params as ResearchFetchPageParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
