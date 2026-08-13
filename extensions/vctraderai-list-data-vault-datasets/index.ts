import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

export const LIST_DATA_VAULT_DATASETS_TOOL_NAME = "list_data_vault_datasets";

export type ListDataVaultDatasetsParams = { limit?: number };
export type ListDataVaultDatasetsDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  threadId?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai list_data_vault_datasets: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runListDataVaultDatasets(
  params: ListDataVaultDatasetsParams = {},
  deps: ListDataVaultDatasetsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/workspaces/${requireWorkspaceId()}/data-vault`, {
    query: { limit: params.limit === undefined ? undefined : String(params.limit) },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-data-vault-datasets",
  name: "VC Trader AI List Data Vault Datasets",
  description: "Read the authenticated workspace's immutable Data Vault dataset catalogue.",
  tools: (tool) => [
    tool({
      name: LIST_DATA_VAULT_DATASETS_TOOL_NAME,
      label: "List Data Vault Datasets",
      description:
        "List this workspace's Data Vault datasets, newest first. The response reports when the requested limit truncates the catalogue.",
      parameters: Type.Object(
        {
          limit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: 100, description: "Maximum datasets to return." }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListDataVaultDatasets(
          params as ListDataVaultDatasetsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
