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
  it("relays the BFF's message + retry_suggestion so the model can self-correct", async () => {
    // The whole point: a 422 used to reach the model as the bare statusText
    // "Unprocessable Entity", so it could not tell a CONTRACT error from a
    // backend outage and retried the same wrong shape forever.
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          detail: {
            error: {
              code: "openclaw_stage_invalid_params",
              message: "config is missing required key(s): from_ts, to_ts.",
              retry_suggestion:
                "Re-call dispatch_strategy_experiment with config.from_ts and config.to_ts (ISO-8601).",
            },
          },
        }),
        { status: 422, statusText: "Unprocessable Entity" },
      )) as typeof globalThis.fetch;

    await expect(
      runDispatchStrategyExperiment(
        { strategy_id: "strat-1", experiment_kind: "vbt_backtest" },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: {
        code: "openclaw_stage_invalid_params",
        status: 422,
        message: "config is missing required key(s): from_ts, to_ts.",
        retrySuggestion:
          "Re-call dispatch_strategy_experiment with config.from_ts and config.to_ts (ISO-8601).",
      },
    });

    // The message is what the tool runner shows the model, so the suggestion
    // has to be IN it, not only on the detail object.
    await expect(
      runDispatchStrategyExperiment(
        { strategy_id: "strat-1", experiment_kind: "vbt_backtest" },
        { fetchImpl },
      ),
    ).rejects.toThrow(/retry_suggestion: Re-call dispatch_strategy_experiment/);
  });

  it("falls back to the status line when the error body is unreadable", async () => {
    const fetchImpl = (async () =>
      new Response("", { status: 502, statusText: "Bad Gateway" })) as typeof globalThis.fetch;
    await expect(
      runDispatchStrategyExperiment({ strategy_id: "strat-1" }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_502", status: 502, message: "Bad Gateway" },
    });
  });

  it("teaches the six DISPATCHABLE kinds, the window keys, and rule_overlay", async () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-dispatch-strategy-experiment",
    });
    plugin.register(captured.api);
    const { description = "" } = captured.tools[0] as { description?: string };
    // kind_is_dispatchable() = NOT v3-deferred AND NOT phase5-deferred AND NOT
    // operator-deferred (web_api/sandbox/v3/kinds.py:236-253). Exactly these six
    // pass. Verified by executing the catalogue module, not by reading it.
    for (const kind of [
      "vbt_backtest",
      "vbt_walkforward",
      "nautilus_backtest",
      "nautilus_walkforward",
      "nautilus_prop_sim",
      "nautilus_prop_walkforward",
    ]) {
      expect(description).toContain(kind);
    }
    expect(description).toContain("six DISPATCHABLE");
    expect(description).toContain("from_ts");
    expect(description).toContain("to_ts");
    // Only the two DISPATCHABLE prop kinds require config.rule_overlay. Naming
    // vbt_prop_sim here would be naming an undispatchable kind as a live option.
    expect(description).toContain("rule_overlay");
    expect(description).toMatch(
      /two dispatchable prop kinds \(nautilus_prop_sim, nautilus_prop_walkforward\)/,
    );
    // The window keys must be taught as canonical, WITHOUT claiming start/end are
    // rejected: staged_params._CONFIG_KEY_ALIASES folds start/end onto from_ts/to_ts
    // before the required-key check (web_api/openclaw_internal/router.py:548). A
    // future reader who "fixes" the plugin by deleting that fold would re-open the
    // 2026-07-29 browser-proof bug.
    expect(description).not.toMatch(/"start"\/"end" are NOT accepted/);
  });

  it("names BOTH non-dispatchable kinds as forbidden rather than offering them", async () => {
    // The 8-kind catalogue has TWO non-dispatchable kinds, not one:
    //   stage_b_bundle_run -> V3_DEFERRED_KIND_VALUES        (kinds.py:148)
    //   vbt_prop_sim       -> OPERATOR_DEFERRED_KIND_VALUES  (kinds.py:223)
    // Both are refused 422 at the /stage chokepoint before any row is written
    // (openclaw_internal/router.py:529-538) and again at apply (service.py:578).
    // vbt_prop_sim is the more dangerous of the two to teach: unlike the nautilus
    // prop stubs it is NOT in STUB_KIND_VALUES, so were it ever let through it
    // would land a permanent non-terminal orphan the stale-job reaper never sweeps.
    // Offering either one sends the model down a path that can only fail — the
    // exact defect this PR exists to end.
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-dispatch-strategy-experiment",
    });
    plugin.register(captured.api);
    const { description = "" } = captured.tools[0] as { description?: string };
    expect(description).toMatch(/NON-DISPATCHABLE in V2/);
    expect(description).toMatch(/stage_b_bundle_run \(DEFERRED TO V3\)/);
    expect(description).toMatch(/vbt_prop_sim \(BFF-stubbed at v1\.0/);
    // ...and vbt_prop_sim must NOT appear in the dispatchable sentence.
    const dispatchableSentence = /six DISPATCHABLE catalogue values: ([^-]+)/.exec(
      description,
    )?.[1];
    expect(dispatchableSentence).toBeDefined();
    expect(dispatchableSentence).not.toContain("vbt_prop_sim");
  });

  it("warns that the two nautilus prop kinds park instead of computing", async () => {
    // REAL_ENGINE_LIVE_KIND_VALUES (web_api/sandbox/v3/service.py:258) is only
    // {vbt_backtest, vbt_walkforward, nautilus_backtest, nautilus_walkforward}.
    // nautilus_prop_sim / nautilus_prop_walkforward route to StubEngineAdapter and
    // return state="deferred_pending" with output_envelope={} — no worker, no
    // metrics. A model that promises results from them is honest about the dispatch
    // and wrong about the outcome.
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-dispatch-strategy-experiment",
    });
    plugin.register(captured.api);
    const { description = "" } = captured.tools[0] as { description?: string };
    expect(description).toMatch(/deferred_pending/);
    expect(description).toMatch(/never promise the user metrics/);
  });

  it("offers project_id, because an unprojected run is invisible", async () => {
    // Every agent-dispatched experiment used to land with project_id NULL, and the
    // only experiments list in the product is project-scoped — so the run executed,
    // succeeded, stored its metrics, and could not be found anywhere in the UI.
    // Until this param existed the model had no way to express where a run belongs.
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-dispatch-strategy-experiment",
    });
    plugin.register(captured.api);
    const tool = captured.tools[0] as {
      parameters?: { properties?: Record<string, { description?: string }> };
    };
    const project = tool.parameters?.properties?.project_id;
    expect(project, "project_id must be an accepted parameter").toBeDefined();
    // Accepts a NAME as well as an id — the BFF resolver handles both, and a human
    // talking to the agent says "put it in Alpha Research", not a UUID.
    expect(project?.description ?? "").toMatch(/NAME/i);
    // And the consequence of omitting it must be stated, not left implicit.
    expect(project?.description ?? "").toMatch(/invisible/i);
  });

  it("marks stage_b_bundle_run as V3-deferred rather than offering it", async () => {
    // It IS in the 8-kind catalogue, but V3_DEFERRED_KIND_VALUES makes it
    // non-dispatchable in V2: the BFF 422s before anything is staged
    // (web_api/sandbox/v3/kinds.py:148). Teaching it as usable would send the
    // model down a path that can only fail.
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-dispatch-strategy-experiment",
    });
    plugin.register(captured.api);
    const { description = "" } = captured.tools[0] as { description?: string };
    expect(description).toContain("stage_b_bundle_run");
    expect(description).toMatch(/stage_b_bundle_run[^.]*(DEFERRED TO V3|deferred)/i);
    expect(description).toMatch(/six DISPATCHABLE/);
  });
});
