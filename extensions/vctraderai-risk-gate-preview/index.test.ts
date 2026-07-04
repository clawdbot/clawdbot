import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runRiskGatePreview, RISK_GATE_PREVIEW_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-risk-gate-preview", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  const originalAgentToken = process.env.PFM_AGENT_TOKEN;
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = WORKSPACE_ID;
    process.env.PFM_AGENT_TOKEN = "agent-token-001";
  });
  afterEach(() => {
    if (originalWorkspace === undefined) {
      delete process.env.PFM_WORKSPACE_ID;
    } else {
      process.env.PFM_WORKSPACE_ID = originalWorkspace;
    }
    if (originalAgentToken === undefined) {
      delete process.env.PFM_AGENT_TOKEN;
    } else {
      process.env.PFM_AGENT_TOKEN = originalAgentToken;
    }
  });

  it("registers the risk_gate_preview tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-risk-gate-preview" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: RISK_GATE_PREVIEW_TOOL_NAME,
      label: "Risk Gate Preview",
    });
  });

  it("POSTs a JSON body to the workspace-scoped risk/gate-preview endpoint", async () => {
    let capturedUrl = "";
    let capturedMethod = "GET";
    let capturedAuth: string | null = null;
    let capturedContentType: string | null = null;
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      capturedAuth = headers.get("authorization");
      capturedContentType = headers.get("content-type");
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({ passed: true, checks: [], blocking_check: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    await runRiskGatePreview(
      {
        account_id: "acct-1",
        instrument: "EUR_USD",
        direction: "buy",
        strategy_id: "strat-1",
        entry_price: 1.1,
        stop_loss_price: 1.09,
        take_profit_price: 1.12,
        quantity: 1000,
        market_mid: 1.1005,
        account_status: "active",
        strategy_symbol_allowlist: ["EUR_USD", "GBP_USD"],
      },
      { fetchImpl },
    );
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/risk/gate-preview`);
    expect(capturedMethod).toBe("POST");
    expect(capturedContentType).toBe("application/json");
    expect(capturedBody).toEqual({
      account_id: "acct-1",
      instrument: "EUR_USD",
      direction: "buy",
      strategy_id: "strat-1",
      entry_price: 1.1,
      stop_loss_price: 1.09,
      take_profit_price: 1.12,
      quantity: 1000,
      market_mid: 1.1005,
      account_status: "active",
      strategy_symbol_allowlist: ["EUR_USD", "GBP_USD"],
    });
    expect(capturedAuth).toBe("Bearer agent-token-001");
  });

  it("omits undefined optionals from the request body", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runRiskGatePreview(
      { account_id: "acct-1", instrument: "EUR_USD", direction: "sell" },
      { fetchImpl },
    );
    expect(capturedBody).toEqual({
      account_id: "acct-1",
      instrument: "EUR_USD",
      direction: "sell",
    });
  });

  it("requires account_id, instrument and direction", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as typeof globalThis.fetch;
    await expect(
      runRiskGatePreview(
        { account_id: "", instrument: "EUR_USD", direction: "buy" },
        { fetchImpl },
      ),
    ).rejects.toThrow(/account_id is required/);
    await expect(
      runRiskGatePreview({ account_id: "a", instrument: "", direction: "buy" }, { fetchImpl }),
    ).rejects.toThrow(/instrument is required/);
    await expect(
      runRiskGatePreview({ account_id: "a", instrument: "EUR_USD", direction: "" }, { fetchImpl }),
    ).rejects.toThrow(/direction is required/);
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("bad request", {
        status: 400,
        statusText: "Bad Request",
      })) as typeof globalThis.fetch;
    await expect(
      runRiskGatePreview(
        { account_id: "a", instrument: "EUR_USD", direction: "buy" },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_400", status: 400 },
    });
  });
});
