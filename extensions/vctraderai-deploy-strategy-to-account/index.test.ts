import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, {
  DEPLOY_STRATEGY_TO_ACCOUNT_TOOL_NAME,
  runDeployStrategyToAccount,
} from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

function captureFetch(): {
  fetchImpl: typeof globalThis.fetch;
  request: () => Request | undefined;
} {
  let seen: Request | undefined;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = new Request(input, init);
    return new Response(JSON.stringify({ staged_action_id: "staged-1" }), { status: 201 });
  }) as typeof globalThis.fetch;
  return { fetchImpl, request: () => seen };
}

describe("vctraderai-deploy-strategy-to-account", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  const originalToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = WORKSPACE_ID;
    process.env.OPENCLAW_GATEWAY_TOKEN = "gateway-token-001";
  });
  afterEach(() => {
    if (originalWorkspace === undefined) delete process.env.PFM_WORKSPACE_ID;
    else process.env.PFM_WORKSPACE_ID = originalWorkspace;
    if (originalToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
    else process.env.OPENCLAW_GATEWAY_TOKEN = originalToken;
  });

  it("registers deploy_strategy_to_account", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-deploy-strategy-to-account",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({ name: DEPLOY_STRATEGY_TO_ACCOUNT_TOOL_NAME });
  });

  it("stages through the propose chokepoint and never calls a deploy route", async () => {
    const { fetchImpl, request } = captureFetch();

    await runDeployStrategyToAccount(
      {
        strategy_id: "strat-1",
        version_id: "ver-1",
        account_id: "acct-1",
        deployment_mode: "live",
      },
      { fetchImpl, threadId: "thread-42" },
    );

    const seen = request();
    expect(seen?.method).toBe("POST");
    // The propose chokepoint, NOT a deployment endpoint. If this ever points at
    // a deploy route the tool has stopped being propose-only.
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/openclaw/stage");
    expect(seen?.headers.get("authorization")).toBe("Bearer gateway-token-001");
    expect(seen?.headers.get("x-openclaw-thread")).toBe("thread-42");
  });

  it("stages the exact param keys the apply adapter reads", async () => {
    const { fetchImpl, request } = captureFetch();

    await runDeployStrategyToAccount(
      {
        strategy_id: " strat-1 ",
        version_id: " ver-1 ",
        account_id: " acct-1 ",
        deployment_mode: "confirm",
        risk_cap_override_pct: 2.5,
        idempotency_key: "idem-9",
      },
      { fetchImpl },
    );

    // _build_deploy_strategy_to_account_kwargs reads version_id, NOT
    // strategy_version_id. A rename here applies a deployment with a null version.
    await expect(request()?.json()).resolves.toEqual({
      tool_name: "deploy_strategy_to_account",
      workspace_id: WORKSPACE_ID,
      params: {
        strategy_id: "strat-1",
        version_id: "ver-1",
        account_id: "acct-1",
        deployment_mode: "confirm",
        risk_cap_override_pct: 2.5,
        idempotency_key: "idem-9",
      },
      summary: "Deploy strategy strat-1 version ver-1 to account acct-1 (confirm)",
    });
  });

  it("defaults deployment_mode to paper rather than to live", async () => {
    const { fetchImpl, request } = captureFetch();

    await runDeployStrategyToAccount(
      { strategy_id: "s", version_id: "v", account_id: "a" },
      { fetchImpl },
    );

    const body = (await request()?.json()) as { params: { deployment_mode: string } };
    expect(body.params.deployment_mode).toBe("paper");
  });

  it("tells the caller the proposal is not a deployment", async () => {
    const { fetchImpl } = captureFetch();

    const result = (await runDeployStrategyToAccount(
      { strategy_id: "s", version_id: "v", account_id: "a" },
      { fetchImpl },
    )) as { requires_apply: boolean; confirm_tier: string; message: string };

    expect(result.requires_apply).toBe(true);
    expect(result.confirm_tier).toBe("T3");
    expect(result.message).toMatch(/nothing is deployed/i);
  });

  it.each([
    ["strategy_id", { strategy_id: "  ", version_id: "v", account_id: "a" }],
    ["version_id", { strategy_id: "s", version_id: "", account_id: "a" }],
    ["account_id", { strategy_id: "s", version_id: "v", account_id: "   " }],
  ])("refuses a blank %s before opening a request", async (field, params) => {
    const fetchImpl = (async () => {
      throw new Error("must not be called");
    }) as typeof globalThis.fetch;

    await expect(
      runDeployStrategyToAccount(params as Parameters<typeof runDeployStrategyToAccount>[0], {
        fetchImpl,
      }),
    ).rejects.toThrow(field);
  });

  it("refuses an unknown deployment_mode instead of silently using paper", async () => {
    const fetchImpl = (async () => {
      throw new Error("must not be called");
    }) as typeof globalThis.fetch;

    await expect(
      runDeployStrategyToAccount(
        {
          strategy_id: "s",
          version_id: "v",
          account_id: "a",
          deployment_mode: "yolo" as never,
        },
        { fetchImpl },
      ),
    ).rejects.toThrow("deployment_mode");
  });

  it.each([0, -1, 101, Number.NaN])(
    "refuses an out-of-range risk_cap_override_pct: %s",
    async (cap) => {
      const fetchImpl = (async () => {
        throw new Error("must not be called");
      }) as typeof globalThis.fetch;

      await expect(
        runDeployStrategyToAccount(
          { strategy_id: "s", version_id: "v", account_id: "a", risk_cap_override_pct: cap },
          { fetchImpl },
        ),
      ).rejects.toThrow("risk_cap_override_pct");
    },
  );

  it("omits optional keys entirely rather than staging explicit nulls", async () => {
    const { fetchImpl, request } = captureFetch();

    await runDeployStrategyToAccount(
      { strategy_id: "s", version_id: "v", account_id: "a" },
      { fetchImpl },
    );

    const body = (await request()?.json()) as { params: Record<string, unknown> };
    expect(Object.keys(body.params).sort()).toEqual([
      "account_id",
      "deployment_mode",
      "strategy_id",
      "version_id",
    ]);
  });
});
