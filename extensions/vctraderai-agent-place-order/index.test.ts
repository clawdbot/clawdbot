import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runAgentPlaceOrder, AGENT_PLACE_ORDER_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-agent-place-order", () => {
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

  it("registers the agent_place_order tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-agent-place-order" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: AGENT_PLACE_ORDER_TOOL_NAME,
      label: "Agent Place Order",
    });
  });

  it("posts to the workspace-scoped agent-place path with the owner bearer + mandatory-sl body", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedAuth: string | null = null;
    let capturedBody: any = undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      capturedAuth = new Headers(init?.headers).get("authorization");
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({ accepted_queued: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    const result = await runAgentPlaceOrder(
      {
        account_id: "acct-1",
        symbol: "XAU_USD",
        side: "buy",
        qty: "0.10",
        stop_loss: 1900.5,
        intended_price: 1925.0,
        take_profit: 1950.0,
        client_order_id: "coid-1",
      },
      { fetchImpl },
    );
    expect(new URL(capturedUrl).pathname).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/live/orders/agent-place`,
    );
    expect(capturedMethod).toBe("POST");
    expect(capturedAuth).toBe("Bearer agent-token-001");
    expect(capturedBody).toEqual({
      account_id: "acct-1",
      symbol: "XAU_USD",
      side: "buy",
      qty: "0.10",
      stop_loss: 1900.5,
      intended_price: 1925.0,
      take_profit: 1950.0,
      client_order_id: "coid-1",
    });
    expect(result).toEqual({ accepted_queued: true });
  });

  it("omits take_profit / client_order_id from the body when undefined", async () => {
    let capturedBody: any = undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({ downgraded_to_staged: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runAgentPlaceOrder(
      {
        account_id: "acct-1",
        symbol: "XAU_USD",
        side: "sell",
        qty: 1,
        stop_loss: 1950,
        intended_price: 1925,
      },
      { fetchImpl },
    );
    expect(capturedBody).toEqual({
      account_id: "acct-1",
      symbol: "XAU_USD",
      side: "sell",
      qty: 1,
      stop_loss: 1950,
      intended_price: 1925,
    });
    expect("take_profit" in capturedBody).toBe(false);
    expect("client_order_id" in capturedBody).toBe(false);
  });

  it("stamps X-OpenClaw-Thread with the per-turn thread id when supplied", async () => {
    let capturedThreadHeader: string | null = null;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedThreadHeader = new Headers(init?.headers).get("x-openclaw-thread");
      return new Response(JSON.stringify({ accepted_queued: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runAgentPlaceOrder(
      {
        account_id: "acct-1",
        symbol: "XAU_USD",
        side: "buy",
        qty: "0.10",
        stop_loss: 1900,
        intended_price: 1925,
      },
      { fetchImpl, threadId: "thread-specialist-7" },
    );
    expect(capturedThreadHeader).toBe("thread-specialist-7");
  });

  it("omits X-OpenClaw-Thread when no thread id is supplied", async () => {
    let hasThreadHeader = true;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      hasThreadHeader = new Headers(init?.headers).has("x-openclaw-thread");
      return new Response(JSON.stringify({ accepted_queued: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runAgentPlaceOrder(
      {
        account_id: "acct-1",
        symbol: "XAU_USD",
        side: "buy",
        qty: "0.10",
        stop_loss: 1900,
        intended_price: 1925,
      },
      { fetchImpl },
    );
    expect(hasThreadHeader).toBe(false);
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(
      runAgentPlaceOrder(
        {
          account_id: "acct-1",
          symbol: "XAU_USD",
          side: "buy",
          qty: "0.10",
          stop_loss: 1900,
          intended_price: 1925,
        },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });
});
