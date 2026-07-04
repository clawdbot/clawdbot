import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runPositionSizeCalculator, POSITION_SIZE_CALCULATOR_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-position-size-calculator", () => {
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

  it("registers the position_size_calculator tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-position-size-calculator",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: POSITION_SIZE_CALCULATOR_TOOL_NAME,
      label: "Position Size Calculator",
    });
  });

  it("POSTs a JSON body to the workspace-scoped risk/position-size endpoint", async () => {
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
      return new Response(JSON.stringify({ units: 1000, lots: 0.01, notional: 1000 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    await runPositionSizeCalculator(
      {
        symbol: "EUR_USD",
        entry_price: 1.1,
        stop_price: 1.09,
        account_balance: 10000,
        risk_per_trade_pct: 1,
        conviction_multiplier: 1.5,
        provider: "dukascopy",
      },
      { fetchImpl },
    );
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/risk/position-size`);
    expect(capturedMethod).toBe("POST");
    expect(capturedContentType).toBe("application/json");
    expect(capturedBody).toEqual({
      symbol: "EUR_USD",
      entry_price: 1.1,
      stop_price: 1.09,
      account_balance: 10000,
      risk_per_trade_pct: 1,
      conviction_multiplier: 1.5,
      provider: "dukascopy",
    });
    expect(capturedAuth).toBe("Bearer agent-token-001");
  });

  it("omits undefined optionals from the request body", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runPositionSizeCalculator(
      {
        symbol: "XAU_USD",
        entry_price: 2400,
        stop_price: 2390,
        account_balance: 5000,
        risk_per_trade_pct: 0.5,
      },
      { fetchImpl },
    );
    expect(capturedBody).toEqual({
      symbol: "XAU_USD",
      entry_price: 2400,
      stop_price: 2390,
      account_balance: 5000,
      risk_per_trade_pct: 0.5,
    });
  });

  it("requires a symbol", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as typeof globalThis.fetch;
    await expect(
      runPositionSizeCalculator(
        {
          symbol: "",
          entry_price: 1.1,
          stop_price: 1.09,
          account_balance: 10000,
          risk_per_trade_pct: 1,
        },
        { fetchImpl },
      ),
    ).rejects.toThrow(/symbol is required/);
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("bad request", {
        status: 400,
        statusText: "Bad Request",
      })) as typeof globalThis.fetch;
    await expect(
      runPositionSizeCalculator(
        {
          symbol: "EUR_USD",
          entry_price: 1.1,
          stop_price: 1.09,
          account_balance: 10000,
          risk_per_trade_pct: 1,
        },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_400", status: 400 },
    });
  });
});
