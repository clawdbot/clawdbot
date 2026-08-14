import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: search_data_vault (READ).
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Ranked
// full-text search over the workspace's own Data Vault, served by
// `GET /api/v1/workspaces/{ws}/data-vault/search` (web_api/data_vault/router.py).
//
// The BFF route carries the SAME visibility contract as the list route — search
// can never surface a dataset the list would hide — so this tool needs no
// entitlement logic of its own.

export const SEARCH_DATA_VAULT_TOOL_NAME = "search_data_vault";

export type SearchDataVaultParams = { query: string; limit?: number };
export type SearchDataVaultDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  threadId?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai search_data_vault: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

/** Rank-ordered search across this workspace's entitled Data Vault datasets. */
export async function runSearchDataVault(
  params: SearchDataVaultParams,
  deps: SearchDataVaultDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const query = typeof params.query === "string" ? params.query.trim() : "";
  if (!query) {
    // Refuse loudly rather than issue a request the BFF will reject with a 400
    // (DEC-30). A blank query is a caller mistake, not an empty result set.
    throw new Error("search_data_vault requires a non-empty query");
  }
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/workspaces/${requireWorkspaceId()}/data-vault/search`, {
    query: {
      q: query,
      limit: params.limit === undefined ? undefined : String(params.limit),
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-search-data-vault",
  name: "VC Trader AI Search Data Vault",
  description: "Ranked full-text search over the authenticated workspace's own Data Vault.",
  tools: (tool) => [
    tool({
      name: SEARCH_DATA_VAULT_TOOL_NAME,
      label: "Search Data Vault",
      description:
        "Search the current workspace's Data Vault by name, columns, or content - ranked full-text search over dataset names, descriptions, column tokens, source hosts, and document excerpts. Required: query (non-empty). Optional: limit (default 20, capped 100). Read-only and workspace-scoped: results are the same entitled datasets the list shows, ranked by relevance, each with content kind, immutable version, quality status, and a truncated flag. Use it to find which stored dataset carries a column or topic before opening one with get_data_vault_dataset; an empty result means nothing stored matches, not an error.",
      parameters: Type.Object(
        {
          query: Type.String({
            minLength: 1,
            maxLength: 400,
            description: "Free-text search expression; matched against the dataset search surface.",
          }),
          limit: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 100,
              description: "Maximum datasets to return. Defaults to 20 server-side.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runSearchDataVault(
          params as SearchDataVaultParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
