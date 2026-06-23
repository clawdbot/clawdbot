import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runListExperimentRuns, LIST_EXPERIMENT_RUNS_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-list-experiment-runs", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  const originalAgentToken = process.env.PFM_AGENT_TOKEN;
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = WORKSPACE_ID;
    process.env.PFM_AGENT_TOKEN = "agent-token-001";
  });
  afterEach(() => {
    if (originalWorkspace === undefined) delete process.env.PFM_WORKSPACE_ID;
    else process.env.PFM_WORKSPACE_ID = originalWorkspace;
    if (originalAgentToken === undefined) delete process.env.PFM_AGENT_TOKEN;
    else process.env.PFM_AGENT_TOKEN = originalAgentToken;
  });

  it("registers the list_experiment_runs tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-list-experiment-runs" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: LIST_EXPERIMENT_RUNS_TOOL_NAME,
      label: "List Experiment Runs",
    });
  });

  it("calls the workspace-scoped read with the owner bearer", async () => {
    let capturedUrl = "";
    let capturedAuth: string | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedAuth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    await runListExperimentRuns(
      {
        schema: "schema-x",
        limit: 1,
        status: "status-x",
        strategy_id: "strategy_id-x",
        trader_def_id: "trader_def_id-x",
        order_by: "order_by-x",
      },
      { fetchImpl },
    );
    expect(new URL(capturedUrl).pathname).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/openclaw/research/runs`,
    );
    expect(capturedAuth).toBe("Bearer agent-token-001");
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(
      runListExperimentRuns(
        {
          schema: "schema-x",
          limit: 1,
          status: "status-x",
          strategy_id: "strategy_id-x",
          trader_def_id: "trader_def_id-x",
          order_by: "order_by-x",
        },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });
});
