import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_worker_job.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.

export const GET_WORKER_JOB_TOOL_NAME = "get_worker_job";

export type GetWorkerJobDeps = {
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

export type GetWorkerJobParams = {
  job_id: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai get_worker_job: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runGetWorkerJob(
  params: GetWorkerJobParams,
  deps: GetWorkerJobDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  if (typeof params.job_id !== "string" || params.job_id.length === 0) {
    throw new Error("vctraderai get_worker_job: job_id is required");
  }
  return bffFetch(
    `/api/v1/workspaces/${workspaceId}/openclaw/research/worker-jobs/${params.job_id}`,
    {
      signal,
    },
  );
}

export default defineToolPlugin({
  id: "vctraderai-get-worker-job",
  name: "VC Trader AI Get Worker Job",
  description: "Read-only workspace-scoped tool: Read one research worker job's state.",
  tools: (tool) => [
    tool({
      name: GET_WORKER_JOB_TOOL_NAME,
      label: "Get Worker Job",
      description:
        "Read one research worker job's state. READ_ONLY per ADR 0078 - no mutation. Scoped to the workspace owner.",
      parameters: Type.Object({
        job_id: Type.String({ description: "Worker job id.", minLength: 1 }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetWorkerJob(
          params as GetWorkerJobParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
