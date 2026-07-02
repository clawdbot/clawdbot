import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, {
  runDispatchStrategyExperiment,
  DISPATCH_STRATEGY_EXPERIMENT_TOOL_NAME,
} from "./index.js";

describe("vctraderai-dispatch-strategy-experiment", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = "ws-001";
  });
  afterEach(() => {
    if (originalWorkspace === undefined) {
      delete process.env.PFM_WORKSPACE_ID;
    } else {
      process.env.PFM_WORKSPACE_ID = originalWorkspace;
    }
  });

  it("registers the dispatch_strategy_experiment tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-dispatch-strategy-experiment",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: DISPATCH_STRATEGY_EXPERIMENT_TOOL_NAME,
      label: "Dispatch Strategy Experiment",
    });
  });

  it("posts to the stage path with the staging envelope + threads origin_signal_id", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: any = undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({ staged_action_id: "stg-1" }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runDispatchStrategyExperiment(
      {
        strategy_id: "strat-1",
        experiment_kind: "backtest",
        config: { instrument: "XAUUSD" },
        origin_signal_id: "sig-42",
      },
      { fetchImpl },
    );
    expect(new URL(capturedUrl).pathname).toBe("/api/v1/openclaw/stage");
    expect(capturedMethod).toBe("POST");
    expect(capturedBody.tool_name).toBe("dispatch_strategy_experiment");
    expect(capturedBody.workspace_id).toBe("ws-001");
    expect(capturedBody.params).toMatchObject({
      strategy_id: "strat-1",
      experiment_kind: "backtest",
      origin_signal_id: "sig-42",
    });
    expect(typeof capturedBody.summary).toBe("string");
  });

  it("surfaces a structured error on bff 403 (tool forbidden / not propose_only)", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(
      runDispatchStrategyExperiment(
        { strategy_id: "strat-1", experiment_kind: "backtest" },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });
});
