import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

export const GET_DATA_VAULT_DATASET_TOOL_NAME = "get_data_vault_dataset";

export type GetDataVaultDatasetParams = { name: string; rows?: number };
export type GetDataVaultDatasetDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  threadId?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai get_data_vault_dataset: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runGetDataVaultDataset(
  params: GetDataVaultDatasetParams,
  deps: GetDataVaultDatasetDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(
    `/api/v1/workspaces/${requireWorkspaceId()}/data-vault/${encodeURIComponent(params.name)}/preview`,
    {
      query: { rows: params.rows === undefined ? undefined : String(params.rows) },
      signal,
    },
  );
}

export default defineToolPlugin({
  id: "vctraderai-get-data-vault-dataset",
  name: "VC Trader AI Get Data Vault Dataset",
  description: "Read a bounded, typed preview of one workspace Data Vault dataset.",
  tools: (tool) => [
    tool({
      name: GET_DATA_VAULT_DATASET_TOOL_NAME,
      label: "Get Data Vault Dataset",
      description:
        "Open a bounded preview of a named Data Vault dataset. Tabular data returns rows and columns; documents and structured data return typed content. Storage URIs are never exposed.",
      parameters: Type.Object(
        {
          name: Type.String({ minLength: 1, maxLength: 160, description: "Dataset name." }),
          rows: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 200,
              description: "Maximum tabular preview rows.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetDataVaultDataset(
          params as GetDataVaultDatasetParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
