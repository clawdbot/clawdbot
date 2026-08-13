import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

export const STORE_DATASET_TOOL_NAME = "store_dataset";

export type StoreDatasetParams = {
  name: string;
  content_kind: "tabular" | "document" | "image" | "structured";
  content_text?: string;
  content_base64?: string;
  mime_type?: string;
  description?: string;
  source_uri?: string;
};

export type StoreDatasetDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  threadId?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai store_dataset: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

/** Stores a new immutable version through the workspace-scoped Data Vault BFF. */
export async function runStoreDataset(
  params: StoreDatasetParams,
  deps: StoreDatasetDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  if ((params.content_text === undefined) === (params.content_base64 === undefined)) {
    throw new Error("store_dataset requires exactly one of content_text or content_base64");
  }
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/workspaces/${requireWorkspaceId()}/data-vault`, {
    method: "POST",
    body: params,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-store-dataset",
  name: "VC Trader AI Store Dataset",
  description: "Write a new immutable workspace Data Vault dataset through the authenticated BFF.",
  tools: (tool) => [
    tool({
      name: STORE_DATASET_TOOL_NAME,
      label: "Store Dataset",
      description:
        "Store a cleaned finding as a new immutable Data Vault dataset. Provide exactly one of text or base64 content; a successful response confirms the dataset is registered.",
      parameters: Type.Object(
        {
          name: Type.String({ minLength: 1, maxLength: 160 }),
          content_kind: Type.Union([
            Type.Literal("tabular"),
            Type.Literal("document"),
            Type.Literal("image"),
            Type.Literal("structured"),
          ]),
          content_text: Type.Optional(Type.String()),
          content_base64: Type.Optional(Type.String()),
          mime_type: Type.Optional(Type.String({ maxLength: 160 })),
          description: Type.Optional(Type.String({ maxLength: 4000 })),
          source_uri: Type.Optional(Type.String({ maxLength: 4000 })),
        },
        { additionalProperties: false },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runStoreDataset(
          params as StoreDatasetParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
