import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: explain.
//
// READ_ONLY per ADR 0078. Fetches a single decision-ledger entry by id and
// returns the raw entry plus a short narrative summary built from
// `kind`, `subkind`, and the entry payload. We deliberately keep the summary
// formula trivial so the agent can override it; the canonical entry stays the
// source of truth.

export const EXPLAIN_TOOL_NAME = "explain";

export type LedgerEntry = {
  ledger_id?: string;
  kind?: string;
  subkind?: string;
  occurred_at?: string;
  payload?: unknown;
  [key: string]: unknown;
};

export type ExplainResult = {
  entry: LedgerEntry;
  summary: string;
};

export type ExplainDeps = {
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

function buildNarrativeSummary(entry: LedgerEntry): string {
  const kind = typeof entry.kind === "string" && entry.kind.length > 0 ? entry.kind : "unknown";
  const subkind =
    typeof entry.subkind === "string" && entry.subkind.length > 0 ? entry.subkind : null;
  const occurred =
    typeof entry.occurred_at === "string" && entry.occurred_at.length > 0
      ? entry.occurred_at
      : null;
  const subkindFragment = subkind ? `/${subkind}` : "";
  const occurredFragment = occurred ? ` at ${occurred}` : "";
  return `Decision-ledger entry of kind ${kind}${subkindFragment}${occurredFragment}.`;
}

export async function runExplain(
  workspaceId: string,
  decisionId: string,
  deps: ExplainDeps = {},
  signal?: AbortSignal,
): Promise<ExplainResult> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const entry = (await bffFetch(
    `/api/v1/workspaces/${workspaceId}/decision-ledger/entries/${decisionId}`,
    { signal },
  )) as LedgerEntry;
  return { entry, summary: buildNarrativeSummary(entry) };
}

export default defineToolPlugin({
  id: "vctraderai-explain",
  name: "VC Trader AI Explain",
  description:
    "Read-only inspector for a single decision-ledger entry with a brief narrative summary.",
  tools: (tool) => [
    tool({
      name: EXPLAIN_TOOL_NAME,
      label: "Explain",
      description:
        "Fetch a decision-ledger entry by id and return it with a short narrative summary. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        workspace_id: Type.String({
          description: "Workspace UUID (lowercase hex with dashes).",
          minLength: 1,
        }),
        decision_id: Type.String({
          description: "Decision-ledger entry UUID.",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runExplain(
          params.workspace_id,
          params.decision_id,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
