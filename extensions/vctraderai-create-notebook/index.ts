import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: create_notebook (PROPOSE).
//
// PROPOSE_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). This
// tool STAGES a proposal; it NEVER creates, runs, or executes a notebook
// directly. It POSTs to the BFF staged-action chokepoint
// `POST /api/v1/openclaw/stage` with `{ tool_name, workspace_id, params,
// summary }`. The BFF gates the tool against the closed-world allowlist,
// resolves the target_action_kind + confirm tier SERVER-SIDE from the allowlist
// spec, persists a reviewable staged descriptor, and returns it; the human
// reviews + Applies it in the chat.

export const CREATE_NOTEBOOK_TOOL_NAME = "create_notebook";
const STAGE_PATH = "/api/v1/openclaw/stage";

export type CreateNotebookDeps = {
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

export type CreateNotebookParams = {
  project_id: string;
  title: string;
  purpose?: string;
  template_kind?: "compare" | "wf" | "feat" | "blank";
  notebook?: Record<string, unknown>;
  notebook_json?: string;
  default_params?: Record<string, unknown>;
  idempotency_key?: string;
  [key: string]: unknown;
};

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai create_notebook: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

function buildSummary(params: CreateNotebookParams): string {
  return `Create notebook ${params.title} for project ${params.project_id}`;
}

/**
 * Normalize to the CANONICAL staging shape before we hand params to the BFF: the
 * plugin always emits the notebook document under a single `notebook` OBJECT
 * field. `notebook_json` is accepted as an input convenience (some models emit a
 * serialized document) but is parsed here, folded into `notebook`, and dropped,
 * so the propfirm_manager staged_apply adapter only ever reads ONE shape
 * (`params.notebook` as an object, or absent). When both are supplied the object
 * `notebook` wins. Per ADR 0078.
 */
function normalizeNotebookParams(params: CreateNotebookParams): CreateNotebookParams {
  const { notebook, notebook_json, ...rest } = params;
  let doc = notebook;
  if (doc === undefined && typeof notebook_json === "string" && notebook_json.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(notebook_json);
    } catch {
      throw new Error("vctraderai create_notebook: notebook_json is not valid JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("vctraderai create_notebook: notebook_json must encode a JSON object");
    }
    doc = parsed as Record<string, unknown>;
  }
  return doc === undefined ? rest : { ...rest, notebook: doc };
}

export async function runCreateNotebook(
  params: CreateNotebookParams,
  deps: CreateNotebookDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const normalized = normalizeNotebookParams(params);
  const staged = await bffFetch(STAGE_PATH, {
    method: "POST",
    body: {
      tool_name: CREATE_NOTEBOOK_TOOL_NAME,
      workspace_id: readWorkspaceId(),
      params: normalized,
      summary: buildSummary(normalized),
    },
    signal,
  });
  return {
    staged,
    message: "Staged a create notebook proposal. Review + Apply it in the chat.",
  };
}

export default defineToolPlugin({
  id: "vctraderai-create-notebook",
  name: "VC Trader AI Create Notebook (Propose)",
  description:
    "Stages a notebook creation proposal for human review; never creates or executes a notebook directly.",
  tools: (tool) => [
    tool({
      name: CREATE_NOTEBOOK_TOOL_NAME,
      label: "Create Notebook",
      description:
        "Propose a Project notebook. This STAGES a proposal for the human to review + Apply in the chat - it does NOT create or execute the notebook directly. After Apply, the propfirm_manager backend creates an agent-authored notebook and dispatches the sandboxed executor. PROPOSE_ONLY per ADR 0078.",
      parameters: Type.Object(
        {
          project_id: Type.String({
            description: "Project id that will own the notebook.",
            minLength: 1,
          }),
          title: Type.String({ description: "Notebook title.", minLength: 1 }),
          purpose: Type.Optional(
            Type.String({ description: "Why this notebook should be created." }),
          ),
          template_kind: Type.Optional(
            Type.Union(
              [
                Type.Literal("compare"),
                Type.Literal("wf"),
                Type.Literal("feat"),
                Type.Literal("blank"),
              ],
              { description: "Notebook template kind." },
            ),
          ),
          notebook: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "Notebook document payload when the caller has generated one.",
            }),
          ),
          notebook_json: Type.Optional(
            Type.String({ description: "Serialized notebook document payload." }),
          ),
          default_params: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "Default notebook parameters keyed by name.",
            }),
          ),
          idempotency_key: Type.Optional(
            Type.String({ description: "Optional idempotency key for repeated staging attempts." }),
          ),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runCreateNotebook(
          params as CreateNotebookParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
